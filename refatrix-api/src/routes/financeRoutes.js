import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { allowedAccountIds, allowedDetailAccountIds, canViewAccount, canViewDetail, canOperateAccount, blockedDetailAccountIds } from '../accountScope.js';
import { logEvent } from '../audit.js';
import { getUsdMxnRate, getUsdKrwRate, getFxHistory, getRateForDate, getFxRange } from '../fx.js';
import { allocateOldestFirst, validateAllocations } from '../settlement.js';
import { validateReceiptDataUrl } from '../ar.js';
import { expandRule, expandBetween } from '../recurring.js';
import { aggregateCashflow, planVsActual, planVsActualByCategory, computeOverdue, latePaymentHistory, monthBreakdown, calendarArApByDay, bucketKey } from '../cashflow.js';

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
  // 오늘자 USD→KRW (MXN→KRW는 프런트에서 usdKrw ÷ usdMxn 으로 산출)
  app.get('/api/fx/krw', { preHandler: [authGuard] }, async () => {
    return await getUsdKrwRate();
  });

  // ===== 계좌 =====
  // 목록 + 잔액(계좌 통화 기준: 기초잔액 + 승인된 실제거래 합)
  app.get('/api/accounts', { preHandler: [authGuard, requirePage('transactions')] }, async (req) => {
    const allow = allowedAccountIds(req.ctx.perm);   // null = 전체(디렉터)
    const usd = (await getUsdMxnRate()).rate;        // 오늘 환율 — USD '기초잔액' 환산용(현금흐름과 동일 기준)
    const args = [];
    let acccond = '';
    if (allow !== null) {
      if (allow.length === 0) return { items: [], fx_rate: usd };   // 권한 계좌 없음
      args.push(allow);
      acccond = ` AND a.id = ANY($${args.length})`;
    }
    const rows = (await query(
      `SELECT a.id, a.name, a.type, a.currency, a.open_balance, a.open_date, a.non_deductible,
              a.open_balance + COALESCE((
                SELECT SUM(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END)
                  FROM transactions t
                 WHERE t.account_id=a.id AND t.status='actual' AND t.approved=true AND t.deleted_at IS NULL
              ),0) AS balance,
              COALESCE((
                SELECT SUM(CASE WHEN t.direction='in' THEN t.amount_mxn ELSE -t.amount_mxn END)
                  FROM transactions t
                 WHERE t.account_id=a.id AND t.status='actual' AND t.approved=true AND t.deleted_at IS NULL
              ),0) AS mxn_txn_sum
         FROM accounts a WHERE a.deleted_at IS NULL${acccond} ORDER BY a.id`, args)).rows;
    return { items: rows.map((a) => ({
      ...a, non_deductible: a.non_deductible === true, can_detail: canViewDetail(req.ctx.perm, a.id),
      open_balance: Number(a.open_balance), balance: Number(a.balance),
      // MXN 환산 잔액: 거래는 거래당시 환율로 확정 저장된 amount_mxn, 기초잔액(USD)은 오늘 환율. → 현금흐름·장부와 동일 기준.
      balance_mxn: r2(Number(a.open_balance) * (a.currency === 'USD' ? usd : 1) + Number(a.mxn_txn_sum)),
    })), fx_rate: usd };
  });

  // 계좌 생성(디렉터)
  app.post('/api/accounts', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const { name, type, currency = 'MXN', open_balance = 0, open_date, non_deductible } = req.body || {};
    if (!name || !['MXN', 'USD'].includes(currency)) return reply.code(400).send({ error: 'name_currency_required' });
    const r = await query(
      `INSERT INTO accounts (name, type, currency, open_balance, open_date, non_deductible, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [name, type || null, currency, r2(open_balance), open_date || null, non_deductible === true, req.ctx.perm.userId]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `account:${r.rows[0].id}` });
    return { id: r.rows[0].id };
  });

  // 계좌 수정(디렉터)
  app.patch('/api/accounts/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const { name, type, open_balance, open_date, non_deductible } = req.body || {};
    const r = await query(
      `UPDATE accounts SET name=COALESCE($1,name), type=COALESCE($2,type),
         open_balance=COALESCE($3,open_balance), open_date=COALESCE($4,open_date),
         non_deductible=COALESCE($5,non_deductible), updated_by=$6
       WHERE id=$7 AND deleted_at IS NULL RETURNING id`,
      [name ?? null, type ?? null, (open_balance == null ? null : r2(open_balance)), open_date ?? null,
       (typeof non_deductible === 'boolean' ? non_deductible : null), req.ctx.perm.userId, id]);
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
    // 계좌 운영권한: 실제/예정 모두 지정 계좌에 운영 권한이 있어야 등록 가능(디렉터는 통과).
    if (b.account_id != null && !canOperateAccount(req.ctx.perm, b.account_id)) {
      return reply.code(403).send({ error: 'account_not_operable' });
    }
    if (b.account_id == null && !isDirector) {
      // 계좌 미지정 거래는 디렉터만(비디렉터는 운영 계좌를 명시해야 함).
      return reply.code(403).send({ error: 'account_required' });
    }
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
    // 비디렉터: 거래내역 열람 권한(can_detail) 있는 계좌의 거래만. "잔액만" 계좌는 거래내역 숨김.
    const allow = allowedDetailAccountIds(req.ctx.perm);
    if (allow !== null) {
      if (allow.length === 0) return { items: [] };
      args.push(allow); cond.push(`t.account_id = ANY($${args.length})`);
    }
    // 현금·불공제 세부 차단(디렉터 포함): 해당 계좌 거래는 목록에서 숨김.
    const block = blockedDetailAccountIds(req.ctx.perm);
    if (block.length) { args.push(block); cond.push(`(t.account_id IS NULL OR t.account_id <> ALL($${args.length}))`); }
    if (q.status) { args.push(q.status); cond.push(`t.status=$${args.length}`); }
    if (q.direction) { args.push(q.direction); cond.push(`t.direction=$${args.length}`); }
    if (q.account_id) { args.push(Number(q.account_id)); cond.push(`t.account_id=$${args.length}`); }
    if (q.from) { args.push(q.from); cond.push(`t.txn_date>=$${args.length}`); }
    if (q.to) { args.push(q.to); cond.push(`t.txn_date<=$${args.length}`); }
    const rows = (await query(
      `SELECT t.id, t.account_id, a.name AS account_name, t.txn_date, t.direction, t.amount, t.currency, t.fx_rate,
              t.amount_mxn, t.category_code, cat.name AS category_name, t.status, t.kind, t.approved, t.change_status, t.memo, t.sales_invoice_id,
              t.plan_amount, t.plan_date, t.plan_memo, t.change_count, t.recurring_rule_id,
              si.sat_no AS sat_no, c.name AS customer_name,
              (SELECT COUNT(*) FROM txn_change_requests cr WHERE cr.txn_id=t.id AND cr.req_type='edit' AND cr.status='approved') AS edit_count
         FROM transactions t
         LEFT JOIN accounts a ON a.id=t.account_id
         LEFT JOIN categories cat ON cat.code=t.category_code
         LEFT JOIN sales_invoices si ON si.id=t.sales_invoice_id
         LEFT JOIN customers c ON c.id=si.customer_id
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
    const isDir = req.ctx.perm.role === 'director';
    // 미승인 거래의 직접 수정은 등록 본인 또는 디렉터만(승인된 건은 수정요청 경로 사용).
    if (!isDir && Number(t.created_by) !== Number(req.ctx.perm.userId)) {
      return reply.code(403).send({ error: 'not_owner' });
    }
    const b = req.body || {};
    // 옮길/현재 계좌 모두 운영권한 필요.
    const targetAcc = b.account_id ?? t.account_id;
    if (!canOperateAccount(req.ctx.perm, t.account_id) || (targetAcc != null && !canOperateAccount(req.ctx.perm, targetAcc))) {
      return reply.code(403).send({ error: 'account_not_operable' });
    }
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

  // 반제용 계좌 목록(최소 정보: 이름·통화) — 잔액(balance/open_balance) 미노출.
  // /api/accounts 는 잔액까지 주므로 transactions 권한이 필요. 반제만 하는 사용자(settlement)는 이걸 사용.
  app.get('/api/ar/accounts', { preHandler: [authGuard, requirePage('settlement')] }, async () => {
    const rows = (await query(
      `SELECT id, name, currency FROM accounts WHERE deleted_at IS NULL ORDER BY id`)).rows;
    return { items: rows };
  });

  // 입금(반제) 생성
  // body: { customer_id, pay_date, account_id, amount, allocations:[{invoice_id, amount}], memo }
  app.post('/api/ar/payments', { preHandler: [authGuard, requirePage('settlement')] }, async (req, reply) => {
    const b = req.body || {};
    const customerId = Number(b.customer_id), accountId = Number(b.account_id), amount = r2(b.amount);
    const allocations = Array.isArray(b.allocations) ? b.allocations.filter((a) => Number(a.amount) > 0).map((a) => ({ invoice_id: Number(a.invoice_id), amount: r2(a.amount) })) : [];
    if (!customerId || !accountId || !b.pay_date || !(amount > 0)) return reply.code(400).send({ error: 'missing_fields' });
    // 입금증(은행 입금증 등) 첨부 — 선택. 있으면 형식·크기 검증 후 입금건에 함께 저장.
    let receipt = null;
    if (b.receipt) {
      const rv = validateReceiptDataUrl(b.receipt);
      if (!rv.ok) return reply.code(400).send({ error: 'invalid_receipt', detail: rv.error });
      receipt = { data: b.receipt, name: b.receipt_name || null, mime: rv.mime };
    }
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
      // 입금증 저장(있으면)
      if (receipt) {
        await c.query(
          `INSERT INTO sales_payment_docs (payment_id, file_name, mime_type, file_data, uploaded_by)
           VALUES ($1,$2,$3,$4,$5)`,
          [pay.id, receipt.name, receipt.mime, receipt.data, userId]);
      }
      return { id: pay.id, advance, allocated: sumAlloc, receipt: !!receipt };
    });
    if (out.error) return reply.code(out.error === 'invalid_allocations' ? 409 : 400).send(out);
    await logEvent({ userId, action: 'create', target: `sales_payment:${out.id}`, detail: { amount, advance: out.advance, receipt: out.receipt } });
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

  // 수금 상세: 오픈 인보이스 전체 목록(회사/팀/영업담당자/고객 토글은 프런트에서 그룹·필터)
  // 각 행: 고객·팀·담당자 + 청구액(total_mxn)·입금(반제합)·잔액(outstanding) + 연체여부/일수
  app.get('/api/ar/open-list', { preHandler: [authGuard, requirePage('settlement')] }, async (req) => {
    const includeClosed = ['1', 'true', 'yes', 'on'].includes(String((req.query && req.query.closed) || '').toLowerCase());
    const rows = (await query(
      `SELECT s.id, s.sat_no,
              to_char(s.inv_date,'YYYY-MM-DD') AS inv_date,
              to_char(s.due_date,'YYYY-MM-DD') AS due_date,
              s.total_mxn,
              COALESCE(pa.paid,0) AS paid,
              (s.total_mxn - COALESCE(pa.paid,0)) AS outstanding,
              (s.due_date IS NOT NULL AND s.due_date < CURRENT_DATE AND (s.total_mxn - COALESCE(pa.paid,0)) > 0.01) AS is_overdue,
              CASE WHEN s.due_date IS NOT NULL THEN (CURRENT_DATE - s.due_date) ELSE NULL END AS day_diff,
              c.id AS customer_id, c.code AS customer_code, c.name AS customer_name, c.rfc AS customer_rfc, c.phone AS customer_phone,
              c.team_id, t.name AS team_name,
              c.owner_id, u.name AS owner_name
         FROM sales_invoices s
         JOIN customers c ON c.id=s.customer_id AND c.deleted_at IS NULL
         LEFT JOIN sales_teams t ON t.id=c.team_id
         LEFT JOIN users u ON u.id=c.owner_id
         LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) pa ON pa.invoice_id=s.id
        WHERE s.deleted_at IS NULL AND s.status='posted'
          ${includeClosed ? '' : 'AND (s.total_mxn - COALESCE(pa.paid,0)) > 0.01'}
        ORDER BY ((s.total_mxn - COALESCE(pa.paid,0)) <= 0.005), s.due_date NULLS LAST, s.inv_date, s.id`)).rows;
    return {
      today: new Date().toISOString().slice(0, 10),
      items: rows.map((r) => ({
        id: Number(r.id), sat_no: r.sat_no, inv_date: r.inv_date, due_date: r.due_date,
        total_mxn: r2(Number(r.total_mxn)), paid: r2(Number(r.paid)), outstanding: r2(Number(r.outstanding)),
        paid_full: r2(Number(r.outstanding)) <= 0.005,
        overdue: !!r.is_overdue, day_diff: r.day_diff == null ? null : Number(r.day_diff),
        customer_id: Number(r.customer_id), customer_code: r.customer_code, customer_name: r.customer_name,
        customer_rfc: r.customer_rfc || null, customer_phone: r.customer_phone || null,
        team_id: r.team_id == null ? null : Number(r.team_id), team_name: r.team_name || null,
        owner_id: r.owner_id == null ? null : Number(r.owner_id), owner_name: r.owner_name || null,
      })),
    };
  });

  // 한 인보이스의 수금(반제) 내역 + 요약 — 드릴다운용.
  //   각 행: 입금일·금액(배분)·계좌·메모·등록자 + 입금증 첨부 여부.
  app.get('/api/ar/invoice/:id/payments', { preHandler: [authGuard, requirePage('settlement')] }, async (req, reply) => {
    const invId = Number(req.params.id);
    if (!invId) return reply.code(400).send({ error: 'bad_id' });
    const inv = (await query(
      `SELECT s.id, s.sat_no, to_char(s.inv_date,'YYYY-MM-DD') AS inv_date, to_char(s.due_date,'YYYY-MM-DD') AS due_date,
              s.total_mxn, COALESCE(pa.paid,0) AS paid,
              c.id AS customer_id, c.code AS customer_code, c.name AS customer_name
         FROM sales_invoices s
         JOIN customers c ON c.id=s.customer_id
         LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) pa ON pa.invoice_id=s.id
        WHERE s.id=$1 AND s.deleted_at IS NULL`, [invId])).rows[0];
    if (!inv) return reply.code(404).send({ error: 'not_found' });
    const rows = (await query(
      `SELECT al.id AS alloc_id, al.amount, p.id AS payment_id, p.account_id,
              to_char(p.pay_date,'YYYY-MM-DD') AS pay_date, p.memo,
              a.name AS account_name, u.name AS created_by_name,
              (d.payment_id IS NOT NULL) AS has_receipt, d.file_name AS receipt_name, d.mime_type AS receipt_mime,
              (p.advance_amount = 0 AND ac.cnt = 1) AS editable
         FROM sales_payment_allocations al
         JOIN sales_payments p ON p.id=al.payment_id
         LEFT JOIN accounts a ON a.id=p.account_id
         LEFT JOIN users u ON u.id=p.created_by
         LEFT JOIN sales_payment_docs d ON d.payment_id=p.id
         LEFT JOIN (SELECT payment_id, COUNT(*) AS cnt FROM sales_payment_allocations GROUP BY payment_id) ac ON ac.payment_id=p.id
        WHERE al.invoice_id=$1
        ORDER BY p.pay_date, al.id`, [invId])).rows;
    const total = r2(Number(inv.total_mxn)), paid = r2(Number(inv.paid)), outstanding = r2(total - paid);
    return {
      invoice: {
        id: Number(inv.id), sat_no: inv.sat_no, inv_date: inv.inv_date, due_date: inv.due_date,
        total_mxn: total, paid, outstanding, paid_full: outstanding <= 0.005,
        customer_id: Number(inv.customer_id), customer_code: inv.customer_code, customer_name: inv.customer_name,
      },
      payments: rows.map((r) => ({
        alloc_id: Number(r.alloc_id), payment_id: Number(r.payment_id), amount: r2(Number(r.amount)),
        pay_date: r.pay_date, memo: r.memo || null,
        account_id: r.account_id == null ? null : Number(r.account_id), account_name: r.account_name || null,
        created_by_name: r.created_by_name || null, editable: !!r.editable,
        has_receipt: !!r.has_receipt, receipt_name: r.receipt_name || null, receipt_mime: r.receipt_mime || null,
      })),
    };
  });

  // 입금증 파일 보기(데이터 URL 반환)
  app.get('/api/ar/payments/:id/receipt/file', { preHandler: [authGuard, requirePage('settlement')] }, async (req, reply) => {
    const pid = Number(req.params.id);
    const row = (await query(`SELECT file_data, file_name, mime_type FROM sales_payment_docs WHERE payment_id=$1`, [pid])).rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { file_data: row.file_data, file_name: row.file_name || null, mime_type: row.mime_type || null };
  });

  // 기존 입금건에 입금증 부착(나중에 업로드/교체)
  app.post('/api/ar/payments/:id/receipt', { preHandler: [authGuard, requirePage('settlement')] }, async (req, reply) => {
    const pid = Number(req.params.id);
    const b = req.body || {};
    const v = validateReceiptDataUrl(b.receipt);
    if (!v.ok) return reply.code(400).send({ error: 'invalid_receipt', detail: v.error });
    const exists = (await query(`SELECT id FROM sales_payments WHERE id=$1`, [pid])).rows[0];
    if (!exists) return reply.code(404).send({ error: 'not_found' });
    await query(
      `INSERT INTO sales_payment_docs (payment_id, file_name, mime_type, file_data, uploaded_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (payment_id) DO UPDATE
         SET file_name=EXCLUDED.file_name, mime_type=EXCLUDED.mime_type, file_data=EXCLUDED.file_data,
             uploaded_by=EXCLUDED.uploaded_by, uploaded_at=now()`,
      [pid, b.receipt_name || null, v.mime, b.receipt, req.ctx.perm.userId]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `sales_payment:${pid}`, detail: { receipt: true } });
    return { ok: true };
  });

  // 수금(반제) 취소 — 디렉터 전용. 입금건 전체 되돌리기:
  //   배분(allocations) 삭제 → 인보이스 미수 자동 복구 / 통장 입금 거래 소프트취소(잔액 복구)
  //   / 선수금 거래 소프트취소 / 입금증·헤더 삭제. 거래는 deleted_at로 이력 보존.
  app.delete('/api/ar/payments/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const pid = Number(req.params.id);
    if (!pid) return reply.code(400).send({ error: 'bad_id' });
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const pay = (await c.query(`SELECT id, customer_id, amount, advance_amount, advance_txn_id FROM sales_payments WHERE id=$1`, [pid])).rows[0];
      if (!pay) return { error: 'not_found' };
      const allocs = (await c.query(`SELECT id, invoice_id, amount, txn_id FROM sales_payment_allocations WHERE payment_id=$1`, [pid])).rows;
      for (const a of allocs) {
        if (a.txn_id) await c.query(`UPDATE transactions SET deleted_at=now(), updated_by=$1 WHERE id=$2 AND deleted_at IS NULL`, [userId, a.txn_id]);
      }
      if (pay.advance_txn_id) await c.query(`UPDATE transactions SET deleted_at=now(), updated_by=$1 WHERE id=$2 AND deleted_at IS NULL`, [userId, pay.advance_txn_id]);
      await c.query(`DELETE FROM sales_payment_allocations WHERE payment_id=$1`, [pid]);
      await c.query(`DELETE FROM sales_payment_docs WHERE payment_id=$1`, [pid]);
      await c.query(`DELETE FROM sales_payments WHERE id=$1`, [pid]);
      return {
        ok: true, customer_id: Number(pay.customer_id), amount: r2(Number(pay.amount)),
        advance: r2(Number(pay.advance_amount || 0)),
        restored: allocs.map((a) => ({ invoice_id: Number(a.invoice_id), amount: r2(Number(a.amount)) })),
      };
    });
    if (out.error) return reply.code(out.error === 'not_found' ? 404 : 400).send(out);
    await logEvent({ userId, action: 'delete', target: `sales_payment:${pid}`, detail: { amount: out.amount, advance: out.advance, restored: out.restored } });
    return out;
  });

  // 수금내역 건별(배분 1건) 삭제 — 디렉터 전용.
  //   해당 배분만 삭제 → 그 인보이스 미수 복구 / 배분 거래 소프트취소 / 헤더 금액 차감.
  //   배분을 빼고 남은 게 없고 선수금도 0이면 입금 헤더·증빙까지 삭제.
  app.delete('/api/ar/allocations/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const aid = Number(req.params.id);
    if (!aid) return reply.code(400).send({ error: 'bad_id' });
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const al = (await c.query(
        `SELECT al.id, al.payment_id, al.invoice_id, al.amount, al.txn_id,
                p.advance_amount, p.advance_txn_id
           FROM sales_payment_allocations al JOIN sales_payments p ON p.id=al.payment_id
          WHERE al.id=$1`, [aid])).rows[0];
      if (!al) return { error: 'not_found' };
      if (al.txn_id) await c.query(`UPDATE transactions SET deleted_at=now(), updated_by=$1 WHERE id=$2 AND deleted_at IS NULL`, [userId, al.txn_id]);
      await c.query(`DELETE FROM sales_payment_allocations WHERE id=$1`, [aid]);
      const remain = Number((await c.query(`SELECT COUNT(*) AS n FROM sales_payment_allocations WHERE payment_id=$1`, [al.payment_id])).rows[0].n);
      let payment_deleted = false;
      if (remain === 0 && r2(Number(al.advance_amount || 0)) === 0) {
        if (al.advance_txn_id) await c.query(`UPDATE transactions SET deleted_at=now(), updated_by=$1 WHERE id=$2 AND deleted_at IS NULL`, [userId, al.advance_txn_id]);
        await c.query(`DELETE FROM sales_payment_docs WHERE payment_id=$1`, [al.payment_id]);
        await c.query(`DELETE FROM sales_payments WHERE id=$1`, [al.payment_id]);
        payment_deleted = true;
      } else {
        await c.query(`UPDATE sales_payments SET amount = amount - $1 WHERE id=$2`, [r2(Number(al.amount)), al.payment_id]);
      }
      return { ok: true, invoice_id: Number(al.invoice_id), amount: r2(Number(al.amount)), payment_deleted };
    });
    if (out.error) return reply.code(out.error === 'not_found' ? 404 : 400).send(out);
    await logEvent({ userId, action: 'delete', target: `sales_payment_allocation:${aid}`, detail: { invoice_id: out.invoice_id, amount: out.amount, payment_deleted: out.payment_deleted } });
    return out;
  });

  // 수금내역 건별 수정 — 디렉터 전용. (입금 1건=배분 1건인 경우만; 다배분/선수금 동반 입금은 불가)
  //   수정 항목: 금액·입금일·계좌·메모. 금액은 인보이스 미수 한도 내에서만.
  app.patch('/api/ar/allocations/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const aid = Number(req.params.id);
    if (!aid) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {};
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const al = (await c.query(
        `SELECT al.id, al.payment_id, al.invoice_id, al.amount, al.txn_id,
                p.advance_amount, p.account_id, p.pay_date, p.memo,
                (SELECT COUNT(*) FROM sales_payment_allocations x WHERE x.payment_id=al.payment_id) AS cnt,
                s.total_mxn
           FROM sales_payment_allocations al
           JOIN sales_payments p ON p.id=al.payment_id
           JOIN sales_invoices s ON s.id=al.invoice_id
          WHERE al.id=$1`, [aid])).rows[0];
      if (!al) return { error: 'not_found' };
      if (Number(al.cnt) !== 1 || r2(Number(al.advance_amount || 0)) !== 0) return { error: 'multi_allocation' };
      // 새 값(미지정이면 기존 유지)
      const newAmount = b.amount != null ? r2(b.amount) : r2(Number(al.amount));
      const newDate = b.pay_date || (al.pay_date instanceof Date ? al.pay_date.toISOString().slice(0, 10) : al.pay_date);
      const newAcc = b.account_id != null ? Number(b.account_id) : Number(al.account_id);
      const newMemo = b.memo !== undefined ? (b.memo || null) : (al.memo || null);
      if (!(newAmount > 0)) return { error: 'bad_amount' };
      if (!newAcc) return { error: 'bad_account' };
      if (!newDate) return { error: 'bad_date' };
      // 금액 한도: 인보이스 총액 − (이 배분 제외 다른 배분 합)
      const paidOthers = Number((await c.query(
        `SELECT COALESCE(SUM(amount),0) AS s FROM sales_payment_allocations WHERE invoice_id=$1 AND id<>$2`, [al.invoice_id, aid])).rows[0].s) || 0;
      const maxAmount = r2(Number(al.total_mxn) - paidOthers);
      if (newAmount > maxAmount + 0.005) return { error: 'amount_exceeds_outstanding', max: maxAmount };
      // 배분 · 거래 · 헤더 갱신
      await c.query(`UPDATE sales_payment_allocations SET amount=$1 WHERE id=$2`, [newAmount, aid]);
      if (al.txn_id) await c.query(`UPDATE transactions SET amount=$1, amount_mxn=$1, txn_date=$2, account_id=$3, updated_by=$4 WHERE id=$5`, [newAmount, newDate, newAcc, userId, al.txn_id]);
      await c.query(`UPDATE sales_payments SET amount=$1, pay_date=$2, account_id=$3, memo=$4 WHERE id=$5`, [newAmount, newDate, newAcc, newMemo, al.payment_id]);
      return { ok: true, invoice_id: Number(al.invoice_id), amount: newAmount };
    });
    if (out.error) {
      const code = out.error === 'not_found' ? 404 : (out.error === 'multi_allocation' || out.error === 'amount_exceeds_outstanding' ? 409 : 400);
      return reply.code(code).send(out);
    }
    await logEvent({ userId, action: 'update', target: `sales_payment_allocation:${aid}`, detail: { invoice_id: out.invoice_id, amount: out.amount } });
    return out;
  });

  // SAT 번호(또는 고객명/코드)로 인보이스 검색 — 완납 인보이스 포함.
  //   open-list와 같은 행 모양 + paid_full 플래그를 주어 같은 화면 렌더 재사용.
  app.get('/api/ar/search', { preHandler: [authGuard, requirePage('settlement')] }, async (req) => {
    const today = new Date().toISOString().slice(0, 10);
    const q = String(req.query.q || '').trim();
    if (q.length < 1) return { today, items: [] };
    const like = '%' + q.replace(/[%_\\]/g, (m) => '\\' + m) + '%';
    const rows = (await query(
      `SELECT s.id, s.sat_no,
              to_char(s.inv_date,'YYYY-MM-DD') AS inv_date,
              to_char(s.due_date,'YYYY-MM-DD') AS due_date,
              s.total_mxn, COALESCE(pa.paid,0) AS paid,
              (s.total_mxn - COALESCE(pa.paid,0)) AS outstanding,
              (s.due_date IS NOT NULL AND s.due_date < CURRENT_DATE AND (s.total_mxn - COALESCE(pa.paid,0)) > 0.01) AS is_overdue,
              CASE WHEN s.due_date IS NOT NULL THEN (CURRENT_DATE - s.due_date) ELSE NULL END AS day_diff,
              c.id AS customer_id, c.code AS customer_code, c.name AS customer_name, c.rfc AS customer_rfc, c.phone AS customer_phone,
              c.team_id, t.name AS team_name, c.owner_id, u.name AS owner_name
         FROM sales_invoices s
         JOIN customers c ON c.id=s.customer_id AND c.deleted_at IS NULL
         LEFT JOIN sales_teams t ON t.id=c.team_id
         LEFT JOIN users u ON u.id=c.owner_id
         LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) pa ON pa.invoice_id=s.id
        WHERE s.deleted_at IS NULL AND s.status='posted'
          AND (s.sat_no ILIKE $1 ESCAPE '\\' OR c.name ILIKE $1 ESCAPE '\\')
        ORDER BY s.inv_date DESC, s.id DESC
        LIMIT 80`, [like])).rows;
    return {
      today,
      items: rows.map((r) => {
        const total = r2(Number(r.total_mxn)), paid = r2(Number(r.paid)), outstanding = r2(Number(r.outstanding));
        return {
          id: Number(r.id), sat_no: r.sat_no, inv_date: r.inv_date, due_date: r.due_date,
          total_mxn: total, paid, outstanding, paid_full: outstanding <= 0.005,
          overdue: !!r.is_overdue, day_diff: r.day_diff == null ? null : Number(r.day_diff),
          customer_id: Number(r.customer_id), customer_code: r.customer_code, customer_name: r.customer_name,
          customer_rfc: r.customer_rfc || null, customer_phone: r.customer_phone || null,
          team_id: r.team_id == null ? null : Number(r.team_id), team_name: r.team_name || null,
          owner_id: r.owner_id == null ? null : Number(r.owner_id), owner_name: r.owner_name || null,
        };
      }),
    };
  });

  // ===== 수금 보기 전용(재무탭) — 영업지원이 처리한 반제 결과를 재무에서 "열람만" =====
  // settlement(입력) 권한 없이 transactions(재무) 권한만으로 볼 수 있는 읽기 전용 엔드포인트.
  // 미수 요약(전사).
  app.get('/api/ar/view/summary', { preHandler: [authGuard, requirePage('transactions')] }, async () => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = (await query(
      `SELECT (si.total_mxn - COALESCE(SUM(spa.amount),0)) AS outstanding,
              to_char(si.due_date,'YYYY-MM-DD') AS due_date
         FROM sales_invoices si
         LEFT JOIN sales_payment_allocations spa ON spa.invoice_id=si.id
        WHERE si.status='posted' AND si.deleted_at IS NULL
        GROUP BY si.id`)).rows;
    let open = 0, outstanding = 0, overdue = 0;
    for (const r of rows) {
      const o = Number(r.outstanding);
      if (o > 0.005) { open += 1; outstanding += o; if (r.due_date < today) overdue += o; }
    }
    return { today, open_count: open, outstanding: r2(outstanding), overdue: r2(overdue) };
  });

  // 최근 반제(입금) 내역 — 영업지원이 기록한 수금 활동(읽기 전용).
  app.get('/api/ar/view/recent', { preHandler: [authGuard, requirePage('transactions')] }, async (req) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = (await query(
      `SELECT sp.id, to_char(sp.pay_date,'YYYY-MM-DD') AS pay_date, sp.amount, acc.name AS account_label,
              c.name AS customer_name, c.code AS customer_code, u.name AS by_name,
              (SELECT string_agg(si.sat_no, ', ') FROM sales_payment_allocations spa
                 JOIN sales_invoices si ON si.id=spa.invoice_id WHERE spa.payment_id=sp.id) AS sat_list
         FROM sales_payments sp
         JOIN customers c ON c.id=sp.customer_id
         LEFT JOIN accounts acc ON acc.id=sp.account_id
         LEFT JOIN users u ON u.id=sp.created_by
        ORDER BY sp.pay_date DESC, sp.id DESC LIMIT $1`, [limit])).rows;
    return { items: rows.map((r) => ({ ...r, amount: Number(r.amount) })) };
  });

  // 월별 수금(반제) 달력용 — 일자별 입금 합계 + 건별(읽기 전용).
  app.get('/api/ar/view/calendar', { preHandler: [authGuard, requirePage('transactions')] }, async (req) => {
    const month = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : new Date().toISOString().slice(0, 7);
    const rows = (await query(
      `SELECT sp.id, to_char(sp.pay_date,'YYYY-MM-DD') AS pay_date, sp.amount, acc.name AS account_label,
              c.name AS customer_name
         FROM sales_payments sp
         JOIN customers c ON c.id=sp.customer_id
         LEFT JOIN accounts acc ON acc.id=sp.account_id
        WHERE to_char(sp.pay_date,'YYYY-MM')=$1
        ORDER BY sp.pay_date, sp.id`, [month])).rows;
    const byDay = {};
    for (const r of rows) {
      const d = r.pay_date;
      if (!byDay[d]) byDay[d] = { sum: 0, items: [] };
      byDay[d].sum = r2(byDay[d].sum + Number(r.amount));
      byDay[d].items.push({ id: r.id, customer_name: r.customer_name, account_label: r.account_label, amount: Number(r.amount) });
    }
    return { month, days: byDay };
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
    // 확정 대상 계좌에 운영권한 필요(원래 계좌도 확인).
    if (!canOperateAccount(req.ctx.perm, accountId) || (t.account_id != null && !canOperateAccount(req.ctx.perm, t.account_id))) {
      return reply.code(403).send({ error: 'account_not_operable' });
    }
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
    // 지출(out)을 비디렉터가 확정하면 실적이지만 디렉터 승인 전까지 미반영(approved=false).
    const isDir = req.ctx.perm.role === 'director';
    const approved = !(t.direction === 'out' && !isDir);
    await query(
      `UPDATE transactions SET status='actual', account_id=$1, txn_date=$2, amount=$3, fx_rate=$4, amount_mxn=$5,
         approved=$10, change_count=$6, plan_memo=$7, updated_by=$8 WHERE id=$9`,
      [accountId, payDate, newAmount, fx, amountMxn, newChangeCount, planMemo, req.ctx.perm.userId, id, approved]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `transaction:${id}`, detail: { confirm_pay: true, changed, approved } });
    return { ok: true, amount_mxn: amountMxn, changed, change_count: newChangeCount, approved };
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
    if (!canOperateAccount(req.ctx.perm, t.account_id)) return reply.code(403).send({ error: 'account_not_operable' });
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

  // 모든 거래(현금흐름용) 로딩 헬퍼 — 권한 계좌로 필터(잔고·AP용).
  // AR(수금예정)은 account_id=NULL 인 plan·in 거래라 비디렉터에선 자동 제외되고, 별도(전사)로 계산한다.
  async function loadCashTxns(perm) {
    const allow = allowedDetailAccountIds(perm);   // null = 전체(디렉터). "잔액만" 계좌 제외.
    const args = [];
    let cond = 't.deleted_at IS NULL';
    if (allow !== null) {
      if (allow.length === 0) return [];
      args.push(allow); cond += ` AND t.account_id = ANY($${args.length})`;
    }
    // 현금·불공제 세부 차단(디렉터 포함): 현금흐름에서도 제외. (account_id NULL = AR 예정은 유지)
    const block = blockedDetailAccountIds(perm);
    if (block.length) { args.push(block); cond += ` AND (t.account_id IS NULL OR t.account_id <> ALL($${args.length}))`; }
    return (await query(
      `SELECT t.id, t.direction, t.status, to_char(t.txn_date,'YYYY-MM-DD') AS txn_date, t.amount, t.currency, t.fx_rate, t.amount_mxn,
              t.plan_amount, to_char(t.plan_date,'YYYY-MM-DD') AS plan_date, t.category_code, cat.name AS category_name,
              t.recurring_rule_id, t.sales_invoice_id, t.account_id, a.name AS account_name, t.memo, t.approved,
              (t.plan_amount * (CASE WHEN t.currency='USD' THEN t.fx_rate ELSE 1 END)) AS plan_amount_mxn
         FROM transactions t
         LEFT JOIN categories cat ON cat.code=t.category_code
         LEFT JOIN accounts a ON a.id=t.account_id
        WHERE ${cond}`, args)).rows;
  }
  async function openingBalanceMxn(perm) {
    const usd = (await getUsdMxnRate()).rate;
    const allow = allowedDetailAccountIds(perm);
    const args = [];
    let cond = 'deleted_at IS NULL';
    if (allow !== null) {
      if (allow.length === 0) return 0;
      args.push(allow); cond += ` AND id = ANY($${args.length})`;
    }
    // 현금·불공제 세부 차단(디렉터 포함): 현금흐름 기초잔고 계산에서도 제외(거래내역과 일관).
    const block = blockedDetailAccountIds(perm);
    if (block.length) { args.push(block); cond += ` AND id <> ALL($${args.length})`; }
    const accs = (await query(`SELECT currency, open_balance FROM accounts WHERE ${cond}`, args)).rows;
    return accs.reduce((s, a) => s + Number(a.open_balance) * (a.currency === 'USD' ? usd : 1), 0);
  }

  // 현금흐름 집계: 기간별 유입/유출/순액/누적잔고
  // query: granularity=month|week, includePlan=0|1
  app.get('/api/cashflow', { preHandler: [authGuard, requirePage('transactions')] }, async (req) => {
    const granularity = req.query.granularity === 'week' ? 'week' : 'month';
    const includePlan = req.query.includePlan === '1' || req.query.includePlan === 'true';
    const txns = await loadCashTxns(req.ctx.perm);
    const opening = await openingBalanceMxn(req.ctx.perm);
    const mappedTx = txns.map((t) => ({
      direction: t.direction, status: t.status, amount_mxn: Number(t.amount_mxn) || 0,
      txn_date: String(t.txn_date).slice(0, 10), plan_date: t.plan_date ? String(t.plan_date).slice(0, 10) : null,
    }));
    const rows = aggregateCashflow(mappedTx, { granularity, includePlan, openingBalance: opening });
    // 실적 기준 누적잔고: 토글과 무관하게 실제 거래만 누적(= 실제 현금잔고). 표시 구간별로 정렬해 산출.
    const actualNetByPeriod = new Map();
    for (const t of mappedTx) {
      if (t.status !== 'actual') continue;
      const key = bucketKey(t.txn_date, granularity);
      actualNetByPeriod.set(key, (actualNetByPeriod.get(key) || 0) + (t.direction === 'in' ? 1 : -1) * t.amount_mxn);
    }
    const allKeys = [...new Set([...rows.map((r) => r.period), ...actualNetByPeriod.keys()])].sort();
    let runA = opening; const cumActualByPeriod = {};
    for (const k of allKeys) { runA += (actualNetByPeriod.get(k) || 0); cumActualByPeriod[k] = r2(runA); }
    for (const r of rows) { r.cumulative_actual = cumActualByPeriod[r.period]; }
    return { granularity, includePlan, opening_balance: r2(opening), rows };
  });

  // 계획 대비 실적(수입/지출 분리): query granularity, filter=all|recurring|other
  app.get('/api/plan-vs-actual', { preHandler: [authGuard, requirePage('transactions')] }, async (req) => {
    const granularity = req.query.granularity === 'week' ? 'week' : 'month';
    const filter = ['all', 'recurring', 'other'].includes(req.query.filter) ? req.query.filter : 'all';
    const txns = await loadCashTxns(req.ctx.perm);
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
      `SELECT si.id, si.customer_id, c.code AS customer_code, c.name AS customer_name,
              to_char(si.due_date,'YYYY-MM-DD') AS due_date, to_char(si.inv_date,'YYYY-MM-DD') AS inv_date, si.sat_no,
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
              to_char(si.due_date,'YYYY-MM-DD') AS due_date, to_char(sp.pay_date,'YYYY-MM-DD') AS pay_date, spa.amount, si.sat_no
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
    const txns = await loadCashTxns(req.ctx.perm);
    const mapped = txns.map((t) => ({
      id: t.id, direction: t.direction, status: t.status,
      txn_date: String(t.txn_date).slice(0, 10), amount_mxn: Number(t.amount_mxn) || 0,
      plan_date: t.plan_date ? String(t.plan_date).slice(0, 10) : null,
      plan_amount_mxn: t.plan_amount_mxn != null ? Number(t.plan_amount_mxn) : null,
      currency: t.currency, amount: Number(t.amount), category_code: t.category_code, category_name: t.category_name,
      memo: t.memo, sales_invoice_id: t.sales_invoice_id, recurring_rule_id: t.recurring_rule_id,
      account_id: t.account_id, account_name: t.account_name,
    }));
    // AR(수금예정): 전사 미수 인보이스(만기 due_date 기준) — 권한 계좌와 무관(재무 열람자는 전 팀 고객의 수금계획을 봄).
    const invRows = (await query(
      `SELECT si.id, c.name AS customer_name, si.sat_no,
              to_char(si.due_date,'YYYY-MM-DD') AS due_date,
              (si.total_mxn - COALESCE(SUM(spa.amount),0)) AS outstanding
         FROM sales_invoices si
         JOIN customers c ON c.id=si.customer_id
         LEFT JOIN sales_payment_allocations spa ON spa.invoice_id=si.id
        WHERE si.status='posted' AND si.deleted_at IS NULL
          AND to_char(si.due_date,'YYYY-MM')=$1
        GROUP BY si.id, c.name`, [month])).rows
      .map((r) => ({ ...r, outstanding: Number(r.outstanding) }));
    // AP(지급예정): 권한 계좌의 예정(plan)·지출(out) 거래(plan_date 기준).
    const planOut = mapped.filter((t) => t.status === 'plan' && t.direction === 'out');
    const { ar: arByDay, ap: apByDay } = calendarArApByDay(invRows, planOut, month);
    // 일자별 집계 + 누적잔고(기초잔고부터 그 달 시작 직전까지 누적 후 일자별)
    const opening = await openingBalanceMxn(req.ctx.perm);
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
      const arc = arByDay[ds] || { sum: 0, items: [] };
      const apc = apByDay[ds] || { sum: 0, items: [] };
      return { date: ds, in: r2(c.in), out: r2(c.out), net: r2(c.in - c.out), cumulative: r2(cumActual), items: c.items,
        ar: r2(arc.sum), ap: r2(apc.sum), ar_items: arc.items, ap_items: apc.items, balance: r2(cumActual) };
    });
    const breakdown = monthBreakdown(mapped, month, today);
    return { month, today, opening_before_month: r2(runBefore), days, ...breakdown };
  });

  // 계정과목별 계획 vs 실적(막대 비교): query filter=all|recurring|other, from, to (YYYY-MM-DD)
  app.get('/api/plan-vs-actual/by-category', { preHandler: [authGuard, requirePage('transactions')] }, async (req) => {
    const filter = ['all', 'recurring', 'other'].includes(req.query.filter) ? req.query.filter : 'all';
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
    const txns = await loadCashTxns(req.ctx.perm);
    const res = planVsActualByCategory(txns.map((t) => ({
      direction: t.direction, status: t.status, amount_mxn: Number(t.amount_mxn) || 0,
      txn_date: t.txn_date, plan_date: t.plan_date || t.txn_date,
      plan_amount_mxn: t.plan_amount_mxn != null ? Number(t.plan_amount_mxn) : null,
      category_code: t.category_code, category_name: t.category_name, recurring_rule_id: t.recurring_rule_id, memo: t.memo,
    })), { filter, from, to });
    return res;
  });

  // 환율 요약: 지정 기간 추이 + 통계 + USD 거래 요약.
  // query: from, to (YYYY-MM-DD), pair=usdmxn|mxnkrw (기본 usdmxn)
  app.get('/api/fx/summary', { preHandler: [authGuard, requirePage('transactions')] }, async (req) => {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
    const pair = req.query.pair === 'mxnkrw' ? 'mxnkrw' : 'usdmxn';

    let series, todayMeta;
    if (pair === 'mxnkrw') {
      // USD→MXN, USD→KRW 두 시리즈를 날짜로 조인 → MXN→KRW = USD→KRW ÷ USD→MXN (둘 다 있는 날만)
      const mxnSeries = await getFxRange(from, to, 'MXN');
      const krwSeries = await getFxRange(from, to, 'KRW');
      const mxnMap = new Map(mxnSeries.map((r) => [r.rate_date, r.rate]));
      series = [];
      for (const k of krwSeries) {
        const m = mxnMap.get(k.rate_date);
        if (m && m > 0) series.push({ rate_date: k.rate_date, rate: Math.round((k.rate / m) * 10000) / 10000, source: k.source });
      }
      const tMxn = await getUsdMxnRate();
      const tKrw = await getUsdKrwRate();
      const tRate = (tMxn.rate > 0) ? Math.round((tKrw.rate / tMxn.rate) * 10000) / 10000 : null;
      todayMeta = { rate: tRate, asOf: tKrw.asOf, source: 'USD→KRW ÷ USD→MXN', stale: tKrw.stale || tMxn.stale };
    } else {
      series = await getFxRange(from, to, 'MXN');
      const today = await getUsdMxnRate();
      todayMeta = { rate: today.rate, asOf: today.asOf, source: today.source, stale: today.stale };
    }

    let stats = null;
    if (series.length) {
      const rates = series.map((s) => s.rate);
      const first = series[0], last = series[series.length - 1];
      const min = series.reduce((a, b) => (b.rate < a.rate ? b : a));
      const max = series.reduce((a, b) => (b.rate > a.rate ? b : a));
      const avg = rates.reduce((s, r) => s + r, 0) / rates.length;
      const change = r2(last.rate - first.rate);
      stats = {
        first: { date: first.rate_date, rate: first.rate }, last: { date: last.rate_date, rate: last.rate },
        min: { date: min.rate_date, rate: min.rate }, max: { date: max.rate_date, rate: max.rate },
        avg: Math.round(avg * 10000) / 10000, change, change_pct: first.rate ? Math.round((change / first.rate) * 10000) / 100 : 0,
        count: series.length,
      };
    }
    // USD 거래 요약(예정/실제) — USD→MXN 모드에서만(거래가 USD라 KRW 모드엔 비표시)
    let usd = null;
    if (pair === 'usdmxn') {
      const usdRows = (await query(
        `SELECT status, COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS usd, COALESCE(SUM(amount_mxn),0) AS mxn,
                CASE WHEN SUM(amount)>0 THEN SUM(amount_mxn)/SUM(amount) ELSE NULL END AS avg_rate
           FROM transactions WHERE currency='USD' AND deleted_at IS NULL GROUP BY status`)).rows;
      usd = { plan: { cnt: 0, usd: 0, mxn: 0, avg_rate: null }, actual: { cnt: 0, usd: 0, mxn: 0, avg_rate: null } };
      for (const r of usdRows) {
        const k = r.status === 'actual' ? 'actual' : 'plan';
        usd[k] = { cnt: Number(r.cnt), usd: r2(r.usd), mxn: r2(r.mxn), avg_rate: r.avg_rate == null ? null : Math.round(Number(r.avg_rate) * 10000) / 10000 };
      }
    }
    return { from, to, pair, today: todayMeta, series, stats, usd };
  });

  // 처리 대기 예정 목록: 이번 달(또는 지정 월) 예정 + 과거에 예정됐으나 미처리(경과)인 것 전부.
  // query: month=YYYY-MM (기본 이번 달)
  app.get('/api/transactions/pending-plans', { preHandler: [authGuard, requirePage('transactions')] }, async (req) => {
    const month = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : new Date().toISOString().slice(0, 7);
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = month + '-01';
    const [yy, mm] = month.split('-').map(Number);
    const monthEnd = new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
    const rows = (await query(
      `SELECT t.id, t.account_id, a.name AS account_name, to_char(t.txn_date,'YYYY-MM-DD') AS txn_date, t.direction,
              t.amount, t.currency, t.fx_rate, t.amount_mxn, t.category_code, cat.name AS category_name,
              to_char(t.plan_date,'YYYY-MM-DD') AS plan_date, t.plan_amount, t.memo, t.sales_invoice_id, t.recurring_rule_id,
              si.sat_no AS sat_no, c.name AS customer_name
         FROM transactions t
         LEFT JOIN accounts a ON a.id=t.account_id
         LEFT JOIN categories cat ON cat.code=t.category_code
         LEFT JOIN sales_invoices si ON si.id=t.sales_invoice_id
         LEFT JOIN customers c ON c.id=si.customer_id
        WHERE t.status='plan' AND t.deleted_at IS NULL
          AND (
            (COALESCE(t.plan_date,t.txn_date) BETWEEN $1 AND $2)   -- 이번 달 예정
            OR (COALESCE(t.plan_date,t.txn_date) < $3)              -- 과거 미처리(경과) 전부
          )
        ORDER BY COALESCE(t.plan_date,t.txn_date) ASC, t.id ASC`,
      [monthStart, monthEnd, today])).rows;
    const items = rows.map((t) => {
      const pdate = t.plan_date || t.txn_date;
      const overdue = pdate < today;
      return { ...t, amount: Number(t.amount), amount_mxn: Number(t.amount_mxn), fx_rate: Number(t.fx_rate),
        plan_amount: t.plan_amount == null ? null : Number(t.plan_amount), plan_date: pdate, overdue,
        source: t.sales_invoice_id ? 'sales' : (t.recurring_rule_id ? 'recurring' : 'manual') };
    });
    return { month, today, count: items.length, items };
  });

  // 계정과목 목록(드롭다운용)
  app.get('/api/categories', { preHandler: [authGuard, requirePage('transactions')] }, async () => {
    const rows = (await query(`SELECT code, name, group_name FROM categories ORDER BY sort_order, code`)).rows;
    return { items: rows };
  });
}
