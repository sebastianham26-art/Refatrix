import { query, withTx } from '../db.js';
import { authGuard, requirePage, requirePageEdit, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';

// =====================================================================
// Refatrix ERP · marketingSpendRoutes.js  (마케팅 지출 계획 · v2 집행항목)
//   · 구조: 활동(계획) → 집행 항목 N(장소·케이터링·판촉물 …)
//            → 항목별 지급 라인 N(선지급/중도금/잔금/일시불).
//   · 담당자(marketing 편집권한) 작성·제출 → 디렉터가 내용을 직접 수정하며
//     승인 → 모든 지급 라인마다 transactions(status='plan', 6070,
//     memo '[마케팅] 집행항목 · 구분 · 활동', 0125)이 생성돼 재무 예정 내역·현금흐름
//     AP(자금 계획)에 반영. 실제 송금은 재무 [실적 처리](confirm-pay).
//   · 승인 후 수정:
//       - 디렉터: 즉시 반영 — 연결 거래가 아직 plan이면 자동 동기화,
//         이미 actual(지급완료)이면 그 라인은 잠금(409 line_locked).
//       - 담당자(작성자, 비디렉터): "수정 요청" — pending_revision(jsonb)에만
//         저장되고 자금계획(현금흐름)은 건드리지 않음. 디렉터가 열어 검토·
//         승인 저장 시에만 예정 지출이 동기화되고 요청이 종료됨(0124).
//         디렉터 승인 전까지 담당자는 요청 내용을 계속 수정 가능.
//   · 대상 통계: 고객별 연간 매출목표(target_customer_months 합) +
//     올해 1/1~오늘 누적 매출(sales_invoices posted subtotal_mxn, ex-IVA).
// =====================================================================

function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
const KINDS = new Set(['adv', 'mid', 'fin', 'one']);
const KIND_LABEL = { adv: '선지급금', mid: '중도금', fin: '잔금', one: '일시불' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDirector(req) { return req.ctx.perm.role === 'director'; }

// 증빙 파일 검증(인보이스 첨부와 동일하게 폭넓은 허용, 8MB)
export function validateSpendFileDataUrl(dataUrl, maxBytes = 8 * 1024 * 1024) {
  let s = String(dataUrl || '');
  // 확장자 미인식 파일: 브라우저 FileReader가 mime 없이 'data:;base64,'를 만들 수 있음 → octet-stream으로 간주
  s = s.replace(/^data:;base64,/, 'data:application/octet-stream;base64,')
       .replace(/^data:base64,/, 'data:application/octet-stream;base64,');
  const m = s.match(/^data:([a-zA-Z0-9.+\/-]+);base64,([A-Za-z0-9+\/=\s]+)$/);
  if (!m) return { ok: false, error: 'bad_format' };
  const mime = m[1].toLowerCase();
  const okMime = mime.startsWith('image/') || [
    'application/pdf', 'text/xml', 'application/xml',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/csv', 'text/plain', 'application/zip', 'application/octet-stream',
  ].includes(mime);
  if (!okMime) return { ok: false, error: 'bad_mime' };
  const b64 = m[2].replace(/\s+/g, '');
  if (!b64) return { ok: false, error: 'empty' };
  const bytes = Math.floor(b64.length * 3 / 4);
  if (bytes > maxBytes) return { ok: false, error: 'too_large' };
  return { ok: true, mime, size: bytes, data: s };
}

// 지급 라인 정규화(항목 내부). 오류 시 {error}
export function normalizeLines(rawLines) {
  const lines = Array.isArray(rawLines) ? rawLines : [];
  if (!lines.length) return { error: 'lines_required' };
  if (lines.length > 50) return { error: 'too_many_lines' };
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] || {};
    const kind = KINDS.has(l.kind) ? l.kind : 'one';
    const due = String(l.due_date || '');
    let dOk = DATE_RE.test(due);
    if (dOk) { const dt = new Date(due + 'T00:00:00Z'); dOk = !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === due; }
    if (!dOk) return { error: 'bad_line_date', index: i };
    const amount = Number(l.amount);
    if (!(amount > 0)) return { error: 'bad_line_amount', index: i };
    out.push({ id: l.id != null ? Number(l.id) : null, kind, due_date: due, amount: r2(amount),
      memo: (l.memo == null || String(l.memo).trim() === '') ? null : String(l.memo).trim().slice(0, 300), sort_order: i });
  }
  return { lines: out };
}

// 집행 항목 정규화(항목마다 지급 라인 1개 이상). 오류 시 {error}
export function normalizeItems(rawItems) {
  const arr = Array.isArray(rawItems) ? rawItems : [];
  if (!arr.length) return { error: 'items_required' };
  if (arr.length > 30) return { error: 'too_many_items' };
  const items = [];
  let totalLines = 0;
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i] || {};
    const name = String(it.name || '').trim().slice(0, 120);
    if (!name) return { error: 'item_name_required', index: i };
    const nl = normalizeLines(it.lines);
    if (nl.error) return { error: nl.error, item_index: i, index: nl.index };
    totalLines += nl.lines.length;
    if (totalLines > 100) return { error: 'too_many_lines_total' };
    items.push({ id: it.id != null ? Number(it.id) : null, name,
      memo: (it.memo == null || String(it.memo).trim() === '') ? null : String(it.memo).trim().slice(0, 300),
      sort_order: i, lines: nl.lines });
  }
  return { items };
}

// 본문 → 대상 정규화(고객 중복 제거, 불특정 다수 1건으로 축약)
export function normalizeTargets(rawTargets) {
  const arr = Array.isArray(rawTargets) ? rawTargets : [];
  if (arr.length > 200) return { error: 'too_many_targets' };
  const custIds = [];
  const seen = new Set();
  let general = false;
  for (const t of arr) {
    if (t && t.is_general) { general = true; continue; }
    const cid = Number(t && t.customer_id);
    if (!(cid > 0)) return { error: 'bad_target' };
    if (!seen.has(cid)) { seen.add(cid); custIds.push(cid); }
  }
  return { custIds, general };
}

// 계획 거래 메모: '[마케팅] 집행항목 · 구분 · 활동명 (· 명목)'  (0125)
//  — 집행항목이 앞에 오도록: 현금흐름·예정내역의 좁은 메모 칸(22~30자)에서
//    활동명이 아니라 "그 날짜에 무엇을 집행하는지"가 먼저 보이게 한다.
//  — 재무 화면이 '[마케팅]' 접두사로 출처 배지를 표시(규약 유지)
export function spendTxnMemo(title, itemName, kind, lineMemo) {
  const base = `[마케팅] ${String(itemName || '기본 집행').slice(0, 80)} · ${KIND_LABEL[kind] || kind} · ${String(title || '').slice(0, 100)}`;
  return lineMemo ? `${base} · ${String(lineMemo).slice(0, 160)}` : base;
}

// 일정 달력 자동 연동(0135): 계획 승인/수정/삭제 시 호출.
//   승인 상태면 행사일·집행라인 일정을 (재)생성하고, 아니면(반려·삭제·회수) 제거.
//   대상자 = 계획 작성자(마케팅 담당) + 디렉터 전원. scope='shared'.
//   run = 트랜잭션 클라이언트의 query 함수. actorId = 이벤트 created_by.
export function fmtMoney(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export async function syncPlanCalendar(run, planId, actorId) {
  // best-effort: 마이그레이션(0135) 미적용 등으로 실패해도 호출측(계획 저장)에 영향 없도록 자체 흡수.
  //   반드시 트랜잭션 커밋 "이후" pool query로 호출할 것(실패가 계획 저장을 롤백하지 않게).
  try {
    // 1) 기존 자동 일정 제거(대상자 → 이벤트 순, 이 계획 소속 전부)
    await run(`DELETE FROM calendar_event_targets WHERE event_id IN (SELECT id FROM calendar_events WHERE src_plan_id=$1)`, [planId]);
    await run(`DELETE FROM calendar_events WHERE src_plan_id=$1`, [planId]);

    const p = (await run(
      `SELECT title, to_char(event_date,'YYYY-MM-DD') AS event_date, created_by, status, deleted_at
         FROM marketing_spend_plans WHERE id=$1`, [planId])).rows[0];
    if (!p || p.deleted_at || p.status !== 'approved') return; // 승인 상태에서만 일정 생성

    // 대상자 = 작성자 + 디렉터 전원(중복 제거)
    const dirs = (await run(`SELECT id FROM users WHERE role='director' AND deleted_at IS NULL`)).rows.map((r) => Number(r.id));
    const targetIds = [...new Set([...(p.created_by != null ? [Number(p.created_by)] : []), ...dirs])];

    const addEvent = async (dateStr, content, kind, srcId) => {
      if (!dateStr) return;
      const ev = (await run(
        `INSERT INTO calendar_events (event_date, content, scope, created_by, src_kind, src_id, src_plan_id)
         VALUES ($1,$2,'shared',$3,$4,$5,$6) RETURNING id`,
        [dateStr, String(content).slice(0, 200), actorId || p.created_by || null, kind, srcId, planId])).rows[0];
      for (const uid of targetIds) {
        await run(`INSERT INTO calendar_event_targets (event_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ev.id, uid]);
      }
    };

    // 2) 행사일 일정 — 내용 = 행사명
    if (p.event_date) await addEvent(p.event_date, p.title || '(행사)', 'mkt_plan', planId);

    // 3) 집행 라인 일정 — 내용 = 행사명 · 집행항목명 · 금액
    const lines = (await run(
      `SELECT l.id, to_char(l.due_date,'YYYY-MM-DD') AS due_date, l.amount,
              COALESCE(i.name,'기본 집행') AS item_name
         FROM marketing_spend_lines l
         LEFT JOIN marketing_spend_items i ON i.id=l.item_id
        WHERE l.plan_id=$1 AND l.due_date IS NOT NULL
        ORDER BY l.due_date, l.id`, [planId])).rows;
    for (const l of lines) {
      const content = `${p.title || ''} · ${l.item_name} · ${fmtMoney(l.amount)} MXN`;
      await addEvent(l.due_date, content, 'mkt_line', Number(l.id));
    }
  } catch (e) {
    // 마이그레이션 미적용/일시 오류 등 — 계획 저장 자체는 성공해야 하므로 삼킨다.
    try { console.error('[mktspend] calendar sync skipped:', e && e.message ? e.message : e); } catch (_) {}
  }
}

export default async function marketingSpendRoutes(app) {
  const num = (v) => (v == null ? 0 : Number(v));

  // ---- 저장 헬퍼(트랜잭션 내) ------------------------------------------
  async function insertItemsWithLines(run, planId, items) {
    for (const it of items) {
      const r = await run(
        `INSERT INTO marketing_spend_items (plan_id, name, memo, sort_order) VALUES ($1,$2,$3,$4) RETURNING id`,
        [planId, it.name, it.memo, it.sort_order]);
      const itemId = Number(r.rows[0].id);
      for (const l of it.lines) {
        await run(
          `INSERT INTO marketing_spend_lines (plan_id, item_id, kind, due_date, amount, memo, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [planId, itemId, l.kind, l.due_date, l.amount, l.memo, l.sort_order]);
      }
    }
  }
  async function replaceTargets(run, planId, custIds, general) {
    await run(`DELETE FROM marketing_spend_targets WHERE plan_id=$1`, [planId]);
    for (const cid of custIds) {
      await run(`INSERT INTO marketing_spend_targets (plan_id, customer_id, is_general) VALUES ($1,$2,false)`, [planId, cid]);
    }
    if (general) {
      await run(`INSERT INTO marketing_spend_targets (plan_id, customer_id, is_general) VALUES ($1,NULL,true)`, [planId]);
    }
  }
  async function validateCustomers(custIds) {
    if (!custIds.length) return true;
    const rows = (await query(`SELECT id FROM customers WHERE id=ANY($1) AND deleted_at IS NULL`, [custIds])).rows;
    return rows.length === custIds.length;
  }

  // ---- 헤더 필드 정규화 ------------------------------------------------
  function headerFields(b) {
    const title = String(b.title || '').trim().slice(0, 200);
    if (!title) return { error: 'title_required' };
    const category = (b.category == null || String(b.category).trim() === '') ? null : String(b.category).trim().slice(0, 60);
    const eventDate = (b.event_date && DATE_RE.test(String(b.event_date))) ? String(b.event_date) : null;
    const purpose = (b.purpose == null || String(b.purpose).trim() === '') ? null : String(b.purpose).trim().slice(0, 2000);
    return { title, category, eventDate, purpose };
  }

  // =====================================================================
  // 고객 검색(마케팅 권한으로 — customers 페이지 권한 없이도 대상 선택 가능)
  // =====================================================================
  app.get('/api/mktspend/customers', { preHandler: [authGuard, requirePage('marketing')] }, async (req) => {
    const q = String(req.query.q || '').trim();
    if (!q) return { items: [] };
    const rows = (await query(
      `SELECT id, code, name FROM customers
        WHERE deleted_at IS NULL AND (name ILIKE $1 OR code ILIKE $1)
        ORDER BY name LIMIT 20`, ['%' + q + '%'])).rows;
    return { items: rows.map((r) => ({ id: Number(r.id), code: r.code, name: r.name })) };
  });

  // =====================================================================
  // 대상 통계: 연간 매출목표 + 올해 누적 매출(기안 시점 기준, ex-IVA)
  // =====================================================================
  app.get('/api/mktspend/target-stats', { preHandler: [authGuard, requirePage('marketing')] }, async (req) => {
    const ids = String(req.query.ids || '').split(',').map((s) => Number(s)).filter((n) => n > 0);
    const year = String(new Date().getFullYear());
    const today = new Date().toISOString().slice(0, 10);
    if (!ids.length) return { year, as_of: today, items: [], total_target: 0, total_sales: 0 };
    const ymFrom = year + '-01', ymTo = year + '-12';
    const dFrom = year + '-01-01';
    const custRows = (await query(`SELECT id, code, name FROM customers WHERE id=ANY($1)`, [ids])).rows;
    const tgtRows = (await query(
      `SELECT customer_id, COALESCE(SUM(amount),0) AS t FROM target_customer_months
        WHERE customer_id=ANY($1) AND ym >= $2 AND ym <= $3 GROUP BY customer_id`, [ids, ymFrom, ymTo])).rows;
    const salesRows = (await query(
      `SELECT customer_id, COALESCE(SUM(subtotal_mxn),0) AS s FROM sales_invoices
        WHERE customer_id=ANY($1) AND status='posted' AND inv_date >= $2 AND inv_date <= $3 GROUP BY customer_id`,
      [ids, dFrom, today])).rows;
    const tgtMap = new Map(tgtRows.map((r) => [Number(r.customer_id), r2(num(r.t))]));
    const salesMap = new Map(salesRows.map((r) => [Number(r.customer_id), r2(num(r.s))]));
    let totalTarget = 0, totalSales = 0;
    const items = custRows.map((c) => {
      const id = Number(c.id);
      const target = tgtMap.has(id) ? tgtMap.get(id) : null;   // null = 목표 미설정
      const sales = salesMap.get(id) || 0;
      if (target != null) totalTarget = r2(totalTarget + target);
      totalSales = r2(totalSales + sales);
      return { customer_id: id, code: c.code, name: c.name, annual_target: target, ytd_sales: sales,
        progress: target ? Math.round(sales / target * 100) : null };
    });
    return { year, as_of: today, items, total_target: totalTarget, total_sales: totalSales };
  });

  // =====================================================================
  // 계획 목록
  // =====================================================================
  app.get('/api/mktspend/plans', { preHandler: [authGuard, requirePage('marketing')] }, async (req) => {
    const st = ['draft', 'submitted', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const params = [];
    let where = `p.deleted_at IS NULL`;
    if (st) { params.push(st); where += ` AND p.status=$${params.length}`; }
    const rows = (await query(
      `SELECT p.id, p.title, p.category, to_char(p.event_date,'YYYY-MM-DD') AS event_date, p.status, p.reject_reason,
              (p.pending_revision IS NOT NULL) AS has_revision,
              p.created_by, u.name AS created_by_name, p.submitted_at, p.decided_at,
              COALESCE(ia.item_count,0) AS item_count,
              COALESCE(la.line_count,0) AS line_count, COALESCE(la.total_amount,0) AS total_amount, la.first_due,
              COALESCE(ta.customer_count,0) AS customer_count, COALESCE(ta.general_count,0) AS general_count,
              COALESCE(fa.file_count,0) AS file_count
         FROM marketing_spend_plans p
         LEFT JOIN users u ON u.id=p.created_by
         LEFT JOIN (SELECT plan_id, COUNT(*) AS item_count
                      FROM marketing_spend_items GROUP BY plan_id) ia ON ia.plan_id=p.id
         LEFT JOIN (SELECT plan_id, COUNT(*) AS line_count, COALESCE(SUM(amount),0) AS total_amount,
                           to_char(MIN(due_date),'YYYY-MM-DD') AS first_due
                      FROM marketing_spend_lines GROUP BY plan_id) la ON la.plan_id=p.id
         LEFT JOIN (SELECT plan_id, SUM(CASE WHEN is_general THEN 0 ELSE 1 END) AS customer_count,
                           SUM(CASE WHEN is_general THEN 1 ELSE 0 END) AS general_count
                      FROM marketing_spend_targets GROUP BY plan_id) ta ON ta.plan_id=p.id
         LEFT JOIN (SELECT plan_id, COUNT(*) AS file_count
                      FROM marketing_spend_files GROUP BY plan_id) fa ON fa.plan_id=p.id
        WHERE ${where}
        ORDER BY p.id DESC LIMIT 300`, params)).rows;
    const items = rows.map((r) => ({
      id: Number(r.id), title: r.title, category: r.category, event_date: r.event_date, status: r.status,
      reject_reason: r.reject_reason, created_by: r.created_by == null ? null : Number(r.created_by),
      created_by_name: r.created_by_name, submitted_at: r.submitted_at, decided_at: r.decided_at,
      item_count: num(r.item_count), line_count: num(r.line_count), total_amount: r2(num(r.total_amount)), first_due: r.first_due,
      customer_count: num(r.customer_count), has_general: num(r.general_count) > 0, file_count: num(r.file_count),
      has_revision: !!r.has_revision,
    }));
    return { items, me: req.ctx.perm.userId, is_director: isDirector(req) };
  });

  // =====================================================================
  // 계획 상세(집행 항목 → 라인+지급상태, 대상, 파일 메타)
  // =====================================================================
  app.get('/api/mktspend/plans/:id', { preHandler: [authGuard, requirePage('marketing')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!(id > 0)) return reply.code(400).send({ error: 'bad_id' });
    const p = (await query(
      `SELECT p.*, to_char(p.event_date,'YYYY-MM-DD') AS event_date_fmt,
              u.name AS created_by_name, d.name AS decided_by_name, rv.name AS revision_by_name
         FROM marketing_spend_plans p
         LEFT JOIN users u ON u.id=p.created_by
         LEFT JOIN users d ON d.id=p.decided_by
         LEFT JOIN users rv ON rv.id=p.revision_by
        WHERE p.id=$1 AND p.deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const itemRows = (await query(
      `SELECT id, name, memo, sort_order FROM marketing_spend_items WHERE plan_id=$1 ORDER BY sort_order, id`, [id])).rows;
    const lineRows = (await query(
      `SELECT l.id, l.item_id, l.kind, to_char(l.due_date,'YYYY-MM-DD') AS due_date, l.amount, l.memo, l.sort_order, l.txn_id,
              t.status AS txn_status, to_char(t.txn_date,'YYYY-MM-DD') AS txn_date, t.amount AS txn_amount, t.deleted_at AS txn_deleted
         FROM marketing_spend_lines l
         LEFT JOIN transactions t ON t.id=l.txn_id
        WHERE l.plan_id=$1 ORDER BY l.sort_order, l.id`, [id])).rows;
    const mapLine = (l) => ({ id: Number(l.id), item_id: l.item_id == null ? null : Number(l.item_id),
      kind: l.kind, due_date: l.due_date, amount: r2(num(l.amount)), memo: l.memo,
      txn_id: l.txn_id == null ? null : Number(l.txn_id),
      paid: l.txn_status === 'actual', txn_deleted: !!l.txn_deleted,
      paid_date: l.txn_status === 'actual' ? l.txn_date : null,
      paid_amount: l.txn_status === 'actual' ? r2(num(l.txn_amount)) : null });
    const items = itemRows.map((it) => ({ id: Number(it.id), name: it.name, memo: it.memo,
      lines: lineRows.filter((l) => Number(l.item_id) === Number(it.id)).map(mapLine) }));
    // 항목 미귀속 라인(0116 백필 전 잔여) 안전망
    const orphan = lineRows.filter((l) => l.item_id == null).map(mapLine);
    if (orphan.length) items.push({ id: null, name: '기본 집행', memo: null, lines: orphan });
    const targets = (await query(
      `SELECT tg.id, tg.customer_id, tg.is_general, c.code, c.name
         FROM marketing_spend_targets tg
         LEFT JOIN customers c ON c.id=tg.customer_id
        WHERE tg.plan_id=$1 ORDER BY tg.is_general, tg.id`, [id])).rows;
    const files = (await query(
      `SELECT f.id, f.file_name, f.mime_type, f.file_size, f.uploaded_at, u.name AS uploaded_by_name
         FROM marketing_spend_files f LEFT JOIN users u ON u.id=f.uploaded_by
        WHERE f.plan_id=$1 ORDER BY f.id DESC`, [id])).rows;
    // ---- 담당자 수정 요청(0124): 대상 고객명 하이드레이션 포함 ----
    let revision = null;
    if (p.pending_revision != null) {
      let rp = p.pending_revision;
      if (typeof rp === 'string') { try { rp = JSON.parse(rp); } catch (_) { rp = null; } }
      if (rp) {
        const rids = (rp.targets || []).filter((t) => t && t.customer_id).map((t) => Number(t.customer_id));
        let nmap = new Map();
        if (rids.length) {
          const cr = (await query(`SELECT id, code, name FROM customers WHERE id=ANY($1)`, [rids])).rows;
          nmap = new Map(cr.map((c) => [Number(c.id), c]));
        }
        rp.targets = (rp.targets || []).map((t) => {
          if (t && t.customer_id) {
            const c = nmap.get(Number(t.customer_id)) || {};
            return { customer_id: Number(t.customer_id), is_general: false, code: c.code || null, name: c.name || ('#' + t.customer_id) };
          }
          return { customer_id: null, is_general: true };
        });
        revision = { payload: rp, by_name: p.revision_by_name || null, at: p.revision_at };
      }
    }
    return {
      plan: { id: Number(p.id), title: p.title, category: p.category,
        event_date: p.event_date_fmt || null,
        purpose: p.purpose, status: p.status, reject_reason: p.reject_reason,
        created_by: p.created_by == null ? null : Number(p.created_by), created_by_name: p.created_by_name,
        submitted_at: p.submitted_at, decided_at: p.decided_at, decided_by_name: p.decided_by_name },
      items,
      lines: lineRows.map(mapLine),
      targets: targets.map((t) => ({ id: Number(t.id), customer_id: t.customer_id == null ? null : Number(t.customer_id),
        is_general: !!t.is_general, code: t.code, name: t.name })),
      files: files.map((f) => ({ id: Number(f.id), file_name: f.file_name, mime_type: f.mime_type,
        file_size: f.file_size == null ? null : Number(f.file_size), uploaded_at: f.uploaded_at, uploaded_by_name: f.uploaded_by_name })),
      revision,
      can_edit: isDirector(req) || (Number(p.created_by) === Number(req.ctx.perm.userId) && ['draft', 'rejected', 'approved'].includes(p.status)),
      is_director: isDirector(req),
    };
  });

  // =====================================================================
  // 계획 생성(작성중 저장) — body.items = [{name, memo, lines:[…]}]
  // =====================================================================
  app.post('/api/mktspend/plans', { preHandler: [authGuard, requirePageEdit('marketing')] }, async (req, reply) => {
    const b = req.body || {};
    const h = headerFields(b);
    if (h.error) return reply.code(400).send({ error: h.error });
    const ni = normalizeItems(b.items);
    if (ni.error) return reply.code(400).send(ni);
    const nt = normalizeTargets(b.targets);
    if (nt.error) return reply.code(400).send(nt);
    if (!(await validateCustomers(nt.custIds))) return reply.code(400).send({ error: 'customer_not_found' });
    const userId = req.ctx.perm.userId;
    const planId = await withTx(async (c) => {
      const run = (s, p2) => c.query(s, p2);
      const r = await run(
        `INSERT INTO marketing_spend_plans (title, category, event_date, purpose, status, created_by, updated_by)
         VALUES ($1,$2,$3,$4,'draft',$5,$5) RETURNING id`,
        [h.title, h.category, h.eventDate, h.purpose, userId]);
      const pid = Number(r.rows[0].id);
      await insertItemsWithLines(run, pid, ni.items);
      await replaceTargets(run, pid, nt.custIds, nt.general);
      return pid;
    });
    await logEvent({ userId, action: 'create', target: `mktspend:${planId}` });
    return { ok: true, id: planId };
  });

  // =====================================================================
  // 계획 수정
  //   · draft/rejected: 작성자 또는 디렉터 — 항목·라인·대상 전체 교체
  //   · submitted: 디렉터만(승인 전 검토 수정) — 전체 교체
  //   · approved: 디렉터만 — 연결 거래 동기화(plan만), actual 라인은 잠금
  // =====================================================================
  app.patch('/api/mktspend/plans/:id', { preHandler: [authGuard, requirePageEdit('marketing')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!(id > 0)) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {};
    const h = headerFields(b);
    if (h.error) return reply.code(400).send({ error: h.error });
    const ni = normalizeItems(b.items);
    if (ni.error) return reply.code(400).send(ni);
    const nt = normalizeTargets(b.targets);
    if (nt.error) return reply.code(400).send(nt);
    if (!(await validateCustomers(nt.custIds))) return reply.code(400).send({ error: 'customer_not_found' });
    const p = (await query(`SELECT * FROM marketing_spend_plans WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const dir = isDirector(req);
    const mine = Number(p.created_by) === Number(req.ctx.perm.userId);
    if (['draft', 'rejected'].includes(p.status)) { if (!dir && !mine) return reply.code(403).send({ error: 'not_owner' }); }
    else if (p.status === 'approved') { if (!dir && !mine) return reply.code(403).send({ error: 'not_owner' }); }
    else if (!dir) return reply.code(403).send({ error: 'director_only' });
    const userId = req.ctx.perm.userId;

    // ---- 승인건 + 담당자(비디렉터): "수정 요청" 저장 — 자금계획(현금흐름) 미반영 ----
    //      디렉터가 검토·승인 저장할 때만 예정 지출이 동기화된다(0124).
    if (p.status === 'approved' && !dir) {
      // 지급완료 라인 조기 잠금 검사(실제 반영 시에도 다시 검사됨)
      const paidRows = (await query(
        `SELECT l.id, l.item_id, l.kind, to_char(l.due_date,'YYYY-MM-DD') AS due_date, l.amount, l.memo
           FROM marketing_spend_lines l JOIN transactions t ON t.id=l.txn_id
          WHERE l.plan_id=$1 AND t.status='actual' AND t.deleted_at IS NULL`, [id])).rows;
      const flat = [];
      for (const it of ni.items) for (const l of it.lines) flat.push({ ...l, itemId: it.id });
      for (const e of paidRows) {
        const m = flat.find((l) => l.id != null && Number(l.id) === Number(e.id));
        if (!m) return reply.code(409).send({ error: 'line_locked', line_id: Number(e.id), reason: 'paid' });
        const changed = m.kind !== e.kind || m.due_date !== e.due_date || Math.abs(num(e.amount) - m.amount) > 0.001
          || (e.memo || null) !== m.memo || Number(m.itemId) !== Number(e.item_id);
        if (changed) return reply.code(409).send({ error: 'line_locked', line_id: Number(e.id), reason: 'paid' });
      }
      const payload = { title: h.title, category: h.category, event_date: h.eventDate, purpose: h.purpose,
        items: ni.items,
        targets: [...nt.custIds.map((cid) => ({ customer_id: cid })), ...(nt.general ? [{ is_general: true }] : [])] };
      await query(
        `UPDATE marketing_spend_plans SET pending_revision=$1::jsonb, revision_by=$2, revision_at=now(), updated_by=$2 WHERE id=$3`,
        [JSON.stringify(payload), userId, id]);
      await logEvent({ userId, action: 'update', target: `mktspend:${id}`, detail: { revision: true } });
      return { ok: true, revision: true };
    }

    const result = await withTx(async (c) => {
      const run = (s, p2) => c.query(s, p2);
      await run(
        `UPDATE marketing_spend_plans SET title=$1, category=$2, event_date=$3, purpose=$4, updated_by=$5 WHERE id=$6`,
        [h.title, h.category, h.eventDate, h.purpose, userId, id]);
      await replaceTargets(run, id, nt.custIds, nt.general);

      if (p.status !== 'approved') {
        // 아직 거래 미생성 — 항목·라인 전체 교체
        await run(`DELETE FROM marketing_spend_lines WHERE plan_id=$1`, [id]);
        await run(`DELETE FROM marketing_spend_items WHERE plan_id=$1`, [id]);
        await insertItemsWithLines(run, id, ni.items);
        return { ok: true };
      }

      // ---- 승인된 계획: 집행 항목 upsert + 연결 거래 동기화 ---------------
      const exItems = (await run(`SELECT id, name, memo, sort_order FROM marketing_spend_items WHERE plan_id=$1`, [id])).rows;
      const exItemIds = new Set(exItems.map((e) => Number(e.id)));
      const keepItemIds = new Set();
      // 1) 항목 upsert(기존 id 유지·이름 수정 / 신규 삽입)
      for (const it of ni.items) {
        if (it.id != null && exItemIds.has(it.id)) {
          await run(`UPDATE marketing_spend_items SET name=$1, memo=$2, sort_order=$3 WHERE id=$4 AND plan_id=$5`,
            [it.name, it.memo, it.sort_order, it.id, id]);
          it._dbId = it.id;
        } else {
          const r = await run(`INSERT INTO marketing_spend_items (plan_id, name, memo, sort_order) VALUES ($1,$2,$3,$4) RETURNING id`,
            [id, it.name, it.memo, it.sort_order]);
          it._dbId = Number(r.rows[0].id);
        }
        keepItemIds.add(it._dbId);
      }
      // 2) 라인 동기화
      const existing = (await run(
        `SELECT l.id, l.item_id, l.kind, to_char(l.due_date,'YYYY-MM-DD') AS due_date, l.amount, l.memo, l.txn_id,
                t.status AS txn_status, t.deleted_at AS txn_deleted
           FROM marketing_spend_lines l LEFT JOIN transactions t ON t.id=l.txn_id
          WHERE l.plan_id=$1`, [id])).rows;
      const exMap = new Map(existing.map((e) => [Number(e.id), e]));
      const flat = [];
      for (const it of ni.items) for (const l of it.lines) flat.push({ ...l, itemId: it._dbId, itemName: it.name });
      const keepLineIds = new Set(flat.filter((l) => l.id != null).map((l) => Number(l.id)));
      // 삭제된 라인
      for (const e of existing) {
        if (keepLineIds.has(Number(e.id))) continue;
        if (e.txn_id != null && e.txn_status === 'actual' && !e.txn_deleted) {
          return { error: 'line_locked', line_id: Number(e.id), reason: 'paid' };
        }
        if (e.txn_id != null && !e.txn_deleted) {
          await run(`UPDATE transactions SET deleted_at=now(), updated_by=$1 WHERE id=$2`, [userId, e.txn_id]);
        }
        await run(`DELETE FROM marketing_spend_lines WHERE id=$1`, [e.id]);
      }
      // 유지·수정 라인 + 신규 라인
      for (const l of flat) {
        if (l.id != null && exMap.has(Number(l.id))) {
          const e = exMap.get(Number(l.id));
          const changed = e.kind !== l.kind || e.due_date !== l.due_date || Math.abs(num(e.amount) - l.amount) > 0.001
            || (e.memo || null) !== l.memo || Number(e.item_id) !== Number(l.itemId);
          if (e.txn_status === 'actual' && !e.txn_deleted) {
            if (changed) return { error: 'line_locked', line_id: Number(l.id), reason: 'paid' };
            await run(`UPDATE marketing_spend_lines SET sort_order=$1 WHERE id=$2`, [l.sort_order, l.id]);
            continue;
          }
          await run(
            `UPDATE marketing_spend_lines SET item_id=$1, kind=$2, due_date=$3, amount=$4, memo=$5, sort_order=$6 WHERE id=$7`,
            [l.itemId, l.kind, l.due_date, l.amount, l.memo, l.sort_order, l.id]);
          if (e.txn_id != null && !e.txn_deleted) {
            await run(
              `UPDATE transactions SET txn_date=$1, plan_date=$1, amount=$2, amount_mxn=$2, plan_amount=$2, memo=$3, updated_by=$4 WHERE id=$5`,
              [l.due_date, l.amount, spendTxnMemo(h.title, l.itemName, l.kind, l.memo), userId, e.txn_id]);
          }
        } else {
          const r = await run(
            `INSERT INTO marketing_spend_lines (plan_id, item_id, kind, due_date, amount, memo, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [id, l.itemId, l.kind, l.due_date, l.amount, l.memo, l.sort_order]);
          const lineId = Number(r.rows[0].id);
          const t = await run(
            `INSERT INTO transactions
               (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, memo, created_by, plan_amount, plan_date)
             VALUES (NULL,$1,'out',$2,'MXN',1,$2,'6070','plan','general',true,$3,$4,$3,$2,$1) RETURNING id`,
            [l.due_date, l.amount, userId, spendTxnMemo(h.title, l.itemName, l.kind, l.memo)]);
          await run(`UPDATE marketing_spend_lines SET txn_id=$1 WHERE id=$2`, [t.rows[0].id, lineId]);
        }
      }
      // 3) 빈 항목 정리(라인 삭제가 모두 통과한 뒤)
      for (const e of exItems) {
        if (!keepItemIds.has(Number(e.id))) {
          await run(`DELETE FROM marketing_spend_items WHERE id=$1 AND plan_id=$2`, [e.id, id]);
        }
      }
      // 4) 디렉터가 저장했으므로 담당자 수정 요청은 종료(반영 또는 대체)
      await run(`UPDATE marketing_spend_plans SET pending_revision=NULL, revision_by=NULL, revision_at=NULL WHERE id=$1`, [id]);
      return { ok: true, synced: true, revision_cleared: p.pending_revision != null };
    });
    if (result.error) return reply.code(409).send(result);
    await syncPlanCalendar(query, id, userId); // 커밋 후 best-effort(실패해도 저장 유지) — 승인건 수정 시 일정 재동기화
    await logEvent({ userId, action: 'update', target: `mktspend:${id}` });
    return result;
  });

  // =====================================================================
  // 제출(승인 요청) / 회수
  // =====================================================================
  app.post('/api/mktspend/plans/:id/submit', { preHandler: [authGuard, requirePageEdit('marketing')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const p = (await query(`SELECT * FROM marketing_spend_plans WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (!['draft', 'rejected'].includes(p.status)) return reply.code(409).send({ error: 'bad_status', status: p.status });
    if (!isDirector(req) && Number(p.created_by) !== Number(req.ctx.perm.userId)) return reply.code(403).send({ error: 'not_owner' });
    const n = (await query(`SELECT COUNT(*) AS n FROM marketing_spend_lines WHERE plan_id=$1`, [id])).rows[0];
    if (!(Number(n.n) > 0)) return reply.code(400).send({ error: 'lines_required' });
    await query(
      `UPDATE marketing_spend_plans SET status='submitted', submitted_at=now(), reject_reason=NULL, updated_by=$1 WHERE id=$2`,
      [req.ctx.perm.userId, id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `mktspend:${id}`, detail: { submit: true } });
    return { ok: true };
  });

  app.post('/api/mktspend/plans/:id/withdraw', { preHandler: [authGuard, requirePageEdit('marketing')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const p = (await query(`SELECT * FROM marketing_spend_plans WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (p.status !== 'submitted') return reply.code(409).send({ error: 'bad_status', status: p.status });
    if (!isDirector(req) && Number(p.created_by) !== Number(req.ctx.perm.userId)) return reply.code(403).send({ error: 'not_owner' });
    await query(`UPDATE marketing_spend_plans SET status='draft', updated_by=$1 WHERE id=$2`, [req.ctx.perm.userId, id]);
    return { ok: true };
  });

  // =====================================================================
  // 수정 요청 폐기(0124) — 디렉터(반려) 또는 요청자·담당자 본인(취소).
  //   승인본·자금계획은 그대로 유지된다.
  // =====================================================================
  app.post('/api/mktspend/plans/:id/discard-revision', { preHandler: [authGuard, requirePageEdit('marketing')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!(id > 0)) return reply.code(400).send({ error: 'bad_id' });
    const p = (await query(`SELECT * FROM marketing_spend_plans WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (p.pending_revision == null) return reply.code(409).send({ error: 'no_revision' });
    const meId = Number(req.ctx.perm.userId);
    if (!isDirector(req) && Number(p.revision_by) !== meId && Number(p.created_by) !== meId) {
      return reply.code(403).send({ error: 'not_allowed' });
    }
    await query(
      `UPDATE marketing_spend_plans SET pending_revision=NULL, revision_by=NULL, revision_at=NULL, updated_by=$1 WHERE id=$2`,
      [meId, id]);
    await logEvent({ userId: meId, action: 'update', target: `mktspend:${id}`, detail: { revision_discard: true } });
    return { ok: true };
  });

  // =====================================================================
  // 승인(디렉터) — 모든 항목의 지급 라인마다 계획 거래 생성 → 자금계획 연결
  //   본문에 수정 내용(title/items/targets 등)을 함께 보내면 반영 후 승인.
  // =====================================================================
  app.post('/api/mktspend/plans/:id/approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!(id > 0)) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {};
    const p = (await query(`SELECT * FROM marketing_spend_plans WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (!['submitted', 'draft', 'rejected'].includes(p.status)) return reply.code(409).send({ error: 'bad_status', status: p.status });

    // 수정 내용이 오면 검증(없으면 저장된 내용 그대로 승인)
    let h = null, ni = null, nt = null;
    if (b.title != null || b.items != null || b.targets != null) {
      h = headerFields({ title: b.title != null ? b.title : p.title, category: b.category, event_date: b.event_date, purpose: b.purpose });
      if (h.error) return reply.code(400).send({ error: h.error });
      ni = normalizeItems(b.items);
      if (ni.error) return reply.code(400).send(ni);
      nt = normalizeTargets(b.targets);
      if (nt.error) return reply.code(400).send(nt);
      if (!(await validateCustomers(nt.custIds))) return reply.code(400).send({ error: 'customer_not_found' });
    }
    const userId = req.ctx.perm.userId;
    const result = await withTx(async (c) => {
      const run = (s, p2) => c.query(s, p2);
      let title = p.title;
      if (h) {
        title = h.title;
        await run(`UPDATE marketing_spend_plans SET title=$1, category=$2, event_date=$3, purpose=$4, updated_by=$5 WHERE id=$6`,
          [h.title, h.category, h.eventDate, h.purpose, userId, id]);
        await replaceTargets(run, id, nt.custIds, nt.general);
        await run(`DELETE FROM marketing_spend_lines WHERE plan_id=$1`, [id]);
        await run(`DELETE FROM marketing_spend_items WHERE plan_id=$1`, [id]);
        await insertItemsWithLines(run, id, ni.items);
      }
      const lines = (await run(
        `SELECT l.id, l.kind, to_char(l.due_date,'YYYY-MM-DD') AS due_date, l.amount, l.memo,
                COALESCE(i.name,'기본 집행') AS item_name
           FROM marketing_spend_lines l
           LEFT JOIN marketing_spend_items i ON i.id=l.item_id
          WHERE l.plan_id=$1 ORDER BY l.sort_order, l.id`, [id])).rows;
      if (!lines.length) return { error: 'lines_required' };
      const txnIds = [];
      for (const l of lines) {
        const t = await run(
          `INSERT INTO transactions
             (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, memo, created_by, plan_amount, plan_date)
           VALUES (NULL,$1,'out',$2,'MXN',1,$2,'6070','plan','general',true,$3,$4,$3,$2,$1) RETURNING id`,
          [l.due_date, r2(num(l.amount)), userId, spendTxnMemo(title, l.item_name, l.kind, l.memo)]);
        await run(`UPDATE marketing_spend_lines SET txn_id=$1 WHERE id=$2`, [t.rows[0].id, l.id]);
        txnIds.push(Number(t.rows[0].id));
      }
      await run(`UPDATE marketing_spend_plans SET status='approved', decided_by=$1, decided_at=now(), reject_reason=NULL, updated_by=$1 WHERE id=$2`, [userId, id]);
      return { ok: true, txn_ids: txnIds };
    });
    if (result.error) return reply.code(400).send(result);
    await syncPlanCalendar(query, id, userId); // 커밋 후 best-effort — 승인 시 일정 달력 자동 등록
    await logEvent({ userId, action: 'update', target: `mktspend:${id}`, detail: { approve: true, txns: result.txn_ids.length } });
    return result;
  });

  // 반려(디렉터, 사유 필수)
  app.post('/api/mktspend/plans/:id/reject', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!reason) return reply.code(400).send({ error: 'reason_required' });
    const p = (await query(`SELECT * FROM marketing_spend_plans WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (p.status !== 'submitted') return reply.code(409).send({ error: 'bad_status', status: p.status });
    await query(
      `UPDATE marketing_spend_plans SET status='rejected', reject_reason=$1, decided_by=$2, decided_at=now(), updated_by=$2 WHERE id=$3`,
      [reason.slice(0, 500), req.ctx.perm.userId, id]);
    await syncPlanCalendar(query, id, req.ctx.perm.userId); // best-effort — 반려 → 일정 제거
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `mktspend:${id}`, detail: { reject: true } });
    return { ok: true };
  });

  // =====================================================================
  // 삭제(soft) — 작성자(draft/rejected) 또는 디렉터. 승인건은 지급완료 없을 때만.
  // =====================================================================
  app.delete('/api/mktspend/plans/:id', { preHandler: [authGuard, requirePageEdit('marketing')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const p = (await query(`SELECT * FROM marketing_spend_plans WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const dir = isDirector(req);
    const mine = Number(p.created_by) === Number(req.ctx.perm.userId);
    if (!dir && !(mine && ['draft', 'rejected'].includes(p.status))) return reply.code(403).send({ error: 'not_allowed' });
    const result = await withTx(async (c) => {
      const run = (s, p2) => c.query(s, p2);
      if (p.status === 'approved') {
        const paid = (await run(
          `SELECT COUNT(*) AS n FROM marketing_spend_lines l JOIN transactions t ON t.id=l.txn_id
            WHERE l.plan_id=$1 AND t.status='actual' AND t.deleted_at IS NULL`, [id])).rows[0];
        if (Number(paid.n) > 0) return { error: 'has_paid_lines' };
        const txns = (await run(`SELECT txn_id FROM marketing_spend_lines WHERE plan_id=$1 AND txn_id IS NOT NULL`, [id])).rows;
        for (const t of txns) {
          await run(`UPDATE transactions SET deleted_at=now(), updated_by=$1 WHERE id=$2 AND deleted_at IS NULL`, [req.ctx.perm.userId, t.txn_id]);
        }
      }
      await run(`UPDATE marketing_spend_plans SET deleted_at=now(), updated_by=$1 WHERE id=$2`, [req.ctx.perm.userId, id]);
      return { ok: true };
    });
    if (result.error) return reply.code(409).send(result);
    await syncPlanCalendar(query, id, req.ctx.perm.userId); // best-effort — 삭제 → 일정 제거
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `mktspend:${id}` });
    return result;
  });

  // =====================================================================
  // 증빙 파일 — 인보이스 첨부(0091) 패턴
  // =====================================================================
  app.get('/api/mktspend/plans/:id/files', { preHandler: [authGuard, requirePage('marketing')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!(id > 0)) return reply.code(400).send({ error: 'bad_id' });
    const rows = (await query(
      `SELECT f.id, f.file_name, f.mime_type, f.file_size, f.uploaded_at, u.name AS uploaded_by_name
         FROM marketing_spend_files f LEFT JOIN users u ON u.id=f.uploaded_by
        WHERE f.plan_id=$1 ORDER BY f.id DESC`, [id])).rows;
    return { items: rows.map((f) => ({ id: Number(f.id), file_name: f.file_name, mime_type: f.mime_type,
      file_size: f.file_size == null ? null : Number(f.file_size), uploaded_at: f.uploaded_at, uploaded_by_name: f.uploaded_by_name })) };
  });

  app.post('/api/mktspend/plans/:id/files', { preHandler: [authGuard, requirePageEdit('marketing')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!(id > 0)) return reply.code(400).send({ error: 'bad_id' });
    const p = (await query(`SELECT id FROM marketing_spend_plans WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {};
    const v = validateSpendFileDataUrl(b.data);
    if (!v.ok) return reply.code(400).send({ error: 'invalid_file', note: v.error });
    const name = String(b.file_name || 'archivo').slice(0, 200);
    const r = (await query(
      `INSERT INTO marketing_spend_files (plan_id, file_name, mime_type, file_data, file_size, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, uploaded_at`,
      [id, name, v.mime, v.data, v.size, req.ctx.perm.userId])).rows[0];
    return { ok: true, id: Number(r.id), uploaded_at: r.uploaded_at };
  });

  app.get('/api/mktspend/files/:fileId', { preHandler: [authGuard, requirePage('marketing')] }, async (req, reply) => {
    const fid = Number(req.params.fileId);
    if (!(fid > 0)) return reply.code(400).send({ error: 'bad_id' });
    const f = (await query(`SELECT id, plan_id, file_name, mime_type, file_data FROM marketing_spend_files WHERE id=$1`, [fid])).rows[0];
    if (!f) return reply.code(404).send({ error: 'not_found' });
    return { id: Number(f.id), plan_id: Number(f.plan_id), file_name: f.file_name, mime_type: f.mime_type, file_data: f.file_data };
  });

  app.delete('/api/mktspend/files/:fileId', { preHandler: [authGuard, requirePageEdit('marketing')] }, async (req, reply) => {
    const fid = Number(req.params.fileId);
    if (!(fid > 0)) return reply.code(400).send({ error: 'bad_id' });
    const r = await query(`DELETE FROM marketing_spend_files WHERE id=$1 RETURNING plan_id`, [fid]);
    if (!r.rows.length) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
