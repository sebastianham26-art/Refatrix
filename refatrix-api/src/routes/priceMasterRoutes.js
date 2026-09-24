// =====================================================================
// Refatrix ERP · priceMasterRoutes.js  (2026-09-24 · v2 · 0229)
// 제품·마케팅 › 가격 마스터 — 디렉터 전용.
//
//   ① 가격표          GET  /api/price-master/table
//                     POST /api/price-master/single                 단일 수정(List 또는 FOB) — PIN
//                     POST /api/price-master/import/preview|commit  FOB·List 엑셀 — commit 은 PIN
//   ② 일괄 변경        GET  /api/price-master/facets
//                     POST /api/price-master/preview
//                     POST /api/price-master/batches                % · SYD 비율 · (SYD 제안 = set) — PIN
//   ③ 이력            GET  /api/price-master/batches · /batches/:id
//                     POST /api/price-master/batches/:id/cancel · /revert(PIN)
//   ④ 제품별 이력      GET  /api/price-master/product?code=
//   ⑤ 경쟁사 SYD       POST /api/price-master/syd/lists · GET /syd/lists · GET /syd/lists/:id/report · DELETE /syd/lists/:id(PIN)
//   ⑥ 구매가 검증      GET  /api/price-master/purchase-check · /purchase-check/:poId
// =====================================================================
import { query, withTx } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { verifyPin } from '../auth.js';
import { logEvent } from '../audit.js';
import {
  priceMasterReady, mxToday, isYmd, latestFx, normType, PRICE_COL, ROUNDINGS, normalizeFilter, normalizeChange,
  nvSql, eligibleSql, calcNewPrice, roundTo, buildFilterWhere, buildTargetWhere, describeFilter, createBatch,
  applyDue, revertBatch, MAX_SELECTED, sydNorm, SYD_NORM_SQL, parseSydRows, prevSydList, latestSydListId,
  compareSydCounts, syncProductSydPrices, purchaseLinesWithFob, summarizeFob,
} from '../priceMaster.js';

const num = (v) => (v == null ? null : Number(v));
const PRE = { preHandler: [authGuard, requireDirector] };

async function pinOk(perm, pin) {
  const r = (await query(`SELECT pin_hash FROM users WHERE id=$1`, [perm.userId])).rows[0];
  return verifyPin(String(pin || ''), r && r.pin_hash);
}

const ORIGIN_KO = { bulk: '일괄', single: '단일 수정', import: '엑셀', syd: 'SYD 제안' };
function batchOut(r) {
  const mode = r.mode || 'pct';
  let condition = describeFilter(r.scope, r.filter, Number(r.product_count));
  if (r.origin === 'single') condition = '단일 수정';
  else if (r.origin === 'import') condition = `엑셀 ${r.product_count}개`;
  else if (r.origin === 'syd') condition = `SYD 제안 ${r.product_count}개` + (r.syd_date ? ` (SYD ${r.syd_date})` : '');
  return {
    id: Number(r.id), price_type: r.price_type || 'list', mode, origin: r.origin || 'bulk',
    effective_date: r.eff, status: r.status,
    direction: num(r.direction), pct: num(r.pct), ratio: num(r.ratio), rounding: Number(r.rounding),
    scope: r.scope, filter: r.filter, condition, syd_list_id: num(r.syd_list_id),
    product_count: Number(r.product_count || 0),
    applied_count: num(r.applied_count), skipped_count: num(r.skipped_count),
    reverted_count: num(r.reverted_count), revert_skipped_count: num(r.revert_skipped_count),
    note: r.note, created_by_name: r.created_by_name || null, created_at: r.created_at,
    applied_at: r.applied_at, cancelled_at: r.cancelled_at, reverted_at: r.reverted_at,
  };
}
const BATCH_COLS = `b.id, b.price_type, b.mode, b.origin, to_char(b.effective_date,'YYYY-MM-DD') AS eff, b.status,
  b.direction, b.pct, b.ratio, b.rounding, b.scope, b.filter, b.syd_list_id, b.product_count, b.applied_count,
  b.skipped_count, b.reverted_count, b.revert_skipped_count, b.note, b.created_at, b.applied_at, b.cancelled_at,
  b.reverted_at, u.name AS created_by_name, to_char(sl.list_date,'YYYY-MM-DD') AS syd_date`;
const BATCH_FROM = `price_change_batches b LEFT JOIN users u ON u.id = b.created_by LEFT JOIN syd_price_lists sl ON sl.id = b.syd_list_id`;

/** 적용일 · 사유 공통 검증 */
function checkDateNote(b, today) {
  const eff = String(b.effective_date || today);
  if (!isYmd(eff)) return { error: 'bad_date' };
  if (eff < today) return { error: 'past_date', today };
  const note = String(b.note || '').trim().slice(0, 300);
  if (note.length < 2) return { error: 'note_required' };
  return { eff, note };
}

export default async function priceMasterRoutes(app) {
  async function gate(reply) {
    if (await priceMasterReady()) return true;
    reply.code(503).send({ error: 'migration_required', detail: '서버 마이그레이션(0229) 후에 쓸 수 있습니다.' });
    return false;
  }
  const noTargets = (reply) => reply.code(400).send({ error: 'no_targets', detail: '대상 제품이 없습니다.' });

  // ── 칩 · 환율 · 현재 평균 CTR÷SYD ──
  app.get('/api/price-master/facets', PRE, async () => {
    const ok = await priceMasterReady();
    const base = `p.deleted_at IS NULL`;
    const origin = (await query(
      `SELECT COALESCE(NULLIF(upper(trim(p.origin)),''),'__none__') AS v, COUNT(*)::int AS n
         FROM products p WHERE ${base} GROUP BY 1 ORDER BY 2 DESC, 1`)).rows;
    const cat = (await query(
      `SELECT upper(trim(p.name)) AS v, COUNT(*)::int AS n FROM products p
        WHERE ${base} AND COALESCE(trim(p.name),'') <> '' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 400`)).rows;
    const maker = (await query(
      `SELECT upper(pa.maker) AS v, COUNT(DISTINCT pa.product_id)::int AS n
         FROM product_applications pa JOIN products p ON p.id = pa.product_id
        WHERE ${base} AND COALESCE(pa.maker,'') <> '' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 300`)).rows;
    const material = (await query(
      `SELECT COALESCE(NULLIF(lower(trim(p.material)),''),'__none__') AS v, COUNT(*)::int AS n
         FROM products p WHERE ${base} GROUP BY 1 ORDER BY 2 DESC, 1`)).rows;
    const avg = (await query(
      `SELECT AVG(p.list_price / p.list_price_syd) AS r FROM products p
        WHERE ${base} AND p.is_active AND p.list_price > 0 AND p.list_price_syd > 0`)).rows[0];
    return { ready: ok, today: mxToday(), fx: await latestFx(), origin, cat, maker, material,
      ratio_avg: avg && avg.r != null ? Math.round(Number(avg.r) * 10000) / 10000 : null };
  });

  // ── ① 가격표 ──
  app.get('/api/price-master/table', PRE, async (req, reply) => {
    if (!(await gate(reply))) return;
    const qv = req.query || {};
    const fx = await latestFx();
    const params = [];
    const where = [buildFilterWhere({ q: qv.q, origin: qv.origin ? [qv.origin] : [], active_only: qv.all !== '1' }, params)];
    const multLt = Number(qv.mult_lt) > 0 ? Number(qv.mult_lt) : 3;
    const view = String(qv.view || '');
    if (view === 'no_fob') where.push('p.fob_usd IS NULL');
    else if (view === 'no_list') where.push('(p.list_price IS NULL OR p.list_price <= 0)');
    else if (view === 'syd_over') where.push('p.list_price > p.list_price_syd AND p.list_price_syd > 0');
    else if (view === 'mult_lt') {
      if (!fx) where.push('FALSE');
      else { params.push(fx.rate, multLt); where.push(`p.fob_usd > 0 AND p.list_price > 0 AND p.list_price / (p.fob_usd * $${params.length - 1}::numeric) < $${params.length}::numeric`); }
    }
    const W = where.join(' AND ');
    const k = (await query(
      `SELECT COUNT(*)::int AS n,
              COALESCE(SUM(CASE WHEN p.fob_usd > 0 THEN 1 ELSE 0 END),0)::int AS fob_n,
              COALESCE(SUM(CASE WHEN p.list_price > 0 THEN 1 ELSE 0 END),0)::int AS list_n,
              AVG(CASE WHEN p.fob_usd > 0 AND p.list_price > 0 THEN p.list_price / p.fob_usd END) AS mxn_per_usd,
              AVG(CASE WHEN p.list_price > 0 AND p.list_price_syd > 0 THEN p.list_price / p.list_price_syd END) AS ratio_avg
         FROM products p WHERE ${W}`, params)).rows[0];
    const SORT = { code: 'p.code', list: 'p.list_price DESC NULLS LAST, p.code', fob: 'p.fob_usd DESC NULLS LAST, p.code',
      ratio: '(p.list_price / NULLIF(p.list_price_syd,0)) ASC NULLS LAST, p.code', mult: '(p.list_price / NULLIF(p.fob_usd,0)) ASC NULLS LAST, p.code' };
    const limit = Math.min(Math.max(Number(qv.limit) || 200, 1), 20000);
    const offset = Math.max(Number(qv.offset) || 0, 0);
    const lp = params.slice(); lp.push(limit, offset);
    const rows = (await query(
      `SELECT p.id, p.code, p.name, p.origin, p.is_active, p.fob_usd, p.list_price, p.list_price_syd,
              (SELECT to_char(MAX(h.effective_date),'YYYY-MM-DD') FROM product_price_history h
                WHERE h.product_id = p.id AND h.source <> 'initial') AS last_change
         FROM products p WHERE ${W}
        ORDER BY ${SORT[qv.sort] || SORT.code} LIMIT $${lp.length - 1} OFFSET $${lp.length}`, lp)).rows;
    const fr = fx ? fx.rate : null;
    return {
      fx, today: mxToday(),
      kpi: { total: k.n, fob: k.fob_n, list: k.list_n,
        mult_avg: fr && k.mxn_per_usd != null ? Math.round(Number(k.mxn_per_usd) / fr * 100) / 100 : null,
        ratio_avg: k.ratio_avg != null ? Math.round(Number(k.ratio_avg) * 10000) / 10000 : null },
      offset, limit,
      rows: rows.map((r) => {
        const fob = num(r.fob_usd); const lp2 = num(r.list_price); const syd = num(r.list_price_syd);
        return { id: Number(r.id), code: r.code, name: r.name, origin: r.origin, is_active: r.is_active !== false,
          fob_usd: fob, list_price: lp2, list_price_syd: syd,
          mult: fr && fob > 0 && lp2 > 0 ? Math.round(lp2 / (fob * fr) * 100) / 100 : null,
          ratio: syd > 0 && lp2 > 0 ? Math.round(lp2 / syd * 10000) / 10000 : null,
          last_change: r.last_change };
      }),
    };
  });

  // ── ① 단일 수정 ──
  app.post('/api/price-master/single', PRE, async (req, reply) => {
    if (!(await gate(reply))) return;
    const { perm } = req.ctx; const b = req.body || {};
    if (!(await pinOk(perm, b.pin))) return reply.code(403).send({ error: 'bad_pin' });
    const t = normType(b.price_type);
    const price = Number(String(b.price ?? '').replace(/,/g, ''));
    if (!Number.isFinite(price) || price <= 0) return reply.code(400).send({ error: 'bad_price' });
    const today = mxToday(); const dn = checkDateNote(b, today);
    if (dn.error) return reply.code(400).send(dn);
    const pid = Number(b.product_id);
    const cur = (await query(`SELECT id, code, ${PRICE_COL[t]} AS v FROM products WHERE id=$1 AND deleted_at IS NULL`, [pid])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    const rounding = t === 'fob' ? 0.001 : 0.01;
    if (num(cur.v) === roundTo(price, rounding) && dn.eff === today) return reply.code(400).send({ error: 'same_price' });
    const out = await withTx((c) => createBatch(c, { price_type: t, mode: 'set', origin: 'single', rounding,
      effective_date: dn.eff, note: dn.note, items: [{ product_id: pid, price }], userId: perm.userId, today }));
    await logEvent({ userId: perm.userId, action: 'update', target: `price_batch:${out.id}`, detail: { single: cur.code, price_type: t, price, effective_date: dn.eff } });
    return { ok: true, id: out.id, status: out.applied ? 'applied' : 'scheduled', effective_date: dn.eff,
      applied_count: out.applied ? out.applied.applied : null };
  });

  // ── ① FOB·List 엑셀 ── rows:[{code, fob, list}] (프런트가 SheetJS 로 읽어 보낸다)
  async function importPlan(rows) {
    const clean = []; const errors = []; const seen = new Set();
    (Array.isArray(rows) ? rows : []).slice(0, 30000).forEach((r, i) => {
      const code = String(r && r.code != null ? r.code : '').trim().toUpperCase();
      const rowNo = (r && r._row) || i + 2;
      if (!code) return;
      const f = r.fob == null || r.fob === '' ? null : Number(String(r.fob).replace(/[$,\s]/g, ''));
      const l = r.list == null || r.list === '' ? null : Number(String(r.list).replace(/[$,\s]/g, ''));
      if ((f != null && !(f > 0)) || (l != null && !(l > 0))) { errors.push({ row: rowNo, code, reason: 'bad_price' }); return; }
      if (seen.has(code)) { errors.push({ row: rowNo, code, reason: 'dup_code' }); return; }
      seen.add(code); clean.push({ code, fob: f == null ? null : roundTo(f, 0.001), list: l == null ? null : roundTo(l, 0.01) });
    });
    const codes = clean.map((x) => x.code);
    const prods = codes.length ? (await query(
      `SELECT id, upper(code) AS code, fob_usd, list_price FROM products WHERE deleted_at IS NULL AND upper(code) = ANY($1::text[])`, [codes])).rows : [];
    const byCode = new Map(prods.map((p) => [p.code, p]));
    const fob = []; const list = []; const unknown = []; let same = 0;
    for (const x of clean) {
      const p = byCode.get(x.code);
      if (!p) { unknown.push(x.code); continue; }
      let changed = false;
      if (x.fob != null && num(p.fob_usd) !== x.fob) { fob.push({ product_id: Number(p.id), code: x.code, old: num(p.fob_usd), price: x.fob }); changed = true; }
      if (x.list != null && num(p.list_price) !== x.list) { list.push({ product_id: Number(p.id), code: x.code, old: num(p.list_price), price: x.list }); changed = true; }
      if (!changed) same++;
    }
    return { rows: clean.length, fob, list, unknown, same, errors };
  }
  app.post('/api/price-master/import/preview', PRE, async (req, reply) => {
    if (!(await gate(reply))) return;
    const p = await importPlan((req.body || {}).rows);
    return { rows: p.rows, fob_changes: p.fob.length, list_changes: p.list.length, same: p.same,
      unknown: p.unknown.slice(0, 500), unknown_count: p.unknown.length, errors: p.errors.slice(0, 500), error_count: p.errors.length,
      sample: [...p.fob.slice(0, 100).map((x) => ({ ...x, type: 'fob' })), ...p.list.slice(0, 100).map((x) => ({ ...x, type: 'list' }))] };
  });
  app.post('/api/price-master/import/commit', PRE, async (req, reply) => {
    if (!(await gate(reply))) return;
    const { perm } = req.ctx; const b = req.body || {};
    if (!(await pinOk(perm, b.pin))) return reply.code(403).send({ error: 'bad_pin' });
    const today = mxToday(); const dn = checkDateNote(b, today);
    if (dn.error) return reply.code(400).send(dn);
    const p = await importPlan(b.rows);
    if (!p.fob.length && !p.list.length) return noTargets(reply);
    const out = await withTx(async (c) => {
      const res = {};
      if (p.fob.length) res.fob = await createBatch(c, { price_type: 'fob', mode: 'set', origin: 'import', rounding: 0.001,
        effective_date: dn.eff, note: dn.note, items: p.fob, userId: perm.userId, today });
      if (p.list.length) res.list = await createBatch(c, { price_type: 'list', mode: 'set', origin: 'import', rounding: 0.01,
        effective_date: dn.eff, note: dn.note, items: p.list, userId: perm.userId, today });
      return res;
    });
    await logEvent({ userId: perm.userId, action: 'update', target: 'price_import',
      detail: { fob: out.fob ? out.fob.id : null, list: out.list ? out.list.id : null, effective_date: dn.eff } });
    const o = (x) => (x ? { id: x.id, count: x.product_count, applied: x.applied ? x.applied.applied : null } : null);
    return { ok: true, effective_date: dn.eff, fob: o(out.fob), list: o(out.list), unknown_count: p.unknown.length };
  });

  // ── ② 미리보기 (% · SYD 비율) ──
  app.post('/api/price-master/preview', PRE, async (req) => {
    const b = req.body || {};
    const scope = b.scope === 'selected' ? 'selected' : 'filter';
    const t = normType(b.price_type); const col = PRICE_COL[t]; const cur = 'p.' + col;
    const ch = normalizeChange({ ...b, price_type: t });
    const change = ch.error ? null : ch;
    const mode = change ? change.mode : (b.mode === 'ratio' ? 'ratio' : 'pct');
    const fx = await latestFx(); const fr = fx ? fx.rate : null;
    const limit = Math.min(Math.max(Number(b.limit) || 200, 1), 1000);
    const offset = Math.max(Number(b.offset) || 0, 0);
    const addChange = (arr) => {
      if (!change) return 'NULL::numeric';
      arr.push(change.direction || 0, change.pct || 0, change.rounding, change.ratio || 0);
      const n = arr.length;
      return `(${nvSql(mode, cur, { dir: n - 3, pct: n - 2, rnd: n - 1, ratio: n })} + 0*$${n - 3}::numeric + 0*$${n - 2}::numeric + 0*$${n}::numeric)`;
    };

    const lp = [];
    const lw = buildFilterWhere(b.filter, lp, { fx: fr });
    const nvL = addChange(lp);
    const pendingOn = await priceMasterReady();
    const pendingSql = pendingOn
      ? `EXISTS (SELECT 1 FROM price_change_items pi JOIN price_change_batches pb ON pb.id = pi.batch_id
                  WHERE pi.product_id = p.id AND pb.status = 'scheduled' AND pb.price_type = '${t}')`
      : 'false';
    lp.push(limit, offset);
    const rows = (await query(
      `SELECT p.id, p.code, p.name, p.origin, p.is_active, ${cur} AS cur, p.list_price, p.fob_usd, p.list_price_syd,
              CASE WHEN ${eligibleSql(mode, cur)} THEN ${nvL} END AS new_price,
              left(COALESCE(p.app,''), 90) AS app, ${pendingSql} AS pending
         FROM products p WHERE ${lw}
        ORDER BY p.code LIMIT $${lp.length - 1} OFFSET $${lp.length}`, lp)).rows;
    const cp = [];
    const matched = (await query(`SELECT COUNT(*)::int AS n FROM products p WHERE ${buildFilterWhere(b.filter, cp, { fx: fr })}`, cp)).rows[0].n;

    const sp = [];
    const tw = buildTargetWhere({ scope, filter: b.filter, product_ids: b.product_ids }, sp, { fx: fr });
    const nvS = addChange(sp);
    const el = eligibleSql(mode, cur);
    let multCols = 'NULL::numeric AS mult_before, NULL::numeric AS mult_after';
    if (t === 'list' && fr) {
      sp.push(fr); const fp = sp.length;
      multCols = `AVG(CASE WHEN ${el} AND p.fob_usd > 0 AND ${cur} > 0 THEN ${cur} / (p.fob_usd * $${fp}::numeric) END) AS mult_before,
                  AVG(CASE WHEN ${el} AND p.fob_usd > 0 THEN ${nvS} / (p.fob_usd * $${fp}::numeric) END) AS mult_after`;
    }
    const s = (await query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(CASE WHEN ${el} THEN 1 ELSE 0 END),0)::int AS eligible,
              COALESCE(SUM(CASE WHEN ${el} THEN COALESCE(${cur},0) ELSE 0 END),0) AS before_sum,
              COALESCE(SUM(CASE WHEN ${el} THEN ${nvS} ELSE 0 END),0) AS after_sum,
              COALESCE(SUM(CASE WHEN ${el} AND ${nvS} = ${cur} THEN 1 ELSE 0 END),0)::int AS no_change,
              COALESCE(SUM(CASE WHEN ${el} AND ${nvS} <= 0 THEN 1 ELSE 0 END),0)::int AS to_zero,
              COALESCE(SUM(CASE WHEN ${el} AND ${t === 'list' ? `p.list_price_syd > 0 AND ${nvS} > p.list_price_syd` : 'FALSE'} THEN 1 ELSE 0 END),0)::int AS over_syd,
              ${multCols}
         FROM products p WHERE ${tw}`, sp)).rows[0];

    let overlaps = [];
    if (pendingOn && s.eligible > 0) {
      const op = [];
      const ow = buildTargetWhere({ scope, filter: b.filter, product_ids: b.product_ids }, op, { fx: fr });
      op.push(t);
      overlaps = (await query(
        `SELECT pb.id, to_char(pb.effective_date,'YYYY-MM-DD') AS eff, pb.mode, pb.direction, pb.pct, pb.ratio, COUNT(*)::int AS n
           FROM price_change_batches pb
           JOIN price_change_items pi ON pi.batch_id = pb.id
           JOIN products p ON p.id = pi.product_id
          WHERE pb.status = 'scheduled' AND pb.price_type = $${op.length} AND ${ow}
          GROUP BY pb.id ORDER BY pb.effective_date, pb.id`, op)).rows
        .map((r) => ({ id: Number(r.id), effective_date: r.eff, mode: r.mode, direction: num(r.direction), pct: num(r.pct), ratio: num(r.ratio), count: r.n }));
    }
    return {
      ready: pendingOn, today: mxToday(), fx, price_type: t, mode, matched, offset, limit,
      rows: rows.map((r) => ({
        id: Number(r.id), code: r.code, name: r.name, origin: r.origin, is_active: r.is_active !== false,
        cur: num(r.cur), new_price: num(r.new_price), list_price: num(r.list_price), fob_usd: num(r.fob_usd),
        list_price_syd: num(r.list_price_syd), app: r.app, pending: !!r.pending,
      })),
      summary: {
        scope, total: s.total, eligible: s.eligible, not_eligible: s.total - s.eligible,
        before_sum: Number(s.before_sum), after_sum: Number(s.after_sum), no_change: s.no_change, to_zero: s.to_zero,
        over_syd: s.over_syd,
        mult_before: s.mult_before == null ? null : Math.round(Number(s.mult_before) * 100) / 100,
        mult_after: s.mult_after == null ? null : Math.round(Number(s.mult_after) * 100) / 100,
      },
      overlaps, change_error: ch.error || null,
    };
  });

  // ── ② 묶음 만들기: % · SYD 비율 (b.mode) / SYD 제안(b.items + syd_list_id) ──
  app.post('/api/price-master/batches', PRE, async (req, reply) => {
    if (!(await gate(reply))) return;
    const { perm } = req.ctx; const b = req.body || {};
    if (!(await pinOk(perm, b.pin))) return reply.code(403).send({ error: 'bad_pin' });
    const today = mxToday(); const dn = checkDateNote(b, today);
    if (dn.error) return reply.code(400).send(dn);
    const fx = await latestFx();
    let spec;
    if (Array.isArray(b.items)) {                                // SYD 제안 등 — 제품별 목표가
      if (!b.items.length) return noTargets(reply);
      if (b.items.length > MAX_SELECTED) return reply.code(400).send({ error: 'too_many' });
      spec = { price_type: 'list', mode: 'set', origin: b.syd_list_id ? 'syd' : 'bulk', rounding: 0.01,
        items: b.items, syd_list_id: Number(b.syd_list_id) || null };
    } else {
      const ch = normalizeChange(b);
      if (ch.error) return reply.code(400).send({ error: ch.error });
      const scope = b.scope === 'selected' ? 'selected' : 'filter';
      if (scope === 'selected' && (!Array.isArray(b.product_ids) || !b.product_ids.length)) return noTargets(reply);
      if (scope === 'selected' && b.product_ids.length > MAX_SELECTED) return reply.code(400).send({ error: 'too_many' });
      spec = { ...ch, origin: 'bulk', scope, filter: b.filter, product_ids: b.product_ids, fx: fx ? fx.rate : null };
    }
    let out;
    try {
      out = await withTx((c) => createBatch(c, { ...spec, effective_date: dn.eff, note: dn.note, userId: perm.userId, today }));
    } catch (e) {
      if (e && e.code === 'NO_TARGETS') return noTargets(reply);
      throw e;
    }
    await logEvent({ userId: perm.userId, action: 'create', target: `price_batch:${out.id}`,
      detail: { price_type: spec.price_type, mode: spec.mode, origin: spec.origin, effective_date: dn.eff, products: out.product_count,
        applied: out.applied ? out.applied.applied : null } });
    return {
      ok: true, id: out.id, status: out.applied ? 'applied' : 'scheduled', effective_date: dn.eff, product_count: out.product_count,
      applied_count: out.applied ? out.applied.applied : null, skipped_count: out.applied ? out.applied.skipped : null,
    };
  });

  // ── ③ 이력 ──
  app.get('/api/price-master/batches', PRE, async (req, reply) => {
    if (!(await gate(reply))) return;
    try { await applyDue(); } catch (_) {}
    const limit = Math.min(Number(req.query.limit) || 150, 500);
    const p = [limit]; const w = ['TRUE'];
    const status = String(req.query.status || '');
    if (['scheduled', 'applied', 'cancelled', 'reverted'].includes(status)) { p.push(status); w.push(`b.status = $${p.length}`); }
    const pt = String(req.query.price_type || '');
    if (pt === 'list' || pt === 'fob') { p.push(pt); w.push(`b.price_type = $${p.length}`); }
    const rows = (await query(
      `SELECT ${BATCH_COLS} FROM ${BATCH_FROM} WHERE ${w.join(' AND ')}
        ORDER BY b.effective_date DESC, b.id DESC LIMIT $1`, p)).rows;
    return { today: mxToday(), items: rows.map(batchOut) };
  });

  app.get('/api/price-master/batches/:id', PRE, async (req, reply) => {
    if (!(await gate(reply))) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    const r = (await query(`SELECT ${BATCH_COLS} FROM ${BATCH_FROM} WHERE b.id=$1`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    const batch = batchOut(r);
    const cur = 'p.' + PRICE_COL[batch.price_type];
    const nv = nvSql(batch.mode, cur, { dir: 2, pct: 3, rnd: 4, ratio: 5 });
    const items = (await query(
      `SELECT p.id, p.code, p.name, p.origin, i.old_price, i.new_price, i.target_price, i.result, ${cur} AS cur,
              CASE WHEN ${eligibleSql(batch.mode, cur)} THEN ${nv} END AS proj,
              0*$2::numeric + 0*$3::numeric + 0*$4::numeric + 0*$5::numeric AS _z
         FROM price_change_items i JOIN products p ON p.id = i.product_id
        WHERE i.batch_id = $1 ORDER BY p.code LIMIT 20000`,
      [id, batch.direction || 0, batch.pct || 0, batch.rounding, batch.ratio || 0])).rows;
    const pending = batch.status === 'scheduled' || batch.status === 'cancelled';
    return {
      batch,
      items: items.map((x) => ({
        product_id: Number(x.id), code: x.code, name: x.name, origin: x.origin,
        old_price: pending ? num(x.cur) : num(x.old_price),
        new_price: pending ? num(x.proj) : num(x.new_price),
        current_price: num(x.cur), result: x.result || (pending ? 'pending' : null),
      })),
    };
  });

  app.post('/api/price-master/batches/:id/cancel', PRE, async (req, reply) => {
    if (!(await gate(reply))) return;
    const id = Number(req.params.id);
    const r = await query(
      `UPDATE price_change_batches SET status='cancelled', cancelled_at=now(), cancelled_by=$2
        WHERE id=$1 AND status='scheduled' RETURNING id`, [id, req.ctx.perm.userId]);
    if (!r.rowCount) {
      const cur = (await query(`SELECT status FROM price_change_batches WHERE id=$1`, [id])).rows[0];
      return reply.code(cur ? 409 : 404).send({ error: cur ? 'not_scheduled' : 'not_found', status: cur ? cur.status : null });
    }
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `price_batch:${id}`, detail: { cancel: true } });
    return { ok: true };
  });

  app.post('/api/price-master/batches/:id/revert', PRE, async (req, reply) => {
    if (!(await gate(reply))) return;
    const { perm } = req.ctx;
    if (!(await pinOk(perm, req.body && req.body.pin))) return reply.code(403).send({ error: 'bad_pin' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    const out = await withTx((c) => revertBatch(c, id, { userId: perm.userId }));
    if (out.error) return reply.code(out.error === 'not_found' ? 404 : 409).send(out);
    await logEvent({ userId: perm.userId, action: 'update', target: `price_batch:${id}`,
      detail: { revert: true, reverted: out.reverted, skipped: out.skipped.length } });
    return { ok: true, reverted: out.reverted, skipped: out.skipped };
  });

  // ── ④ 제품별 이력 (List · FOB · SYD) ──
  app.get('/api/price-master/product', PRE, async (req, reply) => {
    if (!(await gate(reply))) return;
    const code = String(req.query.code || '').trim();
    if (!code) return reply.code(400).send({ error: 'code_required' });
    const p = (await query(
      `SELECT id, code, name, origin, list_price, fob_usd, list_price_syd, is_active FROM products
        WHERE upper(code) = upper($1) AND deleted_at IS NULL LIMIT 1`, [code])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const hist = (await query(
      `SELECT h.id, h.price_type, to_char(h.effective_date,'YYYY-MM-DD') AS eff, h.old_price, h.new_price, h.source, h.batch_id,
              h.created_at, u.name AS by_name, b.note, b.scope, b.filter, b.product_count, b.status AS batch_status, b.origin
         FROM product_price_history h
         LEFT JOIN users u ON u.id = h.created_by
         LEFT JOIN price_change_batches b ON b.id = h.batch_id
        WHERE h.product_id = $1 ORDER BY h.effective_date DESC, h.id DESC LIMIT 500`, [p.id])).rows;
    const sched = (await query(
      `SELECT b.id, b.price_type, b.mode, to_char(b.effective_date,'YYYY-MM-DD') AS eff, b.direction, b.pct, b.ratio, b.rounding,
              b.note, b.scope, b.filter, b.product_count, b.origin, i.target_price, u.name AS by_name
         FROM price_change_items i JOIN price_change_batches b ON b.id = i.batch_id
         LEFT JOIN users u ON u.id = b.created_by
        WHERE i.product_id = $1 AND b.status = 'scheduled'
        ORDER BY b.effective_date, b.id`, [p.id])).rows;
    const run = { list: num(p.list_price), fob: num(p.fob_usd) };
    const upcoming = sched.map((s) => {
      const t = normType(s.price_type); const from = run[t];
      let to = null;
      if (s.mode === 'set') to = num(s.target_price);
      else if (s.mode === 'ratio') to = num(p.list_price_syd) > 0 ? roundTo(num(p.list_price_syd) * Number(s.ratio), Number(s.rounding)) : null;
      else to = from != null && from > 0 ? calcNewPrice(from, Number(s.direction), Number(s.pct), Number(s.rounding)) : null;
      if (to != null) run[t] = to;
      return { batch_id: Number(s.id), price_type: t, effective_date: s.eff, old_price: from, new_price: to, note: s.note,
        by_name: s.by_name, origin: s.origin, condition: describeFilter(s.scope, s.filter, Number(s.product_count)) };
    }).reverse();
    // SYD — 대응품번의 리스트별 가격(가장 높은 값)
    const syd = (await query(
      `SELECT to_char(l.list_date,'YYYY-MM-DD') AS d, l.id, MAX(it.price) AS price,
              string_agg(DISTINCT it.syd_code, ', ') AS codes
         FROM product_syd_codes sc
         JOIN syd_price_items it ON it.syd_norm = ${SYD_NORM_SQL('sc.syd_code')}
         JOIN syd_price_lists l ON l.id = it.list_id
        WHERE sc.product_id = $1
        GROUP BY l.id, l.list_date ORDER BY l.list_date DESC, l.id DESC LIMIT 50`, [p.id])).rows;
    const sydRows = syd.map((r, i) => ({ list_id: Number(r.id), date: r.d, price: num(r.price), codes: r.codes,
      prev: syd[i + 1] ? num(syd[i + 1].price) : null }));
    return {
      product: { id: Number(p.id), code: p.code, name: p.name, origin: p.origin, list_price: num(p.list_price),
        fob_usd: num(p.fob_usd), list_price_syd: num(p.list_price_syd), is_active: p.is_active !== false },
      fx: await latestFx(), upcoming, syd: sydRows,
      history: hist.map((h) => ({
        id: Number(h.id), price_type: h.price_type, effective_date: h.eff, old_price: num(h.old_price), new_price: num(h.new_price),
        source: h.source, batch_id: h.batch_id == null ? null : Number(h.batch_id), origin: h.origin || null, note: h.note || null,
        condition: h.batch_id ? (h.origin === 'single' ? '단일 수정' : describeFilter(h.scope, h.filter, Number(h.product_count))) : null,
        batch_status: h.batch_status || null, by_name: h.by_name || null, created_at: h.created_at,
      })),
    };
  });

  // ── ⑤ 경쟁사 SYD ──
  app.post('/api/price-master/syd/lists', PRE, async (req, reply) => {
    if (!(await gate(reply))) return;
    const { perm } = req.ctx; const b = req.body || {};
    const listDate = String(b.list_date || '');
    if (!isYmd(listDate)) return reply.code(400).send({ error: 'bad_date' });
    if (listDate > mxToday()) return reply.code(400).send({ error: 'future_date' });
    const { items, dup, errors } = parseSydRows(b.rows);
    if (!items.length) return reply.code(400).send({ error: 'no_rows', errors: errors.slice(0, 200) });
    const out = await withTx(async (c) => {
      const L = (await c.query(
        `INSERT INTO syd_price_lists (list_date, file_name, code_count, dup_count, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [listDate, String(b.file_name || '').slice(0, 200) || null, items.length, dup, String(b.note || '').slice(0, 300) || null, perm.userId])).rows[0];
      const id = Number(L.id);
      for (let i = 0; i < items.length; i += 2000) {
        const part = items.slice(i, i + 2000);
        await c.query(
          `INSERT INTO syd_price_items (list_id, syd_norm, syd_code, price, familia)
           SELECT $1, x.n, x.c, x.p, x.f FROM unnest($2::text[], $3::text[], $4::numeric[], $5::text[]) AS x(n, c, p, f)`,
          [id, part.map((x) => x.norm), part.map((x) => x.code), part.map((x) => x.price), part.map((x) => x.familia)]);
      }
      const prev = await prevSydList(c.query.bind(c), id);
      const cmp = await compareSydCounts(c.query.bind(c), id, prev);
      await c.query(
        `UPDATE syd_price_lists SET prev_list_id=$2, up_count=$3, down_count=$4, same_count=$5, new_count=$6, gone_count=$7 WHERE id=$1`,
        [id, prev, cmp.up, cmp.down, cmp.same, cmp.new, cmp.gone]);
      // 가장 최신 리스트일 때만 제품 마스터 SYD List 를 맞춘다(옛 리스트로 덮지 않는다)
      const latest = await latestSydListId(c.query.bind(c));
      const synced = latest === id ? await syncProductSydPrices(c.query.bind(c), id) : 0;
      return { id, prev, cmp, synced, is_latest: latest === id };
    });
    await logEvent({ userId: perm.userId, action: 'create', target: `syd_list:${out.id}`, detail: { list_date: listDate, codes: items.length, ...out.cmp } });
    return { ok: true, id: out.id, list_date: listDate, codes: items.length, dup, error_count: errors.length, errors: errors.slice(0, 200),
      prev_list_id: out.prev, ...out.cmp, products_synced: out.synced, is_latest: out.is_latest };
  });

  app.get('/api/price-master/syd/lists', PRE, async (req, reply) => {
    if (!(await gate(reply))) return;
    const rows = (await query(
      `SELECT l.*, to_char(l.list_date,'YYYY-MM-DD') AS d, u.name AS by_name, to_char(pl.list_date,'YYYY-MM-DD') AS prev_date
         FROM syd_price_lists l LEFT JOIN users u ON u.id = l.created_by LEFT JOIN syd_price_lists pl ON pl.id = l.prev_list_id
        ORDER BY l.list_date DESC, l.id DESC LIMIT 100`)).rows;
    return { items: rows.map((r) => ({ id: Number(r.id), list_date: r.d, file_name: r.file_name, code_count: r.code_count,
      prev_list_id: num(r.prev_list_id), prev_date: r.prev_date, up: r.up_count, down: r.down_count, same: r.same_count,
      new: r.new_count, gone: r.gone_count, dup: r.dup_count, by_name: r.by_name, created_at: r.created_at })) };
  });

  // 리포트: 품목별 분포(코드 기준) + 제품별 제안(CTR 기준, 한 CTR 의 SYD 여럿 → 가장 높은 값)
  //   view: up_below(인상 · 우리가 목표보다 쌈) · down_above(인하 · 우리가 SYD보다 비쌈) · changed · all
  app.get('/api/price-master/syd/lists/:id/report', PRE, async (req, reply) => {
    if (!(await gate(reply))) return;
    const id = Number(req.params.id);
    const L = (await query(`SELECT id, to_char(list_date,'YYYY-MM-DD') AS d, prev_list_id FROM syd_price_lists WHERE id=$1`, [id])).rows[0];
    if (!L) return reply.code(404).send({ error: 'not_found' });
    const prev = num(L.prev_list_id);
    const prevD = prev ? (await query(`SELECT to_char(list_date,'YYYY-MM-DD') AS d FROM syd_price_lists WHERE id=$1`, [prev])).rows[0] : null;
    const byFam = (await query(
      `SELECT COALESCE(a.familia,'(없음)') AS fam, COUNT(*)::int AS n,
              COALESCE(SUM(CASE WHEN b.price IS NOT NULL AND a.price > b.price THEN 1 ELSE 0 END),0)::int AS up,
              COALESCE(SUM(CASE WHEN b.price IS NOT NULL AND a.price < b.price THEN 1 ELSE 0 END),0)::int AS down,
              AVG(CASE WHEN b.price > 0 AND a.price <> b.price THEN (a.price - b.price) / b.price END) AS avg_chg
         FROM syd_price_items a LEFT JOIN syd_price_items b ON b.list_id = $2 AND b.syd_norm = a.syd_norm
        WHERE a.list_id = $1 GROUP BY 1 ORDER BY (COALESCE(SUM(CASE WHEN b.price IS NOT NULL AND a.price <> b.price THEN 1 ELSE 0 END),0)) DESC, 2 DESC LIMIT 60`,
      [id, prev || 0])).rows;
    const avgUp = (await query(
      `SELECT AVG((a.price - b.price) / b.price) AS u FROM syd_price_items a JOIN syd_price_items b ON b.list_id=$2 AND b.syd_norm=a.syd_norm
        WHERE a.list_id=$1 AND a.price > b.price`, [id, prev || 0])).rows[0];
    const avgDown = (await query(
      `SELECT AVG((a.price - b.price) / b.price) AS d FROM syd_price_items a JOIN syd_price_items b ON b.list_id=$2 AND b.syd_norm=a.syd_norm
        WHERE a.list_id=$1 AND a.price < b.price`, [id, prev || 0])).rows[0];

    // 제품별: 이 리스트의 기준가(최고) · 앞 리스트의 기준가(최고)
    const prod = (await query(
      `WITH m AS (
          SELECT sc.product_id,
                 MAX(a.price) AS ref_new, MAX(b.price) AS ref_old,
                 string_agg(DISTINCT a.syd_code, ', ') AS codes,
                 MAX(a.familia) AS familia
            FROM product_syd_codes sc
            JOIN syd_price_items a ON a.list_id = $1 AND a.syd_norm = ${SYD_NORM_SQL('sc.syd_code')}
            LEFT JOIN syd_price_items b ON b.list_id = $2 AND b.syd_norm = a.syd_norm
           GROUP BY sc.product_id)
       SELECT p.id, p.code, p.name, p.is_active, p.list_price, m.ref_new, m.ref_old, m.codes, m.familia
         FROM m JOIN products p ON p.id = m.product_id AND p.deleted_at IS NULL`, [id, prev || 0])).rows;
    const rowsAll = prod.map((r) => ({
      product_id: Number(r.id), code: r.code, name: r.name, is_active: r.is_active !== false, familia: r.familia,
      syd_codes: r.codes, syd_old: num(r.ref_old), syd_new: num(r.ref_new), list_price: num(r.list_price),
    }));
    // 목표 비율 기본값 = 현재 실제 평균(우리 List ÷ 앞 리스트 SYD; 첫 리스트면 이번 SYD) — 활성·정가 있는 제품
    const base = rowsAll.filter((r) => r.is_active && r.list_price > 0 && (r.syd_old || r.syd_new) > 0);
    const target_default = base.length
      ? Math.round(base.reduce((s, r) => s + r.list_price / (r.syd_old || r.syd_new), 0) / base.length * 10000) / 10000 : null;
    const target = Number(req.query.target) > 0 ? Number(req.query.target) : (target_default || 1);
    const view = ['up_below', 'down_above', 'changed', 'all'].includes(req.query.view) ? req.query.view : 'up_below';
    let need = 0; let over = 0;
    for (const r of rowsAll) {
      r.syd_change = r.syd_old > 0 ? Math.round((r.syd_new - r.syd_old) / r.syd_old * 10000) / 10000 : null;
      r.ratio = r.list_price > 0 ? Math.round(r.list_price / r.syd_new * 10000) / 10000 : null;
      const sug = roundTo(r.syd_new * target, 0.01);
      r.suggested = r.is_active && (r.list_price == null || r.list_price < sug) ? sug : null;
      r.over_syd = r.list_price != null && r.list_price > r.syd_new;
      if (r.syd_change > 0 && r.suggested != null) need++;
      if (r.syd_change < 0 && r.over_syd) over++;
    }
    const pick = rowsAll.filter((r) => (view === 'up_below' ? r.syd_change > 0 && r.suggested != null
      : view === 'down_above' ? r.syd_change < 0 && r.over_syd
        : view === 'changed' ? r.syd_change != null && r.syd_change !== 0 : true));
    pick.sort((a, b) => (b.suggested && a.list_price ? (b.suggested - b.list_price) / b.list_price : 0)
      - (a.suggested && a.list_price ? (a.suggested - a.list_price) / a.list_price : 0) || String(a.code).localeCompare(b.code));
    const c = await query(`SELECT up_count, down_count, same_count, new_count, gone_count, code_count FROM syd_price_lists WHERE id=$1`, [id]);
    const k = c.rows[0];
    return {
      list: { id, date: L.d, prev_id: prev, prev_date: prevD ? prevD.d : null },
      kpi: { codes: k.code_count, up: k.up_count, down: k.down_count, same: k.same_count, new: k.new_count, gone: k.gone_count,
        avg_up: avgUp.u == null ? null : Math.round(Number(avgUp.u) * 10000) / 10000,
        avg_down: avgDown.d == null ? null : Math.round(Number(avgDown.d) * 10000) / 10000,
        linked: rowsAll.length, need_review: need, over_syd_after_down: over },
      target, target_default, view, total: pick.length,
      by_familia: byFam.map((r) => ({ familia: r.fam, n: r.n, up: r.up, down: r.down, avg_change: r.avg_chg == null ? null : Math.round(Number(r.avg_chg) * 10000) / 10000 })),
      rows: pick.slice(0, 3000),
    };
  });

  app.delete('/api/price-master/syd/lists/:id', PRE, async (req, reply) => {
    if (!(await gate(reply))) return;
    const { perm } = req.ctx;
    if (!(await pinOk(perm, req.body && req.body.pin))) return reply.code(403).send({ error: 'bad_pin' });
    const id = Number(req.params.id);
    const out = await withTx(async (c) => {
      const was = (await c.query(`DELETE FROM syd_price_lists WHERE id=$1 RETURNING id`, [id])).rowCount;
      if (!was) return null;
      await c.query(`UPDATE syd_price_lists SET prev_list_id = NULL WHERE prev_list_id = $1`, [id]);
      const latest = await latestSydListId(c.query.bind(c));
      const synced = latest ? await syncProductSydPrices(c.query.bind(c), latest) : 0;
      return { latest, synced };
    });
    if (!out) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: perm.userId, action: 'delete', target: `syd_list:${id}` });
    return { ok: true, ...out };
  });

  // ── ⑥ 구매가 검증 ──
  app.get('/api/price-master/purchase-check', PRE, async (req, reply) => {
    if (!(await gate(reply))) return;
    const qv = req.query || {};
    const p = []; const w = ['po.deleted_at IS NULL'];
    if (isYmd(qv.from)) { p.push(qv.from); w.push(`po.order_date >= $${p.length}::date`); }
    if (isYmd(qv.to)) { p.push(qv.to); w.push(`po.order_date <= $${p.length}::date`); }
    const tol = Math.max(0, Number(qv.tol) || 0);
    const pos = (await query(
      `SELECT po.id, po.ref_no, to_char(po.order_date,'YYYY-MM-DD') AS d FROM purchase_orders po
        WHERE ${w.join(' AND ')} ORDER BY po.order_date DESC, po.id DESC LIMIT 300`, p)).rows;
    const lines = await purchaseLinesWithFob(query, pos.map((x) => Number(x.id)));
    const byPo = new Map();
    for (const l of lines) { const k = Number(l.po_id); if (!byPo.has(k)) byPo.set(k, []); byPo.get(k).push(l); }
    const total = { po: 0, lines: 0, ok: 0, over: 0, under: 0, no_fob: 0, unmatched: 0, over_usd: 0, under_usd: 0, diff_usd: 0 };
    let items = pos.map((po) => {
      const s = summarizeFob(byPo.get(Number(po.id)) || [], tol);
      total.po++; for (const k of ['lines', 'ok', 'over', 'under', 'no_fob', 'unmatched', 'over_usd', 'under_usd', 'diff_usd']) total[k] += s[k];
      return { id: Number(po.id), ref_no: po.ref_no, order_date: po.d, ...s };
    });
    for (const k of ['over_usd', 'under_usd', 'diff_usd']) total[k] = Math.round(total[k] * 100) / 100;
    if (qv.only_bad === '1') items = items.filter((x) => x.over + x.under + x.no_fob > 0);
    return { tol, total, items };
  });

  app.get('/api/price-master/purchase-check/:poId', PRE, async (req, reply) => {
    if (!(await gate(reply))) return;
    const id = Number(req.params.poId);
    const po = (await query(`SELECT id, ref_no, to_char(order_date,'YYYY-MM-DD') AS d FROM purchase_orders WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!po) return reply.code(404).send({ error: 'not_found' });
    const tol = Math.max(0, Number(req.query.tol) || 0);
    const lines = await purchaseLinesWithFob(query, [id]);
    const s = summarizeFob(lines, tol);
    return { po: { id, ref_no: po.ref_no, order_date: po.d }, tol, summary: s,
      lines: lines.map((l) => ({ id: Number(l.id), code: l.code || l.input_code, name: l.name, product_id: num(l.product_id),
        qty: num(l.qty), unit_cost_usd: num(l.unit_cost_usd), fob: num(l.fob), fob_basis: l.basis, fob_now: num(l.fob_now),
        diff_pct: l.fob > 0 ? Math.round((Number(l.unit_cost_usd) - Number(l.fob)) / Number(l.fob) * 10000) / 10000 : null,
        diff_usd: l.diff_usd, status: l.fob_status })) };
  });
}
