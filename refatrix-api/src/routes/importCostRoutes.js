import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { costDocTotalMxn, allocateByQty, applyClosedMonth, isClosedMonth, toMxn } from '../importCost.js';
import { round2 } from '../permissions.js';
import { logEvent } from '../audit.js';

// 한 입고 건의 총수량 (분배 비율 기준)
async function batchTotalQty(c, batchId) {
  const r = await c.query(`SELECT COALESCE(SUM(qty),0) AS q FROM import_lines WHERE batch_id=$1`, [batchId]);
  return Number(r.rows[0].q);
}
async function closedPeriods(c) {
  return (await c.query(`SELECT period FROM period_closings`)).rows.map((r) => r.period);
}

// 승인 시 적용될 제품별 효과를 계산(읽기 전용). preview / approve 공용.
// NOTE: 매출(판매) 모듈 도입 전이므로 "이미 팔린 수량 = 0"으로 본다.
//   → 현재는 전액 재고가산(평균원가 상승), 정산차액/소급COGS = 0.
//   → 매출 원장이 쌓이면 동일 로직에서 분리·정정이 자동 적용된다.
async function computeDoc(c, docId) {
  const doc = (await c.query(`SELECT * FROM import_cost_docs WHERE id=$1 AND deleted_at IS NULL`, [docId])).rows[0];
  if (!doc) return { error: 'not_found' };
  const lines = (await c.query(`SELECT label, amount, currency, invoice_no FROM import_cost_lines WHERE doc_id=$1`, [docId])).rows;
  const allocs = (await c.query(`SELECT * FROM import_cost_allocations WHERE doc_id=$1`, [docId])).rows;
  const closed = await closedPeriods(c);
  const totalMxn = costDocTotalMxn(lines, doc.fx_rate, doc.base_currency);

  const effects = [];
  for (const a of allocs) {
    const batch = (await c.query(`SELECT id, batch_no, import_date FROM import_batches WHERE id=$1`, [a.batch_id])).rows[0];
    const bTotalQty = await batchTotalQty(c, a.batch_id);
    const allocMxn = Number(a.alloc_amount_mxn);
    const perUnit = bTotalQty > 0 ? round2(allocMxn / bTotalQty) : 0;
    const isClosed = isClosedMonth(batch.import_date, closed);

    const plines = (await c.query(
      `SELECT il.product_id, il.qty, p.code, p.name, p.stock_qty, p.avg_cost
         FROM import_lines il JOIN products p ON p.id=il.product_id
        WHERE il.batch_id=$1`, [a.batch_id])).rows;

    for (const pl of plines) {
      const lineQty = Number(pl.qty);
      const allocForProduct = round2(perUnit * lineQty);
      const curStock = Number(pl.stock_qty);
      const curAvg = Number(pl.avg_cost);
      // 판매 모듈 전: soldQtyOfBatch = 0 → 전액 재고가산
      const r = applyClosedMonth({ batchQty: lineQty, soldQtyOfBatch: 0, perUnit, curStockQty: curStock, curAvg });
      effects.push({
        batchId: batch.id, batchNo: batch.batch_no, importDate: batch.import_date, closedMonth: isClosed,
        productId: pl.product_id, code: pl.code, name: pl.name,
        lineQty, perUnit, allocForProduct,
        avgBefore: r.avgBefore, avgAfter: r.avgAfter,
        stockAddedMxn: r.stockAddedMxn, varianceExpenseMxn: 0, retroCogsMxn: 0,
      });
    }
  }
  return {
    docId, status: doc.status, fxRate: Number(doc.fx_rate), totalMxn,
    allocations: allocs.map((a) => ({ batchId: a.batch_id, ratio: Number(a.ratio), allocMxn: Number(a.alloc_amount_mxn) })),
    effects,
  };
}

export default async function importCostRoutes(app) {
  // 승인된 입고 건 목록(부대비용 분배 대상 선택용)
  app.get('/api/import-batches', { preHandler: [authGuard, requirePage('inventory')] }, async (req) => {
    const status = (req.query.status || 'approved');
    const rows = (await query(
      `SELECT b.id, b.batch_no, b.import_date, b.status,
              COALESCE(SUM(il.qty),0) AS total_qty,
              STRING_AGG(DISTINCT p.code, ', ') AS product_codes
         FROM import_batches b
         LEFT JOIN import_lines il ON il.batch_id=b.id
         LEFT JOIN products p ON p.id=il.product_id
        WHERE b.deleted_at IS NULL AND b.status=$1
        GROUP BY b.id ORDER BY b.import_date DESC, b.id DESC LIMIT 200`, [status])).rows;
    return { items: rows.map((r) => ({ ...r, total_qty: Number(r.total_qty) })) };
  });

  // 부대비용 문서 작성(+명세 +분배). 작성 시점엔 원가 미반영(pending).
  app.post('/api/import-costs', { preHandler: [authGuard, requirePage('inventory')] }, async (req, reply) => {
    const { doc_no, cost_date, fx_rate, lines = [], batch_ids = [], note } = req.body || {};
    if (!cost_date || !fx_rate || !lines.length || !batch_ids.length) {
      return reply.code(400).send({ error: 'cost_date_fx_lines_batches_required' });
    }
    const userId = req.ctx.perm.userId;
    const id = await withTx(async (c) => {
      const doc = (await c.query(
        `INSERT INTO import_cost_docs (doc_no, cost_date, fx_rate, status, created_by, note)
         VALUES ($1,$2,$3,'pending',$4,$5) RETURNING id`,
        [doc_no || null, cost_date, fx_rate, userId, note || null])).rows[0];
      for (const l of lines) {
        await c.query(
          `INSERT INTO import_cost_lines (doc_id, label, amount, currency, invoice_no)
           VALUES ($1,$2,$3,$4,$5)`, [doc.id, l.label || '부대비용', l.amount, l.currency || 'USD', l.invoice_no || null]);
      }
      // 분배: 선택된 입고 건들의 총수량 비율로 배분(스냅샷 저장)
      const total = costDocTotalMxn(lines, fx_rate);
      const batches = [];
      for (const bid of batch_ids) batches.push({ batchId: bid, qty: await batchTotalQty(c, bid) });
      const alloc = allocateByQty(total, batches);
      for (const a of alloc) {
        await c.query(
          `INSERT INTO import_cost_allocations (doc_id, batch_id, batch_qty, ratio, alloc_amount_mxn)
           VALUES ($1,$2,$3,$4,$5)`, [doc.id, a.batchId, a.qty, a.ratio, a.allocMxn]);
      }
      return doc.id;
    });
    await logEvent({ userId, deviceId: req.ctx.deviceId, action: 'create', target: `import_cost:${id}` });
    return { id, status: 'pending' };
  });

  // 미리보기(반영 없음) — 디렉터 검토 화면 데이터
  app.get('/api/import-costs/:id/preview', { preHandler: [authGuard, requirePage('inventory')] }, async (req, reply) => {
    const out = await computeDoc({ query: (t, p) => query(t, p) }, Number(req.params.id));
    if (out.error) return reply.code(404).send(out);
    return out;
  });

  // 승인 대기 목록(디렉터)
  app.get('/api/import-costs/pending', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(
      `SELECT d.id, d.doc_no, d.cost_date, d.fx_rate, d.created_at,
              COALESCE(SUM(toMxn.amt),0) AS total_mxn,
              (SELECT COUNT(*) FROM import_cost_allocations a WHERE a.doc_id=d.id) AS batch_count
         FROM import_cost_docs d
         LEFT JOIN LATERAL (
           SELECT CASE WHEN l.currency='MXN' THEN l.amount ELSE l.amount*d.fx_rate END AS amt
             FROM import_cost_lines l WHERE l.doc_id=d.id
         ) toMxn ON true
        WHERE d.status='pending' AND d.deleted_at IS NULL
        GROUP BY d.id ORDER BY d.created_at`)).rows;
    return { items: rows.map((r) => ({ ...r, total_mxn: round2(Number(r.total_mxn)), batch_count: Number(r.batch_count) })) };
  });

  // 디렉터 승인 → 평균원가 반영 + 스냅샷 기록 (트랜잭션)
  app.post('/api/import-costs/:id/approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const doc = (await c.query(`SELECT * FROM import_cost_docs WHERE id=$1`, [id])).rows[0];
      if (!doc || doc.status !== 'pending') return { error: 'not_pending' };

      const computed = await computeDoc(c, id);
      for (const e of computed.effects) {
        // 평균원가 갱신(재고가산분 반영). 판매 모듈 전이므로 전액 재고가산.
        await c.query(
          `UPDATE products SET avg_cost=$1, updated_by=$2 WHERE id=$3`,
          [e.avgAfter, userId, e.productId]);
        // 처리 결과 스냅샷
        await c.query(
          `INSERT INTO import_cost_adjustments
             (doc_id, batch_id, product_id, closed_month, batch_qty, per_unit_mxn,
              sold_qty, remaining_qty, stock_added_mxn, variance_expense_mxn, retro_cogs_mxn,
              avg_cost_before, avg_cost_after)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [id, e.batchId, e.productId, e.closedMonth, e.lineQty, e.perUnit,
           0, e.lineQty, e.stockAddedMxn, e.varianceExpenseMxn, e.retroCogsMxn,
           e.avgBefore, e.avgAfter]);
        // 재고이동 원장에 정산(adjust) 기록(수량 변화 없음, 원가 가산 근거)
        await c.query(
          `INSERT INTO stock_movements (product_id, move_type, qty, unit_cost_mxn, ref, cost_doc_id, created_by)
           VALUES ($1,'adjust',0,$2,$3,$4,$5)`,
          [e.productId, e.perUnit, `cost_doc:${id}`, id, userId]);
      }
      await c.query(
        `UPDATE import_cost_docs SET status='approved', approved_by=$1, approved_at=now() WHERE id=$2`,
        [userId, id]);
      return { ok: true, effects: computed.effects, totalMxn: computed.totalMxn };
    });
    if (out.error) return reply.code(409).send(out);
    await logEvent({ userId, deviceId: req.ctx.deviceId, action: 'update', target: `import_cost:${id}`, detail: { approved: true } });
    return out;
  });

  // 월 마감(디렉터) — 잠금
  app.post('/api/periods/:period/close', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const period = String(req.params.period); // 'YYYY-MM'
    if (!/^\d{4}-\d{2}$/.test(period)) return reply.code(400).send({ error: 'bad_period' });
    await query(
      `INSERT INTO period_closings (period, closed_by) VALUES ($1,$2)
       ON CONFLICT (period) DO NOTHING`, [period, req.ctx.perm.userId]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'period_close', target: period });
    return { ok: true, period };
  });
  app.get('/api/periods/closed', { preHandler: [authGuard, requirePage('inventory')] }, async () => {
    const rows = (await query(`SELECT period, closed_at FROM period_closings ORDER BY period`)).rows;
    return { items: rows };
  });
}
