import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { computeImportCosting } from '../cost.js';
import { logEvent } from '../audit.js';

export default async function importRoutes(app) {
  // 수입 입고 작성(영업지원). 라인(SKU별) + 부대비용(명목·인보이스별).
  // 작성 시점에는 재고/평균원가에 영향 없음(status=pending).
  app.post('/api/imports', { preHandler: [authGuard, requirePage('inventory')] }, async (req, reply) => {
    const { batch_no, import_date, currency = 'USD', fx_rate, lines = [], overheads = [], note } = req.body || {};
    if (!import_date || !fx_rate || !lines.length) {
      return reply.code(400).send({ error: 'import_date_fx_lines_required' });
    }
    const userId = req.ctx.perm.userId;
    const result = await withTx(async (c) => {
      const b = (await c.query(
        `INSERT INTO import_batches (batch_no, import_date, currency, fx_rate, status, created_by, note)
         VALUES ($1,$2,$3,$4,'pending',$5,$6) RETURNING id`,
        [batch_no, import_date, currency, fx_rate, userId, note])).rows[0];
      for (const l of lines) {
        await c.query(
          `INSERT INTO import_lines (batch_id, product_id, qty, import_price, currency, invoice_no)
           VALUES ($1,$2,$3,$4,$5,$6)`, [b.id, l.product_id, l.qty, l.import_price, l.currency || currency, l.invoice_no || null]);
      }
      for (const o of overheads) {
        await c.query(
          `INSERT INTO import_overheads (batch_id, label, amount, currency, invoice_no)
           VALUES ($1,$2,$3,$4,$5)`, [b.id, o.label, o.amount, o.currency || currency, o.invoice_no || null]);
      }
      return b.id;
    });
    await logEvent({ userId, deviceId: req.ctx.deviceId, action: 'create', target: `import_batch:${result}` });
    const skuCount = new Set(lines.map((l) => l.product_id)).size;
    const totalQty = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    const fx = Number(fx_rate) || 1;
    const baseCur = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.import_price) || 0), 0);
    const ohMxn = (overheads || []).reduce((s, o) => s + ((o.currency === 'USD' ? Number(o.amount || 0) * fx : Number(o.amount || 0))), 0);
    const stockValueMxn = Math.round((baseCur * (currency === 'USD' ? fx : 1) + ohMxn) * 100) / 100;
    return { id: result, status: 'pending', sku_count: skuCount, total_qty: totalQty, stock_value_mxn: stockValueMxn };
  });

  // 미리보기: 승인 시 적용될 단위원가·평균원가를 계산해서 보여줌(반영 없음)
  app.get('/api/imports/:id/preview', { preHandler: [authGuard, requirePage('inventory')] }, async (req) => {
    return computeBatch(Number(req.params.id));
  });

  // 디렉터 승인 → 이동평균 갱신, 재고 증가, 원장 기록 (트랜잭션)
  app.post('/api/imports/:id/approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const userId = req.ctx.perm.userId;

    const out = await withTx(async (c) => {
      const batch = (await c.query(`SELECT * FROM import_batches WHERE id=$1`, [id])).rows[0];
      if (!batch || batch.status !== 'pending') return { error: 'not_pending' };

      const lines = (await c.query(`SELECT * FROM import_lines WHERE batch_id=$1`, [id])).rows;
      const overheads = (await c.query(`SELECT * FROM import_overheads WHERE batch_id=$1`, [id])).rows;

      // 관련 제품 현재 상태 잠금(FOR UPDATE)
      const pids = [...new Set(lines.map((l) => l.product_id))];
      const ps = (await c.query(
        `SELECT id, stock_qty, avg_cost FROM products WHERE id = ANY($1) FOR UPDATE`, [pids])).rows;
      const productState = {};
      for (const p of ps) productState[p.id] = { stock_qty: p.stock_qty, avg_cost: p.avg_cost };

      const { computedLines, newState } = computeImportCosting({
        lines, overheads, fxRate: batch.fx_rate, productState, batchCurrency: batch.currency,
      });

      // 라인 원가 스냅샷 기록
      const evNo = Number((await c.query(`SELECT nextval('stock_event_seq') AS n`)).rows[0].n);
      // 참조(referencia): 라인별 매입 인보이스 번호 → 없으면 batch_no → 없으면 batch:#
      const invByProduct = {};
      for (const l of lines) { if (l.invoice_no && String(l.invoice_no).trim()) invByProduct[l.product_id] = String(l.invoice_no).trim(); }
      const refFallback = (batch.batch_no && String(batch.batch_no).trim()) ? String(batch.batch_no).trim() : `batch:${id}`;
      for (const cl of computedLines) {
        await c.query(
          `UPDATE import_lines SET alloc_overhead=$1, unit_cost_mxn=$2, avg_cost_after=$3
             WHERE batch_id=$4 AND product_id=$5`,
          [cl.alloc_overhead, cl.unit_cost_mxn, cl.avg_cost_after, id, cl.product_id]);
        // 입출고 원장(입고) — 배치 전체가 하나의 이벤트. 날짜는 지정한 import_date(재고 등재일), 참조는 인보이스 번호.
        await c.query(
          `INSERT INTO stock_movements (product_id, move_type, qty, unit_cost_mxn, ref, batch_id, event_no, moved_at, created_by)
           VALUES ($1,'in',$2,$3,$4,$5,$6,$7,$8)`,
          [cl.product_id, cl.qty, cl.unit_cost_mxn, invByProduct[cl.product_id] || refFallback, id, evNo, batch.import_date, userId]);
      }
      // 제품 재고·평균원가 갱신
      for (const [pid, st] of Object.entries(newState)) {
        await c.query(
          `UPDATE products SET stock_qty=$1, avg_cost=$2, updated_by=$3 WHERE id=$4`,
          [st.stock_qty, st.avg_cost, userId, pid]);
      }
      await c.query(
        `UPDATE import_batches SET status='approved', approved_by=$1, approved_at=now() WHERE id=$2`,
        [userId, id]);
      return { ok: true, lines: computedLines };
    });

    if (out.error) return reply.code(409).send({ error: out.error });
    await logEvent({ userId, deviceId: req.ctx.deviceId, action: 'update', target: `import_batch:${id}`, detail: { approved: true } });
    return out;
  });

  // 반려(승인거절) — 재고 변동 없음, 거절 기록만
  app.post('/api/imports/:id/reject', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const userId = req.ctx.perm.userId;
    const reason = (req.body && req.body.reason) ? String(req.body.reason).slice(0, 500) : null;
    const batch = (await query(`SELECT id, status FROM import_batches WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!batch) return reply.code(404).send({ error: 'not_found' });
    if (batch.status !== 'pending') return reply.code(409).send({ error: 'not_pending' });
    await query(
      `UPDATE import_batches SET status='rejected', rejected_by=$1, rejected_at=now(), reject_reason=$2 WHERE id=$3`,
      [userId, reason, id]);
    await logEvent({ userId, deviceId: req.ctx.deviceId, action: 'update', target: `import_batch:${id}`, detail: { rejected: true, reason } });
    return { ok: true, status: 'rejected' };
  });
}

// 미리보기 계산(읽기 전용)
async function computeBatch(id) {
  const batch = (await query(`SELECT * FROM import_batches WHERE id=$1`, [id])).rows[0];
  if (!batch) return { error: 'not_found' };
  const lines = (await query(`SELECT * FROM import_lines WHERE batch_id=$1`, [id])).rows;
  const overheads = (await query(`SELECT * FROM import_overheads WHERE batch_id=$1`, [id])).rows;
  const pids = [...new Set(lines.map((l) => l.product_id))];
  const ps = pids.length
    ? (await query(`SELECT id, stock_qty, avg_cost FROM products WHERE id = ANY($1)`, [pids])).rows
    : [];
  const productState = {};
  for (const p of ps) productState[p.id] = { stock_qty: p.stock_qty, avg_cost: p.avg_cost };
  const { computedLines } = computeImportCosting({ lines, overheads, fxRate: batch.fx_rate, productState, batchCurrency: batch.currency });
  return { batch_id: id, status: batch.status, preview: computedLines };
}
