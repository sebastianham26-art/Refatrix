import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { getUsdMxnRate, getFxHistory } from '../fx.js';

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
    // 환율: MXN=1, USD=입력값 또는 오늘 환율
    let fx = 1;
    if (currency === 'USD') fx = Number(b.fx_rate) > 0 ? Number(b.fx_rate) : (await getUsdMxnRate()).rate;
    const amountMxn = r2(amount * fx);
    // 승인 규칙: 지출 + 담당자 → 미승인(approved=false). 그 외 → 승인.
    const approved = !(direction === 'out' && !isDirector);
    const r = await query(
      `INSERT INTO transactions
         (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, memo, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'general',$10,$11,$12,$11) RETURNING id`,
      [b.account_id || null, b.txn_date, direction, r2(amount), currency, fx, amountMxn, b.category_code || null, status, approved, req.ctx.perm.userId, b.memo || null]);
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
              t.amount_mxn, t.category_code, cat.name AS category_name, t.status, t.kind, t.approved, t.memo, t.sales_invoice_id
         FROM transactions t
         LEFT JOIN accounts a ON a.id=t.account_id
         LEFT JOIN categories cat ON cat.code=t.category_code
        WHERE ${cond.join(' AND ')}
        ORDER BY t.txn_date DESC, t.id DESC LIMIT 200`, args)).rows;
    return { items: rows.map((t) => ({ ...t, amount: Number(t.amount), amount_mxn: Number(t.amount_mxn), fx_rate: Number(t.fx_rate) })) };
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

  // 계정과목 목록(드롭다운용)
  app.get('/api/categories', { preHandler: [authGuard, requirePage('transactions')] }, async () => {
    const rows = (await query(`SELECT code, name, group_name FROM categories ORDER BY sort_order, code`)).rows;
    return { items: rows };
  });
}
