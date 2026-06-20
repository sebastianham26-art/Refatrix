import { query, withTx } from '../db.js';
import { authGuard, requirePage, requirePageAny, requirePageEditAny, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { fieldVisible } from '../permissions.js';

function d10(d) { if (!d) return null; if (d instanceof Date) return d.toISOString().slice(0, 10); return String(d).slice(0, 10); }

// 한 건의 수동 이동을 트랜잭션 안에서 적용 (재고 갱신 + 원장 기록). 평균원가는 건드리지 않음.
async function applyMovement(c, { productId, moveType, qty, ref, note, movedAt, eventNo, userId }) {
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
    `INSERT INTO stock_movements (product_id, move_type, qty, unit_cost_mxn, ref, note, source, moved_at, event_no, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'manual',COALESCE($7, now()),$8,$9)`,
    [productId, moveType, storeQty, p.avg_cost || null, ref || null, note || null, movedAt || null, eventNo || null, userId]);
  return { ok: true, code: p.code, name: p.name, before: cur, after: next };
}

export default async function stockRoutes(app) {
  // 부족분 SKU별 집계 (발주 근거) — open 상태 shortage 합산 + 요약(부족/발주)
  app.get('/api/shortages/by-sku', { preHandler: [authGuard, requirePageAny(['shortage','sales'])] }, async (req) => {
    const months = String((req.query && req.query.months) || '').split(',').map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}$/.test(s));
    const _a = [];
    let monthCond = '';
    if (months.length) { _a.push(months); monthCond = ` AND to_char(sh.occurred_at,'YYYY-MM') = ANY($${_a.length})`; }
    const rows = (await query(
      `SELECT sh.product_id, p.code AS ctr_code, p.name AS product_name, p.stock_qty,
              SUM(sh.shortage_qty)::numeric AS total_shortage,
              SUM(sh.shortage_amount_mxn)::numeric AS total_amount_mxn,
              COUNT(*)::int AS cnt,
              MIN(sh.occurred_at) AS first_at, MAX(sh.occurred_at) AS last_at
         FROM stock_shortages sh JOIN products p ON p.id=sh.product_id
        WHERE sh.status='open'${monthCond}
        GROUP BY sh.product_id, p.code, p.name, p.stock_qty
        ORDER BY total_shortage DESC`, _a)).rows;
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
        total_shortage: Number(r.total_shortage), total_amount_mxn: Number(r.total_amount_mxn || 0), cnt: r.cnt,
        first_at: r.first_at ? d10(r.first_at) : null, last_at: r.last_at ? d10(r.last_at) : null,
      })),
    };
  });

  // 수동 이동 등록 (입고/출고/조정). 참조번호 필수.
  app.post('/api/stock/movements', { preHandler: [authGuard, requirePageEditAny(['stock','sales'])] }, async (req, reply) => {
    const b = req.body || {};
    const productId = Number(b.product_id);
    const moveType = String(b.move_type || '');
    const qty = Number(b.qty);
    const ref = String(b.ref || '').trim();
    if (!productId) return reply.code(400).send({ error: 'product_required' });
    if (!['in', 'out', 'adjust'].includes(moveType)) return reply.code(400).send({ error: 'bad_move_type' });
    if (!qty || (moveType !== 'adjust' && qty <= 0)) return reply.code(400).send({ error: 'bad_qty' });
    if (!ref) return reply.code(400).send({ error: 'ref_required', note: '참조번호(수입인보이스/사유 등)는 필수입니다.' });
    const result = await withTx(async (c) => {
      const eventNo = Number((await c.query(`SELECT nextval('stock_event_seq') AS n`)).rows[0].n);
      return applyMovement(c, {
        productId, moveType, qty, ref, note: b.note, movedAt: b.moved_at || null, eventNo, userId: req.ctx.perm.userId,
      });
    });
    if (result.error) return reply.code(409).send(result);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `stock_movement:${result.code}`, detail: { moveType, qty, ref } });
    return result;
  });

  // 엑셀 일괄 등록: { rows: [{code|product_id, move_type, qty, ref, note}] }
  app.post('/api/stock/movements/bulk', { preHandler: [authGuard, requirePageEditAny(['stock','sales'])] }, async (req, reply) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return reply.code(400).send({ error: 'no_rows' });
    const out = await withTx(async (c) => {
      const results = [];
      const eventNo = Number((await c.query(`SELECT nextval('stock_event_seq') AS n`)).rows[0].n);
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
        const res = await applyMovement(c, { productId, moveType, qty, ref, note: r.note, movedAt: r.moved_at || null, eventNo, userId: req.ctx.perm.userId });
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
  // 현재 재고 총괄(고정 요약): SKU 수 · 총수량 · 재고금액(MXN)
  app.get('/api/stock/summary', { preHandler: [authGuard, requirePageAny(['stock', 'sales'])] }, async (req) => {
    const seeCost = fieldVisible(req.ctx.perm, 'unit_cost'); // 원가(재고금액)는 디렉터/원가권한자만
    const r = (await query(
      `SELECT COUNT(*) FILTER (WHERE COALESCE(stock_qty,0) <> 0)::int AS sku_count,
              COALESCE(SUM(stock_qty),0) AS total_qty,
              COALESCE(SUM(COALESCE(stock_qty,0) * COALESCE(avg_cost,0)),0) AS stock_value_mxn
         FROM products WHERE deleted_at IS NULL`)).rows[0];
    // PSN: 구매(수입입고) · 판매(매출출고) 당월/전월 수량 + 당월 순증감(재고 롤백용)
    const p = (await query(
      `SELECT
         COALESCE(SUM(qty) FILTER (WHERE batch_id IS NOT NULL AND move_type='in' AND moved_at >= date_trunc('month', now())),0) AS p_cur,
         COALESCE(SUM(qty) FILTER (WHERE batch_id IS NOT NULL AND move_type='in' AND moved_at >= date_trunc('month', now()) - interval '1 month' AND moved_at < date_trunc('month', now())),0) AS p_prev,
         COALESCE(SUM(qty) FILTER (WHERE sales_invoice_id IS NOT NULL AND move_type='out' AND moved_at >= date_trunc('month', now())),0) AS s_cur,
         COALESCE(SUM(qty) FILTER (WHERE sales_invoice_id IS NOT NULL AND move_type='out' AND moved_at >= date_trunc('month', now()) - interval '1 month' AND moved_at < date_trunc('month', now())),0) AS s_prev,
         COALESCE(SUM(CASE WHEN move_type='in' THEN qty WHEN move_type='out' THEN -qty ELSE qty END) FILTER (WHERE moved_at >= date_trunc('month', now())),0) AS net_cur
       FROM stock_movements`)).rows[0];
    const q3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
    const totalQty = q3(r.total_qty);
    const netCur = q3(p.net_cur);
    return {
      sku_count: Number(r.sku_count) || 0,
      total_qty: totalQty,
      stock_value_mxn: seeCost ? Math.round((Number(r.stock_value_mxn) || 0) * 100) / 100 : null,
      // P/S/N 당월·전월 비교 (수량)
      psn: {
        purchase: { cur: q3(p.p_cur), prev: q3(p.p_prev) },
        sales: { cur: q3(p.s_cur), prev: q3(p.s_prev) },
        inventory: { cur: totalQty, prev: q3(totalQty - netCur) },  // 전월말 재고 = 현재고 − 당월 순증감
      },
    };
  });

  // 이벤트 단위 일괄 수정: 같은 event_no(함께 등록된 입·출고)의 날짜·참조·사유를 한 번에 변경
  app.patch('/api/stock/events/:eventNo', { preHandler: [authGuard, requirePageEditAny(['stock', 'sales'])] }, async (req, reply) => {
    const eventNo = Number(req.params.eventNo);
    if (!eventNo) return reply.code(400).send({ error: 'bad_event' });
    const b = req.body || {};
    const rows = (await query(`SELECT id, source, sales_invoice_id, batch_id FROM stock_movements WHERE event_no=$1`, [eventNo])).rows;
    if (!rows.length) return reply.code(404).send({ error: 'not_found' });
    // 자동기록(매출/수입)이 하나라도 포함되면 거부
    if (rows.some((r) => r.source !== 'manual' || r.sales_invoice_id || r.batch_id)) {
      return reply.code(409).send({ error: 'not_manual', note: '자동 기록(매출·수입) 이벤트는 수정할 수 없습니다.' });
    }
    const sets = [], args = [];
    if (b.moved_at !== undefined) {
      const d = String(b.moved_at || '').trim();
      if (!d) return reply.code(400).send({ error: 'date_required', note: '입고 날짜는 필수입니다.' });
      if (!/^\d{4}-\d{2}-\d{2}/.test(d)) return reply.code(400).send({ error: 'bad_date' });
      args.push(d); sets.push(`moved_at=$${args.length}`);
    }
    if (b.ref !== undefined) {
      const ref = String(b.ref || '').trim();
      if (!ref) return reply.code(400).send({ error: 'ref_required' });
      args.push(ref); sets.push(`ref=$${args.length}`);
    }
    if (b.note !== undefined) { args.push(String(b.note || '').trim() || null); sets.push(`note=$${args.length}`); }
    if (!sets.length) return reply.code(400).send({ error: 'nothing_to_update' });
    args.push(eventNo);
    const r = await query(`UPDATE stock_movements SET ${sets.join(', ')} WHERE event_no=$${args.length} RETURNING id`, args);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `stock_event:${eventNo}`, detail: { moved_at: b.moved_at, ref: b.ref, note: b.note, rows: r.rows.length } });
    return { ok: true, event_no: eventNo, updated: r.rows.length };
  });

  // 재고금액 검토: 제품별 재고금액과 근거(수입 입고 이력) 여부. 근거=stock_movements에 batch_id 존재.
  app.get('/api/stock/value-audit', { preHandler: [authGuard, requirePageAny(['stock', 'sales'])] }, async () => {
    const rows = (await query(
      `SELECT p.id, p.code, p.name, p.stock_qty, p.avg_cost,
              (COALESCE(p.stock_qty,0)*COALESCE(p.avg_cost,0)) AS value,
              EXISTS(SELECT 1 FROM stock_movements m WHERE m.product_id=p.id AND m.batch_id IS NOT NULL) AS has_import
         FROM products p
        WHERE p.deleted_at IS NULL AND COALESCE(p.stock_qty,0)<>0 AND COALESCE(p.avg_cost,0)<>0
        ORDER BY (COALESCE(p.stock_qty,0)*COALESCE(p.avg_cost,0)) DESC`)).rows;
    let supported = 0, unsupported = 0;
    const items = rows.map((r) => {
      const v = Math.round(Number(r.value) * 100) / 100;
      if (r.has_import) supported += v; else unsupported += v;
      return { id: r.id, code: r.code, name: r.name, stock_qty: Number(r.stock_qty), avg_cost: Number(r.avg_cost), value: v, has_import: r.has_import };
    });
    return {
      items,
      total: Math.round((supported + unsupported) * 100) / 100,
      supported: Math.round(supported * 100) / 100,
      unsupported: Math.round(unsupported * 100) / 100,
    };
  });

  // 재고금액 근거 없는 항목(수입 이력 없음)의 평균원가를 0으로. scope='all'이면 전체 0.
  app.post('/api/stock/value-audit/reset', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const all = req.body && req.body.scope === 'all';
    const q = all
      ? `UPDATE products SET avg_cost=0 WHERE deleted_at IS NULL AND COALESCE(avg_cost,0)<>0 RETURNING id`
      : `UPDATE products p SET avg_cost=0
           WHERE p.deleted_at IS NULL AND COALESCE(p.avg_cost,0)<>0
             AND NOT EXISTS(SELECT 1 FROM stock_movements m WHERE m.product_id=p.id AND m.batch_id IS NOT NULL)
         RETURNING id`;
    const r = await query(q);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: 'stock_value_audit', detail: { scope: all ? 'all' : 'unsupported', zeroed: r.rows.length } });
    return { ok: true, zeroed: r.rows.length };
  });

  // 수입 배치 통째 삭제: 같은 batch_id의 입고 이동을 모두 삭제하고 재고를 역산(입고분 차감).
  app.delete('/api/stock/batches/:batchId', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const batchId = Number(req.params.batchId);
    if (!batchId) return reply.code(400).send({ error: 'bad_batch' });
    const result = await withTx(async (c) => {
      const rows = (await c.query(
        `SELECT id, product_id, move_type, qty FROM stock_movements WHERE batch_id=$1 FOR UPDATE`, [batchId])).rows;
      if (!rows.length) return { error: 'not_found' };
      for (const r of rows) {
        const p = (await c.query(`SELECT stock_qty FROM products WHERE id=$1 FOR UPDATE`, [r.product_id])).rows[0];
        if (!p) continue;
        const qty = Number(r.qty) || 0;
        let delta;
        if (r.move_type === 'in') delta = Math.abs(qty);
        else if (r.move_type === 'out') delta = -Math.abs(qty);
        else delta = qty;
        await c.query(`UPDATE products SET stock_qty=$1, updated_by=$2 WHERE id=$3`, [(Number(p.stock_qty) || 0) - delta, req.ctx.perm.userId, r.product_id]);
      }
      await c.query(`DELETE FROM stock_movements WHERE batch_id=$1`, [batchId]);
      return { ok: true, deleted: rows.length };
    });
    if (result.error) return reply.code(result.error === 'not_found' ? 404 : 400).send(result);
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `stock_batch:${batchId}`, detail: { deleted: result.deleted } });
    return result;
  });

  // 이벤트 삭제: 매출/수입 연동이 없는 수동·기타 이벤트만. 재고를 역산(입고→차감, 출고→복원)하고 행 삭제.
  app.delete('/api/stock/events/:eventNo', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const eventNo = Number(req.params.eventNo);
    if (!eventNo) return reply.code(400).send({ error: 'bad_event' });
    const result = await withTx(async (c) => {
      const rows = (await c.query(
        `SELECT id, product_id, move_type, qty, sales_invoice_id, batch_id FROM stock_movements WHERE event_no=$1 FOR UPDATE`, [eventNo])).rows;
      if (!rows.length) return { error: 'not_found' };
      if (rows.some((r) => r.sales_invoice_id || r.batch_id)) return { error: 'linked', note: '매출·수입에 연동된 이벤트는 삭제할 수 없습니다.' };
      let affected = 0;
      for (const r of rows) {
        const p = (await c.query(`SELECT stock_qty FROM products WHERE id=$1 FOR UPDATE`, [r.product_id])).rows[0];
        if (!p) continue;
        const qty = Number(r.qty) || 0;
        let delta; // 원래 이동이 재고에 더한 양
        if (r.move_type === 'in') delta = Math.abs(qty);
        else if (r.move_type === 'out') delta = -Math.abs(qty);
        else delta = qty; // adjust: 저장된 부호 그대로
        const next = (Number(p.stock_qty) || 0) - delta; // 역산
        await c.query(`UPDATE products SET stock_qty=$1, updated_by=$2 WHERE id=$3`, [next, req.ctx.perm.userId, r.product_id]);
        affected++;
      }
      await c.query(`DELETE FROM stock_movements WHERE event_no=$1`, [eventNo]);
      return { ok: true, deleted: rows.length, products: affected };
    });
    if (result.error) {
      const code = result.error === 'not_found' ? 404 : (result.error === 'linked' ? 409 : 400);
      return reply.code(code).send(result);
    }
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `stock_event:${eventNo}`, detail: { deleted: result.deleted } });
    return result;
  });

  app.get('/api/stock/movements', { preHandler: [authGuard, requirePageAny(['stock','sales'])] }, async (req) => {
    const conds = []; const args = [];
    if (req.query.product_id) { args.push(Number(req.query.product_id)); conds.push(`m.product_id=$${args.length}`); }
    if (['in', 'out', 'adjust'].includes(String(req.query.move_type))) { args.push(req.query.move_type); conds.push(`m.move_type=$${args.length}`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ''))) { args.push(req.query.from); conds.push(`m.moved_at >= $${args.length}`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ''))) { args.push(req.query.to); conds.push(`m.moved_at < ($${args.length}::date + 1)`); }
    if (req.query.source === 'manual') conds.push(`m.source='manual'`);
    if (req.query.event_no && /^\d+$/.test(String(req.query.event_no))) { args.push(Number(req.query.event_no)); conds.push(`m.event_no=$${args.length}`); }
    if (req.query.q && String(req.query.q).trim()) {
      args.push('%' + String(req.query.q).trim() + '%');
      conds.push(`(m.ref ILIKE $${args.length} OR m.note ILIKE $${args.length} OR p.code ILIKE $${args.length} OR p.name ILIKE $${args.length})`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const rows = (await query(
      `SELECT m.id, m.product_id, m.move_type, m.qty, m.unit_cost_mxn, m.ref, m.note, m.source, m.moved_at,
              m.sales_invoice_id, m.batch_id, m.event_no,
              p.code AS ctr_code, p.name AS product_name,
              u.name AS created_by_name,
              cu.name AS customer_name, si.sat_no AS sat_no
         FROM stock_movements m
         JOIN products p ON p.id=m.product_id
         LEFT JOIN users u ON u.id=m.created_by
         LEFT JOIN sales_invoices si ON si.id=m.sales_invoice_id
         LEFT JOIN customers cu ON cu.id=si.customer_id
         ${where}
        ORDER BY m.moved_at DESC, m.id DESC
        LIMIT ${limit}`, args)).rows;
    return {
      limit, capped: rows.length >= limit,
      items: rows.map((r) => ({
        id: Number(r.id), product_id: r.product_id, event_no: r.event_no == null ? null : Number(r.event_no),
        batch_id: r.batch_id == null ? null : Number(r.batch_id), sales_invoice_id: r.sales_invoice_id == null ? null : Number(r.sales_invoice_id),
        ctr_code: r.ctr_code, product_name: r.product_name,
        move_type: r.move_type, qty: Number(r.qty), unit_cost_mxn: r.unit_cost_mxn != null ? Number(r.unit_cost_mxn) : null,
        ref: r.ref, note: r.note, moved_at: r.moved_at,
        origin: r.sales_invoice_id ? '매출' : (r.batch_id ? '수입' : (r.source === 'manual' ? '수동' : '기타')),
        created_by_name: r.created_by_name || null,
        customer_name: r.customer_name || null, sat_no: r.sat_no || null,
      })),
    };
  });
}
