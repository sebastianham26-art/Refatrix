import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { getUsdMxnRate, getFxHistory, getRateForDate } from '../fx.js';
import { allocateOldestFirst, validateAllocations } from '../settlement.js';
import { expandRule, expandBetween } from '../recurring.js';
import { aggregateCashflow, planVsActual, computeOverdue, latePaymentHistory, monthBreakdown } from '../cashflow.js';

const RECUR_HORIZON_MONTHS = 12;     // 최초 생성 기본 개월수
const RECUR_MAX_MONTHS = 24;         // 오늘 기준 생성 가능한 최대 미래(상한)

function addMonthsUTC(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  return dt.toISOString().slice(0, 10);
}

function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

export default async function financeRoutes(app) {
  // ===== 환율 =====
  app.get('/api/fx/usd-mxn', { preHandler: [authGuard] }, async () => {
    return await getUsdMxnRate();
  });
  app.get('/api/fx/history', { preHandler: [authGuard] }, async (req) => {
    const limit = Math.min(Number(req.query.limit) || 60, 365);
    return { items: await getFxHistory(limit) };
  });

  // ===== 계좌 =====
  // 목록 + 잔액(계좌 통화 기준: 기초잔액 + 승인된 실제거래 합)
  app.get('/api/accounts', { preHandler: [authGuard, requirePage('transactions')] }, async () => {
    const rows = (await query(
      `SELECT a.id, a.name, a.type, a.currency, a.open_balance, a.open_date,
              a.open_balance + COALESCE((
                SELECT SUM(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END)
                  FROM transactions t
                 WHERE t.account_id=a.id AND t.status='actual' AND t.approved=true AND t.deleted_at IS NULL
              ),0) AS balance
         FROM accounts a WHERE a.deleted_at IS NULL ORDER BY a.id`)).rows;
    return { items: rows.map((a) => ({ ...a, open_balance: Number(a.open_balance), balance: Number(a.balance) })) };
  });

  // 계좌 생성(디렉터)
  app.post('/api/accounts', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const { name, type, currency = 'MXN', open_balance = 0, open_date } = req.body || {};
    if (!name || !['MXN', 'USD'].includes(currency)) return reply.code(400).send({ error: 'name_currency_required' });
    const r = await query(
      `INSERT INTO accounts (name, type, currency, open_balance, open_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [name, type || null, currency, r2(open_balance), open_date || null, req.ctx.perm.userId]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `account:${r.rows[0].id}` });
    return { id: r.rows[0].id };
  });

  // 계좌 수정(디렉터)
  app.patch('/api/accounts/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const { name, type, open_balance, open_date } = req.body || {};
    const r = await query(
      `UPDATE accounts SET name=COALESCE($1,name), type=COALESCE($2,type),
         open_balance=COALESCE($3,open_balance), open_date=COALESCE($4,open_date), updated_by=$5
       WHERE id=$6 AND deleted_at IS NULL RETURNING id`,
      [name ?? null, type ?? null, (open_balance == null ? null : r2(open_balance)), open_date ?? null, req.ctx.perm.userId, id]);
    if (!r.rows[0]) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // ===== 거래 =====
  // 수동 거래 등록(수입/지출). 규칙: 지출(out)을 담당자(비디렉터)가 등록하면 승인 대기, 디렉터면 바로 반영.
  // body: { account_id, txn_date, direction, amount, currency, fx_rate, category_code, status, memo }
  app.post('/api/transactions', { preHandler: [authGuard, requirePage('transactions')] }, async (req, reply) => {
    const b = req.body || {};
    const direction = b.direction === 'in' ? 'in' : 'out';
    const currency = ['MXN', 'USD'].includes(b.currency) ? b.currency : 'MXN';
    const amount = Number(b.amount);
    if (!(amount > 0) || !b.txn_date) return reply.code(400).send({ error: 'amount_date_required' });
    const status = b.status === 'plan' ? 'plan' : 'actual';
    if (status === 'actual' && !b.account_id) return reply.code(400).send({ error: 'account_required_for_actual' });
    const isDirector = req.ctx.perm.role === 'director';
    // 환율: MXN=1. USD는 입력값 우선 → (실제)거래일 캐시 → 오늘. 예정은 항상 오늘.
    let fx = 1;
    if (currency === 'USD') {
      if (Number(b.fx_rate) > 0) fx = Number(b.fx_rate);
      else if (status === 'actual') fx = await getRateForDate(b.txn_date);
      else fx = (await getUsdMxnRate()).rate;
    }
    const amountMxn = r2(amount * fx);
    // 승인 규칙: 지출 + 담당자 → 미승인(approved=false). 그 외 → 승인.
    const approved = !(direction === 'out' && !isDirector);
    const r = await query(
      `INSERT INTO transactions
         (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, memo, created_by, plan_amount, plan_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'general',$10,$11,$12,$11,$13,$14) RETURNING id`,
      [b.account_id || null, b.txn_date, direction, r2(amount), currency, fx, amountMxn, b.category_code || null, status, approved, req.ctx.perm.userId, b.memo || null,
       status === 'plan' ? r2(amount) : null, status === 'plan' ? b.txn_date : null]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `transaction:${r.rows[0].id}`, detail: { direction, approved } });
    return { id: r.rows[0].id, approved, amount_mxn: amountMxn, fx_rate: fx };
  });

  // 거래 목록(필터: status, direction, account_id, from, to)
  app.get('/api/transactions', { preHandler: [authGuard, requirePage('transactions')] }, async (req) => {
    const q = req.query || {};
    const cond = ['t.deleted_at IS NULL']; const args = [];
    if (q.status) { args.push(q.status); cond.push(`t.status=$${args.length}`); }
    if (q.direction) { args.push(q.direction); cond.push(`t.direction=$${args.length}`); }
    if (q.account_id) { args.push(Number(q.account_id)); cond.push(`t.account_id=$${args.length}`); }
    if (q.from) { args.push(q.from); cond.push(`t.txn_date>=$${args.length}`); }
    if (q.to) { args.push(q.to); cond.push(`t.txn_date<=$${args.length}`); }
    const rows = (await query(
      `SELECT t.id, t.account_id, a.name AS account_name, t.txn_date, t.direction, t.amount, t.currency, t.fx_rate,
              t.amount_mxn, t.category_code, cat.name AS category_name, t.status, t.kind, t.approved, t.change_status, t.memo, t.sales_invoice_id,
              t.plan_amount, t.plan_date, t.plan_memo, t.change_count, t.recurring_rule_id,
              (SELECT COUNT(*) FROM txn_change_requests cr WHERE cr.txn_id=t.id AND cr.req_type='edit' AND cr.status='approved') AS edit_count
         FROM transactions t
         LEFT JOIN accounts a ON a.id=t.account_id
         LEFT JOIN categories cat ON cat.code=t.category_code
        WHERE ${cond.join(' AND ')}
        ORDER BY t.txn_date DESC, t.id DESC LIMIT 200`, args)).rows;
    return { items: rows.map((t) => ({ ...t, amount: Number(t.amount), amount_mxn: Number(t.amount_mxn), fx_rate: Number(t.fx_rate),
      plan_amount: t.plan_amount == null ? null : Number(t.plan_amount),
      edit_count: Number(t.edit_count), change_count: Number(t.change_count || 0),
      editable: (t.kind === 'general' && !t.sales_invoice_id) })) };
  });

  // 승인 대기(디렉터) — 담당자가 올린 미승인 지출
  app.get('/api/transactions/pending-approval', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(
      `SELECT t.id, t.txn_date, t.direction, t.amount, t.currency, t.amount_mxn, t.category_code, cat.name AS category_name,
              a.name AS account_name, t.memo, u.name AS created_by_name
         FROM transactions t
         LEFT JOIN accounts a ON a.id=t.account_id
         LEFT JOIN categories cat ON cat.code=t.category_code
         LEFT JOIN users u ON u.id=t.created_by
        WHERE t.approved=false AND t.deleted_at IS NULL AND t.kind='general'
        ORDER BY t.txn_date DESC, t.id DESC`)).rows;
    return { items: rows.map((t) => ({ ...t, amount: Number(t.amount), amount_mxn: Number(t.amount_mxn) })) };
  });

  app.post('/api/transactions/:id/approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const r = await query(`UPDATE transactions SET approved=true, updated_by=$1 WHERE id=$2 AND approved=false AND deleted_at IS NULL RETURNING id`, [req.ctx.perm.userId, id]);
    if (!r.rows[0]) return reply.code(409).send({ error: 'not_pending' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `transaction:${id}`, detail: { approved: true } });
    return { ok: true };
  });

  app.post('/api/transactions/:id/reject', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const r = await query(`UPDATE transactions SET deleted_at=now(), updated_by=$1 WHERE id=$2 AND approved=false AND deleted_at IS NULL RETURNING id`, [req.ctx.perm.userId, id]);
    if (!r.rows[0]) return reply.code(409).send({ error: 'not_pending' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `transaction:${id}`, detail: { rejected: true } });
    return { ok: true };
  });

  // ===== 거래 수정/삭제 =====
  // amount_mxn 계산: 입력값 우선 → (실제)거래일 캐시 → 오늘. 예정은 오늘.
  async function calcMxn(currency, amount, fxIn, status, txnDate) {
    let fx = 1;
    if (currency === 'USD') {
      if (Number(fxIn) > 0) fx = Number(fxIn);
      else if (status === 'actual') fx = await getRateForDate(txnDate);
      else fx = (await getUsdMxnRate()).rate;
    }
    return { fx, amountMxn: r2(Number(amount) * fx) };
  }

  // 미승인 일반 거래: 등록자/디렉터가 바로 수정 (잔액 영향 없음)
  app.patch('/api/transactions/:id', { preHandler: [authGuard, requirePage('transactions')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const t = (await query(`SELECT * FROM transactions WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (t.kind !== 'general' || t.sales_invoice_id) return reply.code(409).send({ error: 'sales_linked_readonly' });
    if (t.approved) return reply.code(409).send({ error: 'already_approved_use_request' });
    const b = req.body || {};
    const direction = b.direction === 'in' ? 'in' : (b.direction === 'out' ? 'out' : t.direction);
    const currency = ['MXN', 'USD'].includes(b.currency) ? b.currency : t.currency;
    const amount = b.amount != null ? Number(b.amount) : Number(t.amount);
    const txnDate = b.txn_date || t.txn_date;
    const { fx, amountMxn } = await calcMxn(currency, amount, b.fx_rate, t.status, txnDate);
    await query(
      `UPDATE transactions SET account_id=$1, txn_date=$2, direction=$3, amount=$4, currency=$5, fx_rate=$6, amount_mxn=$7,
         category_code=$8, memo=$9, updated_by=$10 WHERE id=$11`,
      [b.account_id ?? t.account_id, b.txn_date || t.txn_date, direction, r2(amount), currency, fx, amountMxn,
       b.category_code ?? t.category_code, b.memo ?? t.memo, req.ctx.perm.userId, id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `transaction:${id}`, detail: { direct_edit: true } });
    return { ok: true };
  });

  // 승인된 일반 거래: 수정 요청 (원본 유지)
  app.post('/api/transactions/:id/edit-request', { preHandler: [authGuard, requirePage('transactions')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const t = (await query(`SELECT id, kind, sales_invoice_id, approved, change_status FROM transactions WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (t.kind !== 'general' || t.sales_invoice_id) return reply.code(409).send({ error: 'sales_linked_readonly' });
    if (!t.approved) return reply.code(409).send({ error: 'not_approved_edit_directly' });
    if (t.change_status) return reply.code(409).send({ error: 'change_in_progress' });
    const payload = req.body?.payload || {};
    const r = await query(
      `INSERT INTO txn_change_requests (txn_id, req_type, payload, reason, requested_by) VALUES ($1,'edit',$2,$3,$4) RETURNING id`,
      [id, JSON.stringify(payload), req.body?.reason || null, req.ctx.perm.userId]);
    await query(`UPDATE transactions SET change_status='edit_pending' WHERE id=$1`, [id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `txn_change_request:${r.rows[0].id}`, detail: { type: 'edit', txn: id } });
    return { id: r.rows[0].id, status: 'pending' };
  });

  // 승인된 일반 거래: 삭제 요청
  app.post('/api/transactions/:id/delete-request', { preHandler: [authGuard, requirePage('transactions')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const t = (await query(`SELECT id, kind, sales_invoice_id, approved, change_status FROM transactions WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (t.kind !== 'general' || t.sales_invoice_id) return reply.code(409).send({ error: 'sales_linked_readonly' });
    if (!t.approved) return reply.code(409).send({ error: 'not_approved_delete_directly' });
    if (t.change_status) return reply.code(409).send({ error: 'change_in_progress' });
    const r = await query(
      `INSERT INTO txn_change_requests (txn_id, req_type, payload, reason, requested_by) VALUES ($1,'delete',NULL,$2,$3) RETURNING id`,
      [id, req.body?.reason || null, req.ctx.perm.userId]);
    await query(`UPDATE transactions SET change_status='delete_pending' WHERE id=$1`, [id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `txn_change_request:${r.rows[0].id}`, detail: { type: 'delete', txn: id } });
    return { id: r.rows[0].id, status: 'pending' };
  });

  // 변경요청 대기 목록(디렉터)
  app.get('/api/transactions/change-requests/pending', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(
      `SELECT cr.id, cr.txn_id, cr.req_type, cr.payload, cr.reason, cr.requested_at,
              t.txn_date, t.direction, t.amount, t.currency, t.amount_mxn, t.category_code, t.account_id, t.memo,
              a.name AS account_name, cat.name AS category_name, u.name AS requested_by_name
         FROM txn_change_requests cr
         JOIN transactions t ON t.id=cr.txn_id
         LEFT JOIN accounts a ON a.id=t.account_id
         LEFT JOIN categories cat ON cat.code=t.category_code
         LEFT JOIN users u ON u.id=cr.requested_by
        WHERE cr.status='pending' ORDER BY cr.requested_at`)).rows;
    return { items: rows };
  });

  // 변경요청 상세(전/후 비교)
  app.get('/api/transactions/change-requests/:id/detail', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const reqId = Number(req.params.id);
    const cr = (await query(`SELECT * FROM txn_change_requests WHERE id=$1`, [reqId])).rows[0];
    if (!cr) return reply.code(404).send({ error: 'not_found' });
    const t = (await query(
      `SELECT t.*, a.name AS account_name, cat.name AS category_name FROM transactions t
         LEFT JOIN accounts a ON a.id=t.account_id LEFT JOIN categories cat ON cat.code=t.category_code WHERE t.id=$1`, [cr.txn_id])).rows[0];
    const orig = {
      account_id: t.account_id, account_name: t.account_name, txn_date: String(t.txn_date).slice(0, 10), direction: t.direction,
      amount: Number(t.amount), currency: t.currency, fx_rate: Number(t.fx_rate), amount_mxn: Number(t.amount_mxn),
      category_code: t.category_code, category_name: t.category_name, memo: t.memo,
    };
    if (cr.req_type === 'delete') return { type: 'delete', reason: cr.reason, orig };
    const p = typeof cr.payload === 'string' ? JSON.parse(cr.payload) : (cr.payload || {});
    const direction = p.direction === 'in' ? 'in' : (p.direction === 'out' ? 'out' : t.direction);
    const currency = ['MXN', 'USD'].includes(p.currency) ? p.currency : t.currency;
    const amount = p.amount != null ? Number(p.amount) : Number(t.amount);
    const { fx, amountMxn } = await calcMxn(currency, amount, p.fx_rate, t.status, p.txn_date || t.txn_date);
    let accName = orig.account_name;
    if (p.account_id != null && p.account_id !== t.account_id) {
      accName = (await query(`SELECT name FROM accounts WHERE id=$1`, [p.account_id])).rows[0]?.name || null;
    }
    const next = {
      account_id: p.account_id ?? t.account_id, account_name: accName, txn_date: p.txn_date || orig.txn_date, direction,
      amount, currency, fx_rate: fx, amount_mxn: amountMxn, category_code: p.category_code ?? t.category_code, memo: p.memo ?? t.memo,
    };
    return { type: 'edit', reason: cr.reason, orig, next };
  });

  // 변경요청 승인(디렉터) — 잔액은 거래행에서 자동 재계산되므로 행을 갱신/소프트삭제만
  app.post('/api/transactions/change-requests/:id/approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const reqId = Number(req.params.id);
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const cr = (await c.query(`SELECT * FROM txn_change_requests WHERE id=$1`, [reqId])).rows[0];
      if (!cr || cr.status !== 'pending') return { error: 'not_pending' };
      const t = (await c.query(`SELECT * FROM transactions WHERE id=$1 AND deleted_at IS NULL`, [cr.txn_id])).rows[0];
      if (!t) return { error: 'txn_not_found' };
      if (cr.req_type === 'delete') {
        await c.query(`UPDATE transactions SET deleted_at=now(), change_status=NULL, updated_by=$1 WHERE id=$2`, [userId, t.id]);
      } else {
        const p = typeof cr.payload === 'string' ? JSON.parse(cr.payload) : (cr.payload || {});
        const direction = p.direction === 'in' ? 'in' : (p.direction === 'out' ? 'out' : t.direction);
        const currency = ['MXN', 'USD'].includes(p.currency) ? p.currency : t.currency;
        const amount = p.amount != null ? Number(p.amount) : Number(t.amount);
        const newDate = p.txn_date || t.txn_date;
        let fx = 1;
        if (currency === 'USD') {
          if (Number(p.fx_rate) > 0) fx = Number(p.fx_rate);
          else if (t.status === 'actual') fx = await getRateForDate(newDate);
          else fx = (await getUsdMxnRate()).rate;
        }
        const amountMxn = r2(amount * fx);
        await c.query(
          `UPDATE transactions SET account_id=$1, txn_date=$2, direction=$3, amount=$4, currency=$5, fx_rate=$6, amount_mxn=$7,
             category_code=$8, memo=$9, change_status=NULL, updated_by=$10 WHERE id=$11`,
          [p.account_id ?? t.account_id, p.txn_date || t.txn_date, direction, r2(amount), currency, fx, amountMxn,
           p.category_code ?? t.category_code, p.memo ?? t.memo, userId, t.id]);
      }
      await c.query(`UPDATE txn_change_requests SET status='approved', decided_by=$1, decided_at=now() WHERE id=$2`, [userId, reqId]);
      return { ok: true, type: cr.req_type };
    });
    if (out.error) return reply.code(409).send(out);
    await logEvent({ userId, action: 'update', target: `txn_change_request:${reqId}`, detail: { approved: true, type: out.type } });
    return out;
  });

  // 변경요청 반려(디렉터) — 원본 복귀
  app.post('/api/transactions/change-requests/:id/reject', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const reqId = Number(req.params.id);
    const out = await withTx(async (c) => {
      const cr = (await c.query(`SELECT * FROM txn_change_requests WHERE id=$1`, [reqId])).rows[0];
      if (!cr || cr.status !== 'pending') return { error: 'not_pending' };
      await c.query(`UPDATE txn_change_requests SET status='rejected', decided_by=$1, decided_at=now() WHERE id=$2`, [req.ctx.perm.userId, reqId]);
      await c.query(`UPDATE transactions SET change_status=NULL WHERE id=$1`, [cr.txn_id]);
      return { ok: true };
    });
    if (out.error) return reply.code(409).send(out);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `txn_change_request:${reqId}`, detail: { rejected: true } });
    return out;
  });

  // ===== 매출 AR 반제(입금 배분) =====
  // 미수 고객 목록(미반제 인보이스가 있는 고객 + 미수 합계 + 선수금)
  app.get('/api/ar/customers', { preHandler: [authGuard, requirePage('settlement')] }, async () => {
    const rows = (await query(
      `SELECT c.id, c.code, c.name,
              COALESCE(SUM(s.total_mxn),0) - COALESCE(SUM(pa.paid),0) AS outstanding,
              COALESCE(adv.advance,0) AS advance
         FROM customers c
         JOIN sales_invoices s ON s.customer_id=c.id AND s.deleted_at IS NULL AND s.status='posted'
         LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) pa ON pa.invoice_id=s.id
         LEFT JOIN (SELECT customer_id, SUM(advance_amount) AS advance FROM sales_payments GROUP BY customer_id) adv ON adv.customer_id=c.id
        WHERE c.deleted_at IS NULL
        GROUP BY c.id, c.code, c.name, adv.advance
       HAVING COALESCE(SUM(s.total_mxn),0) - COALESCE(SUM(pa.paid),0) > 0.01
        ORDER BY outstanding DESC`)).rows;
    return { items: rows.map((r) => ({ ...r, outstanding: Number(r.outstanding), advance: Number(r.advance) })) };
  });

  // 한 고객의 미반제 인보이스(오래된 순) + 미수금
  app.get('/api/ar/open-invoices', { preHandler: [authGuard, requirePage('settlement')] }, async (req) => {
    const customerId = Number(req.query.customer_id);
    if (!customerId) return { items: [], advance: 0 };
    const rows = (await query(
      `SELECT s.id, s.sat_no, s.inv_date, s.due_date, s.total_mxn,
              COALESCE(pa.paid,0) AS paid, s.total_mxn - COALESCE(pa.paid,0) AS outstanding
         FROM sales_invoices s
         LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) pa ON pa.invoice_id=s.id
        WHERE s.customer_id=$1 AND s.deleted_at IS NULL AND s.status='posted'
          AND s.total_mxn - COALESCE(pa.paid,0) > 0.01
        ORDER BY s.inv_date, s.id`, [customerId])).rows;
    const adv = (await query(`SELECT COALESCE(SUM(advance_amount),0) AS a FROM sales_payments WHERE customer_id=$1`, [customerId])).rows[0];
    return {
      items: rows.map((r) => ({ id: r.id, sat_no: r.sat_no, inv_date: r.inv_date, due_date: r.due_date,
        total_mxn: Number(r.total_mxn), paid: Number(r.paid), outstanding: r2(Number(r.outstanding)) })),
      advance: Number(adv.a),
    };
  });

  // 입금(반제) 생성
  // body: { customer_id, pay_date, account_id, amount, allocations:[{invoice_id, amount}], memo }
  app.post('/api/ar/payments', { preHandler: [authGuard, requirePage('settlement')] }, async (req, reply) => {
    const b = req.body || {};
    const customerId = Number(b.customer_id), accountId = Number(b.account_id), amount = r2(b.amount);
    const allocations = Array.isArray(b.allocations) ? b.allocations.filter((a) => Number(a.amount) > 0).map((a) => ({ invoice_id: Number(a.invoice_id), amount: r2(a.amount) })) : [];
    if (!customerId || !accountId || !b.pay_date || !(amount > 0)) return reply.code(400).send({ error: 'missing_fields' });
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      // 현재 미수금 맵(검증용)
      const inv = (await c.query(
        `SELECT s.id, s.total_mxn - COALESCE(pa.paid,0) AS outstanding
           FROM sales_invoices s
           LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) pa ON pa.invoice_id=s.id
          WHERE s.customer_id=$1 AND s.deleted_at IS NULL AND s.status='posted'`, [customerId])).rows;
      const outMap = {}; inv.forEach((r) => { outMap[r.id] = r2(Number(r.outstanding)); });
      const sumAlloc = r2(allocations.reduce((s, a) => s + a.amount, 0));
      const advance = r2(amount - sumAlloc);
      if (advance < -0.001) return { error: 'allocations_exceed_amount' };
      const v = validateAllocations(amount, allocations, outMap, advance);
      if (!v.ok) return { error: 'invalid_allocations', detail: v.errors };
      // 헤더
      const pay = (await c.query(
        `INSERT INTO sales_payments (customer_id, pay_date, account_id, amount, advance_amount, memo, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [customerId, b.pay_date, accountId, amount, advance, b.memo || null, userId])).rows[0];
      // 배분별 실제 입금 거래 + 배분행
      for (const a of allocations) {
        const txn = (await c.query(
          `INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, sales_invoice_id, memo, created_by)
           VALUES ($1,$2,'in',$3,'MXN',1,$3,'4010','actual','payment',true,$4,$5,$6,$4) RETURNING id`,
          [accountId, b.pay_date, a.amount, userId, a.invoice_id, `입금 반제 (인보이스 #${a.invoice_id})`])).rows[0];
        await c.query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount, txn_id) VALUES ($1,$2,$3,$4)`, [pay.id, a.invoice_id, a.amount, txn.id]);
      }
      // 선수금(과입금)
      if (advance > 0.001) {
        const at = (await c.query(
          `INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, memo, created_by)
           VALUES ($1,$2,'in',$3,'MXN',1,$3,'2030','actual','advance',true,$4,$5,$4) RETURNING id`,
          [accountId, b.pay_date, advance, userId, '선수금(과입금)'])).rows[0];
        await c.query(`UPDATE sales_payments SET advance_txn_id=$1 WHERE id=$2`, [at.id, pay.id]);
      }
      return { id: pay.id, advance, allocated: sumAlloc };
    });
    if (out.error) return reply.code(out.error === 'invalid_allocations' ? 409 : 400).send(out);
    await logEvent({ userId, action: 'create', target: `sales_payment:${out.id}`, detail: { amount, advance: out.advance } });
    return out;
  });

  // 입금 이력
  app.get('/api/ar/payments', { preHandler: [authGuard, requirePage('settlement')] }, async (req) => {
    const cond = []; const args = [];
    if (req.query.customer_id) { args.push(Number(req.query.customer_id)); cond.push(`p.customer_id=$${args.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const rows = (await query(
      `SELECT p.id, p.pay_date, p.amount, p.advance_amount, p.memo, c.code AS customer_code, c.name AS customer_name,
              a.name AS account_name,
              (SELECT json_agg(json_build_object('invoice_id', al.invoice_id, 'amount', al.amount) ORDER BY al.invoice_id)
                 FROM sales_payment_allocations al WHERE al.payment_id=p.id) AS allocations
         FROM sales_payments p
         JOIN customers c ON c.id=p.customer_id
         JOIN accounts a ON a.id=p.account_id
         ${where}
        ORDER BY p.pay_date DESC, p.id DESC LIMIT 100`, args)).rows;
    return { items: rows.map((r) => ({ ...r, amount: Number(r.amount), advance_amount: Number(r.advance_amount) })) };
  });

  // ===== 고정비(반복 규칙) =====
  app.get('/api/recurring', { preHandler: [authGuard, requirePage('transactions')] }, async () => {
    const rows = (await query(
      `SELECT r.id, r.name, r.category_code, cat.name AS category_name, r.amount, r.direction, r.currency,
              r.account_id, a.name AS account_name, r.freq, r.weekday, r.day_of_month, r.start_date, r.end_month, r.active, r.memo, r.generated_through,
              (SELECT COUNT(*) FROM transactions t WHERE t.recurring_rule_id=r.id AND t.deleted_at IS NULL) AS generated_count,
              (SELECT COUNT(*) FROM transactions t WHERE t.recurring_rule_id=r.id AND t.status='actual' AND t.deleted_at IS NULL) AS paid_count
         FROM recurring_rules r
         LEFT JOIN categories cat ON cat.code=r.category_code
         LEFT JOIN accounts a ON a.id=r.account_id
        WHERE r.deleted_at IS NULL ORDER BY r.active DESC, r.id`)).rows;
    return { items: rows.map((r) => ({ ...r, amount: Number(r.amount), generated_count: Number(r.generated_count), paid_count: Number(r.paid_count) })) };
  });

  app.post('/api/recurring', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const b = req.body || {};
    const freq = b.freq === 'week' ? 'week' : 'month';
    const direction = b.direction === 'in' ? 'in' : 'out';
    const currency = ['MXN', 'USD'].includes(b.currency) ? b.currency : 'MXN';
    if (!b.name || !(Number(b.amount) > 0) || !b.start_date) return reply.code(400).send({ error: 'missing_fields' });
    if (freq === 'week' && (b.weekday == null || b.weekday < 0 || b.weekday > 6)) return reply.code(400).send({ error: 'weekday_required' });
    if (freq === 'month' && !(b.day_of_month >= 1 && b.day_of_month <= 31)) return reply.code(400).send({ error: 'day_of_month_required' });
    const r = await query(
      `INSERT INTO recurring_rules (name, category_code, amount, direction, currency, account_id, freq, weekday, day_of_month, start_date, end_month, active, memo, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [b.name, b.category_code || null, r2(b.amount), direction, currency, b.account_id || null, freq,
       freq === 'week' ? b.weekday : null, freq === 'month' ? b.day_of_month : null, b.start_date, b.end_month || null,
       b.active !== false, b.memo || null, req.ctx.perm.userId]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `recurring_rule:${r.rows[0].id}` });
    return { id: r.rows[0].id };
  });

  app.patch('/api/recurring/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id); const b = req.body || {};
    const r = await query(
      `UPDATE recurring_rules SET name=COALESCE($1,name), category_code=COALESCE($2,category_code), amount=COALESCE($3,amount),
         account_id=COALESCE($4,account_id), end_month=$5, active=COALESCE($6,active), memo=COALESCE($7,memo), updated_at=now()
       WHERE id=$8 AND deleted_at IS NULL RETURNING id`,
      [b.name ?? null, b.category_code ?? null, (b.amount == null ? null : r2(b.amount)), b.account_id ?? null,
       b.end_month ?? null, (b.active == null ? null : b.active), b.memo ?? null, id]);
    if (!r.rows[0]) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // 규칙 삭제(소프트) + 아직 미지급(plan)인 미래 생성분 제거
  app.delete('/api/recurring/:id', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const id = Number(req.params.id);
    const userId = req.ctx.perm.userId;
    await withTx(async (c) => {
      await c.query(`UPDATE recurring_rules SET deleted_at=now(), active=false WHERE id=$1`, [id]);
      await c.query(`UPDATE transactions SET deleted_at=now(), updated_by=$1 WHERE recurring_rule_id=$2 AND status='plan' AND deleted_at IS NULL`, [userId, id]);
    });
    await logEvent({ userId, action: 'delete', target: `recurring_rule:${id}` });
    return { ok: true };
  });

  // 규칙별 생성/연장: 마지막 생성일 이후부터 "목표 월(through_month, YYYY-MM)"의 말일까지 생성. 오늘+24개월 상한.
  // body: { through_month }  (예: '2027-06'). 없으면 오늘+12개월.
  app.post('/api/recurring/:id/generate', { preHandler: [authGuard, requirePage('transactions')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (app.__recurGenerating) return reply.code(409).send({ error: 'generation_in_progress' });
    app.__recurGenerating = true;
    try {
      const rule = (await query(`SELECT * FROM recurring_rules WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
      if (!rule) return reply.code(404).send({ error: 'not_found' });
      if (!rule.start_date) return reply.code(400).send({ error: 'no_start_date' });
      const today = new Date().toISOString().slice(0, 10);
      const cap = addMonthsUTC(today, RECUR_MAX_MONTHS); // 오늘+24개월 상한(날짜)
      // 목표 끝 날짜: through_month 말일, 없으면 오늘+12개월
      let target;
      if (req.body?.through_month && /^\d{4}-\d{2}$/.test(req.body.through_month)) {
        const [ty, tm] = req.body.through_month.split('-').map(Number);
        target = new Date(Date.UTC(ty, tm, 0)).toISOString().slice(0, 10); // 그 달 말일
      } else {
        target = addMonthsUTC(today, RECUR_HORIZON_MONTHS);
      }
      if (target > cap) target = cap; // 상한 초과 차단
      const gthrough = rule.generated_through ? String(rule.generated_through).slice(0, 10) : null;
      const fromExclusive = gthrough
        ? new Date(new Date(gthrough + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10)
        : String(rule.start_date).slice(0, 10);
      if (gthrough && target <= gthrough) {
        return { ok: true, created: 0, generated_through: gthrough, capped: target >= cap };
      }
      const occ = expandBetween({
        freq: rule.freq, start_date: String(rule.start_date).slice(0, 10),
        day_of_month: rule.day_of_month, weekday: rule.weekday, end_month: rule.end_month,
      }, fromExclusive, target);
      const fx = rule.currency === 'USD' ? (await getUsdMxnRate()).rate : 1;
      const amt = r2(rule.amount); const amountMxn = r2(amt * fx);
      let created = 0;
      if (occ.length) {
        const existing = new Set((await query(
          `SELECT recurring_period FROM transactions WHERE recurring_rule_id=$1`, [id])).rows.map((r) => r.recurring_period));
        const fresh = occ.filter((o) => !existing.has(o.period));
        if (fresh.length) {
          const userId = req.ctx.perm.userId;
          const vals = []; const params = []; let i = 1;
          for (const o of fresh) {
            vals.push(`($${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},'plan','general',true,$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++})`);
            params.push(rule.account_id || null, o.date, rule.direction, amt, rule.currency, fx, amountMxn,
              rule.category_code || null, userId, `[고정비] ${rule.name}`, userId, rule.id, o.period, amt, o.date);
          }
          const res = await query(
            `INSERT INTO transactions
               (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, memo, created_by, recurring_rule_id, recurring_period, plan_amount, plan_date)
             VALUES ${vals.join(',')}
             ON CONFLICT (recurring_rule_id, recurring_period) WHERE recurring_rule_id IS NOT NULL DO NOTHING`, params);
          created = res.rowCount || 0;
        }
      }
      await query(`UPDATE recurring_rules SET generated_through=$1 WHERE id=$2`, [target, id]);
      return { ok: true, created, generated_through: target, capped: target >= cap };
    } finally {
      app.__recurGenerating = false;
    }
  });

  // 지급/입금 확인: 예정(plan) 거래 → 실제(actual). 날짜·금액 수정 가능(계획과 다를 수 있음).
  // body: { account_id, pay_date?, amount?, fx_rate?, memo? }
  app.post('/api/transactions/:id/confirm-pay', { preHandler: [authGuard, requirePage('transactions')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const t = (await query(`SELECT * FROM transactions WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (t.status !== 'plan') return reply.code(409).send({ error: 'not_plan' });
    if (t.sales_invoice_id) return reply.code(409).send({ error: 'sales_linked' });
    const accountId = req.body?.account_id || t.account_id;
    if (!accountId) return reply.code(400).send({ error: 'account_required' });
    const payDate = req.body?.pay_date || t.txn_date;
    const newAmount = req.body?.amount != null ? r2(req.body.amount) : Number(t.amount);
    if (!(newAmount > 0)) return reply.code(400).send({ error: 'invalid_amount' });
    let fx = Number(t.fx_rate) || 1;
    if (t.currency === 'USD') fx = Number(req.body?.fx_rate) > 0 ? Number(req.body.fx_rate) : await getRateForDate(payDate);
    const amountMxn = r2(newAmount * fx);
    // 계획 대비 변경 여부
    const planAmt = t.plan_amount != null ? Number(t.plan_amount) : Number(t.amount);
    const planDate = t.plan_date ? String(t.plan_date).slice(0, 10) : String(t.txn_date).slice(0, 10);
    const changed = Math.abs(newAmount - planAmt) > 0.001 || String(payDate).slice(0, 10) !== planDate;
    const memo = req.body?.memo ? String(req.body.memo).trim() : null;
    const newChangeCount = Number(t.change_count || 0) + (changed ? 1 : 0);
    const planMemo = changed && memo
      ? ((t.plan_memo ? t.plan_memo + ' | ' : '') + `${new Date().toISOString().slice(0, 10)}: ${memo}`)
      : t.plan_memo;
    await query(
      `UPDATE transactions SET status='actual', account_id=$1, txn_date=$2, amount=$3, fx_rate=$4, amount_mxn=$5,
         approved=true, change_count=$6, plan_memo=$7, updated_by=$8 WHERE id=$9`,
      [accountId, payDate, newAmount, fx, amountMxn, newChangeCount, planMemo, req.ctx.perm.userId, id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `transaction:${id}`, detail: { confirm_pay: true, changed } });
    return { ok: true, amount_mxn: amountMxn, changed, change_count: newChangeCount };
  });

  // 계획 대비 실적(고정비) 차이 리포트: 확정된 고정비 실적을 기간별로 계획 대비 비교
  app.get('/api/recurring/variance', { preHandler: [authGuard, requirePage('transactions')] }, async (req) => {
    const gran = req.query.granularity === 'week' ? 'week' : 'month';
    const bucket = gran === 'week' ? `to_char(date_trunc('week', t.txn_date), 'IYYY-"W"IW')` : `to_char(t.txn_date, 'YYYY-MM')`;
    const rows = (await query(
      `SELECT ${bucket} AS period,
              SUM(t.plan_amount * (CASE WHEN t.currency='USD' THEN t.fx_rate ELSE 1 END)) AS plan_mxn,
              SUM(t.amount_mxn) AS actual_mxn,
              COUNT(*) AS items,
              SUM(CASE WHEN t.change_count>0 THEN 1 ELSE 0 END) AS changed_items
         FROM transactions t
        WHERE t.recurring_rule_id IS NOT NULL AND t.status='actual' AND t.deleted_at IS NULL
        GROUP BY 1 ORDER BY 1 DESC LIMIT 60`)).rows;
    return { granularity: gran, items: rows.map((r) => {
      const plan = Number(r.plan_mxn) || 0, actual = Number(r.actual_mxn) || 0;
      return { period: r.period, plan_mxn: r2(plan), actual_mxn: r2(actual), diff_mxn: r2(actual - plan),
        items: Number(r.items), changed_items: Number(r.changed_items) };
    }) };
  });

  // ===== 예정(plan) 거래 계획 수정 =====
  // 매출에서 온 AR(sales_invoice_id)은 인보이스와 묶여 수정 불가. 일반 예정만 금액/날짜/메모 수정.
  app.patch('/api/transactions/:id/plan', { preHandler: [authGuard, requirePage('transactions')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const t = (await query(`SELECT * FROM transactions WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (t.status !== 'plan') return reply.code(409).send({ error: 'not_plan' });
    if (t.sales_invoice_id) return reply.code(409).send({ error: 'sales_linked' });
    const b = req.body || {};
    const newAmount = b.amount != null ? r2(b.amount) : Number(t.amount);
    if (!(newAmount > 0)) return reply.code(400).send({ error: 'invalid_amount' });
    const newDate = b.plan_date || String(t.txn_date).slice(0, 10);
    let fx = Number(t.fx_rate) || 1;
    if (t.currency === 'USD') fx = Number(b.fx_rate) > 0 ? Number(b.fx_rate) : (await getUsdMxnRate()).rate;
    const amountMxn = r2(newAmount * fx);
    const changed = Math.abs(newAmount - Number(t.amount)) > 0.001 || newDate !== String(t.txn_date).slice(0, 10);
    const memo = b.memo ? String(b.memo).trim() : null;
    const newCount = Number(t.change_count || 0) + (changed ? 1 : 0);
    const planMemo = changed && memo
      ? ((t.plan_memo ? t.plan_memo + ' | ' : '') + `${new Date().toISOString().slice(0, 10)}(계획수정): ${memo}`)
      : t.plan_memo;
    // 예정 거래는 계획=현재값이므로 txn_date/amount와 plan_date/plan_amount를 함께 갱신
    await query(
      `UPDATE transactions SET txn_date=$1, amount=$2, fx_rate=$3, amount_mxn=$4, plan_amount=$2, plan_date=$1,
         change_count=$5, plan_memo=$6, updated_by=$7 WHERE id=$8`,
      [newDate, newAmount, fx, amountMxn, newCount, planMemo, req.ctx.perm.userId, id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `transaction:${id}`, detail: { plan_edit: true, changed } });
    return { ok: true, changed, change_count: newCount };
  });

  // 모든 거래(현금흐름용) 로딩 헬퍼
  async function loadCashTxns() {
    return (await query(
      `SELECT t.id, t.direction, t.status, t.txn_date, t.amount, t.currency, t.fx_rate, t.amount_mxn,
              t.plan_amount, t.plan_date, t.category_code, t.recurring_rule_id, t.sales_invoice_id, t.memo,
              (t.plan_amount * (CASE WHEN t.currency='USD' THEN t.fx_rate ELSE 1 END)) AS plan_amount_mxn
         FROM transactions t WHERE t.deleted_at IS NULL`)).rows;
  }
  async function openingBalanceMxn() {
    const usd = (await getUsdMxnRate()).rate;
    const accs = (await query(`SELECT currency, open_balance FROM accounts WHERE deleted_at IS NULL`)).rows;
    return accs.reduce((s, a) => s + Number(a.open_balance) * (a.currency === 'USD' ? usd : 1), 0);
  }

  // 현금흐름 집계: 기간별 유입/유출/순액/누적잔고
  // query: granularity=month|week, includePlan=0|1
  app.get('/api/cashflow', { preHandler: [authGuard, requirePage('transactions')] }, async (req) => {
    const granularity = req.query.granularity === 'week' ? 'week' : 'month';
    const includePlan = req.query.includePlan === '1' || req.query.includePlan === 'true';
    const txns = await loadCashTxns();
    const opening = await openingBalanceMxn();
    const rows = aggregateCashflow(txns.map((t) => ({
      direction: t.direction, status: t.status, amount_mxn: Number(t.amount_mxn) || 0,
      txn_date: String(t.txn_date).slice(0, 10), plan_date: t.plan_date ? String(t.plan_date).slice(0, 10) : null,
    })), { granularity, includePlan, openingBalance: opening });
    return { granularity, includePlan, opening_balance: r2(opening), rows };
  });

  // 계획 대비 실적(수입/지출 분리): query granularity, filter=all|recurring|other
  app.get('/api/plan-vs-actual', { preHandler: [authGuard, requirePage('transactions')] }, async (req) => {
    const granularity = req.query.granularity === 'week' ? 'week' : 'month';
    const filter = ['all', 'recurring', 'other'].includes(req.query.filter) ? req.query.filter : 'all';
    const txns = await loadCashTxns();
    const res = planVsActual(txns.map((t) => ({
      direction: t.direction, status: t.status, amount_mxn: Number(t.amount_mxn) || 0,
      txn_date: String(t.txn_date).slice(0, 10), plan_date: t.plan_date ? String(t.plan_date).slice(0, 10) : null,
      plan_amount_mxn: t.plan_amount_mxn != null ? Number(t.plan_amount_mxn) : null, recurring_rule_id: t.recurring_rule_id,
    })), { granularity, filter });
    return { granularity, filter, ...res };
  });

  // 연체: 현재 진행 중 연체 + 과거 늦은 입금 이력
  app.get('/api/overdue', { preHandler: [authGuard, requirePage('transactions')] }, async () => {
    const today = new Date().toISOString().slice(0, 10);
    const invoices = (await query(
      `SELECT si.id, si.customer_id, c.code AS customer_code, c.name AS customer_name, si.due_date, si.inv_date, si.sat_no,
              si.total_mxn AS total, COALESCE(SUM(spa.amount),0) AS paid
         FROM sales_invoices si
         JOIN customers c ON c.id=si.customer_id
         LEFT JOIN sales_payment_allocations spa ON spa.invoice_id=si.id
        WHERE si.status='posted' AND si.deleted_at IS NULL
        GROUP BY si.id, c.code, c.name`)).rows;
    const current = computeOverdue(invoices.map((i) => ({
      id: i.id, customer_id: i.customer_id, customer_code: i.customer_code, customer_name: i.customer_name,
      due_date: i.due_date, sat_no: i.sat_no, total: Number(i.total), paid: Number(i.paid),
    })), today);
    const pays = (await query(
      `SELECT spa.invoice_id, sp.customer_id, c.code AS customer_code, c.name AS customer_name,
              si.due_date, sp.pay_date, spa.amount, si.sat_no
         FROM sales_payment_allocations spa
         JOIN sales_payments sp ON sp.id=spa.payment_id
         JOIN sales_invoices si ON si.id=spa.invoice_id
         JOIN customers c ON c.id=sp.customer_id`)).rows;
    const lateHist = latePaymentHistory(pays.map((p) => ({
      invoice_id: p.invoice_id, customer_id: p.customer_id, customer_code: p.customer_code, customer_name: p.customer_name,
      due_date: p.due_date, pay_date: p.pay_date, amount: Number(p.amount), sat_no: p.sat_no,
    })));
    // 고객별 연체 요약
    const byCustomer = {};
    for (const o of current) {
      const k = o.customer_id;
      if (!byCustomer[k]) byCustomer[k] = { customer_id: k, customer_code: o.customer_code, customer_name: o.customer_name, overdue_amount: 0, count: 0, max_days: 0 };
      byCustomer[k].overdue_amount = r2(byCustomer[k].overdue_amount + o.outstanding);
      byCustomer[k].count += 1;
      byCustomer[k].max_days = Math.max(byCustomer[k].max_days, o.overdue_days);
    }
    const totalOverdue = r2(current.reduce((s, o) => s + o.outstanding, 0));
    return { today, total_overdue: totalOverdue, count: current.length,
      current, by_customer: Object.values(byCustomer).sort((a, b) => b.max_days - a.max_days), late_history: lateHist };
  });

  // 월별 상세: 일자별 집계(달력용) + 실적/예정 섹션
  // query: month=YYYY-MM
  app.get('/api/cashflow/month', { preHandler: [authGuard, requirePage('transactions')] }, async (req) => {
    const month = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : new Date().toISOString().slice(0, 7);
    const today = new Date().toISOString().slice(0, 10);
    const txns = await loadCashTxns();
    const mapped = txns.map((t) => ({
      id: t.id, direction: t.direction, status: t.status,
      txn_date: String(t.txn_date).slice(0, 10), amount_mxn: Number(t.amount_mxn) || 0,
      plan_date: t.plan_date ? String(t.plan_date).slice(0, 10) : null,
      plan_amount_mxn: t.plan_amount_mxn != null ? Number(t.plan_amount_mxn) : null,
      currency: t.currency, amount: Number(t.amount), category_code: t.category_code, category_name: t.category_name,
      memo: t.memo, sales_invoice_id: t.sales_invoice_id, recurring_rule_id: t.recurring_rule_id,
    }));
    // 일자별 집계 + 누적잔고(기초잔고부터 그 달 시작 직전까지 누적 후 일자별)
    const opening = await openingBalanceMxn();
    // 그 달 1일 직전까지의 모든 실적 순액 합 = 기초 + 과거 실적
    const monthStart = month + '-01';
    let runBefore = opening;
    for (const t of mapped) {
      if (t.status !== 'actual') continue;
      if (t.txn_date < monthStart) runBefore += (t.direction === 'in' ? 1 : -1) * t.amount_mxn;
    }
    // 그 달 일자별
    const [yy, mm] = month.split('-').map(Number);
    const daysIn = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    const byDay = {};
    for (let d = 1; d <= daysIn; d++) byDay[`${month}-${String(d).padStart(2, '0')}`] = { in: 0, out: 0, items: [] };
    for (const t of mapped) {
      const date = t.status === 'actual' ? t.txn_date : (t.plan_date || t.txn_date);
      if (String(date).slice(0, 7) !== month) continue;
      const cell = byDay[String(date).slice(0, 10)];
      if (!cell) continue;
      if (t.direction === 'in') cell.in += t.amount_mxn; else cell.out += t.amount_mxn;
      cell.items.push(t);
    }
    // 누적잔고: 실적만 누적(예정 포함 옵션은 프런트 토글 시 별도 표시)
    let cumActual = runBefore;
    const days = Object.keys(byDay).sort().map((ds) => {
      const c = byDay[ds];
      const actualNet = c.items.filter((x) => x.status === 'actual').reduce((s, x) => s + (x.direction === 'in' ? 1 : -1) * x.amount_mxn, 0);
      cumActual += actualNet;
      return { date: ds, in: r2(c.in), out: r2(c.out), net: r2(c.in - c.out), cumulative: r2(cumActual), items: c.items };
    });
    const breakdown = monthBreakdown(mapped, month, today);
    return { month, today, opening_before_month: r2(runBefore), days, ...breakdown };
  });

  // 계정과목 목록(드롭다운용)
  app.get('/api/categories', { preHandler: [authGuard, requirePage('transactions')] }, async () => {
    const rows = (await query(`SELECT code, name, group_name FROM categories ORDER BY sort_order, code`)).rows;
    return { items: rows };
  });
}
