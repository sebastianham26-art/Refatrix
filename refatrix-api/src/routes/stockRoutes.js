import { query, withTx } from '../db.js';
import { authGuard, requirePage } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';

function d10(d) { if (!d) return null; if (d instanceof Date) return d.toISOString().slice(0, 10); return String(d).slice(0, 10); }

// 한 건의 수동 이동을 트랜잭션 안에서 적용 (재고 갱신 + 원장 기록). 평균원가는 건드리지 않음.
async function applyMovement(c, { productId, moveType, qty, ref, note, movedAt, userId }) {
  const p = (await c.query(`SELECT id, code, name, stock_qty, avg_cost FROM products WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [productId])).rows[0];
  if (!p) return { error: 'product_not_found' };
  const cur = Number(p.stock_qty) || 0;
  let delta;
  if (moveType === 'in') delta = Math.abs(qty);
  else if (moveType === 'out') delta = -Math.abs(qty);
  else delta = qty; // adjust: 부호 그대로 (음수=감소)
  const next = cur + delta;
  if (next < 0) return { error: 'would_go_negative', code: p.code, current: cur, requested: Math.abs(delta) };
  await c.query(`UPDATE products SET stock_qty=$1, updated_by=$2 WHERE id=$3`, [next, userId, productId]);
  const storeQty = moveType === 'adjust' ? qty : Math.abs(qty);
  await c.query(
    `INSERT INTO stock_movements (product_id, move_type, qty, unit_cost_mxn, ref, note, source, moved_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'manual',COALESCE($7, now()),$8)`,
    [productId, moveType, storeQty, p.avg_cost || null, ref || null, note || null, movedAt || null, userId]);
  return { ok: true, code: p.code, name: p.name, before: cur, after: next };
}

export default async function stockRoutes(app) {
  // 부족분 SKU별 집계 (발주 근거) — open 상태 shortage 합산 + 요약(부족/발주)
  app.get('/api/shortages/by-sku', { preHandler: [authGuard, requirePage('sales')] }, async () => {
    const rows = (await query(
      `SELECT sh.product_id, p.code AS ctr_code, p.name AS product_name, p.stock_qty,
              SUM(sh.shortage_qty)::numeric AS total_shortage,
              COUNT(*)::int AS cnt,
              MIN(sh.occurred_at) AS first_at, MAX(sh.occurred_at) AS last_at
         FROM stock_shortages sh JOIN products p ON p.id=sh.product_id
        WHERE sh.status='open'
        GROUP BY sh.product_id, p.code, p.name, p.stock_qty
        ORDER BY total_shortage DESC`)).rows;
    // 요약: 미발주(open) vs 발주됨(resolved)
    const sm = (await query(
      `SELECT
         COUNT(DISTINCT product_id) FILTER (WHERE status='open')::int AS open_sku,
         COALESCE(SUM(shortage_qty) FILTER (WHERE status='open'),0)::numeric AS open_qty,
         COUNT(DISTINCT product_id) FILTER (WHERE status='resolved')::int AS ordered_sku,
         COALESCE(SUM(shortage_qty) FILTER (WHERE status='resolved'),0)::numeric AS ordered_qty
       FROM stock_shortages`)).rows[0];
    return {
      summary: {
        open_sku: sm.open_sku || 0, open_qty: Number(sm.open_qty) || 0,
        ordered_sku: sm.ordered_sku || 0, ordered_qty: Number(sm.ordered_qty) || 0,
      },
      items: rows.map((r) => ({
        product_id: r.product_id, ctr_code: r.ctr_code, product_name: r.product_name,
        stock_qty: r.stock_qty != null ? Number(r.stock_qty) : null,
        total_shortage: Number(r.total_shortage), cnt: r.cnt,
        first_at: r.first_at ? d10(r.first_at) : null, last_at: r.last_at ? d10(r.last_at) : null,
      })),
    };
  });

  // 수동 이동 등록 (입고/출고/조정). 참조번호 필수.
  app.post('/api/stock/movements', { preHandler: [authGuard, requirePage('sales')] }, async (req, reply) => {
    const b = req.body || {};
    const productId = Number(b.product_id);
    const moveType = String(b.move_type || '');
    const qty = Number(b.qty);
    const ref = String(b.ref || '').trim();
    if (!productId) return reply.code(400).send({ error: 'product_required' });
    if (!['in', 'out', 'adjust'].includes(moveType)) return reply.code(400).send({ error: 'bad_move_type' });
    if (!qty || (moveType !== 'adjust' && qty <= 0)) return reply.code(400).send({ error: 'bad_qty' });
    if (!ref) return reply.code(400).send({ error: 'ref_required', note: '참조번호(수입인보이스/사유 등)는 필수입니다.' });
    const result = await withTx(async (c) => applyMovement(c, {
      productId, moveType, qty, ref, note: b.note, movedAt: b.moved_at || null, userId: req.ctx.perm.userId,
    }));
    if (result.error) return reply.code(409).send(result);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `stock_movement:${result.code}`, detail: { moveType, qty, ref } });
    return result;
  });

  // 엑셀 일괄 등록: { rows: [{code|product_id, move_type, qty, ref, note}] }
  app.post('/api/stock/movements/bulk', { preHandler: [authGuard, requirePage('sales')] }, async (req, reply) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return reply.code(400).send({ error: 'no_rows' });
    const out = await withTx(async (c) => {
      const results = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const moveType = String(r.move_type || '').trim();
        const qty = Number(r.qty);
        const ref = String(r.ref || '').trim();
        let productId = Number(r.product_id) || null;
        if (!productId && r.code) {
          // CTR 정확매칭 우선, 없으면 SYD
          const code = String(r.code).trim();
          let pr = (await c.query(`SELECT id FROM products WHERE deleted_at IS NULL AND code=$1`, [code])).rows[0];
          if (!pr) pr = (await c.query(`SELECT p.id FROM product_syd_codes s JOIN products p ON p.id=s.product_id AND p.deleted_at IS NULL WHERE s.syd_code=$1 LIMIT 1`, [code])).rows[0];
          productId = pr ? pr.id : null;
        }
        if (!productId) { results.push({ row: i + 1, error: 'product_not_found', code: r.code }); continue; }
        if (!['in', 'out', 'adjust'].includes(moveType)) { results.push({ row: i + 1, error: 'bad_move_type' }); continue; }
        if (!qty || (moveType !== 'adjust' && qty <= 0)) { results.push({ row: i + 1, error: 'bad_qty' }); continue; }
        if (!ref) { results.push({ row: i + 1, error: 'ref_required' }); continue; }
        const res = await applyMovement(c, { productId, moveType, qty, ref, note: r.note, movedAt: r.moved_at || null, userId: req.ctx.perm.userId });
        if (res.error) { results.push({ row: i + 1, ...res }); continue; } // 트랜잭션 전체 롤백을 원하면 throw
        results.push({ row: i + 1, ok: true, code: res.code, before: res.before, after: res.after });
      }
      const errs = results.filter((x) => x.error);
      if (errs.length) { const e = new Error('bulk_failed'); e.results = results; throw e; } // 하나라도 실패하면 전체 롤백
      return results;
    }).catch((e) => ({ error: 'bulk_failed', results: e.results || [] }));
    if (out.error) return reply.code(409).send(out);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: 'stock_movement:bulk', detail: { count: out.length } });
    return { ok: true, count: out.length, results: out };
  });

  // 이동 내역 목록 (전체: 수동 + 매출/수입 자동). 필터: product_id, move_type, from, to, source
  app.get('/api/stock/movements', { preHandler: [authGuard, requirePage('sales')] }, async (req) => {
    const conds = []; const args = [];
    if (req.query.product_id) { args.push(Number(req.query.product_id)); conds.push(`m.product_id=$${args.length}`); }
    if (['in', 'out', 'adjust'].includes(String(req.query.move_type))) { args.push(req.query.move_type); conds.push(`m.move_type=$${args.length}`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ''))) { args.push(req.query.from); conds.push(`m.moved_at >= $${args.length}`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ''))) { args.push(req.query.to); conds.push(`m.moved_at < ($${args.length}::date + 1)`); }
    if (req.query.source === 'manual') conds.push(`m.source='manual'`);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const rows = (await query(
      `SELECT m.id, m.product_id, m.move_type, m.qty, m.unit_cost_mxn, m.ref, m.note, m.source, m.moved_at,
              m.sales_invoice_id, m.batch_id,
              p.code AS ctr_code, p.name AS product_name,
              u.name AS created_by_name
         FROM stock_movements m
         JOIN products p ON p.id=m.product_id
         LEFT JOIN users u ON u.id=m.created_by
         ${where}
        ORDER BY m.moved_at DESC, m.id DESC
        LIMIT ${limit}`, args)).rows;
    return {
      items: rows.map((r) => ({
        id: r.id, product_id: r.product_id, ctr_code: r.ctr_code, product_name: r.product_name,
        move_type: r.move_type, qty: Number(r.qty), unit_cost_mxn: r.unit_cost_mxn != null ? Number(r.unit_cost_mxn) : null,
        ref: r.ref, note: r.note, moved_at: r.moved_at,
        origin: r.sales_invoice_id ? '매출' : (r.batch_id ? '수입' : (r.source === 'manual' ? '수동' : '기타')),
        created_by_name: r.created_by_name || null,
      })),
    };
  });
}
