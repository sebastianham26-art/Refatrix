// 공통 › 전자결재(0234) — 비용집행 품의 · 결재선 · 증빙 · 댓글 · 알림 · 설정 · 예정/실적 리포트
//   규칙(결재선 생성·다음 단계·열람 권한·파일 검증)은 src/approval.js 순수 함수.
//   모든 상태 변경은 withTx 안에서 문서 행을 FOR UPDATE 로 잠근 뒤 처리한다(동시 클릭·중복 승인 방지).
//   예정/실적 금액은 이 모듈 안에서만 관리 — transactions·cashflow 에는 쓰지 않는다.
//   0237: USD 기입 → 재무 환율(fx_rates)로 MXN 환산(상신 시 고정) · 결제 방식(일시불/분할/정기) 회차별 집행 · 본문 그림.
import { query, withTx } from '../db.js';
import { getUsdMxnRate } from '../fx.js';
import { authGuard } from '../middleware/authGuard.js';
import {
  APPROVAL_FILE_BODY_LIMIT, APPROVAL_FILE_MAX_BYTES, KINDS, EXEC_KINDS, PAY_METHODS, STEP_LABEL, REQUEST_KIND,
  n, round2, sameId, decodeApprovalFile, sha256Hex, parseCfdi, guessKind, normKind, calcAmounts,
  roleCtx, buildLines, advance, postLine, myPending, canSeeDoc, isTodo, stageKey, fileStage, variancePct,
  allowedActions, canDeleteFile, canVoidFile, docNo, reportRows, completenessChecks,
  CURRENCIES, PAYMENT_TYPES, PAYMENT_TYPE_LABEL, FREQS, SCHEDULE_MAX, buildSchedule, toMxn, paymentsMxn, normalizeBodyRich, APPROVAL_DOC_BODY_LIMIT, isYmd,
} from '../approval.js';

const DOC_COLS = `d.id, d.doc_no, d.version, d.parent_id, d.category_id, d.title, d.vendor, d.drafter_id,
  to_char(d.pay_due,'YYYY-MM-DD') AS pay_due, d.pay_method, d.iva_applied, d.planned_sub, d.planned_iva, d.planned_total,
  d.include_finance, d.status, d.exec_status, d.post_status, d.ceo_pre_required, d.threshold_at_submit, d.basis_at_submit,
  d.actual_total, to_char(d.exec_date,'YYYY-MM-DD') AS exec_date, d.exec_pay_method, d.exec_memo, d.exec_at, d.exec_by,
  d.created_at, d.submitted_at, d.approved_at, d.closed_at,
  d.currency, d.fx_rate, to_char(d.fx_date,'YYYY-MM-DD') AS fx_date, d.fx_source, d.fx_locked_at,
  d.orig_sub, d.orig_iva, d.orig_total, d.payment_type, d.payment_plan`;
const PAY_COLS = `id, document_id, seq, to_char(due_date,'YYYY-MM-DD') AS due_date, planned_amount, planned_mxn, status,
  actual_amount, actual_mxn, fx_rate, to_char(fx_date,'YYYY-MM-DD') AS fx_date, to_char(exec_date,'YYYY-MM-DD') AS exec_date,
  pay_method, memo, exec_at, exec_by, skip_reason`;

const LINE_COLS = 'id, document_id, step_order, step_type, user_id, status, acted_at, comment';

function normDoc(r) {
  if (!r) return r;
  const o = { ...r };
  for (const k of ['id', 'version', 'parent_id', 'category_id', 'drafter_id', 'exec_by']) o[k] = o[k] == null ? null : Number(o[k]);
  for (const k of ['planned_sub', 'planned_iva', 'planned_total', 'threshold_at_submit', 'actual_total', 'fx_rate', 'orig_sub', 'orig_iva', 'orig_total']) o[k] = o[k] == null ? null : Number(o[k]);
  if ('payment_plan' in o) { try { o.payment_plan = o.payment_plan ? JSON.parse(o.payment_plan) : null; } catch { o.payment_plan = null; } }
  if (o.currency == null) o.currency = 'MXN';
  if (o.payment_type == null) o.payment_type = 'once';
  return o;
}
const normPay = (p) => {
  const o = { ...p };
  for (const k of ['id', 'document_id', 'seq', 'exec_by']) o[k] = o[k] == null ? null : Number(o[k]);
  for (const k of ['planned_amount', 'planned_mxn', 'actual_amount', 'actual_mxn', 'fx_rate']) o[k] = o[k] == null ? null : Number(o[k]);
  return o;
};
async function loadPayments(q, docId) {
  return (await q(`SELECT ${PAY_COLS} FROM approval_payments WHERE document_id=$1 ORDER BY seq`, [docId])).rows.map(normPay);
}
const normLine = (l) => ({ ...l, id: Number(l.id), document_id: Number(l.document_id), step_order: Number(l.step_order), user_id: Number(l.user_id) });
const normViewer = (v) => ({ document_id: Number(v.document_id), user_id: Number(v.user_id), kind: v.kind });

function normSettings(r) {
  const s = r || {};
  const id = (v) => (v == null ? null : Number(v));
  return {
    ceo_pre_threshold: n(s.ceo_pre_threshold ?? 100000),
    threshold_basis: s.threshold_basis === 'sub' ? 'sub' : 'total',
    variance_tolerance_pct: n(s.variance_tolerance_pct ?? 10),
    ceo_user_id: id(s.ceo_user_id), director_user_id: id(s.director_user_id), finance_user_id: id(s.finance_user_id),
    updated_at: s.updated_at || null, updated_by: id(s.updated_by),
  };
}

async function loadSettings(q) {
  return normSettings((await q(`SELECT * FROM approval_settings WHERE id=1`)).rows[0]);
}
async function loadUsers(q) {
  const rows = (await q(`SELECT id, name, role, dept, deleted_at FROM users ORDER BY name`)).rows;
  const map = new Map(rows.map((u) => [Number(u.id), { id: Number(u.id), name: u.name, role: u.role, dept: u.dept, active: !u.deleted_at }]));
  return map;
}
async function loadBundle(q, id, lock = false) {
  const doc = normDoc((await q(`SELECT ${DOC_COLS}, d.body, d.body_rich, d.deleted_at FROM approval_documents d WHERE d.id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0]);
  if (!doc || doc.deleted_at) return null;
  const lines = (await q(`SELECT ${LINE_COLS} FROM approval_lines WHERE document_id=$1 ORDER BY step_order, id`, [id])).rows.map(normLine);
  const viewers = (await q(`SELECT document_id, user_id, kind FROM approval_viewers WHERE document_id=$1`, [id])).rows.map(normViewer);
  return { doc, lines, viewers };
}

async function notify(q, userId, docId, kind, memo, actorId) {
  if (userId == null || sameId(userId, actorId)) return;
  await q(`INSERT INTO approval_notifications(user_id, document_id, kind, memo) VALUES ($1,$2,$3,$4)`,
    [userId, docId, kind, memo ? String(memo).slice(0, 300) : null]);
}
async function event(q, docId, actorId, action, stepType, detail) {
  await q(`INSERT INTO approval_events(document_id, actor_id, action, step_type, detail) VALUES ($1,$2,$3,$4,$5)`,
    [docId, actorId, action, stepType || null, detail || null]);
}

function mxYear(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric' }).format(d));
}
function mxMonth(t) {
  if (!t) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit' }).format(new Date(t)).slice(0, 7);
}
const cleanText = (v, max = 5000) => (v == null ? null : String(v).replace(/\u0000/g, '').slice(0, max));

// ── 환율 ─────────────────────────────────────────────────────────────
//   재무 › 환율(fx.js · fx_rates)을 그대로 쓴다. fx_rates 는 날짜별로 한 번 받아 캐시하고 지난 날짜는 다시 받지 않는다.
//   문서: 상신 시 그날 환율을 문서에 고정(fx_locked_at) — 이후 절대 다시 계산하지 않는다.
//   회차 집행: 지급일(exec_date) 환율을 회차에 고정.
async function rateToday() {
  const r = await getUsdMxnRate();      // { rate, asOf, stale, source }
  return { rate: n(r.rate), date: r.asOf || null, source: r.source || null, stale: !!r.stale };
}
async function rateOn(q, ymd) {
  const today = new Date().toISOString().slice(0, 10);             // fx.js 캐시 키와 같은 기준(UTC 날짜)
  if (!ymd || ymd >= today) return rateToday();
  const row = (await q(
    `SELECT rate, to_char(rate_date,'YYYY-MM-DD') AS d, source FROM fx_rates
      WHERE base='USD' AND quote='MXN' AND rate_date <= $1 ORDER BY rate_date DESC LIMIT 1`, [ymd])).rows[0];
  if (row) return { rate: n(row.rate), date: row.d, source: row.source, stale: row.d !== ymd };
  return rateToday();
}
// 문서 환율: MXN=1 · 이미 고정됐으면 그 값 · 아니면 오늘 환율(미리보기, 고정 아님)
async function docRate(doc) {
  if (doc.currency !== 'USD') return { rate: 1, date: null, source: null, locked: false };
  if (doc.fx_locked_at) return { rate: n(doc.fx_rate), date: doc.fx_date, source: doc.fx_source, locked: true };
  return { ...(await rateToday()), locked: false };
}
// 원통화 금액·회차 → MXN 반영(임시저장·상신 공용). lock=true 면 오늘 환율을 문서에 고정.
async function applyMoney(q, docId, { lock = false } = {}) {
  const doc = normDoc((await q(`SELECT ${DOC_COLS} FROM approval_documents d WHERE d.id=$1`, [docId])).rows[0]);
  let fx = await docRate(doc);
  if (lock && doc.currency === 'USD' && !fx.locked) {
    if (fx.source === 'default' || !(fx.rate > 0)) throw new Stop('fx_unavailable');
    await q(`UPDATE approval_documents SET fx_rate=$2, fx_date=$3, fx_source=$4, fx_locked_at=now() WHERE id=$1`,
      [docId, fx.rate, fx.date, fx.source]);
    fx = { ...fx, locked: true };
  }
  const mx = toMxn(doc, fx.rate);
  await q(`UPDATE approval_documents SET planned_sub=$2, planned_iva=$3, planned_total=$4, fx_rate=$5 WHERE id=$1`,
    [docId, mx.planned_sub, mx.planned_iva, mx.planned_total, fx.rate]);
  const pays = await loadPayments(q, docId);
  const mxn = paymentsMxn(pays.map((p) => p.planned_amount), fx.rate, mx.planned_total);
  for (const [i, p] of pays.entries()) await q(`UPDATE approval_payments SET planned_mxn=$2 WHERE id=$1`, [p.id, mxn[i]]);
  return { ...mx, fx };
}

// 다음 단계 활성화 + 승인완료 처리(알림 포함). lines 는 DB 행과 같은 객체(id 보유).
async function applyAdvance(q, bundle, actorId, settings) {
  const { doc, lines, viewers } = bundle;
  const res = advance(lines);
  for (const l of res.activated) {
    await q(`UPDATE approval_lines SET status='pending' WHERE id=$1`, [l.id]);
    await notify(q, l.user_id, doc.id, REQUEST_KIND[l.step_type], null, actorId);
  }
  if (res.approved) {
    await q(`UPDATE approval_documents SET status='approved', exec_status='pending', approved_at=now(), updated_at=now() WHERE id=$1`, [doc.id]);
    doc.status = 'approved'; doc.exec_status = 'pending';
    await event(q, doc.id, null, 'approved', null, '결재 완료 · 집행대기');
    await notify(q, doc.drafter_id, doc.id, '승인완료', null, actorId);
    for (const v of viewers) if (v.kind === 'share') await notify(q, v.user_id, doc.id, '공람', null, actorId);
    const fin = settings.finance_user_id
      ? [settings.finance_user_id]
      : (await q(`SELECT id FROM users WHERE role='treasury' AND deleted_at IS NULL`)).rows.map((r) => Number(r.id));
    for (const u of fin) await notify(q, u, doc.id, '집행 대기', null, actorId);
  }
  return res;
}

const ERR = {
  not_found: 404, forbidden: 403, not_your_turn: 409, bad_state: 409, memo_required: 400, bad_input: 400,
  director_unset: 409, ceo_unset: 409, exec_evidence_required: 400, director_only: 403, fx_unavailable: 409,
};
function fail(reply, code, extra) {
  return reply.code(ERR[code] || 400).send({ error: code, ...(extra || {}) });
}
class Stop extends Error { constructor(code, extra) { super(code); this.code = code; this.extra = extra; } }
async function tx(reply, fn) {
  try { return await withTx((c) => fn(c.query.bind(c))); }
  catch (e) { if (e instanceof Stop) return fail(reply, e.code, e.extra); throw e; }
}

export default async function approvalRoutes(app) {
  const guard = { preHandler: [authGuard] };
  const ctxOf = (req, settings) => roleCtx(req.ctx.perm, settings);

  // ── 첫 화면 데이터: 나 · 설정 · 카테고리/템플릿 · 사용자 목록 · 배지 ─────────
  app.get('/api/approvals/bootstrap', guard, async (req) => {
    const settings = await loadSettings(query);
    const ctx = ctxOf(req, settings);
    const users = await loadUsers(query);
    const cats = (await query(`SELECT id, name, sort_order, active FROM approval_categories ORDER BY sort_order, id`)).rows;
    const steps = (await query(`SELECT id, category_id, step_order, step_type, user_id FROM approval_category_steps ORDER BY step_order, id`)).rows;
    const unread = Number((await query(`SELECT count(*)::int AS c FROM approval_notifications WHERE user_id=$1 AND read_at IS NULL`, [ctx.uid])).rows[0].c);
    const log = (await query(`SELECT changed_at, changed_by, detail FROM approval_settings_log ORDER BY changed_at DESC, id DESC LIMIT 50`)).rows;
    return {
      me: { id: ctx.uid, name: req.ctx.perm.name, role: ctx.role, isDirector: ctx.isDirector, isCeo: ctx.isCeo, isFinance: ctx.isFinance },
      settings,
      settings_log: log.map((r) => ({ at: r.changed_at, by: r.changed_by == null ? null : Number(r.changed_by), detail: r.detail })),
      categories: cats.map((c) => ({
        id: Number(c.id), name: c.name, sort_order: Number(c.sort_order), active: c.active,
        steps: steps.filter((s) => sameId(s.category_id, c.id)).map((s) => ({ id: Number(s.id), step_order: Number(s.step_order), step_type: s.step_type, user_id: Number(s.user_id) })),
      })),
      users: [...users.values()],
      kinds: KINDS, exec_kinds: EXEC_KINDS, pay_methods: PAY_METHODS, step_label: STEP_LABEL,
      currencies: CURRENCIES, payment_types: PAYMENT_TYPE_LABEL, freqs: FREQS, schedule_max: SCHEDULE_MAX,
      file_max_bytes: APPROVAL_FILE_MAX_BYTES,
      unread,
    };
  });

  // ── 게시판 목록 ──────────────────────────────────────────────────────
  app.get('/api/approvals', guard, async (req) => {
    const settings = await loadSettings(query);
    const ctx = ctxOf(req, settings);
    const users = await loadUsers(query);
    const docs = (await query(`SELECT ${DOC_COLS} FROM approval_documents d WHERE d.deleted_at IS NULL`)).rows.map(normDoc);
    const lines = (await query(`SELECT ${LINE_COLS} FROM approval_lines`)).rows.map(normLine);
    const viewers = (await query(`SELECT document_id, user_id, kind FROM approval_viewers`)).rows.map(normViewer);
    const files = (await query(`SELECT document_id, kind, voided_at, dup_of FROM approval_files`)).rows;
    const cmts = (await query(`SELECT document_id, count(*)::int AS c FROM approval_comments WHERE deleted_at IS NULL GROUP BY document_id`)).rows;
    const payRows = (await query(`SELECT document_id, status, to_char(due_date,'YYYY-MM-DD') AS due_date FROM approval_payments`)).rows;
    const unreadDocs = new Set((await query(`SELECT DISTINCT document_id FROM approval_notifications WHERE user_id=$1 AND read_at IS NULL`, [ctx.uid])).rows.map((r) => Number(r.document_id)));
    const group = (arr, key = 'document_id') => { const m = new Map(); for (const x of arr) { const k = Number(x[key]); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
    const L = group(lines), V = group(viewers), F = group(files), P = group(payRows);
    const C = new Map(cmts.map((r) => [Number(r.document_id), Number(r.c)]));
    const uname = (id) => (users.get(Number(id)) || {}).name || '—';
    const items = [];
    for (const d of docs) {
      const ls = L.get(d.id) || [], vs = V.get(d.id) || [], fs = F.get(d.id) || [];
      if (!canSeeDoc(ctx, d, ls, vs)) continue;
      const pl = postLine(ls);
      const pend = ls.filter((l) => l.status === 'pending' && l.step_type !== 'post_ceo');
      let current = null;
      if (d.status === 'progress') current = pend.map((l) => uname(l.user_id) + (l.step_type === 'pre_ceo' ? ' (사전)' : '')).join(', ');
      else if (d.status === 'approved' && d.exec_status === 'pending') current = '재무 (집행)';
      else if (d.post_status === 'pending' && pl) current = uname(pl.user_id) + ' (사후)';
      else if (d.post_status === 'flagged') current = uname(d.drafter_id) + ' (소명)';
      const live = fs.filter((f) => !f.voided_at);
      const ps = P.get(d.id) || [];
      const open = ps.filter((x) => x.status === 'planned').map((x) => x.due_date).filter(Boolean).sort();
      items.push({
        pay_n: ps.length, pay_done: ps.filter((x) => x.status !== 'planned').length, next_due: open[0] || null,
        ...d,
        drafter_name: uname(d.drafter_id),
        stage: stageKey(d, ls),
        todo: isTodo(ctx, d, ls),
        is_ref: vs.some((v) => sameId(v.user_id, ctx.uid)),
        current,
        files_n: live.length,
        has_exec_evidence: live.some((f) => EXEC_KINDS.includes(f.kind)),
        dup: live.some((f) => f.dup_of),
        comments_n: C.get(d.id) || 0,
        variance_pct: variancePct(d),
        director_no_finance: d.status !== 'draft' && ls.some((l) => l.step_type === 'director' && sameId(l.user_id, d.drafter_id))
          && !ls.some((l) => l.step_type === 'agree' && sameId(l.user_id, settings.finance_user_id)),
        unread: unreadDocs.has(d.id),
      });
    }
    items.sort((a, b) => String(b.submitted_at || b.created_at).localeCompare(String(a.submitted_at || a.created_at)));
    return { items };
  });

  // ── 상세 ─────────────────────────────────────────────────────────────
  async function detail(req, id) {
    const settings = await loadSettings(query);
    const ctx = ctxOf(req, settings);
    const b = await loadBundle(query, id);
    if (!b || !canSeeDoc(ctx, b.doc, b.lines, b.viewers)) return null;
    const priv = ctx.isDirector || ctx.isCeo;
    const files = (await query(
      `SELECT id, comment_id, payment_id, kind, stage, file_name, mime_type, file_size, sha256, cfdi_uuid, cfdi_rfc, cfdi_total, dup_of,
              uploaded_by, uploaded_at, voided_at, voided_by, void_reason
         FROM approval_files WHERE document_id=$1 ORDER BY uploaded_at, id`, [id])).rows.map((f) => ({
      ...f, id: Number(f.id), comment_id: f.comment_id == null ? null : Number(f.comment_id),
      payment_id: f.payment_id == null ? null : Number(f.payment_id), file_size: Number(f.file_size),
      cfdi_total: f.cfdi_total == null ? null : Number(f.cfdi_total), uploaded_by: Number(f.uploaded_by),
      voided_by: f.voided_by == null ? null : Number(f.voided_by),
    }));
    const comments = (await query(
      `SELECT id, author_id, body, created_at, edited_at, edited_by, deleted_at, deleted_by
         FROM approval_comments WHERE document_id=$1 ORDER BY created_at, id`, [id])).rows;
    const hist = priv ? (await query(
      `SELECT h.comment_id, h.old_body, h.replaced_at, h.replaced_by FROM approval_comment_history h
         JOIN approval_comments c ON c.id=h.comment_id WHERE c.document_id=$1 ORDER BY h.replaced_at, h.id`, [id])).rows : [];
    const events = (await query(
      `SELECT id, actor_id, action, step_type, detail, created_at FROM approval_events WHERE document_id=$1 ORDER BY created_at, id`, [id])).rows;
    const links = (await query(
      `SELECT l.linked_document_id AS id, d.doc_no, d.title FROM approval_links l JOIN approval_documents d ON d.id=l.linked_document_id
        WHERE l.document_id=$1 ORDER BY l.created_at`, [id])).rows.map((r) => ({ id: Number(r.id), doc_no: r.doc_no, title: r.title }));
    const parent = b.doc.parent_id ? (await query(`SELECT id, doc_no FROM approval_documents WHERE id=$1`, [b.doc.parent_id])).rows[0] : null;
    await query(`UPDATE approval_notifications SET read_at=now() WHERE user_id=$1 AND document_id=$2 AND read_at IS NULL`, [ctx.uid, id]);
    const payments = await loadPayments(query, id);
    const rich = normalizeBodyRich(b.doc.body_rich ?? null, b.doc.body);
    const { body_rich: _raw, ...docOut } = b.doc;
    return {
      doc: { ...docOut, stage: stageKey(b.doc, b.lines), variance_pct: variancePct(b.doc), parent_no: parent ? parent.doc_no : null },
      body_nodes: rich.ok ? rich.nodes : [{ t: 'p', v: b.doc.body || '' }],
      payments,
      lines: b.lines,
      viewers: b.viewers,
      files: files.map((f) => ({ ...f, can_delete: canDeleteFile(ctx, b.doc, f), can_void: canVoidFile(ctx, b.doc, f) })),
      comments: comments.map((c) => {
        const cid = Number(c.id);
        const del = !!c.deleted_at;
        return {
          id: cid, author_id: Number(c.author_id), created_at: c.created_at,
          body: del && !priv ? null : c.body,
          edited_at: c.edited_at, edited_by: c.edited_by == null ? null : Number(c.edited_by),
          deleted_at: c.deleted_at, deleted_by: c.deleted_by == null ? null : Number(c.deleted_by),
          history: priv ? hist.filter((h) => sameId(h.comment_id, cid)).map((h) => ({ body: h.old_body, at: h.replaced_at, by: h.replaced_by == null ? null : Number(h.replaced_by) })) : [],
        };
      }),
      events: events.map((e) => ({ ...e, id: Number(e.id), actor_id: e.actor_id == null ? null : Number(e.actor_id) })),
      links,
      actions: allowedActions(ctx, b.doc, b.lines),
      can_comment: b.doc.status !== 'draft',
      can_upload: b.doc.status !== 'draft' || sameId(b.doc.drafter_id, ctx.uid),
      priv,
    };
  }
  app.get('/api/approvals/:id', guard, async (req, reply) => {
    const r = await detail(req, Number(req.params.id));
    if (!r) return fail(reply, 'not_found');
    return r;
  });

  // ── 임시저장(생성/수정) · 삭제 ─────────────────────────────────────────
  // 임시저장 입력 → 원통화 금액 · 결제 방식 일정 · 본문(문단+그림)
  //   금액은 문서 통화(orig_*) 로 받는다(구 클라이언트 planned_sub 도 허용). MXN 환산은 applyMoney.
  function draftFields(body) {
    const b = body || {};
    const title = cleanText(b.title, 200);
    if (!title || !title.trim()) return { error: 'title_required' };
    const currency = CURRENCIES.includes(b.currency) ? b.currency : 'MXN';
    const ptype = PAYMENT_TYPES.includes(b.payment_type) ? b.payment_type : 'once';
    const iva = b.iva_applied !== false;
    const plan = b.payment_plan && typeof b.payment_plan === 'object' ? b.payment_plan : null;
    let sub = round2(b.orig_sub ?? b.planned_sub);
    if (ptype === 'recurring' && plan && plan.per_sub != null) sub = round2(n(plan.per_sub) * n(plan.count));
    if (sub < 0) return { error: 'bad_amount' };
    const amt = calcAmounts(sub, iva);
    const sch = buildSchedule({ type: ptype, total: amt.planned_total, pay_due: b.pay_due, plan, rows: b.schedule });
    if (sch.error) return { error: sch.error };
    const rich = normalizeBodyRich(b.body_rich ?? null, b.body);
    if (!rich.ok) return { error: rich.error };
    return {
      category_id: b.category_id ? Number(b.category_id) : null,
      title: title.trim(),
      vendor: cleanText(b.vendor, 200),
      body: rich.plain,
      body_rich: rich.nodes.length ? JSON.stringify(rich.nodes) : null,
      pay_due: sch.rows[0].due_date || (isYmd(b.pay_due) ? b.pay_due : null),
      pay_method: PAY_METHODS.includes(b.pay_method) ? b.pay_method : '계좌이체',
      iva_applied: iva,
      include_finance: b.include_finance !== false,
      currency, payment_type: ptype,
      payment_plan: sch.plan ? JSON.stringify(sch.plan) : null,
      orig_sub: amt.planned_sub, orig_iva: amt.planned_iva, orig_total: amt.planned_total,
      schedule: sch.rows,
      refs: Array.isArray(b.refs) ? [...new Set(b.refs.map(Number).filter(Boolean))] : [],
      shares: Array.isArray(b.shares) ? [...new Set(b.shares.map(Number).filter(Boolean))] : [],
    };
  }
  async function saveViewers(q, docId, drafterId, f) {
    await q(`DELETE FROM approval_viewers WHERE document_id=$1`, [docId]);
    for (const [kind, arr] of [['ref', f.refs], ['share', f.shares]]) {
      for (const u of arr) {
        if (sameId(u, drafterId)) continue;
        await q(`INSERT INTO approval_viewers(document_id, user_id, kind) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [docId, u, kind]);
      }
    }
  }
  // 임시저장 문서의 회차를 새 일정으로 교체(집행 전이라 안전)
  async function saveSchedule(q, docId, rows) {
    await q(`DELETE FROM approval_payments WHERE document_id=$1`, [docId]);
    for (const r of rows) {
      await q(`INSERT INTO approval_payments(document_id, seq, due_date, planned_amount, planned_mxn) VALUES ($1,$2,$3,$4,$4)`,
        [docId, r.seq, r.due_date, r.amount]);
    }
  }
  const DRAFT_SET = `category_id=$2, title=$3, vendor=$4, body=$5, body_rich=$6, pay_due=$7, pay_method=$8, iva_applied=$9,
    include_finance=$10, currency=$11, payment_type=$12, payment_plan=$13, orig_sub=$14, orig_iva=$15, orig_total=$16`;
  const draftArgs = (id, f) => [id, f.category_id, f.title, f.vendor, f.body, f.body_rich, f.pay_due, f.pay_method, f.iva_applied,
    f.include_finance, f.currency, f.payment_type, f.payment_plan, f.orig_sub, f.orig_iva, f.orig_total];
  const docGuard = { preHandler: [authGuard], bodyLimit: APPROVAL_DOC_BODY_LIMIT };   // 본문 그림 포함
  app.post('/api/approvals', docGuard, async (req, reply) => {
    const f = draftFields(req.body);
    if (f.error) return fail(reply, 'bad_input', { detail: f.error });
    const uid = Number(req.ctx.perm.userId);
    return tx(reply, async (q) => {
      const id = Number((await q(`INSERT INTO approval_documents(title, drafter_id) VALUES ($1,$2) RETURNING id`, [f.title, uid])).rows[0].id);
      await q(`UPDATE approval_documents SET ${DRAFT_SET} WHERE id=$1`, draftArgs(id, f));
      await saveSchedule(q, id, f.schedule);
      await saveViewers(q, id, uid, f);
      const m = await applyMoney(q, id);
      return { id, planned_total: m.planned_total, fx: m.fx };
    });
  });
  app.put('/api/approvals/:id', docGuard, async (req, reply) => {
    const f = draftFields(req.body);
    if (f.error) return fail(reply, 'bad_input', { detail: f.error });
    const id = Number(req.params.id), uid = Number(req.ctx.perm.userId);
    return tx(reply, async (q) => {
      const b = await loadBundle(q, id, true);
      if (!b || !sameId(b.doc.drafter_id, uid)) throw new Stop('not_found');
      if (b.doc.status !== 'draft') throw new Stop('bad_state');
      await q(`UPDATE approval_documents SET ${DRAFT_SET}, updated_at=now() WHERE id=$1`, draftArgs(id, f));
      await saveSchedule(q, id, f.schedule);
      await saveViewers(q, id, uid, f);
      const m = await applyMoney(q, id);
      return { id, planned_total: m.planned_total, fx: m.fx };
    });
  });
  app.delete('/api/approvals/:id', guard, async (req, reply) => {
    const id = Number(req.params.id), uid = Number(req.ctx.perm.userId);
    return tx(reply, async (q) => {
      const b = await loadBundle(q, id, true);
      if (!b || !sameId(b.doc.drafter_id, uid)) throw new Stop('not_found');
      if (b.doc.status !== 'draft' || b.doc.doc_no) throw new Stop('bad_state');   // 번호 받은 문서는 삭제 대신 보관
      await q(`UPDATE approval_documents SET deleted_at=now() WHERE id=$1`, [id]);
      return { ok: true };
    });
  });

  // ── 상신 ─────────────────────────────────────────────────────────────
  app.post('/api/approvals/:id/submit', guard, async (req, reply) => {
    const id = Number(req.params.id), uid = Number(req.ctx.perm.userId);
    return tx(reply, async (q) => {
      const settings = await loadSettings(q);
      const b = await loadBundle(q, id, true);
      if (!b || !sameId(b.doc.drafter_id, uid)) throw new Stop('not_found');
      if (b.doc.status !== 'draft') throw new Stop('bad_state');
      if (!b.doc.category_id) throw new Stop('bad_input', { detail: 'category_required' });
      if (!(n(b.doc.orig_sub ?? b.doc.planned_sub) > 0)) throw new Stop('bad_input', { detail: 'amount_required' });
      if (!(await loadPayments(q, id)).length) {                    // 0237 이전에 만든 임시저장 — 일시불 1회로
        await saveSchedule(q, id, [{ seq: 1, due_date: b.doc.pay_due, amount: n(b.doc.orig_total ?? b.doc.planned_total) }]);
      }
      // 환율 고정(USD) → MXN 확정 → 기준액·결재선은 확정된 MXN 으로 판단
      const money = await applyMoney(q, id, { lock: true });
      Object.assign(b.doc, { planned_sub: money.planned_sub, planned_iva: money.planned_iva, planned_total: money.planned_total });
      const cat = (await q(`SELECT id, active FROM approval_categories WHERE id=$1`, [b.doc.category_id])).rows[0];
      if (!cat) throw new Stop('bad_input', { detail: 'category_missing' });
      const steps = (await q(`SELECT id, step_order, step_type, user_id FROM approval_category_steps WHERE category_id=$1`, [b.doc.category_id])).rows;
      const built = buildLines({ drafterId: uid, drafterIsDirector: req.ctx.perm.role === 'director', catSteps: steps, doc: b.doc }, settings);
      if (built.error) throw new Stop(built.error);
      let no = b.doc.doc_no;
      if (!no) {
        const year = mxYear();
        const r = (await q(
          `INSERT INTO approval_doc_seq(year, last_no) VALUES ($1, 1)
           ON CONFLICT (year) DO UPDATE SET last_no = approval_doc_seq.last_no + 1 RETURNING last_no`, [year])).rows[0];
        no = docNo(year, Number(r.last_no));
      }
      await q(`DELETE FROM approval_lines WHERE document_id=$1`, [id]);
      const lines = [];
      for (const l of built.lines) {
        const row = (await q(
          `INSERT INTO approval_lines(document_id, step_order, step_type, user_id, status, acted_at, comment)
           VALUES ($1,$2,$3,$4,$5, CASE WHEN $5='done' THEN now() ELSE NULL END, $6) RETURNING ${LINE_COLS}`,
          [id, l.step_order, l.step_type, l.user_id, l.status, l.comment])).rows[0];
        lines.push(normLine(row));
      }
      await q(`UPDATE approval_documents SET doc_no=$2, status='progress', exec_status='none', post_status='none',
                 ceo_pre_required=$3, threshold_at_submit=$4, basis_at_submit=$5, submitted_at=now(), approved_at=NULL,
                 updated_at=now() WHERE id=$1`,
        [id, no, built.ceoPre, settings.ceo_pre_threshold, settings.threshold_basis]);
      b.doc.status = 'progress'; b.doc.doc_no = no;
      const fxNote = b.doc.currency === 'USD'
        ? `USD ${n(b.doc.orig_total).toFixed(2)} × ${money.fx.rate} (${money.fx.date || '—'} 환율 고정) = MXN ${money.planned_total.toFixed(2)}` : null;
      await event(q, id, uid, 'submit', 'draft',
        [built.ceoPre ? `사전승인 대상 (기준액 ${settings.ceo_pre_threshold})` : null, fxNote].filter(Boolean).join('\n') || null);
      for (const v of b.viewers) if (v.kind === 'ref') await notify(q, v.user_id, id, '참조', null, uid);
      await applyAdvance(q, { doc: b.doc, lines, viewers: b.viewers }, uid, settings);
      return { id, doc_no: no };
    });
  });

  // ── 결재 행위: 승인/합의/경유 확인/사전승인/사후승인 확인 · 반려/반대 ─────────
  app.post('/api/approvals/:id/act', guard, async (req, reply) => {
    const id = Number(req.params.id);
    const action = req.body?.action;
    const comment = cleanText(req.body?.comment, 2000)?.trim() || null;
    if (!['approve', 'reject'].includes(action)) return fail(reply, 'bad_input');
    return tx(reply, async (q) => {
      const settings = await loadSettings(q);
      const ctx = ctxOf(req, settings);
      const b = await loadBundle(q, id, true);
      if (!b || !canSeeDoc(ctx, b.doc, b.lines, b.viewers)) throw new Stop('not_found');
      const mine = myPending(ctx, b.lines);
      if (!mine) throw new Stop('not_your_turn');
      const isPost = mine.step_type === 'post_ceo';
      if (isPost ? !(b.doc.status === 'approved' && b.doc.post_status === 'pending') : b.doc.status !== 'progress') throw new Stop('bad_state');
      if (action === 'reject') {
        if (isPost || mine.step_type === 'pass') throw new Stop('bad_state');
        if (!comment) throw new Stop('memo_required');
        await q(`UPDATE approval_lines SET status='rejected', acted_at=now(), comment=$2 WHERE id=$1`, [mine.id, comment]);
        await q(`UPDATE approval_lines SET status='skipped' WHERE document_id=$1 AND status IN ('waiting','pending')`, [id]);
        await q(`UPDATE approval_documents SET status='rejected', updated_at=now() WHERE id=$1`, [id]);
        await event(q, id, ctx.uid, mine.step_type === 'agree' ? 'disagree' : 'reject', mine.step_type, comment);
        await notify(q, b.doc.drafter_id, id, mine.step_type === 'agree' ? '반대 (반려)' : '반려', comment, ctx.uid);
        return { ok: true, status: 'rejected' };
      }
      await q(`UPDATE approval_lines SET status='done', acted_at=now(), comment=$2 WHERE id=$1`, [mine.id, comment]);
      mine.status = 'done';
      if (isPost) {
        await q(`UPDATE approval_documents SET post_status='confirmed', closed_at=now(), updated_at=now() WHERE id=$1`, [id]);
        await event(q, id, ctx.uid, 'post_confirm', 'post_ceo', comment);
        await notify(q, b.doc.drafter_id, id, '사후승인 확인', null, ctx.uid);
        return { ok: true, status: 'closed' };
      }
      await event(q, id, ctx.uid, { agree: 'agree', pass: 'pass' }[mine.step_type] || 'approve', mine.step_type, comment);
      const r = await applyAdvance(q, b, ctx.uid, settings);
      return { ok: true, status: r.approved ? 'approved' : 'progress' };
    });
  });

  // 사후승인 일괄 확인(대표이사)
  app.post('/api/approvals/post-bulk', guard, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(Boolean))] : [];
    if (!ids.length || ids.length > 200) return fail(reply, 'bad_input');
    return tx(reply, async (q) => {
      const settings = await loadSettings(q);
      const ctx = ctxOf(req, settings);
      const done = [], skipped = [];
      for (const id of ids) {
        const b = await loadBundle(q, id, true);
        const mine = b && myPending(ctx, b.lines);
        if (!b || !mine || mine.step_type !== 'post_ceo' || b.doc.post_status !== 'pending') { skipped.push(id); continue; }
        await q(`UPDATE approval_lines SET status='done', acted_at=now(), comment='일괄 확인' WHERE id=$1`, [mine.id]);
        await q(`UPDATE approval_documents SET post_status='confirmed', closed_at=now(), updated_at=now() WHERE id=$1`, [id]);
        await event(q, id, ctx.uid, 'post_confirm', 'post_ceo', '일괄 확인');
        await notify(q, b.doc.drafter_id, id, '사후승인 확인', null, ctx.uid);
        done.push(id);
      }
      return { done, skipped };
    });
  });

  // 이의제기(사후승인 단계)
  app.post('/api/approvals/:id/flag', guard, async (req, reply) => {
    const id = Number(req.params.id);
    const memo = cleanText(req.body?.memo, 2000)?.trim();
    if (!memo) return fail(reply, 'memo_required');
    return tx(reply, async (q) => {
      const settings = await loadSettings(q);
      const ctx = ctxOf(req, settings);
      const b = await loadBundle(q, id, true);
      if (!b) throw new Stop('not_found');
      const mine = myPending(ctx, b.lines);
      if (!mine || mine.step_type !== 'post_ceo' || b.doc.post_status !== 'pending') throw new Stop('not_your_turn');
      await q(`UPDATE approval_lines SET status='flagged', acted_at=now(), comment=$2 WHERE id=$1`, [mine.id, memo]);
      await q(`UPDATE approval_documents SET post_status='flagged', updated_at=now() WHERE id=$1`, [id]);
      await event(q, id, ctx.uid, 'flag', 'post_ceo', memo);
      await notify(q, b.doc.drafter_id, id, '이의제기', memo, ctx.uid);
      if (settings.director_user_id) await notify(q, settings.director_user_id, id, '이의제기', memo, ctx.uid);
      return { ok: true };
    });
  });
  // 이의 종결 · 사후승인 확인
  app.post('/api/approvals/:id/close-flag', guard, async (req, reply) => {
    const id = Number(req.params.id);
    const memo = cleanText(req.body?.memo, 2000)?.trim() || '이의 종결 · 사후승인 확인';
    return tx(reply, async (q) => {
      const settings = await loadSettings(q);
      const ctx = ctxOf(req, settings);
      const b = await loadBundle(q, id, true);
      if (!b) throw new Stop('not_found');
      const pl = postLine(b.lines);
      if (!pl || !sameId(pl.user_id, ctx.uid) || b.doc.post_status !== 'flagged') throw new Stop('not_your_turn');
      await q(`UPDATE approval_lines SET status='done', acted_at=now(), comment=$2 WHERE id=$1`, [pl.id, memo]);
      await q(`UPDATE approval_documents SET post_status='confirmed', closed_at=now(), updated_at=now() WHERE id=$1`, [id]);
      await event(q, id, ctx.uid, 'close_flag', 'post_ceo', memo);
      await notify(q, b.doc.drafter_id, id, '사후승인 확인', null, ctx.uid);
      return { ok: true };
    });
  });

  // ── 집행 처리(재무) — 실적 증빙(Factura·송금증) 1건 이상 필요 ───────────────
  // ── 집행(재무) — 회차 단위 ────────────────────────────────────────────
  //   · 실적은 문서 통화로 입력. USD 는 지급일 환율로 MXN 환산해 그 회차에 고정.
  //   · 회차 증빙: 그 회차에 연결된 Factura·송금증 1건 이상(link_file_ids 로 기존 증빙 연결 가능).
  //     회차가 1개뿐인 문서는 문서에 붙은 실적 증빙도 인정(0234 방식 호환).
  //   · 모든 회차가 집행/중단되면 문서 집행완료 → 대표이사 사후승인 요청.
  async function finishIfAllPaid(q, b, ctx) {
    const pays = await loadPayments(q, b.doc.id);
    const done = pays.filter((p) => p.status === 'done');
    const actual = round2(done.reduce((s2, p) => s2 + n(p.actual_mxn), 0));
    if (pays.some((p) => p.status === 'planned')) {
      await q(`UPDATE approval_documents SET actual_total=$2, updated_at=now() WHERE id=$1`, [b.doc.id, actual]);
      return false;
    }
    const last = [...done].sort((a, c) => String(a.exec_date || '').localeCompare(String(c.exec_date || '')) || a.seq - c.seq).pop();
    await q(`UPDATE approval_documents SET exec_status='done', actual_total=$2, exec_date=$3, exec_pay_method=$4,
               exec_at=now(), exec_by=$5, post_status='pending', updated_at=now() WHERE id=$1`,
      [b.doc.id, actual, last ? last.exec_date : null, last ? last.pay_method : null, ctx.uid]);
    const pl = postLine(b.lines);
    if (pl) await q(`UPDATE approval_lines SET status='pending' WHERE id=$1`, [pl.id]);
    if (pays.length > 1) await event(q, b.doc.id, ctx.uid, 'exec_done', null, `전 회차 처리 완료 · 실적 합계 MXN ${actual.toFixed(2)}`);
    if (pl) await notify(q, pl.user_id, b.doc.id, '사후승인 요청', null, ctx.uid);
    await notify(q, b.doc.drafter_id, b.doc.id, '집행완료', null, ctx.uid);
    return true;
  }
  async function execPrelude(q, req, id) {
    const settings = await loadSettings(q);
    const ctx = ctxOf(req, settings);
    if (!ctx.isFinance && !ctx.isDirector) throw new Stop('forbidden');
    const b = await loadBundle(q, id, true);
    if (!b) throw new Stop('not_found');
    if (b.doc.status !== 'approved' || b.doc.exec_status !== 'pending') throw new Stop('bad_state');
    const pays = await loadPayments(q, id);
    return { ctx, b, pays };
  }
  app.post('/api/approvals/:id/execute', guard, async (req, reply) => {
    const id = Number(req.params.id);
    const amt = round2(req.body?.actual_amount ?? req.body?.actual_total);   // 문서 통화
    const date = req.body?.exec_date;
    const pay = PAY_METHODS.includes(req.body?.pay_method) ? req.body.pay_method : '계좌이체';
    const memo = cleanText(req.body?.memo, 2000)?.trim() || null;
    const linkIds = Array.isArray(req.body?.link_file_ids) ? req.body.link_file_ids.map(Number).filter(Boolean) : [];
    if (!(amt > 0) || !isYmd(date)) return fail(reply, 'bad_input');
    return tx(reply, async (q) => {
      const { ctx, b, pays } = await execPrelude(q, req, id);
      const pid = req.body?.payment_id ? Number(req.body.payment_id) : (pays.find((p) => p.status === 'planned') || {}).id;
      const row = pays.find((p) => p.id === pid);
      if (!row || row.status !== 'planned') throw new Stop('bad_state', { detail: 'payment_not_open' });
      for (const fid of linkIds) {
        await q(`UPDATE approval_files SET payment_id=$3 WHERE id=$1 AND document_id=$2 AND payment_id IS NULL AND voided_at IS NULL`, [fid, id, pid]);
      }
      const ev = (await q(`SELECT kind, payment_id FROM approval_files WHERE document_id=$1 AND voided_at IS NULL`, [id])).rows;
      const okEv = ev.some((f) => EXEC_KINDS.includes(f.kind) && (sameId(f.payment_id, pid) || (pays.length === 1 && f.payment_id == null)));
      if (!okEv) throw new Stop('exec_evidence_required');
      const fx = b.doc.currency === 'USD' ? await rateOn(q, date) : { rate: 1, date: null, source: null };
      if (b.doc.currency === 'USD' && (fx.source === 'default' || !(fx.rate > 0))) throw new Stop('fx_unavailable');
      const mxn = round2(amt * fx.rate);
      await q(`UPDATE approval_payments SET status='done', actual_amount=$2, actual_mxn=$3, fx_rate=$4, fx_date=$5, exec_date=$6,
                 pay_method=$7, memo=$8, exec_at=now(), exec_by=$9 WHERE id=$1`,
        [pid, amt, mxn, fx.rate, fx.date, date, pay, memo, ctx.uid]);
      const cur = b.doc.currency;
      const money = cur === 'USD' ? `USD ${amt.toFixed(2)} × ${fx.rate} (${fx.date || '—'}) = MXN ${mxn.toFixed(2)}` : `MXN ${amt.toFixed(2)}`;
      await event(q, id, ctx.uid, 'execute', null,
        `${pays.length > 1 ? `${row.seq}/${pays.length}회차 · ` : ''}실적 ${money} · ${pay} · 지급일 ${date}${memo ? '\n' + memo : ''}`);
      const finished = await finishIfAllPaid(q, b, ctx);
      return { ok: true, payment_id: pid, actual_mxn: mxn, fx, finished };
    });
  });
  // 남은 회차 중단(계약 종료 등) — 재무·디렉터. 사유 필수.
  app.post('/api/approvals/:id/payments/:pid/skip', guard, async (req, reply) => {
    const id = Number(req.params.id), pid = Number(req.params.pid);
    const reason = cleanText(req.body?.reason, 500)?.trim();
    if (!reason) return fail(reply, 'memo_required');
    return tx(reply, async (q) => {
      const { ctx, b, pays } = await execPrelude(q, req, id);
      const row = pays.find((p) => p.id === pid);
      if (!row || row.status !== 'planned') throw new Stop('bad_state', { detail: 'payment_not_open' });
      await q(`UPDATE approval_payments SET status='skipped', skip_reason=$2, exec_at=now(), exec_by=$3 WHERE id=$1`, [pid, reason, ctx.uid]);
      await event(q, id, ctx.uid, 'pay_skip', null, `${row.seq}/${pays.length}회차 중단 · ${reason}`);
      const finished = await finishIfAllPaid(q, b, ctx);
      return { ok: true, finished };
    });
  });

  // ── 회수 · 재기안 ─────────────────────────────────────────────────────
  app.post('/api/approvals/:id/withdraw', guard, async (req, reply) => {
    const id = Number(req.params.id);
    return tx(reply, async (q) => {
      const settings = await loadSettings(q);
      const ctx = ctxOf(req, settings);
      const b = await loadBundle(q, id, true);
      if (!b || !sameId(b.doc.drafter_id, ctx.uid)) throw new Stop('not_found');
      if (!allowedActions(ctx, b.doc, b.lines).includes('withdraw')) throw new Stop('bad_state');
      await q(`DELETE FROM approval_lines WHERE document_id=$1`, [id]);
      await q(`UPDATE approval_documents SET status='draft', ceo_pre_required=false, updated_at=now() WHERE id=$1`, [id]);
      await q(`DELETE FROM approval_notifications WHERE document_id=$1 AND read_at IS NULL AND kind LIKE '%요청'`, [id]);
      await event(q, id, ctx.uid, 'withdraw', null, '회수 · 임시저장으로 전환');
      return { ok: true };
    });
  });
  app.post('/api/approvals/:id/resubmit', guard, async (req, reply) => {
    const id = Number(req.params.id);
    return tx(reply, async (q) => {
      const settings = await loadSettings(q);
      const ctx = ctxOf(req, settings);
      const b = await loadBundle(q, id, true);
      if (!b || !sameId(b.doc.drafter_id, ctx.uid)) throw new Stop('not_found');
      if (b.doc.status !== 'rejected') throw new Stop('bad_state');
      const d = b.doc;
      const nid = Number((await q(
        `INSERT INTO approval_documents(version, parent_id, category_id, title, vendor, body, drafter_id, pay_due, pay_method,
           iva_applied, planned_sub, planned_iva, planned_total, include_finance,
           currency, orig_sub, orig_iva, orig_total, payment_type, payment_plan, body_rich)
         SELECT version+1, id, category_id, title, vendor, body, drafter_id, pay_due, pay_method,
           iva_applied, planned_sub, planned_iva, planned_total, include_finance,
           currency, orig_sub, orig_iva, orig_total, payment_type, payment_plan, body_rich
           FROM approval_documents WHERE id=$1 RETURNING id`, [id])).rows[0].id);
      await q(`INSERT INTO approval_payments(document_id, seq, due_date, planned_amount, planned_mxn)
               SELECT $2, seq, due_date, planned_amount, planned_mxn FROM approval_payments WHERE document_id=$1`, [id, nid]);
      await applyMoney(q, nid);       // USD 면 오늘 환율로 미리보기(상신 때 새로 고정)
      await q(`INSERT INTO approval_files(document_id, kind, stage, file_name, mime_type, file_size, sha256, file_data,
                 cfdi_uuid, cfdi_rfc, cfdi_total, uploaded_by, uploaded_at)
               SELECT $2, kind, 'draft', file_name, mime_type, file_size, sha256, file_data, cfdi_uuid, cfdi_rfc, cfdi_total,
                 uploaded_by, uploaded_at FROM approval_files WHERE document_id=$1 AND voided_at IS NULL`, [id, nid]);
      await q(`INSERT INTO approval_viewers(document_id, user_id, kind) SELECT $2, user_id, kind FROM approval_viewers WHERE document_id=$1`, [id, nid]);
      await q(`INSERT INTO approval_links(document_id, linked_document_id, created_by) VALUES ($1,$2,$3)`, [nid, id, ctx.uid]);
      await event(q, nid, ctx.uid, 'resubmit_from', null, `${d.doc_no} 반려 건 재기안 (v${d.version + 1})`);
      await event(q, id, ctx.uid, 'resubmitted', null, '재기안 문서 작성');
      return { id: nid };
    });
  });

  // ── 증빙 파일 ─────────────────────────────────────────────────────────
  app.post('/api/approvals/:id/files', { preHandler: [authGuard], bodyLimit: APPROVAL_FILE_BODY_LIMIT }, async (req, reply) => {
    const id = Number(req.params.id);
    const dec = decodeApprovalFile(req.body?.data_url, req.body?.file_name);
    if (!dec.ok) return fail(reply, 'bad_input', { detail: dec.error, max_bytes: APPROVAL_FILE_MAX_BYTES });
    const kind = req.body?.kind ? normKind(req.body.kind) : guessKind(dec.name);
    const commentId = req.body?.comment_id ? Number(req.body.comment_id) : null;
    const paymentId = req.body?.payment_id ? Number(req.body.payment_id) : null;
    const hash = sha256Hex(dec.buf);
    const cfdi = dec.ext === 'xml' ? parseCfdi(dec.buf.toString('utf8')) : null;
    return tx(reply, async (q) => {
      const settings = await loadSettings(q);
      const ctx = ctxOf(req, settings);
      const b = await loadBundle(q, id, true);
      if (!b || !canSeeDoc(ctx, b.doc, b.lines, b.viewers)) throw new Stop('not_found');
      if (b.doc.status === 'draft' && !sameId(b.doc.drafter_id, ctx.uid)) throw new Stop('forbidden');
      if (commentId) {
        const c = (await q(`SELECT document_id, author_id, deleted_at FROM approval_comments WHERE id=$1`, [commentId])).rows[0];
        if (!c || !sameId(c.document_id, id) || !sameId(c.author_id, ctx.uid) || c.deleted_at) throw new Stop('bad_input', { detail: 'bad_comment' });
      }
      if (paymentId) {
        const pr = (await q(`SELECT document_id FROM approval_payments WHERE id=$1`, [paymentId])).rows[0];
        if (!pr || !sameId(pr.document_id, id)) throw new Stop('bad_input', { detail: 'bad_payment' });
      }
      // 같은 파일/같은 CFDI 가 다른 문서에 쓰였나(재기안 원문서·사본은 제외)
      const fam = [id, b.doc.parent_id].filter(Boolean);
      const kids = (await q(`SELECT id FROM approval_documents WHERE parent_id=$1`, [id])).rows.map((r) => Number(r.id));
      const exclude = [...fam, ...kids];
      const dupQ = async (col, v) => {
        if (!v) return null;
        const rows = (await q(
          `SELECT f.document_id, d.doc_no FROM approval_files f JOIN approval_documents d ON d.id=f.document_id
            WHERE f.${col}=$1 AND f.voided_at IS NULL AND d.deleted_at IS NULL`, [v])).rows;
        const hit = rows.find((r) => !exclude.includes(Number(r.document_id)));
        return hit ? (hit.doc_no || '임시저장 문서') : null;
      };
      let dup = await dupQ('sha256', hash);
      if (!dup && cfdi?.uuid) { const u = await dupQ('cfdi_uuid', cfdi.uuid); if (u) dup = `${u} (같은 CFDI UUID)`; }
      const row = (await q(
        `INSERT INTO approval_files(document_id, comment_id, kind, stage, file_name, mime_type, file_size, sha256, file_data,
           cfdi_uuid, cfdi_rfc, cfdi_total, dup_of, uploaded_by, payment_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id, uploaded_at`,
        [id, commentId, kind, fileStage(b.doc), dec.name, dec.mime, dec.bytes, hash, dec.buf,
          cfdi?.uuid || null, cfdi?.rfc || null, cfdi?.total ?? null, dup, ctx.uid, paymentId])).rows[0];
      return { id: Number(row.id), uploaded_at: row.uploaded_at, kind, dup_of: dup, cfdi };
    });
  });
  async function fileWithDoc(q, fid) {
    const f = (await q(`SELECT id, document_id, comment_id, kind, file_name, uploaded_by, voided_at FROM approval_files WHERE id=$1`, [fid])).rows[0];
    if (!f) return null;
    return { f: { ...f, id: Number(f.id), document_id: Number(f.document_id), uploaded_by: Number(f.uploaded_by) } };
  }
  app.get('/api/approvals/files/:fid', guard, async (req, reply) => {
    const fid = Number(req.params.fid);
    const settings = await loadSettings(query);
    const ctx = ctxOf(req, settings);
    const r = await fileWithDoc(query, fid);
    if (!r) return fail(reply, 'not_found');
    const b = await loadBundle(query, r.f.document_id);
    if (!b || !canSeeDoc(ctx, b.doc, b.lines, b.viewers)) return fail(reply, 'not_found');
    const row = (await query(`SELECT file_name, mime_type, file_data FROM approval_files WHERE id=$1`, [fid])).rows[0];
    const name = row.file_name || `file-${fid}`;
    reply.header('Content-Type', row.mime_type);
    reply.header('Content-Disposition', `inline; filename="file-${fid}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    reply.header('Cache-Control', 'private, no-store');
    return reply.send(Buffer.isBuffer(row.file_data) ? row.file_data : Buffer.from(row.file_data));
  });
  app.delete('/api/approvals/files/:fid', guard, async (req, reply) => {
    const fid = Number(req.params.fid);
    return tx(reply, async (q) => {
      const settings = await loadSettings(q);
      const ctx = ctxOf(req, settings);
      const r = await fileWithDoc(q, fid);
      if (!r) throw new Stop('not_found');
      const b = await loadBundle(q, r.f.document_id, true);
      if (!b || !canDeleteFile(ctx, b.doc, r.f)) throw new Stop('forbidden');
      await q(`DELETE FROM approval_files WHERE id=$1`, [fid]);
      if (b.doc.status !== 'draft') await event(q, b.doc.id, ctx.uid, 'file_delete', null, r.f.file_name);
      return { ok: true };
    });
  });
  app.post('/api/approvals/files/:fid/void', guard, async (req, reply) => {
    const fid = Number(req.params.fid);
    const reason = cleanText(req.body?.reason, 500)?.trim();
    if (!reason) return fail(reply, 'memo_required');
    return tx(reply, async (q) => {
      const settings = await loadSettings(q);
      const ctx = ctxOf(req, settings);
      const r = await fileWithDoc(q, fid);
      if (!r) throw new Stop('not_found');
      const b = await loadBundle(q, r.f.document_id, true);
      if (!b || !canVoidFile(ctx, b.doc, r.f)) throw new Stop('forbidden');
      await q(`UPDATE approval_files SET voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1`, [fid, ctx.uid, reason]);
      await event(q, b.doc.id, ctx.uid, 'file_void', null, `${r.f.file_name}\n사유: ${reason}`);
      return { ok: true };
    });
  });

  // ── 결재문서 연결 ─────────────────────────────────────────────────────
  app.post('/api/approvals/:id/links', guard, async (req, reply) => {
    const id = Number(req.params.id);
    const no = String(req.body?.doc_no || '').trim().toUpperCase();
    return tx(reply, async (q) => {
      const settings = await loadSettings(q);
      const ctx = ctxOf(req, settings);
      const b = await loadBundle(q, id, true);
      if (!b || !canSeeDoc(ctx, b.doc, b.lines, b.viewers)) throw new Stop('not_found');
      const t = (await q(`SELECT id FROM approval_documents WHERE doc_no=$1 AND deleted_at IS NULL`, [no])).rows[0];
      if (!t || sameId(t.id, id)) throw new Stop('bad_input', { detail: 'doc_not_found' });
      const tb = await loadBundle(q, Number(t.id));
      if (!canSeeDoc(ctx, tb.doc, tb.lines, tb.viewers)) throw new Stop('bad_input', { detail: 'doc_not_found' });
      await q(`INSERT INTO approval_links(document_id, linked_document_id, created_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, Number(t.id), ctx.uid]);
      await event(q, id, ctx.uid, 'link', null, `${no} ${tb.doc.title}`);
      return { ok: true };
    });
  });

  // ── 댓글(수정·삭제는 디렉터만 · 원문 보존) ─────────────────────────────────
  app.post('/api/approvals/:id/comments', guard, async (req, reply) => {
    const id = Number(req.params.id);
    const body = cleanText(req.body?.body, 5000)?.trim() || '';
    const withFiles = !!req.body?.with_files;
    if (!body && !withFiles) return fail(reply, 'bad_input');
    return tx(reply, async (q) => {
      const settings = await loadSettings(q);
      const ctx = ctxOf(req, settings);
      const b = await loadBundle(q, id, true);
      if (!b || !canSeeDoc(ctx, b.doc, b.lines, b.viewers)) throw new Stop('not_found');
      if (b.doc.status === 'draft') throw new Stop('bad_state');
      const row = (await q(`INSERT INTO approval_comments(document_id, author_id, body) VALUES ($1,$2,$3) RETURNING id`, [id, ctx.uid, body])).rows[0];
      const to = new Set([b.doc.drafter_id, ...b.lines.filter((l) => !['waiting', 'skipped'].includes(l.status)).map((l) => l.user_id)]);
      for (const u of to) await notify(q, u, id, '새 댓글', body.slice(0, 60) || '(파일 첨부)', ctx.uid);
      return { id: Number(row.id) };
    });
  });
  app.put('/api/approvals/comments/:cid', guard, async (req, reply) => {
    if (req.ctx.perm.role !== 'director') return fail(reply, 'director_only');
    const cid = Number(req.params.cid);
    const body = cleanText(req.body?.body, 5000)?.trim();
    if (!body) return fail(reply, 'bad_input');
    return tx(reply, async (q) => {
      const c = (await q(`SELECT id, document_id, body, deleted_at FROM approval_comments WHERE id=$1 FOR UPDATE`, [cid])).rows[0];
      if (!c || c.deleted_at) throw new Stop('not_found');
      if (c.body === body) return { ok: true };
      await q(`INSERT INTO approval_comment_history(comment_id, old_body, replaced_by) VALUES ($1,$2,$3)`, [cid, c.body, req.ctx.perm.userId]);
      await q(`UPDATE approval_comments SET body=$2, edited_at=now(), edited_by=$3 WHERE id=$1`, [cid, body, req.ctx.perm.userId]);
      return { ok: true };
    });
  });
  app.delete('/api/approvals/comments/:cid', guard, async (req, reply) => {
    if (req.ctx.perm.role !== 'director') return fail(reply, 'director_only');
    const cid = Number(req.params.cid);
    const r = await query(`UPDATE approval_comments SET deleted_at=now(), deleted_by=$2 WHERE id=$1 AND deleted_at IS NULL`, [cid, req.ctx.perm.userId]);
    if (!r.rowCount) return fail(reply, 'not_found');
    return { ok: true };
  });

  // ── 알림 ─────────────────────────────────────────────────────────────
  app.get('/api/approvals/notifications', guard, async (req) => {
    const rows = (await query(
      `SELECT x.id, x.document_id, x.kind, x.memo, x.created_at, x.read_at, d.doc_no, d.title
         FROM approval_notifications x JOIN approval_documents d ON d.id=x.document_id
        WHERE x.user_id=$1 AND d.deleted_at IS NULL ORDER BY x.created_at DESC, x.id DESC LIMIT 100`, [req.ctx.perm.userId])).rows;
    return { items: rows.map((r) => ({ ...r, id: Number(r.id), document_id: Number(r.document_id) })) };
  });
  app.post('/api/approvals/notifications/read', guard, async (req) => {
    const uid = req.ctx.perm.userId;
    if (req.body?.all) await query(`UPDATE approval_notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL`, [uid]);
    else {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
      for (const i of ids) await query(`UPDATE approval_notifications SET read_at=now() WHERE id=$1 AND user_id=$2 AND read_at IS NULL`, [i, uid]);
    }
    return { ok: true };
  });

  // ── 설정(디렉터) ──────────────────────────────────────────────────────
  const logSet = (q, uid, detail) => q(`INSERT INTO approval_settings_log(changed_by, detail) VALUES ($1,$2)`, [uid, detail]);
  app.put('/api/approvals/settings', guard, async (req, reply) => {
    if (req.ctx.perm.role !== 'director') return fail(reply, 'director_only');
    const bd = req.body || {};
    const thr = round2(bd.ceo_pre_threshold);
    const basis = bd.threshold_basis === 'sub' ? 'sub' : 'total';
    const tol = round2(bd.variance_tolerance_pct);
    if (!(thr > 0) || tol < 0 || tol > 1000) return fail(reply, 'bad_input');
    const uidOrNull = (v) => (v == null || v === '' ? null : Number(v));
    const ceo = uidOrNull(bd.ceo_user_id), fin = uidOrNull(bd.finance_user_id), dir = uidOrNull(bd.director_user_id);
    const uid = Number(req.ctx.perm.userId);
    return tx(reply, async (q) => {
      const cur = await loadSettings(q);
      const users = await loadUsers(q);
      for (const u of [ceo, fin, dir]) if (u != null && !(users.get(u) || {}).active) throw new Stop('bad_input', { detail: 'bad_user' });
      const nm = (v) => (v == null ? '(없음)' : (users.get(v) || {}).name || v);
      const money = (v) => '$' + n(v).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const changes = [];
      if (thr !== cur.ceo_pre_threshold) changes.push(`사전승인 기준액 ${money(cur.ceo_pre_threshold)} → ${money(thr)}`);
      if (basis !== cur.threshold_basis) changes.push(`판단 금액 ${cur.threshold_basis === 'sub' ? '소계' : 'IVA 포함 합계'} → ${basis === 'sub' ? '소계' : 'IVA 포함 합계'}`);
      if (tol !== cur.variance_tolerance_pct) changes.push(`실적 초과 경고 ${cur.variance_tolerance_pct}% → ${tol}%`);
      if (!sameId(ceo, cur.ceo_user_id) && !(ceo == null && cur.ceo_user_id == null)) changes.push(`대표이사 계정 ${nm(cur.ceo_user_id)} → ${nm(ceo)}`);
      if (!sameId(fin, cur.finance_user_id) && !(fin == null && cur.finance_user_id == null)) changes.push(`재무 담당 ${nm(cur.finance_user_id)} → ${nm(fin)}`);
      if (!sameId(dir, cur.director_user_id) && !(dir == null && cur.director_user_id == null)) changes.push(`디렉터 결재자 ${nm(cur.director_user_id)} → ${nm(dir)}`);
      await q(`INSERT INTO approval_settings(id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
      await q(`UPDATE approval_settings SET ceo_pre_threshold=$1, threshold_basis=$2, variance_tolerance_pct=$3, ceo_user_id=$4,
                 finance_user_id=$5, director_user_id=$6, updated_at=now(), updated_by=$7 WHERE id=1`, [thr, basis, tol, ceo, fin, dir, uid]);
      for (const c of changes) await logSet(q, uid, c);
      return { ok: true, changes };
    });
  });
  app.post('/api/approvals/categories', guard, async (req, reply) => {
    if (req.ctx.perm.role !== 'director') return fail(reply, 'director_only');
    const name = cleanText(req.body?.name, 60)?.trim();
    if (!name) return fail(reply, 'bad_input');
    return tx(reply, async (q) => {
      const ord = Number((await q(`SELECT COALESCE(MAX(sort_order),0)+10 AS o FROM approval_categories`)).rows[0].o);
      const row = (await q(`INSERT INTO approval_categories(name, sort_order) VALUES ($1,$2) RETURNING id`, [name, ord])).rows[0];
      await logSet(q, req.ctx.perm.userId, `카테고리 추가: ${name}`);
      return { id: Number(row.id) };
    });
  });
  app.put('/api/approvals/categories/:cid', guard, async (req, reply) => {
    if (req.ctx.perm.role !== 'director') return fail(reply, 'director_only');
    const cid = Number(req.params.cid);
    return tx(reply, async (q) => {
      const c = (await q(`SELECT id, name, active FROM approval_categories WHERE id=$1`, [cid])).rows[0];
      if (!c) throw new Stop('not_found');
      const name = cleanText(req.body?.name, 60)?.trim() || c.name;
      const active = typeof req.body?.active === 'boolean' ? req.body.active : c.active;
      await q(`UPDATE approval_categories SET name=$2, active=$3 WHERE id=$1`, [cid, name, active]);
      if (name !== c.name) await logSet(q, req.ctx.perm.userId, `카테고리 이름: ${c.name} → ${name}`);
      if (active !== c.active) await logSet(q, req.ctx.perm.userId, `카테고리 ${name}: ${active ? '사용' : '사용 중지'}`);
      return { ok: true };
    });
  });
  app.post('/api/approvals/categories/:cid/steps', guard, async (req, reply) => {
    if (req.ctx.perm.role !== 'director') return fail(reply, 'director_only');
    const cid = Number(req.params.cid);
    const type = req.body?.step_type;
    const uid = Number(req.body?.user_id);
    if (!['approve', 'agree', 'pass'].includes(type) || !uid) return fail(reply, 'bad_input');
    return tx(reply, async (q) => {
      const c = (await q(`SELECT id, name FROM approval_categories WHERE id=$1`, [cid])).rows[0];
      if (!c) throw new Stop('not_found');
      const users = await loadUsers(q);
      if (!(users.get(uid) || {}).active) throw new Stop('bad_input', { detail: 'bad_user' });
      const dup = (await q(`SELECT id FROM approval_category_steps WHERE category_id=$1 AND step_type=$2 AND user_id=$3`, [cid, type, uid])).rows[0];
      if (dup) throw new Stop('bad_input', { detail: 'duplicate' });
      const ord = Number((await q(`SELECT COALESCE(MAX(step_order),0)+1 AS o FROM approval_category_steps WHERE category_id=$1`, [cid])).rows[0].o);
      await q(`INSERT INTO approval_category_steps(category_id, step_order, step_type, user_id) VALUES ($1,$2,$3,$4)`, [cid, ord, type, uid]);
      await logSet(q, req.ctx.perm.userId, `${c.name} 결재선: ${STEP_LABEL[type]} ${users.get(uid).name} 추가`);
      return { ok: true };
    });
  });
  app.delete('/api/approvals/category-steps/:sid', guard, async (req, reply) => {
    if (req.ctx.perm.role !== 'director') return fail(reply, 'director_only');
    const sid = Number(req.params.sid);
    return tx(reply, async (q) => {
      const s = (await q(`SELECT s.id, s.step_type, s.user_id, c.name FROM approval_category_steps s JOIN approval_categories c ON c.id=s.category_id WHERE s.id=$1`, [sid])).rows[0];
      if (!s) throw new Stop('not_found');
      const users = await loadUsers(q);
      await q(`DELETE FROM approval_category_steps WHERE id=$1`, [sid]);
      await logSet(q, req.ctx.perm.userId, `${s.name} 결재선: ${STEP_LABEL[s.step_type]} ${(users.get(Number(s.user_id)) || {}).name || s.user_id} 삭제`);
      return { ok: true };
    });
  });

  // ── 예정 대비 실적 리포트(모듈 내부 집계 · 재무상태 미반영) ───────────────────
  app.get('/api/approvals/report', guard, async (req, reply) => {
    const settings = await loadSettings(query);
    const ctx = ctxOf(req, settings);
    if (!ctx.isDirector && !ctx.isCeo && !ctx.isFinance) return fail(reply, 'forbidden');
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : mxMonth(new Date());
    const docs = (await query(`SELECT ${DOC_COLS} FROM approval_documents d WHERE d.deleted_at IS NULL AND d.status <> 'draft'`)).rows.map(normDoc);
    const lines = (await query(`SELECT ${LINE_COLS} FROM approval_lines`)).rows.map(normLine);
    const viewers = (await query(`SELECT document_id, user_id, kind FROM approval_viewers`)).rows.map(normViewer);
    const files = (await query(`SELECT document_id, kind, voided_at, dup_of FROM approval_files`)).rows;
    const cats = new Map((await query(`SELECT id, name FROM approval_categories`)).rows.map((c) => [Number(c.id), c.name]));
    const vis = docs.filter((d) => canSeeDoc(ctx, d, lines.filter((l) => l.document_id === d.id), viewers.filter((v) => v.document_id === d.id)))
      .map((d) => ({ ...d, files: files.filter((f) => sameId(f.document_id, d.id)) }));
    const monthDocs = vis.filter((d) => d.status === 'approved' && mxMonth(d.submitted_at) === month);
    const months = [...new Set(vis.map((d) => mxMonth(d.submitted_at)).filter(Boolean))].sort().reverse();
    return {
      month, months: months.includes(month) ? months : [month, ...months],
      ...reportRows(monthDocs, (k) => cats.get(k) || '(미분류)'),
      checks: completenessChecks(vis, settings),
    };
  });
}
