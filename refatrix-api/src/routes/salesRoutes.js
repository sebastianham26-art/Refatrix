import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { computeLine, computeInvoiceTotals, dueDate, isCreditException, computeDeleteReversal, computeEditNetEffect, ymd } from '../sales.js';
import { isClosedMonth } from '../importCost.js';
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
      const newDue = dueDate(s.inv_date, baseDays);
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

  // ===== 매출 수정·삭제 승인 워크플로 (원본 격리, 디렉터 승인 시 반영) =====

  // 헬퍼: 원본 인보이스 + 라인 로드, 마감월 판정
  async function loadInvoiceForChange(c, id) {
    const inv = (await c.query(`SELECT * FROM sales_invoices WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!inv) return null;
    const lines = (await c.query(`SELECT * FROM sales_invoice_lines WHERE invoice_id=$1`, [id])).rows;
    const closed = (await c.query(`SELECT period FROM period_closings`)).rows.map((r) => r.period);
    inv._closedMonth = isClosedMonth(String(inv.inv_date).slice(0, 10), closed);
    inv._lines = lines.map((l) => ({ productId: l.product_id, qty: Number(l.qty), appliedUnitCost: Number(l.applied_unit_cost), lineAmountMxn: Number(l.line_amount_mxn) }));
    return inv;
  }

  // 수정 요청 (영업/디렉터) — 원본 유지, edit_pending
  // body: { reason, lines:[{product_id, qty, discount_rate?}], credit_days?, sat_no?, inv_date? }
  app.post('/api/sales/:id/edit-request', { preHandler: [authGuard, requirePage('sales')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const { reason, lines, credit_days, sat_no, inv_date } = req.body || {};
    if (!Array.isArray(lines) || !lines.length) return reply.code(400).send({ error: 'lines_required' });
    const inv = (await query(`SELECT id, status FROM sales_invoices WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!inv) return reply.code(404).send({ error: 'not_found' });
    if (inv.status !== 'posted') return reply.code(409).send({ error: 'not_posted' });
    const payload = { lines, credit_days: credit_days ?? null, sat_no: sat_no ?? null, inv_date: inv_date ?? null };
    const r = await query(
      `INSERT INTO sales_change_requests (invoice_id, req_type, payload, reason, requested_by)
       VALUES ($1,'edit',$2,$3,$4) RETURNING id`, [id, JSON.stringify(payload), reason || null, req.ctx.perm.userId]);
    await query(`UPDATE sales_invoices SET status='edit_pending' WHERE id=$1`, [id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `sales_change_request:${r.rows[0].id}`, detail: { type: 'edit', invoice: id } });
    return { id: r.rows[0].id, type: 'edit', status: 'pending' };
  });

  // 삭제 요청 (영업/디렉터) — 원본 유지, delete_pending
  app.post('/api/sales/:id/delete-request', { preHandler: [authGuard, requirePage('sales')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const { reason } = req.body || {};
    const inv = (await query(`SELECT id, status FROM sales_invoices WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!inv) return reply.code(404).send({ error: 'not_found' });
    if (inv.status !== 'posted') return reply.code(409).send({ error: 'not_posted' });
    const r = await query(
      `INSERT INTO sales_change_requests (invoice_id, req_type, payload, reason, requested_by)
       VALUES ($1,'delete',NULL,$2,$3) RETURNING id`, [id, reason || null, req.ctx.perm.userId]);
    await query(`UPDATE sales_invoices SET status='delete_pending' WHERE id=$1`, [id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `sales_change_request:${r.rows[0].id}`, detail: { type: 'delete', invoice: id } });
    return { id: r.rows[0].id, type: 'delete', status: 'pending' };
  });

  // 변경요청 대기 목록 (디렉터)
  app.get('/api/sales/change-requests/pending', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(
      `SELECT cr.id, cr.invoice_id, cr.req_type, cr.payload, cr.reason, cr.requested_at,
              s.sat_no, s.inv_date, s.total_mxn, s.credit_days,
              c.code AS customer_code, c.name AS customer_name
         FROM sales_change_requests cr
         JOIN sales_invoices s ON s.id=cr.invoice_id
         JOIN customers c ON c.id=s.customer_id
        WHERE cr.status='pending' ORDER BY cr.requested_at`)).rows;
    return { items: rows };
  });

  // 변경요청 상세 미리보기 (디렉터) — 전/후 비교 + 예상 정산차액 (DB 변경 없음)
  app.get('/api/sales/change-requests/:reqId/detail', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const reqId = Number(req.params.reqId);
    const cr = (await query(`SELECT * FROM sales_change_requests WHERE id=$1`, [reqId])).rows[0];
    if (!cr) return reply.code(404).send({ error: 'not_found' });
    const inv = (await query(`SELECT * FROM sales_invoices WHERE id=$1`, [cr.invoice_id])).rows[0];
    if (!inv) return reply.code(404).send({ error: 'invoice_not_found' });
    const cust = (await query(`SELECT discount, credit_days, code, name FROM customers WHERE id=$1`, [inv.customer_id])).rows[0];
    const origRows = (await query(
      `SELECT l.product_id, l.qty, l.list_price, l.discount_rate, l.unit_price, l.line_amount_mxn, l.applied_unit_cost, l.cogs_mxn, p.code, p.name
         FROM sales_invoice_lines l JOIN products p ON p.id=l.product_id WHERE l.invoice_id=$1 ORDER BY l.id`, [cr.invoice_id])).rows;
    const closedList = (await query(`SELECT period FROM period_closings`)).rows.map((r) => r.period);
    const closedMonth = isClosedMonth(String(inv.inv_date).slice(0, 10), closedList);

    const origLinesCalc = origRows.map((l) => ({ productId: l.product_id, qty: Number(l.qty), appliedUnitCost: Number(l.applied_unit_cost), lineAmountMxn: Number(l.line_amount_mxn) }));

    const base = {
      reqId, type: cr.req_type, reason: cr.reason, closedMonth,
      invoice: { id: inv.id, sat_no: inv.sat_no, inv_date: ymd(inv.inv_date), credit_days: inv.credit_days, due_date: inv.due_date ? ymd(inv.due_date) : null, subtotal_mxn: Number(inv.subtotal_mxn), iva_mxn: Number(inv.iva_mxn), total_mxn: Number(inv.total_mxn) },
      customer: { code: cust.code, name: cust.name, base_credit_days: Number(cust.credit_days) || 0 },
      origLines: origRows.map((l) => ({ product_id: l.product_id, code: l.code, name: l.name, qty: Number(l.qty), discount_rate: Number(l.discount_rate), unit_price: Number(l.unit_price), line_amount_mxn: Number(l.line_amount_mxn) })),
    };

    if (cr.req_type === 'delete') {
      const rev = computeDeleteReversal({ origLines: origLinesCalc, closedMonth });
      return { ...base, mode: rev.mode, varianceMxn: rev.varianceMxn,
        effect: { stockRestore: rev.stockRestore, cogsReversal: rev.cogsReversal, salesReversal: rev.salesReversal } };
    }

    // edit: 변경 후 라인 계산(현재 평균원가 스냅샷)
    const payload = typeof cr.payload === 'string' ? JSON.parse(cr.payload) : cr.payload;
    const custDiscount = Number(cust.discount) || 0;
    const baseDays = Number(cust.credit_days) || 0;
    const newLines = [];
    const linesForTotals = [];
    for (const l of payload.lines) {
      const p = (await query(`SELECT id, code, name, list_price, stock_qty, avg_cost FROM products WHERE id=$1`, [l.product_id])).rows[0];
      if (!p) continue;
      const discRate = (l.discount_rate == null || l.discount_rate === '') ? custDiscount : Number(l.discount_rate);
      const line = computeLine({ qty: l.qty, listPrice: p.list_price, discountRate: discRate, cost: p.avg_cost });
      linesForTotals.push(line);
      newLines.push({ product_id: p.id, code: p.code, name: p.name, qty: line.qty, discount_rate: line.discountRate, unit_price: line.unitPrice, line_amount_mxn: line.lineAmountMxn, applied_unit_cost: line.appliedUnitCost, cogs_mxn: line.cogsMxn, stock_qty: Number(p.stock_qty) });
    }
    const newTotals = computeInvoiceTotals(linesForTotals, Number(inv.iva_rate) || 16);
    const newLinesCalc = newLines.map((l) => ({ productId: l.product_id, qty: l.qty, appliedUnitCost: l.applied_unit_cost, lineAmountMxn: l.line_amount_mxn }));
    const net = computeEditNetEffect({ origLines: origLinesCalc, newLines: newLinesCalc, closedMonth });
    const appliedDays = (payload.credit_days == null || payload.credit_days === '') ? baseDays : Number(payload.credit_days);
    const due = dueDate(payload.inv_date || inv.inv_date, appliedDays);

    // 재고 가능 여부 사전 점검(되돌림분 포함)
    const restore = {}; for (const l of origLinesCalc) restore[l.productId] = (restore[l.productId] || 0) + l.qty;
    const shortages = [];
    for (const l of newLines) {
      const avail = l.stock_qty + (restore[l.product_id] || 0);
      if (l.qty > avail) shortages.push({ code: l.code, requested: l.qty, available: avail, shortage: round2(l.qty - avail) });
    }

    return { ...base, mode: net.mode, varianceMxn: net.varianceMxn,
      newLines: newLines.map((l) => ({ product_id: l.product_id, code: l.code, name: l.name, qty: l.qty, discount_rate: l.discount_rate, unit_price: l.unit_price, line_amount_mxn: l.line_amount_mxn })),
      newTotals: { subtotal_mxn: newTotals.subtotalMxn, iva_mxn: newTotals.ivaMxn, total_mxn: newTotals.totalMxn },
      newCreditDays: appliedDays, newDueDate: due,
      stockOk: shortages.length === 0, shortages };
  });

  // 변경요청 반려 (디렉터) — 원본 상태 복귀
  app.post('/api/sales/change-requests/:reqId/reject', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const reqId = Number(req.params.reqId);
    const out = await withTx(async (c) => {
      const cr = (await c.query(`SELECT * FROM sales_change_requests WHERE id=$1`, [reqId])).rows[0];
      if (!cr || cr.status !== 'pending') return { error: 'not_pending' };
      await c.query(`UPDATE sales_change_requests SET status='rejected', decided_by=$1, decided_at=now() WHERE id=$2`, [req.ctx.perm.userId, reqId]);
      await c.query(`UPDATE sales_invoices SET status='posted' WHERE id=$1`, [cr.invoice_id]);
      return { ok: true };
    });
    if (out.error) return reply.code(409).send(out);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `sales_change_request:${reqId}`, detail: { rejected: true } });
    return out;
  });

  // 변경요청 승인 (디렉터) — 트랜잭션으로 되돌림+재적용, 마감월 규칙
  app.post('/api/sales/change-requests/:reqId/approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const reqId = Number(req.params.reqId);
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const cr = (await c.query(`SELECT * FROM sales_change_requests WHERE id=$1`, [reqId])).rows[0];
      if (!cr || cr.status !== 'pending') return { error: 'not_pending' };
      const inv = await loadInvoiceForChange(c, cr.invoice_id);
      if (!inv) return { error: 'invoice_not_found' };
      const closed = inv._closedMonth;

      // 원본 효과 되돌림: 재고 복원(원가 스냅샷으로 'in' 이동), AR 취소
      async function reverseOriginalStock() {
        for (const l of inv._lines) {
          await c.query(`UPDATE products SET stock_qty = stock_qty + $1, updated_by=$2 WHERE id=$3`, [l.qty, userId, l.productId]);
          await c.query(
            `INSERT INTO stock_movements (product_id, move_type, qty, unit_cost_mxn, ref, sales_invoice_id, created_by)
             VALUES ($1,'in',$2,$3,$4,$5,$6)`,
            [l.productId, l.qty, l.appliedUnitCost, `sales_reverse:${inv.id}`, inv.id, userId]);
        }
      }
      // 정산차액/소급 정정 기록(기록만, 거래전기는 후속)
      async function recordVariance(varianceMxn, kind, source) {
        if (!varianceMxn) return;
        await c.query(
          `INSERT INTO cogs_adjustments (doc_id, sales_invoice_id, product_id, sale_date, qty, diff_mxn, kind, source)
           VALUES (NULL,$1,$2,$3,$4,$5,$6,$7)`,
          [inv.id, inv._lines[0]?.productId || null, String(inv.inv_date).slice(0, 10), null, round2(varianceMxn), kind, source]);
      }

      if (cr.req_type === 'delete') {
        const rev = computeDeleteReversal({ origLines: inv._lines, closedMonth: closed });
        await reverseOriginalStock();
        // AR(입금예정) 취소
        if (inv.txn_id) await c.query(`UPDATE transactions SET deleted_at=now(), updated_by=$1 WHERE id=$2`, [userId, inv.txn_id]);
        // 원장 out 무효화 표시는 reverse 'in'으로 상쇄됨. 인보이스 소프트 삭제.
        await c.query(`UPDATE sales_invoices SET status='deleted', deleted_at=now(), updated_by=$1 WHERE id=$2`, [userId, inv.id]);
        await recordVariance(rev.varianceMxn, 'variance', 'sales_delete');
        await c.query(`UPDATE sales_change_requests SET status='approved', decided_by=$1, decided_at=now() WHERE id=$2`, [userId, reqId]);
        return { ok: true, type: 'delete', mode: rev.mode, variance: rev.varianceMxn };
      }

      // 수정: 원본 되돌림 + 새 내용 재적용
      const payload = typeof cr.payload === 'string' ? JSON.parse(cr.payload) : cr.payload;
      const cust = (await c.query(`SELECT discount, credit_days FROM customers WHERE id=$1`, [inv.customer_id])).rows[0];
      const custDiscount = Number(cust.discount) || 0;
      const baseDays = Number(cust.credit_days) || 0;

      // 새 라인 계산(현재 평균원가 스냅샷)
      const newComputed = [];
      for (const l of payload.lines) {
        const p = (await c.query(`SELECT id, code, list_price, stock_qty, avg_cost FROM products WHERE id=$1 AND deleted_at IS NULL`, [l.product_id])).rows[0];
        if (!p) return { error: `product_not_found:${l.product_id}` };
        const discRate = (l.discount_rate == null || l.discount_rate === '') ? custDiscount : Number(l.discount_rate);
        const line = computeLine({ qty: l.qty, listPrice: p.list_price, discountRate: discRate, cost: p.avg_cost });
        newComputed.push({ ...line, product_id: p.id, code: p.code, _stock: Number(p.stock_qty) });
      }
      const newLinesForCalc = newComputed.map((l) => ({ productId: l.product_id, qty: l.qty, appliedUnitCost: l.appliedUnitCost, lineAmountMxn: l.lineAmountMxn }));
      const net = computeEditNetEffect({ origLines: inv._lines, newLines: newLinesForCalc, closedMonth: closed });

      // 재고 가능 여부 점검: 되돌림(+orig) 후 새로 차감(-new). 순변화가 음수이고 재고 부족이면 막음.
      // 원본 복원분을 먼저 더한 가용재고로 판단.
      const restore = {};
      for (const l of inv._lines) restore[l.productId] = (restore[l.productId] || 0) + l.qty;
      const shortages = [];
      for (const l of newComputed) {
        const avail = l._stock + (restore[l.product_id] || 0);
        if (l.qty > avail) shortages.push({ code: l.code, requested: l.qty, available: avail, shortage: round2(l.qty - avail) });
      }
      if (shortages.length) return { error: 'stock_short', shortages };

      // 1) 원본 되돌림(재고 복원)
      await reverseOriginalStock();
      // 2) 기존 라인/원장 제거(소프트): 기존 out 이동은 reverse 'in'으로 상쇄됨. 라인 삭제 후 재삽입.
      await c.query(`DELETE FROM sales_invoice_lines WHERE invoice_id=$1`, [inv.id]);
      // 3) 새 라인 적용(재고 차감 + 원장 out)
      const totals = computeInvoiceTotals(newComputed, Number(inv.iva_rate) || 16);
      for (const ln of newComputed) {
        const lineRow = (await c.query(
          `INSERT INTO sales_invoice_lines (invoice_id, product_id, qty, list_price, discount_rate, unit_price, line_amount_mxn, applied_unit_cost, cogs_mxn)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [inv.id, ln.product_id, ln.qty, ln.listPrice, ln.discountRate, ln.unitPrice, ln.lineAmountMxn, ln.appliedUnitCost, ln.cogsMxn])).rows[0];
        await c.query(`UPDATE products SET stock_qty = stock_qty - $1, updated_by=$2 WHERE id=$3`, [ln.qty, userId, ln.product_id]);
        await c.query(
          `INSERT INTO stock_movements (product_id, move_type, qty, unit_cost_mxn, ref, sales_invoice_id, sales_invoice_line_id, created_by)
           VALUES ($1,'out',$2,$3,$4,$5,$6,$7)`,
          [ln.product_id, ln.qty, ln.appliedUnitCost, `sales:${inv.id}`, inv.id, lineRow.id, userId]);
      }
      // 4) 외상일/예외(디렉터 수정승인에 흡수: 예외라도 승인된 것으로 확정)
      const appliedDays = (payload.credit_days == null || payload.credit_days === '') ? baseDays : Number(payload.credit_days);
      const exception = isCreditException(appliedDays, baseDays);
      const due = dueDate(payload.inv_date || inv.inv_date, appliedDays);
      await c.query(
        `UPDATE sales_invoices SET sat_no=COALESCE($1,sat_no), inv_date=COALESCE($2,inv_date),
           credit_days=$3, due_date=$4, credit_exception=$5, credit_approved=true,
           subtotal_mxn=$6, iva_mxn=$7, total_mxn=$8, status='posted', updated_by=$9 WHERE id=$10`,
        [payload.sat_no, payload.inv_date, appliedDays, due, exception, totals.subtotalMxn, totals.ivaMxn, totals.totalMxn, userId, inv.id]);
      // 5) AR 갱신
      if (inv.txn_id) await c.query(`UPDATE transactions SET txn_date=$1, amount=$2, amount_mxn=$2, updated_by=$3 WHERE id=$4`, [due, totals.totalMxn, userId, inv.txn_id]);
      // 6) 정산차액 기록(마감월)
      await recordVariance(net.varianceMxn, 'variance', 'sales_edit');
      await c.query(`UPDATE sales_change_requests SET status='approved', decided_by=$1, decided_at=now() WHERE id=$2`, [userId, reqId]);
      return { ok: true, type: 'edit', mode: net.mode, totals, due, exception, variance: net.varianceMxn };
    });
    if (out.error === 'stock_short') return reply.code(409).send(out);
    if (out.error) return reply.code(409).send(out);
    await logEvent({ userId, action: 'update', target: `sales_change_request:${reqId}`, detail: { approved: true, type: out.type } });
    return out;
  });
}
