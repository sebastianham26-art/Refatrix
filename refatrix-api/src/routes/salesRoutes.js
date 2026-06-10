import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { computeLine, computeInvoiceTotals, dueDate, isCreditException } from '../sales.js';
import { round2 } from '../permissions.js';
import { logEvent } from '../audit.js';

export default async function salesRoutes(app) {
  // ---- 고객 (매출 전제, 간단 버전) ----
  app.get('/api/customers', { preHandler: [authGuard, requirePage('customers')] }, async (req) => {
    const q = (req.query.q || '').trim();
    const params = [];
    let where = 'deleted_at IS NULL';
    if (q) { params.push(`%${q}%`); where += ` AND (code ILIKE $${params.length} OR name ILIKE $${params.length} OR rfc ILIKE $${params.length})`; }
    const rows = (await query(
      `SELECT id, code, name, rfc, discount, credit_days, owner_id
         FROM customers WHERE ${where} ORDER BY code LIMIT 50`, params)).rows;
    return { items: rows };
  });

  app.post('/api/customers', { preHandler: [authGuard, requirePage('customers')] }, async (req, reply) => {
    const { code, name, rfc, discount = 0, credit_days = 0, memo } = req.body || {};
    if (!code || !name) return reply.code(400).send({ error: 'code_and_name_required' });
    const dup = (await query(`SELECT 1 FROM customers WHERE code=$1`, [code])).rows[0];
    if (dup) return reply.code(409).send({ error: 'code_taken' });
    const r = await query(
      `INSERT INTO customers (code, name, rfc, discount, credit_days, memo, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [code, name, rfc || null, discount, credit_days, memo || null, req.ctx.perm.userId]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `customer:${r.rows[0].id}` });
    return { id: r.rows[0].id, code, name };
  });

  // ---- 매출 인보이스 등록 (즉시 반영, 승인 불필요) ----
  // body: { sat_no?, customer_id, inv_date, credit_days?(예외 시), lines:[{product_id, qty, discount_rate?}], memo? }
  app.post('/api/sales', { preHandler: [authGuard, requirePage('sales')] }, async (req, reply) => {
    const { sat_no, customer_id, inv_date, credit_days, lines = [], memo, credit_memo } = req.body || {};
    if (!customer_id || !inv_date || !lines.length) {
      return reply.code(400).send({ error: 'customer_date_lines_required' });
    }
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const cust = (await c.query(`SELECT id, discount, credit_days FROM customers WHERE id=$1 AND deleted_at IS NULL`, [customer_id])).rows[0];
      if (!cust) return { error: 'customer_not_found' };

      const custDiscount = Number(cust.discount) || 0;
      const baseCreditDays = Number(cust.credit_days) || 0;
      const appliedDays = (credit_days == null || credit_days === '') ? baseCreditDays : Number(credit_days);
      const exception = isCreditException(appliedDays, baseCreditDays);

      // 라인 계산 + 재고 확인 (부족 시 있는 만큼만 출고, 부족분은 기록)
      const r3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
      const allowPartial = req.body?.allow_partial === true;
      const computed = [];   // 실제 출고(인보이싱)될 라인
      const shortages = [];  // 부족분 기록 대상
      for (const l of lines) {
        const p = (await c.query(`SELECT id, code, name, list_price, stock_qty, avg_cost FROM products WHERE id=$1 AND deleted_at IS NULL`, [l.product_id])).rows[0];
        if (!p) return { error: `product_not_found:${l.product_id}` };
        const reqQty = Number(l.qty);
        const avail = Math.max(Number(p.stock_qty), 0);
        const fulfill = Math.min(reqQty, avail);
        const short = r3(reqQty - fulfill);
        if (short > 0) shortages.push({ product_id: p.id, code: p.code, name: p.name, requested: reqQty, available: avail, shortage: short });
        if (fulfill > 0) {
          const discRate = (l.discount_rate == null || l.discount_rate === '') ? custDiscount : Number(l.discount_rate);
          const line = computeLine({ qty: fulfill, listPrice: p.list_price, discountRate: discRate, cost: p.avg_cost });
          computed.push({ ...line, product_id: p.id, code: p.code });
        }
      }

      // 부족이 있는데 영업 확인(allow_partial)을 안 받았으면 막고 부족내역 반환
      if (shortages.length && !allowPartial) return { error: 'stock_short', shortages };

      const due = dueDate(inv_date, appliedDays);

      // 출고분이 하나도 없으면: 인보이스 없이 부족분만 기록
      if (!computed.length) {
        for (const s of shortages) {
          await c.query(
            `INSERT INTO stock_shortages (product_id, customer_id, sales_invoice_id, requested_qty, fulfilled_qty, shortage_qty, occurred_at, created_by)
             VALUES ($1,$2,NULL,$3,0,$4,$5,$6)`,
            [s.product_id, customer_id, s.requested, s.shortage, inv_date, userId]);
        }
        return { id: null, invoiced: false, shortages, due };
      }

      const totals = computeInvoiceTotals(computed, 16);

      // 헤더
      const inv = (await c.query(
        `INSERT INTO sales_invoices
           (sat_no, customer_id, inv_date, credit_days, due_date, credit_exception, credit_memo, credit_approved,
            iva_rate, subtotal_mxn, iva_mxn, total_mxn, status, owner_id, memo, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,16,$9,$10,$11,'posted',$12,$13,$14) RETURNING id`,
        [sat_no || null, customer_id, inv_date, appliedDays, due, exception, exception ? (credit_memo || null) : null,
         exception ? false : true, totals.subtotalMxn, totals.ivaMxn, totals.totalMxn, userId, memo || null, userId])).rows[0];

      // 라인 + 재고 차감 + 원장(out)
      for (const ln of computed) {
        const lineRow = (await c.query(
          `INSERT INTO sales_invoice_lines
             (invoice_id, product_id, qty, list_price, discount_rate, unit_price, line_amount_mxn, applied_unit_cost, cogs_mxn)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [inv.id, ln.product_id, ln.qty, ln.listPrice, ln.discountRate, ln.unitPrice, ln.lineAmountMxn, ln.appliedUnitCost, ln.cogsMxn])).rows[0];
        await c.query(`UPDATE products SET stock_qty = stock_qty - $1, updated_by=$2 WHERE id=$3`, [ln.qty, userId, ln.product_id]);
        await c.query(
          `INSERT INTO stock_movements (product_id, move_type, qty, unit_cost_mxn, ref, sales_invoice_id, sales_invoice_line_id, created_by)
           VALUES ($1,'out',$2,$3,$4,$5,$6,$7)`,
          [ln.product_id, ln.qty, ln.appliedUnitCost, `sales:${inv.id}`, inv.id, lineRow.id, userId]);
      }

      // 부족분 기록 (인보이스 연결)
      for (const s of shortages) {
        await c.query(
          `INSERT INTO stock_shortages (product_id, customer_id, sales_invoice_id, requested_qty, fulfilled_qty, shortage_qty, occurred_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [s.product_id, customer_id, inv.id, s.requested, r3(s.requested - s.shortage), s.shortage, inv_date, userId]);
      }

      // 입금 예정(AR) — transactions plan, 인보이스당 한 건, 총액(IVA 포함)
      const txn = (await c.query(
        `INSERT INTO transactions (txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, sales_invoice_id, memo, created_by)
         VALUES ($1,'in',$2,'MXN',1,$2,'4010','plan','invoice',true,$3,$4,$5,$6) RETURNING id`,
        [due, totals.totalMxn, userId, inv.id, `매출 입금예정 (인보이스 #${inv.id})`, userId])).rows[0];
      await c.query(`UPDATE sales_invoices SET txn_id=$1 WHERE id=$2`, [txn.id, inv.id]);

      return { id: inv.id, invoiced: true, totals, due, exception, shortages };
    });

    if (out.error === 'stock_short') return reply.code(409).send({ error: 'stock_short', shortages: out.shortages });
    if (out.error) return reply.code(out.error.startsWith('insufficient') ? 409 : 400).send({ error: out.error });
    await logEvent({ userId, deviceId: req.ctx.deviceId, action: 'create', target: `sales_invoice:${out.id || 'none'}`, detail: { exception: out.exception, shortages: out.shortages?.length || 0 } });
    return out;
  });

  // ---- 매출 목록 ----
  app.get('/api/sales', { preHandler: [authGuard, requirePage('sales')] }, async (req) => {
    const rows = (await query(
      `SELECT s.id, s.sat_no, s.inv_date, s.due_date, s.credit_days, s.credit_exception, s.credit_approved,
              s.subtotal_mxn, s.iva_mxn, s.total_mxn, s.status, c.code AS customer_code, c.name AS customer_name
         FROM sales_invoices s JOIN customers c ON c.id=s.customer_id
        WHERE s.deleted_at IS NULL ORDER BY s.inv_date DESC, s.id DESC LIMIT 100`)).rows;
    return { items: rows };
  });

  // ---- 매출 상세(라인 포함) ----
  app.get('/api/sales/:id', { preHandler: [authGuard, requirePage('sales')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const head = (await query(
      `SELECT s.*, c.code AS customer_code, c.name AS customer_name, c.credit_days AS customer_credit_days
         FROM sales_invoices s JOIN customers c ON c.id=s.customer_id WHERE s.id=$1`, [id])).rows[0];
    if (!head) return reply.code(404).send({ error: 'not_found' });
    const lines = (await query(
      `SELECT l.*, p.code, p.name FROM sales_invoice_lines l JOIN products p ON p.id=l.product_id WHERE l.invoice_id=$1 ORDER BY l.id`, [id])).rows;
    return { invoice: head, lines };
  });

  // ---- 예외 외상일 승인 대기 목록(디렉터) ----
  app.get('/api/sales/credit-exceptions/pending', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(
      `SELECT s.id, s.sat_no, s.inv_date, s.credit_days, s.due_date, s.credit_memo, s.total_mxn,
              c.code AS customer_code, c.name AS customer_name, c.credit_days AS base_credit_days
         FROM sales_invoices s JOIN customers c ON c.id=s.customer_id
        WHERE s.credit_exception=true AND s.credit_approved=false AND s.deleted_at IS NULL
        ORDER BY s.inv_date DESC`)).rows;
    return { items: rows };
  });

  // ---- 예외 외상일 승인/반려(디렉터) ----
  app.post('/api/sales/:id/credit-approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const { approve = true, reset_to_base = false } = req.body || {};
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const s = (await c.query(`SELECT s.*, cu.credit_days AS base_days FROM sales_invoices s JOIN customers cu ON cu.id=s.customer_id WHERE s.id=$1`, [id])).rows[0];
      if (!s) return { error: 'not_found' };
      if (!s.credit_exception) return { error: 'not_exception' };
      if (approve) {
        await c.query(`UPDATE sales_invoices SET credit_approved=true, credit_approved_by=$1, credit_approved_at=now() WHERE id=$2`, [userId, id]);
        return { ok: true, approved: true };
      }
      // 반려: 기준 외상일로 되돌림(요청 시) + 입금예정일 재계산
      const baseDays = Number(s.base_days) || 0;
      const newDue = dueDate(String(s.inv_date).slice(0, 10), baseDays);
      await c.query(
        `UPDATE sales_invoices SET credit_days=$1, due_date=$2, credit_exception=false, credit_approved=true, credit_approved_by=$3, credit_approved_at=now() WHERE id=$4`,
        [baseDays, newDue, userId, id]);
      if (s.txn_id) await c.query(`UPDATE transactions SET txn_date=$1 WHERE id=$2`, [newDue, s.txn_id]);
      return { ok: true, approved: false, resetTo: baseDays, newDue };
    });
    if (out.error) return reply.code(409).send(out);
    await logEvent({ userId, action: 'update', target: `sales_invoice:${id}`, detail: { creditApprove: out.approved } });
    return out;
  });

  // ---- 부족 기록: 제품별 합계(주문용) ----
  app.get('/api/shortages/summary', { preHandler: [authGuard, requirePage('sales')] }, async () => {
    const rows = (await query(
      `SELECT sh.product_id, p.code, p.name, p.stock_qty,
              SUM(sh.shortage_qty) AS open_shortage,
              COUNT(*) AS records,
              MAX(sh.occurred_at) AS last_occurred
         FROM stock_shortages sh JOIN products p ON p.id=sh.product_id
        WHERE sh.status='open'
        GROUP BY sh.product_id, p.code, p.name, p.stock_qty
        ORDER BY open_shortage DESC`)).rows;
    return { items: rows.map((r) => ({ ...r, open_shortage: Number(r.open_shortage), stock_qty: Number(r.stock_qty), records: Number(r.records) })) };
  });

  // ---- 부족 기록: 원장(영업용, 누가·언제·얼마) ----
  app.get('/api/shortages', { preHandler: [authGuard, requirePage('sales')] }, async (req) => {
    const status = req.query.status || 'open';
    const rows = (await query(
      `SELECT sh.id, sh.occurred_at, sh.requested_qty, sh.fulfilled_qty, sh.shortage_qty, sh.status,
              p.code, p.name, c.code AS customer_code, c.name AS customer_name, sh.sales_invoice_id
         FROM stock_shortages sh
         JOIN products p ON p.id=sh.product_id
         LEFT JOIN customers c ON c.id=sh.customer_id
        WHERE ($1='all' OR sh.status=$1)
        ORDER BY sh.occurred_at DESC, sh.id DESC LIMIT 200`, [status])).rows;
    return { items: rows };
  });

  // ---- 부족 기록 해소/취소(디렉터) ----
  app.post('/api/shortages/:id/resolve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const status = (req.body?.status === 'cancelled') ? 'cancelled' : 'resolved';
    const r = await query(
      `UPDATE stock_shortages SET status=$1, resolved_at=now(), resolved_by=$2 WHERE id=$3 AND status='open' RETURNING id`,
      [status, req.ctx.perm.userId, id]);
    if (!r.rows[0]) return reply.code(409).send({ error: 'not_open' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `shortage:${id}`, detail: { status } });
    return { ok: true, status };
  });
}
