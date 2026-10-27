// =====================================================================
// Refatrix ERP · pfCatalog.js — REFATRIX Platform 「제품 카탈로그 점검」 (0302 · 2026-10-27)
//
//   흐름
//     CTR 개발담당자(플랫폼 로그인) → 부품별로 ERP 의 지금 값을 본다 → 고칠 칸을 고쳐 둔다(수정안)
//     → [확인완료] → 그 자리에서 ERP 제품 마스터에 반영(디렉터 승인 없음) → CRM 즉시 전송 예약.
//
//   설계에서 양보하지 않은 것
//     1) **플랫폼에 사본을 두지 않는다.** 화면은 ERP 를 직접 읽는다. 그래서 ERP 현장 수정·신규 품목이
//        플랫폼에 「전송」될 필요가 없고, 두 곳이 어긋날 수가 없다.
//     2) **현장 수정이 조용히 덮이지 않는다.** 수정안에는 시작 때의 ERP 값(base)을 함께 둔다.
//        확인완료 순간 ERP 값이 base 와 다르면(그사이 현장 수정) 그 칸은 반영하지 않고 사람에게 묻는다.
//     3) **가격·재고는 이 경로에 없다.** 읽지도 쓰지도 않는다.
//     4) 점검 상태는 저장하지 않고 지문(md5)으로 계산한다 — 상태표가 실제 값과 어긋날 수 없다.
//
//   순수 함수(정규화·비교·수정안 병합·확인 계획)는 DB 를 모른다 — 테스트가 쉽다.
// =====================================================================
import { query, withTx } from './db.js';
import { normalizeMaterial, splitSyd, parseApplications } from './productImport.js';
import { parseOe, formatOe } from './oeParse.js';
import { syncOe } from './oeCodes.js';

// CTR 이 고칠 수 있는 칸 — 제품 마스터 이름 그대로. 코드(키)·가격·재고·SAT 등은 없다.
export const PF_FIELDS = ['name', 'scode', 'app', 'oe', 'material'];
export const PF_LABELS = {
  name: '제품명', scode: 'SYD 코드', app: '적용차종', oe: 'OE 번호', material: '소재',
};

// 0302 이 아직 적용되지 않은 환경에서 서버가 죽지 않게 — 긍정은 영구, 부정은 30초마다 다시 본다.
let readyFlag = false; let probeAt = 0;
export async function pfCatalogReady() {
  if (readyFlag) return true;
  if (Date.now() - probeAt < 30000) return false;
  probeAt = Date.now();
  try {
    const r = await query(`SELECT to_regclass('public.pf_catalog_review') AS a, to_regclass('public.pf_catalog_confirms') AS b,
                                  to_regclass('public.pf_catalog_exports') AS c`);
    readyFlag = !!(r.rows[0] && r.rows[0].a && r.rows[0].b && r.rows[0].c);
  } catch (_) { readyFlag = false; }
  return readyFlag;
}
export function setPfCatalogReady(v) { readyFlag = !!v; probeAt = Date.now(); }

// ─────────────────────────── 순수 규칙 ───────────────────────────

/**
 * 칸 값 정규화 — 저장 · 비교에 같은 규칙. 빈 값은 null.
 *   SYD · 적용차종은 ' // ' 구분 목록이라 구분자 모양(A//B · A // B)이 달라도 같은 값으로 본다.
 *   (그렇지 않으면 열기만 해도 「수정됨」 이 되고, 확인하면 ERP 를 괜히 다시 쓴다)
 */
export function normValue(field, v) {
  if (field === 'material') return normalizeMaterial(v);
  if (field === 'oe') {
    if (v == null || String(v).trim() === '') return null;
    const f = formatOe(parseOe(v));
    return f ? f : null;
  }
  if (field === 'scode' || field === 'app') {
    if (v == null) return null;
    const parts = String(v).split(/\s*\/\/\s*/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return parts.length ? parts.join(' // ') : null;
  }
  if (v == null) return null;
  const s = String(v).replace(/\r\n?/g, '\n').trim();
  return s === '' ? null : s;
}

/** 같은 값인가 — null 과 빈 문자열은 같다, 앞뒤 공백 무시. */
export function same(a, b) {
  const x = a == null ? '' : String(a).trim();
  const y = b == null ? '' : String(b).trim();
  return x === y;
}
/** 칸 규칙으로 정규화한 뒤 같은가. */
export function eqF(field, a, b) { return same(normValue(field, a), normValue(field, b)); }

/** 저장된 draft(JSONB) 를 안전한 모양으로 — 모르는 칸·깨진 값은 버린다. */
export function cleanDraft(draft) {
  const out = {};
  if (!draft || typeof draft !== 'object') return out;
  for (const f of PF_FIELDS) {
    const d = draft[f];
    if (!d || typeof d !== 'object' || !('value' in d)) continue;
    out[f] = { base: d.base === undefined ? null : d.base, value: d.value === undefined ? null : d.value };
  }
  return out;
}

const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

/**
 * 수정안 병합.
 *   cur      — 지금 ERP 값 {name, scode, app, oe, material}
 *   prev     — 저장돼 있던 수정안
 *   incoming — 이번에 보낸 칸들 {field: value}
 *   loaded   — 화면이 **열 때 받은** ERP 값 {field: value} (없으면 지금 값으로 본다)
 *   · base(수정 시작 때 ERP 값) = 예전 수정안의 base, 없으면 화면이 열 때 받은 값.
 *     → 화면을 연 뒤 ERP 가 바뀌었으면 확인 때 겹침으로 잡힌다(오래된 화면이 새 값을 덮지 않는다).
 *   · 제안 값이 지금 ERP 값과 같거나, base 와 같으면(손대지 않음) 그 칸은 수정안에서 빠진다.
 *   returns { draft, errors:[{field, error}] }
 */
export function mergeDraft(cur, prev, incoming, loaded = null) {
  const draft = cleanDraft(prev);
  const errors = [];
  for (const f of Object.keys(incoming || {})) {
    if (!PF_FIELDS.includes(f)) continue;
    const nv = normValue(f, incoming[f]);
    if (f === 'name' && nv == null) { errors.push({ field: f, error: 'name_required' }); continue; }
    const base = draft[f] ? draft[f].base : (has(loaded, f) ? loaded[f] : cur[f]) ?? null;
    if (eqF(f, nv, cur[f]) || eqF(f, nv, base)) { delete draft[f]; continue; }
    draft[f] = { base, value: nv };
  }
  return { draft, errors };
}

/**
 * 화면이 열 때 본 값과 지금 ERP 값이 다른 칸(수정안이 없는 칸만) — 확인완료를 막는다.
 *   그대로 두면 「그대로 맞음」 확인이 사람이 보지도 않은 새 값을 확인한 것으로 남는다.
 */
export function staleFields(cur, draft, loaded) {
  if (!loaded || typeof loaded !== 'object') return [];
  const d = cleanDraft(draft);
  return PF_FIELDS.filter((f) => !d[f] && has(loaded, f) && !eqF(f, loaded[f], cur[f]));
}

/**
 * 수정안 각 칸의 상태 — 화면이 「현장에서 바뀜」 을 그릴 때 쓴다.
 *   ok       : base = 지금 ERP 값 → 확인완료 때 그대로 반영
 *   moot     : 지금 ERP 값이 이미 제안 값과 같다 → 반영할 것 없음
 *   conflict : 그사이 ERP 에서 바뀌었다 → 어느 쪽을 쓸지 골라야 한다
 */
export function draftState(cur, draft) {
  const out = {};
  const d = cleanDraft(draft);
  for (const f of Object.keys(d)) {
    const x = d[f];
    if (eqF(f, x.value, cur[f])) out[f] = { ...x, erp: cur[f] ?? null, state: 'moot' };
    else if (eqF(f, x.base, cur[f])) out[f] = { ...x, erp: cur[f] ?? null, state: 'ok' };
    else out[f] = { ...x, erp: cur[f] ?? null, state: 'conflict' };
  }
  return out;
}

/**
 * 확인완료 계획.
 *   resolve — 겹친 칸마다 { field: 'mine' | 'erp' }
 *   returns { apply:{f:{from,to}}, chosen:{f:{base,erp,mine,chose}}, unresolved:[{field,base,erp,mine}] }
 */
export function planConfirm(cur, draft, resolve = {}) {
  const apply = {}; const chosen = {}; const unresolved = [];
  const st = draftState(cur, draft);
  for (const f of Object.keys(st)) {
    const x = st[f];
    if (x.state === 'moot') continue;
    if (x.state === 'ok') { apply[f] = { from: cur[f] ?? null, to: x.value }; continue; }
    const pick = resolve && resolve[f];
    if (pick === 'mine') {
      apply[f] = { from: cur[f] ?? null, to: x.value };
      chosen[f] = { base: x.base, erp: cur[f] ?? null, mine: x.value, chose: 'mine' };
    } else if (pick === 'erp') {
      chosen[f] = { base: x.base, erp: cur[f] ?? null, mine: x.value, chose: 'erp' };
    } else {
      unresolved.push({ field: f, base: x.base, erp: cur[f] ?? null, mine: x.value });
    }
  }
  return { apply, chosen, unresolved };
}

/** 미리보기 — ERP 가 저장하면서 나눠 넣을 모양(적용차종 줄 · SYD 코드 · OE). */
export function previewDerived(vals) {
  return {
    syd: splitSyd(vals.scode),
    apps: parseApplications(vals.app).map((a) => ({
      texto: a.app_text, marca: a.maker, modelo: a.model, desde: a.year_from, hasta: a.year_to,
    })),
    oe: parseOe(vals.oe).map((it) => ({ codigo: it.oe_code, tipo: it.rel === 'for' ? 'CONJUNTO' : 'OE' })),
  };
}

// ─────────────────────────── SQL 조각 ───────────────────────────

/** 카탈로그 칸 지문 — 확인 때 저장한 값과 지금 값을 비교한다. 칸 순서 = PF_FIELDS. */
export const FP_SQL = (a = 'p') => `md5(concat_ws(chr(31),
  COALESCE(btrim(${a}.name),''), COALESCE(btrim(${a}.scode),''), COALESCE(btrim(${a}.app),''),
  COALESCE(btrim(${a}.oe),''), COALESCE(btrim(${a}.material),'')))`;

export const STATUS_SQL = `CASE
  WHEN r.draft IS NOT NULL AND r.draft <> '{}'::jsonb THEN 'draft'
  WHEN r.confirmed_hash IS NULL THEN 'pending'
  WHEN r.confirmed_hash = ${FP_SQL('p')} THEN 'ok'
  ELSE 'changed' END`;

// 점검 대상 — 삭제 안 됨 · 코드 있음 · PRO 접두어(사내 코드) 아님 · VIO 프로모션 키트(K0001…) 아님.
//   고객 카탈로그 API 와 같은 기준이다(catalogPull.excludeSql 기본값).
export const TARGET_SQL = `p.deleted_at IS NULL AND p.code IS NOT NULL AND btrim(p.code) <> ''
  AND upper(p.code) NOT LIKE 'PRO%' AND upper(p.code) !~ '^K[0-9]{4,}$'`;

export const STATUSES = ['pending', 'draft', 'ok', 'changed'];

/** 화면에 보낼 1행. 가격·재고 칸은 처음부터 SELECT 하지 않는다. */
export function rowView(r) {
  const cur = { name: r.name, scode: r.scode, app: r.app, oe: r.oe, material: r.material };
  const ds = draftState(cur, r.draft);
  return {
    id: Number(r.id),
    code: r.code,
    ...cur,
    activo: r.is_active !== false,
    status: r.status,
    draft: ds,
    draft_conflicts: Object.values(ds).filter((x) => x.state === 'conflict').length,
    draft_note: r.draft_note || null,
    draft_by_name: r.draft_by_name || null,
    draft_at: r.draft_at || null,
    confirmed_at: r.confirmed_at || null,
    confirmed_by_name: r.confirmed_by_name || null,
    confirm_count: Number(r.confirm_count || 0),
    erp_changed_at: r.erp_changed_at || null,
    rev: r.rev || '',   // 점검 상태 행의 판(수정안 · 확인 때마다 바뀐다) — 다른 사람이 그사이 저장했는지 알아본다
  };
}

const LIST_COLS = `p.id, p.code, p.name, p.scode, p.app, p.oe, p.material, p.is_active,
  r.draft, r.draft_note, r.draft_by_name, r.draft_at, r.confirmed_at, r.confirmed_by_name, r.confirm_count,
  r.updated_at::text AS rev,
  (SELECT max(l.created_at) FROM product_change_log l WHERE l.product_id = p.id) AS erp_changed_at,
  ${STATUS_SQL} AS status`;

const SORTS = {
  code: 'code ASC',
  recent: 'erp_changed_at DESC NULLS LAST, code ASC',
  confirmed: 'confirmed_at DESC NULLS LAST, code ASC',
};

/**
 * 목록 — 검색(코드·제품명·SYD·적용차종·OE) · 상태 · 판매중만 · 정렬 · 페이지.
 *   returns { items, total }
 */
/** 거르기 조건 → SQL. 상태는 목록에 있는 값만(그 밖의 값은 무시) — 문자열을 그대로 SQL 에 넣지 않는다. */
function filterSql({ q = '', status = '', active = 'all' } = {}) {
  const params = [];
  let where = TARGET_SQL;
  const s = String(q || '').trim();
  if (s) {
    params.push(`%${s.replace(/[\\%_]/g, (m) => '\\' + m)}%`);   // % _ 는 글자 그대로 찾는다
    const i = params.length;
    where += ` AND (p.code ILIKE $${i} OR p.name ILIKE $${i} OR p.scode ILIKE $${i} OR p.app ILIKE $${i} OR p.oe ILIKE $${i})`;
  }
  if (active === '1') where += ` AND p.is_active IS NOT FALSE`;
  if (active === '0') where += ` AND p.is_active IS FALSE`;
  const inner = `SELECT ${LIST_COLS} FROM products p LEFT JOIN pf_catalog_review r ON r.product_id = p.id WHERE ${where}`;
  const st = STATUSES.includes(status) ? status : '';
  if (st) params.push(st);
  const outerWhere = st ? `WHERE x.status = $${params.length}` : '';
  return { inner, outerWhere, params, status: st };
}

export async function listItems({ q = '', status = '', active = 'all', sort = 'code', limit = 50, offset = 0 } = {}) {
  const { inner, outerWhere, params } = filterSql({ q, status, active });
  const order = SORTS[sort] || SORTS.code;
  const lim = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const off = Math.min(1000000, Math.max(0, parseInt(offset, 10) || 0));
  const rows = (await query(
    `SELECT * FROM (${inner}) x ${outerWhere} ORDER BY ${order} LIMIT ${lim} OFFSET ${off}`, params)).rows;
  const total = Number((await query(
    `SELECT count(*)::int AS n FROM (${inner}) x ${outerWhere}`, params)).rows[0].n);
  return { items: rows.map(rowView), total };
}

/** 상태별 건수 — 화면 위 숫자 칸. 판매중/전체 둘 다. */
export async function summary() {
  const rows = (await query(
    `SELECT ${STATUS_SQL} AS status, (p.is_active IS NOT FALSE) AS activo, count(*)::int AS n
       FROM products p LEFT JOIN pf_catalog_review r ON r.product_id = p.id
      WHERE ${TARGET_SQL}
      GROUP BY 1, 2`)).rows;
  const all = { pending: 0, draft: 0, ok: 0, changed: 0, total: 0 };
  const act = { pending: 0, draft: 0, ok: 0, changed: 0, total: 0 };
  for (const r of rows) {
    all[r.status] += r.n; all.total += r.n;
    if (r.activo) { act[r.status] += r.n; act.total += r.n; }
  }
  return { all, active: act };
}

/** 1건 + 최근 ERP 이력(카탈로그 칸) + 확인 이력. */
export async function getItem(id) {
  const r = (await query(
    `SELECT ${LIST_COLS} FROM products p LEFT JOIN pf_catalog_review r ON r.product_id = p.id
      WHERE ${TARGET_SQL} AND p.id = $1`, [Number(id)])).rows[0];
  if (!r) return null;
  const hist = (await query(
    `SELECT l.created_at, l.action, l.source, l.changes, u.name AS by_name
       FROM product_change_log l LEFT JOIN users u ON u.id = l.changed_by
      WHERE l.product_id = $1 ORDER BY l.id DESC LIMIT 15`, [Number(id)])).rows;
  const confirms = (await query(
    `SELECT created_at, pf_user_name, applied, conflicts, note FROM pf_catalog_confirms
      WHERE product_id = $1 ORDER BY id DESC LIMIT 10`, [Number(id)])).rows;
  const view = rowView(r);
  view.preview = previewDerived(view);
  view.history = hist.map((h) => {
    const ch = typeof h.changes === 'string' ? JSON.parse(h.changes) : (h.changes || {});
    const parts = PF_FIELDS.filter((f) => ch[f]).map((f) => ({ field: f, from: ch[f].from ?? null, to: ch[f].to ?? null }));
    const pf = ch._pf && ch._pf.to ? String(ch._pf.to) : null;
    return { at: h.created_at, action: h.action, source: h.source, by: pf || h.by_name || null, parts };
  }).filter((h) => h.parts.length || h.action === 'create');
  view.confirms = confirms.map((c) => ({
    at: c.created_at, by: c.pf_user_name, applied: c.applied || {}, conflicts: c.conflicts || null, note: c.note || null,
  }));
  return view;
}

/** 수정안 저장(또는 비우기). returns { ok, item } | { error } */
/** 화면이 열 때 본 판(rev)과 지금 판이 다르면 — 그사이 다른 사람이 수정안을 저장했거나 확인했다. */
async function revChanged(c, productId, rev) {
  if (rev === undefined || rev === null) return false;   // 보내지 않으면 검사하지 않는다(옛 화면 호환)
  const r = (await c.query(`SELECT updated_at::text AS rev FROM pf_catalog_review WHERE product_id = $1`, [productId])).rows[0];
  return String(rev) !== String((r && r.rev) || '');
}

export async function saveDraft(id, { fields = {}, note, pf, loaded = null, rev }) {
  return withTx(async (c) => {
    const cur = (await c.query(
      `SELECT p.id, p.code, p.name, p.scode, p.app, p.oe, p.material FROM products p
        WHERE ${TARGET_SQL} AND p.id = $1 FOR UPDATE`, [Number(id)])).rows[0];
    if (!cur) return { error: 'not_found' };
    const prev = (await c.query(`SELECT draft, draft_note FROM pf_catalog_review WHERE product_id = $1 FOR UPDATE`, [cur.id])).rows[0];
    if (await revChanged(c, cur.id, rev)) return { error: 'stale_review' };
    const { draft, errors } = mergeDraft(cur, prev ? prev.draft : {}, fields, loaded);
    if (errors.length) return { error: errors[0].error, field: errors[0].field };
    const hasDraft = Object.keys(draft).length > 0;
    // 메모: 보냈으면 그 값, 안 보냈으면 예전 값. 수정안이 비면 메모도 비운다.
    const noteV = !hasDraft ? null
      : note === undefined ? ((prev && prev.draft_note) || null)
        : (String(note || '').trim().slice(0, 1000) || null);
    await c.query(
      `INSERT INTO pf_catalog_review (product_id, draft, draft_note, draft_by, draft_by_name, draft_at, updated_at)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6, now())
       ON CONFLICT (product_id) DO UPDATE
          SET draft = EXCLUDED.draft, draft_note = EXCLUDED.draft_note,
              draft_by = EXCLUDED.draft_by, draft_by_name = EXCLUDED.draft_by_name,
              draft_at = EXCLUDED.draft_at, updated_at = now()`,
      [cur.id, JSON.stringify(draft), noteV, hasDraft ? pf.key : null, hasDraft ? pf.name : null,
        hasDraft ? new Date() : null]);
    return { ok: true, code: cur.code, fields: Object.keys(draft) };
  });
}

/** 수정안 버리기 — 확인 기록은 그대로 둔다. */
export async function discardDraft(id) {
  const r = await query(
    `UPDATE pf_catalog_review SET draft = '{}'::jsonb, draft_note = NULL, draft_by = NULL, draft_by_name = NULL,
            draft_at = NULL, updated_at = now() WHERE product_id = $1 RETURNING product_id`, [Number(id)]);
  return { ok: true, had: r.rowCount > 0 };
}

/**
 * 확인완료 — 수정안을 ERP 제품 마스터에 반영하고 「확인완료」 로 남긴다. 디렉터 승인 없음.
 *   fields  — 이 요청에서 함께 보낸 칸(편집 화면에서 바로 확인완료를 눌렀을 때). 먼저 수정안에 합친다.
 *   resolve — 현장 수정과 겹친 칸 { field: 'mine'|'erp' }. 비어 있는데 겹친 칸이 있으면 반영하지 않고 409.
 *   returns { ok, code, applied, chosen, derived:{syd,app,oe} } | { error, conflicts? }
 */
export async function confirmItem(id, { fields = {}, resolve = {}, note, pf, loaded = null, rev }) {
  return withTx(async (c) => {
    const cur = (await c.query(
      `SELECT p.id, p.code, p.name, p.scode, p.app, p.oe, p.material FROM products p
        WHERE ${TARGET_SQL} AND p.id = $1 FOR UPDATE`, [Number(id)])).rows[0];
    if (!cur) return { error: 'not_found' };
    const prev = (await c.query(`SELECT draft, draft_note FROM pf_catalog_review WHERE product_id = $1 FOR UPDATE`, [cur.id])).rows[0];
    if (await revChanged(c, cur.id, rev)) return { error: 'stale_review' };
    const { draft, errors } = mergeDraft(cur, prev ? prev.draft : {}, fields, loaded);
    if (errors.length) return { error: errors[0].error, field: errors[0].field };
    const plan = planConfirm(cur, draft, resolve);
    // 화면을 연 뒤 ERP 에서 바뀐 칸(손대지 않은 칸) — 보지 않은 값을 확인한 것으로 남기지 않는다
    const stale = staleFields(cur, draft, loaded);
    if (plan.unresolved.length || stale.length) {
      // 겹친 칸이 있으면 아무것도 바꾸지 않는다 — 다만 이번에 보낸 칸은 수정안으로 남겨 둔다(입력이 날아가지 않게).
      await c.query(
        `INSERT INTO pf_catalog_review (product_id, draft, draft_by, draft_by_name, draft_at, updated_at)
         VALUES ($1, $2::jsonb, $3, $4, now(), now())
         ON CONFLICT (product_id) DO UPDATE SET draft = EXCLUDED.draft, draft_by = EXCLUDED.draft_by,
                draft_by_name = EXCLUDED.draft_by_name, draft_at = now(), updated_at = now()`,
        [cur.id, JSON.stringify(draft), pf.key, pf.name]);
      if (plan.unresolved.length) return { error: 'conflict', conflicts: plan.unresolved };
      return { error: 'stale', fields: stale };
    }
    const fieldsApplied = Object.keys(plan.apply);
    if (fieldsApplied.includes('name') && plan.apply.name.to == null) return { error: 'name_required', field: 'name' };

    if (fieldsApplied.length) {
      const sets = []; const vals = [];
      for (const f of fieldsApplied) { vals.push(plan.apply[f].to); sets.push(`${f} = $${vals.length}`); }
      sets.push('updated_by = NULL');   // ERP 사용자가 아니다 — 확인자는 제품 이력(_pf)에 남는다
      vals.push(cur.id);
      await c.query(`UPDATE products SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
      // 파생 데이터 — 제품 화면 수정과 같은 불변식(지우고 다시 넣는다)
      if (plan.apply.scode) {
        await c.query(`DELETE FROM product_syd_codes WHERE product_id = $1`, [cur.id]);
        for (const sc of [...new Set(splitSyd(plan.apply.scode.to))]) {
          await c.query(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [cur.id, sc]);
        }
      }
      if (plan.apply.app) {
        await c.query(`DELETE FROM product_applications WHERE product_id = $1`, [cur.id]);
        for (const a of parseApplications(plan.apply.app.to)) {
          await c.query(
            `INSERT INTO product_applications (product_id, app_text, maker, model, year_from, year_to) VALUES ($1,$2,$3,$4,$5,$6)`,
            [cur.id, a.app_text, a.maker, a.model, a.year_from, a.year_to]);
        }
      }
      if (plan.apply.oe) await syncOe(c, cur.id, parseOe(plan.apply.oe.to));
      // 제품 이력 — 「CTR 확인(Platform)」 · 누가 했는지는 _pf 에(ERP 사용자가 아니라 changed_by 는 비운다)
      await c.query(
        `INSERT INTO product_change_log (product_id, code, action, source, changes, changed_by)
         VALUES ($1, $2, 'update', 'platform', $3::jsonb, NULL)`,
        [cur.id, cur.code, JSON.stringify({ ...plan.apply, _pf: { from: null, to: pf.name } })]);
    }
    const noteV = note === undefined ? (prev && prev.draft_note) || null : (String(note || '').trim().slice(0, 1000) || null);
    const fp = (await c.query(`SELECT ${FP_SQL('p')} AS h FROM products p WHERE p.id = $1`, [cur.id])).rows[0].h;
    await c.query(
      `INSERT INTO pf_catalog_review (product_id, draft, confirmed_hash, confirmed_at, confirmed_by, confirmed_by_name, confirm_count, updated_at)
       VALUES ($1, '{}'::jsonb, $2, now(), $3, $4, 1, now())
       ON CONFLICT (product_id) DO UPDATE
          SET draft = '{}'::jsonb, draft_note = NULL, draft_by = NULL, draft_by_name = NULL, draft_at = NULL,
              confirmed_hash = EXCLUDED.confirmed_hash, confirmed_at = now(),
              confirmed_by = EXCLUDED.confirmed_by, confirmed_by_name = EXCLUDED.confirmed_by_name,
              confirm_count = pf_catalog_review.confirm_count + 1, updated_at = now()`,
      [cur.id, fp, pf.key, pf.name]);
    await c.query(
      `INSERT INTO pf_catalog_confirms (product_id, code, pf_user, pf_user_name, applied, conflicts, note, crm_queued)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)`,
      [cur.id, cur.code, pf.key, pf.name, JSON.stringify(plan.apply),
        Object.keys(plan.chosen).length ? JSON.stringify(plan.chosen) : null, noteV, fieldsApplied.length > 0]);
    return {
      ok: true, id: cur.id, code: cur.code, applied: plan.apply, chosen: plan.chosen,
      derived: { syd: !!plan.apply.scode, app: !!plan.apply.app, oe: !!plan.apply.oe },
    };
  });
}

// ─────────────────────────── 엑셀 다운로드 (플랫폼) ───────────────────────────
export const EXPORT_MAX = 30000;

/**
 * 지금 거르기 조건의 품목 전부(코드순) + 적용차종 줄. 가격 · 재고는 없다.
 *   returns { items:[rowView…], apps:[{code, texto, marca, modelo, desde, hasta}], truncated }
 */
export async function exportItems(filters = {}) {
  const { inner, outerWhere, params } = filterSql(filters);
  const rows = (await query(
    `SELECT * FROM (${inner}) x ${outerWhere} ORDER BY code ASC LIMIT ${EXPORT_MAX + 1}`, params)).rows;
  const truncated = rows.length > EXPORT_MAX;
  const list = rows.slice(0, EXPORT_MAX);
  const ids = list.map((r) => Number(r.id));
  const apps = ids.length ? (await query(
    `SELECT pa.product_id, pa.app_text, pa.maker, pa.model, pa.year_from, pa.year_to
       FROM product_applications pa WHERE pa.product_id = ANY($1::bigint[])
      ORDER BY pa.product_id, pa.id`, [ids])).rows : [];
  const codeOf = new Map(list.map((r) => [Number(r.id), r.code]));
  return {
    items: list.map(rowView),
    apps: apps.map((a) => ({ code: codeOf.get(Number(a.product_id)), texto: a.app_text, marca: a.maker, modelo: a.model,
      desde: a.year_from == null ? null : Number(a.year_from), hasta: a.year_to == null ? null : Number(a.year_to) })),
    truncated,
  };
}

/** 다운로드 1건 기록. returns { id, created_at } */
export async function logExport(rec) {
  const r = (await query(
    `INSERT INTO pf_catalog_exports (pf_user, pf_user_name, row_count, filters, gps_status, gps_lat, gps_lng, gps_acc,
                                     ip, geo_city, geo_region, geo_country, user_agent)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, created_at`,
    [rec.pf_user, rec.pf_user_name, rec.row_count, JSON.stringify(rec.filters || {}), rec.gps_status,
      rec.gps_lat, rec.gps_lng, rec.gps_acc, rec.ip, rec.geo_city, rec.geo_region, rec.geo_country, rec.user_agent])).rows[0];
  return { id: Number(r.id), created_at: r.created_at };
}

/** 디렉터 화면 — 다운로드 기록 최신순. */
export async function listExports({ limit = 50, offset = 0 } = {}) {
  const lim = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const off = Math.min(1000000, Math.max(0, parseInt(offset, 10) || 0));
  const rows = (await query(
    `SELECT * FROM pf_catalog_exports ORDER BY id DESC LIMIT ${lim} OFFSET ${off}`)).rows;
  const total = Number((await query(`SELECT count(*)::int AS n FROM pf_catalog_exports`)).rows[0].n);
  return {
    items: rows.map((r) => ({
      id: Number(r.id), at: r.created_at, user: r.pf_user_name || null, user_key: r.pf_user || null,
      rows: Number(r.row_count || 0), filters: r.filters || {},
      gps: r.gps_lat != null && r.gps_lng != null ? { lat: Number(r.gps_lat), lng: Number(r.gps_lng), acc: r.gps_acc == null ? null : Math.round(Number(r.gps_acc)) } : null,
      gps_status: r.gps_status || null,
      ip: r.ip || null, city: r.geo_city || null, region: r.geo_region || null, country: r.geo_country || null,
      user_agent: r.user_agent || null,
    })),
    total, limit: lim, offset: off,
  };
}
