// =====================================================================
// Refatrix ERP · rackStockRoutes.js  (랙별 재고 조회·수동 조정) · 0245
//   읽기: 창고(warehouse) 또는 제품(products) 화면 권한
//   쓰기: 디렉터 전용(수동 조정, 반영완료된 과거 실사에서 랙재고 가져오기)
//   수량 변경 로직은 전부 ../rackStock.js 에 있다 — 여기는 HTTP 껍데기.
// =====================================================================
import { query, withTx } from '../db.js';
import { authGuard, requirePageAny, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { rackStockReady, rackMap, setRackQty, applyCountToRacks, normRack, RACK_BUILD } from '../rackStock.js';

const NOT_READY = { error: 'rack_stock_not_ready', note: '마이그레이션 0245 를 먼저 실행하세요 (npm run migrate).' };

export default async function rackStockRoutes(app) {
  try { console.log('[rackStockRoutes] loaded ' + RACK_BUILD); } catch (_) {}
  const gRead = { preHandler: [authGuard, requirePageAny(['warehouse', 'products'])] };
  const gDir = { preHandler: [authGuard, requireDirector] };
  const num = (v) => (v == null ? 0 : Number(v));

  /* SKU 별 랙 재고 목록 — ?q=코드·품명 &rack=랙 &unassigned=1 &limit=&offset=
     기본: 랙 기록이 있는 SKU 전체(코드순). */
  app.get('/api/rack-stock', gRead, async (req, reply) => {
    if (!(await rackStockReady())) return reply.code(409).send(NOT_READY);
    const q = req.query || {};
    const limit = Math.max(1, Math.min(1000, Number(q.limit) || 300));
    const offset = Math.max(0, Number(q.offset) || 0);
    const where = ['p.deleted_at IS NULL'];
    const params = [];
    const term = String(q.q || '').trim();
    const rack = normRack(q.rack);
    if (term) {
      params.push(term);
      where.push(`(p.code ILIKE '%' || $${params.length} || '%' OR COALESCE(p.name,'') ILIKE '%' || $${params.length} || '%'
                   OR COALESCE(p.scode,'') ILIKE '%' || $${params.length} || '%')`);
    }
    if (rack) {
      params.push(rack);
      where.push(`p.id IN (SELECT product_id FROM product_rack_stock WHERE rack LIKE $${params.length} || '%')`);
    }
    const located = `COALESCE((SELECT SUM(s.qty) FROM product_rack_stock s WHERE s.product_id = p.id), 0)`;
    const onlyGap = String(q.unassigned || '') === '1';
    // 위치 미지정만 = 시스템 재고와 랙 수량 합이 다른 SKU(랙 기록이 전혀 없는 재고 SKU 포함)
    if (onlyGap) where.push(`(COALESCE(p.stock_qty,0) > ${located} OR ${located} > COALESCE(p.stock_qty,0))`);
    else if (!term && !rack) where.push(`p.id IN (SELECT product_id FROM product_rack_stock)`);
    const base = `FROM products p WHERE ${where.join(' AND ')}`;
    const total = Number((await query(`SELECT COUNT(*)::int AS n ${base}`, params)).rows[0].n);
    params.push(limit, offset);
    const prods = (await query(
      `SELECT p.id, p.code, p.name, p.stock_qty, p.rack_location ${base}
        ORDER BY p.code LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
    const map = await rackMap(null, prods.map((p) => p.id));
    const items = prods.map((p) => {
      const racks = map.get(Number(p.id)) || [];
      const located = racks.reduce((s, r) => s + r.qty, 0);
      const stock = num(p.stock_qty);
      return {
        product_id: Number(p.id), code: p.code, name: p.name || '', stock_qty: stock,
        master_rack: p.rack_location || '', racks,
        located: Math.round(located * 1000) / 1000,
        unassigned: Math.max(0, Math.round((stock - located) * 1000) / 1000),
        over: Math.max(0, Math.round((located - stock) * 1000) / 1000),
      };
    });
    return { total, limit, offset, items };
  });

  /* 랙별 요약 — 랙마다 SKU 수·수량·유형 */
  app.get('/api/rack-stock/racks', gRead, async (req, reply) => {
    if (!(await rackStockReady())) return reply.code(409).send(NOT_READY);
    const rows = (await query(
      `SELECT s.rack, COUNT(*)::int AS skus, SUM(s.qty) AS qty,
              COALESCE((SELECT k.kind FROM rack_kinds k WHERE UPPER(TRIM(k.rack)) = s.rack
                         ORDER BY k.updated_at DESC LIMIT 1), 'carton') AS kind
         FROM product_rack_stock s
        WHERE s.qty > 0
        GROUP BY s.rack ORDER BY s.rack`)).rows;
    return { racks: rows.map((r) => ({ rack: r.rack, skus: Number(r.skus), qty: num(r.qty), kind: r.kind })) };
  });

  /* 한 SKU 의 랙 재고 + 최근 이력 */
  app.get('/api/rack-stock/product/:id', gRead, async (req, reply) => {
    if (!(await rackStockReady())) return reply.code(409).send(NOT_READY);
    const id = Number(req.params.id);
    const p = (await query(`SELECT id, code, name, stock_qty, rack_location FROM products WHERE id=$1`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const racks = (await rackMap(null, [id])).get(id) || [];
    const moves = (await query(
      `SELECT m.id, m.rack, m.delta, m.qty_after, m.reason, m.ref, m.sales_invoice_id, m.quote_id, m.note,
              m.created_at, u.name AS by_name
         FROM product_rack_moves m LEFT JOIN users u ON u.id = m.created_by
        WHERE m.product_id=$1 ORDER BY m.created_at DESC, m.id DESC LIMIT 100`, [id])).rows
      .map((m) => ({ ...m, id: Number(m.id), delta: num(m.delta), qty_after: num(m.qty_after),
        sales_invoice_id: m.sales_invoice_id == null ? null : Number(m.sales_invoice_id),
        quote_id: m.quote_id == null ? null : Number(m.quote_id) }));
    const located = racks.reduce((s, r) => s + r.qty, 0);
    return {
      product: { id: Number(p.id), code: p.code, name: p.name || '', stock_qty: num(p.stock_qty), master_rack: p.rack_location || '' },
      racks, located, unassigned: Math.max(0, num(p.stock_qty) - located), moves,
    };
  });

  /* 디렉터 수동 조정 — body: { product_id, rack, qty, note } (qty=0 이면 그 랙에서 제거) */
  app.post('/api/rack-stock/set', gDir, async (req, reply) => {
    if (!(await rackStockReady())) return reply.code(409).send(NOT_READY);
    const b = req.body || {};
    const pid = Number(b.product_id);
    const rack = normRack(b.rack).slice(0, 40);
    const qty = Number(b.qty);
    if (!pid || !rack) return reply.code(400).send({ error: 'product_and_rack_required' });
    if (!isFinite(qty) || qty < 0) return reply.code(400).send({ error: 'bad_qty' });
    const p = (await query(`SELECT id, code FROM products WHERE id=$1 AND deleted_at IS NULL`, [pid])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const uid = req.ctx.perm.userId;
    const note = String(b.note || '').trim().slice(0, 200) || null;
    const delta = await withTx(async (c) => setRackQty(c, pid, rack, qty, { reason: 'manual', ref: 'manual', userId: uid, note }));
    await logEvent({ userId: uid, action: 'update', target: `rack_stock:${pid}`, detail: { code: p.code, rack, qty, delta, note } });
    return { ok: true, product_id: pid, rack, qty, delta };
  });

  /* 이미 반영완료된 과거 실사에서 랙재고 가져오기(이 기능 배포 전에 반영한 세션용).
     보류(반영 안 함)로 끝난 수량차이 SKU 는 제외한다 — 반영 경로와 같은 규칙. */
  app.post('/api/rack-stock/from-count/:id', gDir, async (req, reply) => {
    if (!(await rackStockReady())) return reply.code(409).send(NOT_READY);
    const id = Number(req.params.id);
    const sc = (await query(`SELECT id, code, status, mode FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (sc.mode === 'spot') return reply.code(409).send({ error: 'full_only', note: '전체 재고실사만 가져올 수 있습니다.' });
    if (sc.status !== 'reconciled') return reply.code(409).send({ error: 'not_reconciled', note: '반영완료된 실사만 가져올 수 있습니다. 제출된 실사는 반영할 때 자동으로 저장됩니다.' });
    const uid = req.ctx.perm.userId;
    // 이미 랙재고로 저장된 실사는 다시 가져오지 않는다 — 그 뒤 출고·위치변경이 오래된 수량으로 덮이기 때문.
    const done = (await query(`SELECT 1 FROM product_rack_moves WHERE ref=$1 LIMIT 1`, [`count:${id}`])).rows[0];
    if (done) return reply.code(409).send({ error: 'already_imported', note: '이 실사의 랙 수량은 이미 랙재고에 저장되어 있습니다.' });
    const skipRows = (await query(
      `SELECT DISTINCT product_id FROM stock_count_adjustments
        WHERE count_id=$1 AND product_id IS NOT NULL AND decision = 'skip' AND delta <> 0`, [id])).rows;
    const skip = new Set(skipRows.map((r) => Number(r.product_id)));
    const out = await withTx(async (c) => applyCountToRacks(c, id, { skip, userId: uid, code: sc.code }));
    await logEvent({ userId: uid, action: 'update', target: `stock_count:${id}`, detail: { step: 'rack_stock_import', ...out, skipped: skip.size } });
    return { ok: true, code: sc.code, ...out, skipped: skip.size };
  });
}
