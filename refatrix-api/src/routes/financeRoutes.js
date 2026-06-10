import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { getUsdMxnRate, getFxHistory, getRateForDate } from '../fx.js';

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
              t.amount_mxn, t.category_code, cat.name AS category_name, t.status, t.kind, t.approved, t.change_status, t.memo, t.sales_invoice_id,
              (SELECT COUNT(*) FROM txn_change_requests cr WHERE cr.txn_id=t.id AND cr.req_type='edit' AND cr.status='approved') AS edit_count
         FROM transactions t
         LEFT JOIN accounts a ON a.id=t.account_id
         LEFT JOIN categories cat ON cat.code=t.category_code
        WHERE ${cond.join(' AND ')}
        ORDER BY t.txn_date DESC, t.id DESC LIMIT 200`, args)).rows;
    return { items: rows.map((t) => ({ ...t, amount: Number(t.amount), amount_mxn: Number(t.amount_mxn), fx_rate: Number(t.fx_rate),
      edit_count: Number(t.edit_count), editable: (t.kind === 'general' && !t.sales_invoice_id) })) };
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

  // 계정과목 목록(드롭다운용)
  app.get('/api/categories', { preHandler: [authGuard, requirePage('transactions')] }, async () => {
    const rows = (await query(`SELECT code, name, group_name FROM categories ORDER BY sort_order, code`)).rows;
    return { items: rows };
  });
}
