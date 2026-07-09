import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { pageAllowed } from '../permissions.js';
import { allowedAccountIds, allowedDetailAccountIds, canViewAccount, canViewDetail, canOperateAccount, blockedDetailAccountIds } from '../accountScope.js';
import { visibleTeamIds, canViewTeam } from '../teams.js';
import { logEvent } from '../audit.js';
import { getUsdMxnRate, getUsdKrwRate, getFxHistory, getRateForDate, getFxRange } from '../fx.js';
import { allocateOldestFirst, validateAllocations } from '../settlement.js';
import { validateReceiptDataUrl } from '../ar.js';
import { expandRule, expandBetween } from '../recurring.js';
import { aggregateCashflow, planVsActual, planVsActualByCategory, computeOverdue, latePaymentHistory, monthBreakdown, calendarArApByDay, bucketKey, planNetBefore } from '../cashflow.js';

const RECUR_HORIZON_MONTHS = 12;     // 최초 생성 기본 개월수
const RECUR_MAX_MONTHS = 24;         // 오늘 기준 생성 가능한 최대 미래(상한)

function addMonthsUTC(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  return dt.toISOString().slice(0, 10);
}

// DB DATE 컬럼 안전 변환: node-pg는 DATE를 JS Date 객체(로컬 자정)로 반환하므로
// String(date).slice(0,10) → "Wed Jul 01" 같은 깨진 값이 됨(고정비 월간 생성 무한루프의 원인).
// Date 객체·'YYYY-MM-DD...' 문자열 모두 'YYYY-MM-DD'로 정규화, 실패 시 null.
function toYMD(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
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
      `SELECT a.id, a.name, a.type, a.currency, a.open_balance, a.open_date, a.non_deductible, a.disabled,
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
      ...a, non_deductible: a.non_deductible === true, disabled: a.disabled === true, can_detail: canViewDetail(req.ctx.perm, a.id),
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
    const { name, type, open_balance, open_date, non_deductible, disabled } = req.body || {};
    const r = await query(
      `UPDATE accounts SET name=COALESCE($1,name), type=COALESCE($2,type),
         open_balance=COALESCE($3,open_balance), open_date=COALESCE($4,open_date),
         non_deductible=COALESCE($5,non_deductible), disabled=COALESCE($6,disabled), updated_by=$7
       WHERE id=$8 AND deleted_at IS NULL RETURNING id`,
      [name ?? null, type ?? null, (open_balance == null ? null : r2(open_balance)), open_date ?? null,
       (typeof non_deductible === 'boolean' ? non_deductible : null),
       (typeof disabled === 'boolean' ? disabled : null), req.ctx.perm.userId, id]);
    if (typeof disabled === 'boolean') await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `account:${id}`, detail: { disabled } });
    if (!r.rows[0]) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // ===== 계좌 원장(엑셀용) =====
  // 기초잔액(open_balance) + 실적(status='actual' AND approved=true)만 행별로, 각 행 누적잔액 포함.
  // 잔액 공식은 /api/accounts 의 balance 와 100% 동일: open_balance + Σ(in:+amount / out:-amount)
  //   WHERE status='actual' AND approved=true AND deleted_at IS NULL.
  // 권한: 해당 계좌의 '세부내역 열람'(can_detail)이 가능한 사용자만(canViewDetail). 현금·불공제 세부차단 계좌는 여기서 막힌다.
  // from 지정 시 그 이전 실적을 기초잔액으로 이월(자체정합: opening + 표시행 = closing).
  app.get('/api/accounts/:id/ledger', { preHandler: [authGuard, requirePage('transactions')] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'bad_id' });
    if (!canViewDetail(perm, id)) return reply.code(403).send({ error: 'account_detail_forbidden' });
    const acc = (await query(
      `SELECT id, name, type, currency, open_balance, open_date
         FROM accounts WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!acc) return reply.code(404).send({ error: 'not_found' });

    const q = req.query || {};
    const from = (q.from && String(q.from).slice(0, 10)) || null;
    const to = (q.to && String(q.to).slice(0, 10)) || null;
    // 비디렉터에게는 비공개 거래를 숨긴다(거래목록 정책과 동일). 디렉터는 전부.
    const priv = perm.role === 'director' ? '' : ' AND t.is_private=false';

    // 기초잔액: from 이 있으면 그 이전 실적을 개시잔고에 이월.
    let opening = Number(acc.open_balance);
    if (from) {
      const pr = (await query(
        `SELECT COALESCE(SUM(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END),0) AS s
           FROM transactions t
          WHERE t.account_id=$1 AND t.status='actual' AND t.approved=true AND t.deleted_at IS NULL${priv}
            AND t.txn_date < $2`, [id, from])).rows[0];
      opening = r2(opening + Number(pr.s));
    }

    const args = [id];
    let dcond = '';
    if (from) { args.push(from); dcond += ` AND t.txn_date >= $${args.length}`; }
    if (to) { args.push(to); dcond += ` AND t.txn_date <= $${args.length}`; }
    const rows = (await query(
      `SELECT t.id, t.txn_date, t.direction, t.amount, t.currency, t.amount_mxn, t.fx_rate,
              t.category_code, cat.name AS category_name, t.kind, t.memo, t.receipt_no,
              si.sat_no AS sat_no, c.name AS customer_name
         FROM transactions t
         LEFT JOIN categories cat ON cat.code=t.category_code
         LEFT JOIN sales_invoices si ON si.id=t.sales_invoice_id
         LEFT JOIN customers c ON c.id=si.customer_id
        WHERE t.account_id=$1 AND t.status='actual' AND t.approved=true AND t.deleted_at IS NULL${priv}${dcond}
        ORDER BY t.txn_date ASC, t.id ASC`, args)).rows;

    let bal = opening;
    const items = rows.map((t) => {
      const amt = Number(t.amount);
      const isIn = t.direction === 'in';
      bal = r2(bal + (isIn ? amt : -amt));
      return {
        id: Number(t.id),
        date: String(t.txn_date).slice(0, 10),
        direction: t.direction,
        category_code: t.category_code || null,
        category_name: t.category_name || null,
        kind: t.kind || 'general',
        memo: t.memo || '',
        receipt_no: t.receipt_no || '',
        sat_no: t.sat_no || '',
        customer_name: t.customer_name || '',
        in_amt: isIn ? amt : 0,
        out_amt: isIn ? 0 : amt,
        amount_mxn: Number(t.amount_mxn),
        balance: bal,
      };
    });

    return {
      account: {
        id: Number(acc.id), name: acc.name, type: acc.type || '', currency: acc.currency,
        open_balance: Number(acc.open_balance), open_date: acc.open_date ? String(acc.open_date).slice(0, 10) : null,
      },
      from, to, opening, closing: bal, count: items.length, items,
    };
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
         (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, memo, created_by, plan_amount, plan_date, receipt_no, cash_due)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'general',$10,$11,$12,$11,$13,$14,$15,$16) RETURNING id`,
      [b.account_id || null, b.txn_date, direction, r2(amount), currency, fx, amountMxn, b.category_code || null, status, approved, req.ctx.perm.userId, b.memo || null,
       status === 'plan' ? r2(amount) : null, status === 'plan' ? b.txn_date : null,
       (b.receipt_no && String(b.receipt_no).trim()) ? String(b.receipt_no).trim().slice(0, 60) : null,
       direction === 'out' && b.cash_due === true]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `transaction:${r.rows[0].id}`, detail: { direction, approved } });
    return { id: r.rows[0].id, approved, amount_mxn: amountMxn, fx_rate: fx };
  });

  // 거래 일괄 등록(엑셀 업로드 — 과거자료 마이그레이션).
  // 전건 검증 통과 시에만 단일 트랜잭션으로 전부 삽입(부분 성공 없음 → 마이그레이션 무결성).
  // body: { rows: [{ txn_date, direction, account_id, category_code, currency, amount, fx_rate, status, memo }] }
  app.post('/api/transactions/bulk-import', { preHandler: [authGuard, requirePage('transactions')] }, async (req, reply) => {
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
    if (!rows.length) return reply.code(400).send({ error: 'rows_required' });
    if (rows.length > 1000) return reply.code(400).send({ error: 'too_many_rows', max: 1000 });
    const isDirector = req.ctx.perm.role === 'director';
    const accIds = new Set((await query(`SELECT id FROM accounts WHERE deleted_at IS NULL`)).rows.map((a) => Number(a.id)));
    const catCodes = new Set((await query(`SELECT code FROM categories`)).rows.map((c) => String(c.code)));
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const errors = [];
    const prepared = [];
    const fxCache = new Map(); // 날짜별 환율 캐시(USD 실제 거래)
    let fxToday = null;
    for (let i = 0; i < rows.length; i++) {
      const b = rows[i] || {};
      const line = i + 2; // 엑셀 기준 행 번호(1행=헤더)
      const direction = b.direction === 'in' ? 'in' : (b.direction === 'out' ? 'out' : null);
      if (!direction) { errors.push({ line, error: 'bad_direction' }); continue; }
      const currency = ['MXN', 'USD'].includes(b.currency) ? b.currency : (b.currency == null || b.currency === '' ? 'MXN' : null);
      if (!currency) { errors.push({ line, error: 'bad_currency' }); continue; }
      const amount = Number(b.amount);
      if (!(amount > 0)) { errors.push({ line, error: 'bad_amount' }); continue; }
      const dstr = String(b.txn_date || '');
      let dOk = dateRe.test(dstr);
      if (dOk) { const dt = new Date(dstr + 'T00:00:00Z'); dOk = !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === dstr; }
      if (!dOk) { errors.push({ line, error: 'bad_date' }); continue; }
      const status = b.status === 'plan' ? 'plan' : 'actual';
      const accountId = (b.account_id == null || b.account_id === '') ? null : Number(b.account_id);
      if (accountId != null && !accIds.has(accountId)) { errors.push({ line, error: 'account_not_found' }); continue; }
      if (status === 'actual' && accountId == null) { errors.push({ line, error: 'account_required_for_actual' }); continue; }
      if (accountId != null && !canOperateAccount(req.ctx.perm, accountId)) { errors.push({ line, error: 'account_not_operable' }); continue; }
      if (accountId == null && !isDirector) { errors.push({ line, error: 'account_required' }); continue; }
      const categoryCode = (b.category_code == null || b.category_code === '') ? null : String(b.category_code);
      if (categoryCode != null && !catCodes.has(categoryCode)) { errors.push({ line, error: 'category_not_found' }); continue; }
      let fx = 1;
      if (currency === 'USD') {
        if (Number(b.fx_rate) > 0) fx = Number(b.fx_rate);
        else if (status === 'actual') {
          if (!fxCache.has(b.txn_date)) fxCache.set(b.txn_date, await getRateForDate(b.txn_date));
          fx = fxCache.get(b.txn_date);
        } else {
          if (fxToday == null) fxToday = (await getUsdMxnRate()).rate;
          fx = fxToday;
        }
      }
      const approved = !(direction === 'out' && !isDirector);
      prepared.push({ accountId, txn_date: b.txn_date, direction, amount: r2(amount), currency, fx,
        amountMxn: r2(amount * fx), categoryCode, status, approved,
        memo: (b.memo == null || String(b.memo).trim() === '') ? null : String(b.memo).trim().slice(0, 500),
        receiptNo: (b.receipt_no == null || String(b.receipt_no).trim() === '') ? null : String(b.receipt_no).trim().slice(0, 60) });
    }
    if (errors.length) return reply.code(400).send({ error: 'validation_failed', errors: errors.slice(0, 50), total_errors: errors.length });
    const userId = req.ctx.perm.userId;
    const ids = await withTx(async (c) => {
      const run = (s, p) => c.query(s, p);
      const out = [];
      for (const p of prepared) {
        const r = await run(
          `INSERT INTO transactions
             (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, memo, created_by, plan_amount, plan_date, receipt_no)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'general',$10,$11,$12,$11,$13,$14,$15) RETURNING id`,
          [p.accountId, p.txn_date, p.direction, p.amount, p.currency, p.fx, p.amountMxn, p.categoryCode, p.status, p.approved, userId, p.memo,
           p.status === 'plan' ? p.amount : null, p.status === 'plan' ? p.txn_date : null, p.receiptNo]);
        out.push(Number(r.rows[0].id));
      }
      return out;
    });
    await logEvent({ userId, action: 'create', target: 'transaction:bulk-import', detail: { count: ids.length } });
    const pendingCount = prepared.filter((p) => !p.approved).length;
    return { ok: true, inserted: ids.length, pending_approval: pendingCount };
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
    // 비공개 고정비 거래: 디렉터 외 숨김
    if (req.ctx.perm.role !== 'director') cond.push('t.is_private=false');
    if (q.status) { args.push(q.status); cond.push(`t.status=$${args.length}`); }
    if (q.direction) { args.push(q.direction); cond.push(`t.direction=$${args.length}`); }
    if (q.account_id) { args.push(Number(q.account_id)); cond.push(`t.account_id=$${args.length}`); }
    if (q.from) { args.push(q.from); cond.push(`t.txn_date>=$${args.length}`); }
    if (q.to) { args.push(q.to); cond.push(`t.txn_date<=$${args.length}`); }
    const rows = (await query(
      `SELECT t.id, t.account_id, a.name AS account_name, t.txn_date, t.direction, t.amount, t.currency, t.fx_rate,
              t.amount_mxn, t.category_code, cat.name AS category_name, t.status, t.kind, t.approved, t.change_status, t.memo, t.receipt_no, t.sales_invoice_id,
              t.plan_amount, t.plan_date, t.plan_memo, t.change_count, t.recurring_rule_id,
              t.cash_due, t.cash_due_done_at,
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
    if (t.is_private && req.ctx.perm.role !== 'director') return reply.code(404).send({ error: 'not_found' });
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
         category_code=$8, memo=$9, receipt_no=$10, updated_by=$11 WHERE id=$12`,
      [b.account_id ?? t.account_id, b.txn_date || t.txn_date, direction, r2(amount), currency, fx, amountMxn,
       // 필드가 body에 있으면 null=비우기(계정과목 '(없음)'·메모 지움), 없으면 기존값 유지.
       // (기존 `?? t.x`는 null을 '변경 없음'으로 삼켜 비우기가 불가능했음)
       ('category_code' in b) ? (b.category_code || null) : t.category_code,
       ('memo' in b) ? (b.memo || null) : t.memo,
       b.receipt_no !== undefined ? ((b.receipt_no && String(b.receipt_no).trim()) ? String(b.receipt_no).trim().slice(0, 60) : null) : t.receipt_no,
       req.ctx.perm.userId, id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `transaction:${id}`, detail: { direct_edit: true } });
    return { ok: true };
  });

  // 승인된 일반 거래: 수정 요청 (원본 유지)
  app.post('/api/transactions/:id/edit-request', { preHandler: [authGuard, requirePage('transactions')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const t = (await query(`SELECT id, kind, sales_invoice_id, approved, change_status, is_private FROM transactions WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (t.is_private && req.ctx.perm.role !== 'director') return reply.code(404).send({ error: 'not_found' });
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
    const t = (await query(`SELECT id, kind, sales_invoice_id, approved, change_status, is_private FROM transactions WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (t.is_private && req.ctx.perm.role !== 'director') return reply.code(404).send({ error: 'not_found' });
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
      account_id: t.account_id, account_name: t.account_name, txn_date: toYMD(t.txn_date), direction: t.direction,
      amount: Number(t.amount), currency: t.currency, fx_rate: Number(t.fx_rate), amount_mxn: Number(t.amount_mxn),
      category_code: t.category_code, category_name: t.category_name, memo: t.memo, receipt_no: t.receipt_no,
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
      amount, currency, fx_rate: fx, amount_mxn: amountMxn,
      category_code: ('category_code' in p) ? (p.category_code || null) : t.category_code, // null=비우기(승인적용과 동일 규칙)
      memo: ('memo' in p) ? (p.memo || null) : t.memo,
      receipt_no: p.receipt_no !== undefined ? p.receipt_no : t.receipt_no,
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
             category_code=$8, memo=$9, receipt_no=$10, change_status=NULL, updated_by=$11 WHERE id=$12`,
          [p.account_id ?? t.account_id, p.txn_date || t.txn_date, direction, r2(amount), currency, fx, amountMxn,
           ('category_code' in p) ? (p.category_code || null) : t.category_code, // null=비우기
           ('memo' in p) ? (p.memo || null) : t.memo,
           p.receipt_no !== undefined ? ((p.receipt_no && String(p.receipt_no).trim()) ? String(p.receipt_no).trim().slice(0, 60) : null) : t.receipt_no,
           userId, t.id]);
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
  app.get('/api/ar/customers', { preHandler: [authGuard, requirePage('settlement')] }, async (req) => {
    const vis = visibleTeamIds(req.ctx.perm);
    const cargs = []; let cTeam = '';
    if (vis !== null) { cargs.push(vis); cTeam = ` AND c.team_id = ANY($${cargs.length})`; }
    const rows = (await query(
      `SELECT c.id, c.code, c.name,
              COALESCE(SUM(s.total_mxn),0) - COALESCE(SUM(pa.paid),0) AS outstanding,
              COALESCE(adv.advance,0) AS advance
         FROM customers c
         JOIN sales_invoices s ON s.customer_id=c.id AND s.deleted_at IS NULL AND s.status='posted'
         LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) pa ON pa.invoice_id=s.id
         LEFT JOIN (SELECT customer_id, SUM(advance_amount) AS advance FROM sales_payments GROUP BY customer_id) adv ON adv.customer_id=c.id
        WHERE c.deleted_at IS NULL${cTeam}
        GROUP BY c.id, c.code, c.name, adv.advance
       HAVING COALESCE(SUM(s.total_mxn),0) - COALESCE(SUM(pa.paid),0) > 0.01
        ORDER BY outstanding DESC`, cargs)).rows;
    return { items: rows.map((r) => ({ ...r, outstanding: Number(r.outstanding), advance: Number(r.advance) })) };
  });

  // 한 고객의 미반제 인보이스(오래된 순) + 미수금
  app.get('/api/ar/open-invoices', { preHandler: [authGuard, requirePage('settlement')] }, async (req) => {
    const customerId = Number(req.query.customer_id);
    if (!customerId) return { items: [], advance: 0 };
    // 팀 가드: 담당팀 밖 고객 id 직접 조회 차단(영업담당 등). 디렉터·영업지원(vis=null)은 통과.
    const vis = visibleTeamIds(req.ctx.perm);
    if (vis !== null) {
      const ct = (await query(`SELECT team_id FROM customers WHERE id=$1`, [customerId])).rows[0];
      if (!ct || !canViewTeam(req.ctx.perm, ct.team_id)) return { items: [], advance: 0 };
    }
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
    const customerId = Number(b.customer_id);
    const depositId = Number(b.deposit_id);
    const allocations = Array.isArray(b.allocations) ? b.allocations.filter((a) => Number(a.amount) > 0).map((a) => ({ invoice_id: Number(a.invoice_id), amount: r2(a.amount) })) : [];
    if (!customerId) return reply.code(400).send({ error: 'missing_fields' });
    // 통지 우선 강제: 반제는 반드시 미배분 입금(통지)에 연결. 계좌·입금일·금액은 통지에서 확정(클라이언트 값 무시).
    if (!Number.isInteger(depositId) || depositId <= 0) return reply.code(400).send({ error: 'deposit_required' });
    // 입금증(은행 입금증 등) 첨부 — 선택. 있으면 형식·크기 검증 후 입금건에 함께 저장.
    let receipt = null;
    if (b.receipt) {
      const rv = validateReceiptDataUrl(b.receipt);
      if (!rv.ok) return reply.code(400).send({ error: 'invalid_receipt', detail: rv.error });
      receipt = { data: b.receipt, name: b.receipt_name || null, mime: rv.mime };
    }
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      // 통지 잠금 + 상태 확인. 계좌·입금일·금액은 통지에서 확정.
      const dep = (await c.query(
        `SELECT id, account_id, deposit_date, amount, status FROM bank_deposits_pending WHERE id=$1 FOR UPDATE`, [depositId])).rows[0];
      if (!dep) return { error: 'deposit_not_found' };
      if (dep.status !== 'pending') return { error: 'deposit_not_pending', status: dep.status };
      const accountId = Number(dep.account_id);
      const payDate = String(dep.deposit_date).slice(0, 10);
      const amount = r2(Number(dep.amount));
      // 현재 미수금 맵(검증용) — 이 고객 인보이스만
      const inv = (await c.query(
        `SELECT s.id, s.total_mxn - COALESCE(pa.paid,0) AS outstanding
           FROM sales_invoices s
           LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) pa ON pa.invoice_id=s.id
          WHERE s.customer_id=$1 AND s.deleted_at IS NULL AND s.status='posted'`, [customerId])).rows;
      const outMap = {}; inv.forEach((r) => { outMap[r.id] = r2(Number(r.outstanding)); });
      // 배분 대상 인보이스는 반드시 이 고객 소속(통지 고객)이어야 함
      for (const a of allocations) { if (outMap[a.invoice_id] == null) return { error: 'invalid_allocations', detail: [{ invoice_id: a.invoice_id, error: 'not_customer_invoice' }] }; }
      const sumAlloc = r2(allocations.reduce((s, a) => s + a.amount, 0));
      // 통지 금액 상한: 배분 합계는 통지 금액을 초과할 수 없음(남는 금액 = 선수금)
      if (sumAlloc - amount > 0.001) return { error: 'allocations_exceed_deposit', deposit: amount, sum: sumAlloc };
      const advance = r2(amount - sumAlloc);
      const v = validateAllocations(amount, allocations, outMap, advance);
      if (!v.ok) return { error: 'invalid_allocations', detail: v.errors };
      // 헤더
      const pay = (await c.query(
        `INSERT INTO sales_payments (customer_id, pay_date, account_id, amount, advance_amount, memo, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [customerId, payDate, accountId, amount, advance, b.memo || null, userId])).rows[0];
      // 배분별 실제 입금 거래 + 배분행
      for (const a of allocations) {
        const txn = (await c.query(
          `INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, sales_invoice_id, memo, created_by)
           VALUES ($1,$2,'in',$3,'MXN',1,$3,'4010','actual','payment',true,$4,$5,$6,$4) RETURNING id`,
          [accountId, payDate, a.amount, userId, a.invoice_id, `입금 반제 (인보이스 #${a.invoice_id})`])).rows[0];
        await c.query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount, txn_id) VALUES ($1,$2,$3,$4)`, [pay.id, a.invoice_id, a.amount, txn.id]);
      }
      // 선수금(과입금)
      if (advance > 0.001) {
        const at = (await c.query(
          `INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, memo, created_by)
           VALUES ($1,$2,'in',$3,'MXN',1,$3,'2030','actual','advance',true,$4,$5,$4) RETURNING id`,
          [accountId, payDate, advance, userId, '선수금(과입금)'])).rows[0];
        await c.query(`UPDATE sales_payments SET advance_txn_id=$1 WHERE id=$2`, [at.id, pay.id]);
      }
      // 입금증 저장(있으면)
      if (receipt) {
        await c.query(
          `INSERT INTO sales_payment_docs (payment_id, file_name, mime_type, file_data, uploaded_by)
           VALUES ($1,$2,$3,$4,$5)`,
          [pay.id, receipt.name, receipt.mime, receipt.data, userId]);
      }
      // 통지 닫기: pending→allocated (FOR UPDATE로 잠갔으므로 경합 없음). 통지 → 실거래 1회만 = 이중계상 불가.
      const depClose = (await c.query(
        `UPDATE bank_deposits_pending SET status='allocated', payment_id=$1, allocated_by=$2, allocated_at=now()
          WHERE id=$3 AND status='pending' RETURNING id`,
        [pay.id, userId, depositId])).rows[0];
      if (!depClose) return { error: 'deposit_not_pending' };
      return { id: pay.id, amount, advance, allocated: sumAlloc, receipt: !!receipt, deposit_linked: true };
    });
    if (out.error) {
      const code = (out.error === 'invalid_allocations' || out.error === 'deposit_not_pending') ? 409
        : (out.error === 'deposit_not_found') ? 404 : 400;
      return reply.code(code).send(out);
    }
    await logEvent({ userId, action: 'create', target: `sales_payment:${out.id}`, detail: { amount: out.amount, advance: out.advance, receipt: out.receipt, deposit_id: depositId } });
    return out;
  });

  // ===== 미배분 입금함 (bank_deposits_pending) =====
  // 재무담당/디렉터가 은행에 들어온 매출 입금을 '통지'로 등록 → 영업지원이 수금/정산에서 반제.
  // 등록은 transactions 미생성(이중계상 방지). 반제 시점에만 거래 1건 생성됨.
  function _bdCanRegister(perm) { return perm.role === 'director' || perm.role === 'treasury'; }
  function _bdCanNotify(perm) { return perm.role === 'director' || perm.role === 'sales_support'; }

  // 등록 (디렉터·재무)
  app.post('/api/bank-deposits', { preHandler: [authGuard] }, async (req, reply) => {
    if (!_bdCanRegister(req.ctx.perm)) return reply.code(403).send({ error: 'forbidden' });
    const b = req.body || {};
    const accountId = Number(b.account_id), amount = r2(b.amount);
    if (!accountId || !b.deposit_date || !(amount > 0)) return reply.code(400).send({ error: 'missing_fields' });
    const userId = req.ctx.perm.userId;
    const r = await query(
      `INSERT INTO bank_deposits_pending (account_id, deposit_date, amount, payer_memo, customer_id, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [accountId, b.deposit_date, amount, b.payer_memo || null, b.customer_id ? Number(b.customer_id) : null, b.note || null, userId]);
    await logEvent({ userId, action: 'create', target: `bank_deposit:${r.rows[0].id}`, detail: { amount } });
    return { id: Number(r.rows[0].id) };
  });

  // 목록 (디렉터·재무·정산권한자) — status=pending(기본) | all
  app.get('/api/bank-deposits', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const allowed = perm.role === 'director' || perm.role === 'treasury' || pageAllowed(perm, 'settlement', req.ctx.isRegistered);
    if (!allowed) return { items: [] };
    const status = String((req.query && req.query.status) || 'pending').toLowerCase();
    const where = status === 'all' ? '' : `WHERE d.status='pending'`;
    const rows = (await query(
      `SELECT d.id, d.deposit_date, d.account_id, a.name AS account_name, d.amount, d.payer_memo,
              d.customer_id, c.name AS customer_name, d.status, d.created_by, u.name AS created_by_name,
              (rd.user_id IS NOT NULL) AS read_by_me
         FROM bank_deposits_pending d
         LEFT JOIN accounts a ON a.id=d.account_id
         LEFT JOIN customers c ON c.id=d.customer_id
         LEFT JOIN users u ON u.id=d.created_by
         LEFT JOIN bank_deposit_reads rd ON rd.deposit_id=d.id AND rd.user_id=$1
         ${where}
        ORDER BY d.created_at DESC`, [perm.userId])).rows;
    return {
      items: rows.map((x) => ({
        ...x, id: Number(x.id), account_id: Number(x.account_id), amount: Number(x.amount),
        customer_id: x.customer_id != null ? Number(x.customer_id) : null, read_by_me: x.read_by_me === true,
      })),
    };
  });

  // 폴링용 안읽음 (디렉터·영업지원만 결과). 자기 등록·이미 읽은 건 제외.
  app.get('/api/bank-deposits/unread', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    if (!_bdCanNotify(perm)) return { count: 0, items: [] };
    const rows = (await query(
      `SELECT d.id, d.deposit_date, a.name AS account_name, d.amount, d.payer_memo
         FROM bank_deposits_pending d
         LEFT JOIN accounts a ON a.id=d.account_id
         LEFT JOIN bank_deposit_reads rd ON rd.deposit_id=d.id AND rd.user_id=$1
        WHERE d.status='pending' AND rd.user_id IS NULL AND COALESCE(d.created_by,0) <> $1
        ORDER BY d.created_at DESC`, [perm.userId])).rows;
    const items = rows.map((x) => ({ ...x, id: Number(x.id), amount: Number(x.amount) }));
    return { count: items.length, items };
  });

  // 읽음 처리(멱등) — 로그인 누구나
  app.post('/api/bank-deposits/read', { preHandler: [authGuard] }, async (req) => {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter((n) => Number.isInteger(n)) : [];
    const userId = req.ctx.perm.userId;
    for (const id of ids) {
      await query(
        `INSERT INTO bank_deposit_reads (deposit_id, user_id) VALUES ($1,$2)
         ON CONFLICT (deposit_id, user_id) DO NOTHING`, [id, userId]);
    }
    return { ok: true, marked: ids.length };
  });

  // 취소 (디렉터·재무) — pending 만. allocated 면 409.
  app.post('/api/bank-deposits/:id/void', { preHandler: [authGuard] }, async (req, reply) => {
    if (!_bdCanRegister(req.ctx.perm)) return reply.code(403).send({ error: 'forbidden' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' });
    const userId = req.ctx.perm.userId;
    const r = await query(
      `UPDATE bank_deposits_pending SET status='void', voided_by=$1, voided_at=now()
        WHERE id=$2 AND status='pending' RETURNING id`, [userId, id]);
    if (!r.rows[0]) {
      const cur = (await query(`SELECT status FROM bank_deposits_pending WHERE id=$1`, [id])).rows[0];
      if (!cur) return reply.code(404).send({ error: 'not_found' });
      return reply.code(409).send({ error: 'not_pending', status: cur.status });
    }
    await logEvent({ userId, action: 'update', target: `bank_deposit:${id}`, detail: { voided: true } });
    return { ok: true, id };
  });

  // 수정 (디렉터·재무) — pending 만. 계좌·입금일·금액·적요.
  app.patch('/api/bank-deposits/:id', { preHandler: [authGuard] }, async (req, reply) => {
    if (!_bdCanRegister(req.ctx.perm)) return reply.code(403).send({ error: 'forbidden' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' });
    const cur = (await query(`SELECT status FROM bank_deposits_pending WHERE id=$1`, [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (cur.status !== 'pending') return reply.code(409).send({ error: 'not_pending', status: cur.status });
    const b = req.body || {};
    const accountId = Number(b.account_id), amount = r2(b.amount);
    if (!accountId || !b.deposit_date || !(amount > 0)) return reply.code(400).send({ error: 'missing_fields' });
    const userId = req.ctx.perm.userId;
    await query(
      `UPDATE bank_deposits_pending
          SET account_id=$1, deposit_date=$2, amount=$3, payer_memo=$4
        WHERE id=$5 AND status='pending'`,
      [accountId, b.deposit_date, amount, b.payer_memo || null, id]);
    await logEvent({ userId, action: 'update', target: `bank_deposit:${id}`, detail: { edited: true, amount } });
    return { ok: true, id };
  });

  // 삭제 (디렉터·재무) — pending|void 만 완전 삭제(하드). allocated·booked 는 실거래가 있어 불가(409).
  app.delete('/api/bank-deposits/:id', { preHandler: [authGuard] }, async (req, reply) => {
    if (!_bdCanRegister(req.ctx.perm)) return reply.code(403).send({ error: 'forbidden' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' });
    const cur = (await query(`SELECT status FROM bank_deposits_pending WHERE id=$1`, [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (cur.status !== 'pending' && cur.status !== 'void') {
      return reply.code(409).send({ error: 'has_transaction', status: cur.status });
    }
    const userId = req.ctx.perm.userId;
    await query(`DELETE FROM bank_deposits_pending WHERE id=$1`, [id]); // bank_deposit_reads 는 ON DELETE CASCADE
    await logEvent({ userId, action: 'delete', target: `bank_deposit:${id}`, detail: { hard: true, prevStatus: cur.status } });
    return { ok: true, id };
  });

  // 수입 전환 (디렉터 전용) — pending 을 일반 수입 거래 1건으로 직접 기표.
  //  반제 경로 대신 디렉터가 "거래등록 수입"으로 확정. 입금은 booked 로 닫혀 반제 인박스에서 사라짐(이중계상 불가).
  app.post('/api/bank-deposits/:id/book-income', { preHandler: [authGuard] }, async (req, reply) => {
    if (req.ctx.perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' });
    const dep = (await query(
      `SELECT id, account_id, deposit_date, amount, payer_memo, status
         FROM bank_deposits_pending WHERE id=$1`, [id])).rows[0];
    if (!dep) return reply.code(404).send({ error: 'not_found' });
    if (dep.status !== 'pending') return reply.code(409).send({ error: 'not_pending', status: dep.status });
    const b = req.body || {};
    // 기본값은 입금 정보. 디렉터가 계좌·일자·금액·적요·계정과목을 덮어쓸 수 있음.
    const accountId = Number(b.account_id || dep.account_id);
    const txnDate = b.txn_date || String(dep.deposit_date).slice(0, 10);
    const amount = r2(b.amount != null ? b.amount : dep.amount);
    const categoryCode = b.category_code || null;
    const memo = (b.memo != null ? b.memo : (dep.payer_memo || '')) || null;
    if (!accountId || !txnDate || !(amount > 0)) return reply.code(400).send({ error: 'missing_fields' });
    const userId = req.ctx.perm.userId;
    // 일반 수입 거래 1건(actual/general/approved). MXN, fx=1.
    const tr = await query(
      `INSERT INTO transactions
         (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, memo, created_by)
       VALUES ($1,$2,'in',$3,'MXN',1,$3,$4,'actual','general',true,$5,$6,$5) RETURNING id`,
      [accountId, txnDate, amount, categoryCode, userId, memo]);
    const txnId = Number(tr.rows[0].id);
    const upd = await query(
      `UPDATE bank_deposits_pending
          SET status='booked', txn_id=$1, booked_by=$2, booked_at=now()
        WHERE id=$3 AND status='pending' RETURNING id`,
      [txnId, userId, id]);
    if (!upd.rows[0]) {
      // 경합(사이에 상태 변경) → 방금 만든 거래 취소하고 409.
      await query(`DELETE FROM transactions WHERE id=$1`, [txnId]);
      const now = (await query(`SELECT status FROM bank_deposits_pending WHERE id=$1`, [id])).rows[0];
      return reply.code(409).send({ error: 'not_pending', status: now ? now.status : 'gone' });
    }
    await logEvent({ userId, action: 'create', target: `transaction:${txnId}`, detail: { from_bank_deposit: id, amount } });
    await logEvent({ userId, action: 'update', target: `bank_deposit:${id}`, detail: { booked: true, txn_id: txnId } });
    return { ok: true, id, txn_id: txnId, amount_mxn: amount };
  });

  // 입금 이력
  app.get('/api/ar/payments', { preHandler: [authGuard, requirePage('settlement')] }, async (req) => {
    const cond = []; const args = [];
    if (req.query.customer_id) { args.push(Number(req.query.customer_id)); cond.push(`p.customer_id=$${args.length}`); }
    const vis = visibleTeamIds(req.ctx.perm);
    if (vis !== null) { args.push(vis); cond.push(`c.team_id = ANY($${args.length})`); }
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
    const vis = visibleTeamIds(req.ctx.perm);
    const oargs = []; let oTeam = '';
    if (vis !== null) { oargs.push(vis); oTeam = ` AND c.team_id = ANY($${oargs.length})`; }
    const rows = (await query(
      `SELECT s.id, s.sat_no, s.folio_no,
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
        WHERE s.deleted_at IS NULL AND s.status='posted'${oTeam}
          ${includeClosed ? '' : 'AND (s.total_mxn - COALESCE(pa.paid,0)) > 0.01'}
        ORDER BY ((s.total_mxn - COALESCE(pa.paid,0)) <= 0.005), s.due_date NULLS LAST, s.inv_date, s.id`, oargs)).rows;
    return {
      today: new Date().toISOString().slice(0, 10),
      items: rows.map((r) => ({
        id: Number(r.id), sat_no: r.sat_no, folio_no: r.folio_no || null, inv_date: r.inv_date, due_date: r.due_date,
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
              c.id AS customer_id, c.code AS customer_code, c.name AS customer_name, c.team_id AS customer_team_id
         FROM sales_invoices s
         JOIN customers c ON c.id=s.customer_id
         LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) pa ON pa.invoice_id=s.id
        WHERE s.id=$1 AND s.deleted_at IS NULL`, [invId])).rows[0];
    if (!inv) return reply.code(404).send({ error: 'not_found' });
    if (!canViewTeam(req.ctx.perm, inv.customer_team_id)) return reply.code(403).send({ error: 'forbidden_team' });
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
    const vis = visibleTeamIds(req.ctx.perm);
    const sargs = [like]; let sTeam = '';
    if (vis !== null) { sargs.push(vis); sTeam = ` AND c.team_id = ANY($${sargs.length})`; }
    const rows = (await query(
      `SELECT s.id, s.sat_no, s.folio_no,
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
        WHERE s.deleted_at IS NULL AND s.status='posted'${sTeam}
          AND (s.sat_no ILIKE $1 ESCAPE '\\' OR s.folio_no ILIKE $1 ESCAPE '\\' OR c.name ILIKE $1 ESCAPE '\\')
        ORDER BY s.inv_date DESC, s.id DESC
        LIMIT 80`, sargs)).rows;
    return {
      today,
      items: rows.map((r) => {
        const total = r2(Number(r.total_mxn)), paid = r2(Number(r.paid)), outstanding = r2(Number(r.outstanding));
        return {
          id: Number(r.id), sat_no: r.sat_no, folio_no: r.folio_no || null, inv_date: r.inv_date, due_date: r.due_date,
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
  // 비공개(is_private) 규칙은 디렉터만 조회/조작. 비디렉터에겐 목록·거래·현금흐름 전부에서 숨김.
  const privTxnCond = (perm, alias = 't') => (perm.role === 'director' ? '' : ` AND ${alias}.is_private=false`);
  app.get('/api/recurring', { preHandler: [authGuard, requirePage('transactions')] }, async (req) => {
    const privCond = req.ctx.perm.role === 'director' ? '' : ' AND r.is_private=false';
    const rows = (await query(
      `SELECT r.id, r.name, r.category_code, cat.name AS category_name, r.amount, r.direction, r.currency,
              r.account_id, a.name AS account_name, r.freq, r.weekday, r.day_of_month, r.start_date, r.end_month, r.active, r.memo, r.generated_through, r.is_private,
              (SELECT COUNT(*) FROM transactions t WHERE t.recurring_rule_id=r.id AND t.deleted_at IS NULL) AS generated_count,
              (SELECT COUNT(*) FROM transactions t WHERE t.recurring_rule_id=r.id AND t.status='actual' AND t.deleted_at IS NULL) AS paid_count
         FROM recurring_rules r
         LEFT JOIN categories cat ON cat.code=r.category_code
         LEFT JOIN accounts a ON a.id=r.account_id
        WHERE r.deleted_at IS NULL${privCond} ORDER BY r.active DESC, r.id`)).rows;
    return { items: rows.map((r) => ({ ...r, amount: Number(r.amount), generated_count: Number(r.generated_count), paid_count: Number(r.paid_count) })) };
  });

  // 등록: 재무담당(transactions 권한)도 "공개" 고정비는 입력 가능. 비공개(is_private)는 디렉터만.
  app.post('/api/recurring', { preHandler: [authGuard, requirePage('transactions')] }, async (req, reply) => {
    const b = req.body || {};
    const isDir = req.ctx.perm.role === 'director';
    const isPrivate = isDir && b.is_private === true; // 비디렉터 요청은 무조건 공개로 강제
    const freq = b.freq === 'week' ? 'week' : 'month';
    const direction = b.direction === 'in' ? 'in' : 'out';
    const currency = ['MXN', 'USD'].includes(b.currency) ? b.currency : 'MXN';
    if (!b.name || !(Number(b.amount) > 0) || !b.start_date) return reply.code(400).send({ error: 'missing_fields' });
    if (freq === 'week' && (b.weekday == null || b.weekday < 0 || b.weekday > 6)) return reply.code(400).send({ error: 'weekday_required' });
    if (freq === 'month' && !(b.day_of_month >= 1 && b.day_of_month <= 31)) return reply.code(400).send({ error: 'day_of_month_required' });
    const r = await query(
      `INSERT INTO recurring_rules (name, category_code, amount, direction, currency, account_id, freq, weekday, day_of_month, start_date, end_month, active, memo, created_by, is_private)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [b.name, b.category_code || null, r2(b.amount), direction, currency, b.account_id || null, freq,
       freq === 'week' ? b.weekday : null, freq === 'month' ? b.day_of_month : null, b.start_date, b.end_month || null,
       b.active !== false, b.memo || null, req.ctx.perm.userId, isPrivate]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `recurring_rule:${r.rows[0].id}`, detail: { is_private: isPrivate } });
    return { id: r.rows[0].id };
  });

  // 수정: 비디렉터는 공개 규칙만(비공개는 존재 자체를 숨기려 404). is_private 전환은 디렉터만 — 전환 시 생성된 거래도 동기화.
  app.patch('/api/recurring/:id', { preHandler: [authGuard, requirePage('transactions')] }, async (req, reply) => {
    const id = Number(req.params.id); const b = req.body || {};
    const isDir = req.ctx.perm.role === 'director';
    const privCond = isDir ? '' : ' AND is_private=false';
    const newPriv = isDir && typeof b.is_private === 'boolean' ? b.is_private : null;
    const r = await query(
      `UPDATE recurring_rules SET name=COALESCE($1,name), category_code=COALESCE($2,category_code), amount=COALESCE($3,amount),
         account_id=COALESCE($4,account_id), end_month=$5, active=COALESCE($6,active), memo=COALESCE($7,memo),
         is_private=COALESCE($9,is_private), updated_at=now()
       WHERE id=$8 AND deleted_at IS NULL${privCond} RETURNING id, is_private`,
      [b.name ?? null, b.category_code ?? null, (b.amount == null ? null : r2(b.amount)), b.account_id ?? null,
       b.end_month ?? null, (b.active == null ? null : b.active), b.memo ?? null, id, newPriv]);
    if (!r.rows[0]) return reply.code(404).send({ error: 'not_found' });
    // 비공개 여부 전환 시, 이 규칙이 생성한 거래(예정+실적)의 is_private 동기화
    if (newPriv != null) {
      await query(`UPDATE transactions SET is_private=$1 WHERE recurring_rule_id=$2`, [newPriv, id]);
    }
    return { ok: true, is_private: r.rows[0].is_private };
  });

  // 규칙 삭제(소프트) + 아직 미지급(plan)인 미래 생성분 제거. 비디렉터는 공개 규칙만.
  app.delete('/api/recurring/:id', { preHandler: [authGuard, requirePage('transactions')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const userId = req.ctx.perm.userId;
    const privCond = req.ctx.perm.role === 'director' ? '' : ' AND is_private=false';
    let found = false;
    await withTx(async (c) => {
      const r = await c.query(`UPDATE recurring_rules SET deleted_at=now(), active=false WHERE id=$1 AND deleted_at IS NULL${privCond} RETURNING id`, [id]);
      if (!r.rows[0]) return;
      found = true;
      await c.query(`UPDATE transactions SET deleted_at=now(), updated_by=$1 WHERE recurring_rule_id=$2 AND status='plan' AND deleted_at IS NULL`, [userId, id]);
    });
    if (!found) return reply.code(404).send({ error: 'not_found' });
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
      if (rule.is_private && req.ctx.perm.role !== 'director') return reply.code(404).send({ error: 'not_found' });
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
      const startYmd = toYMD(rule.start_date);
      if (!startYmd) return reply.code(400).send({ error: 'bad_start_date' });
      const gthrough = toYMD(rule.generated_through);
      // 항상 시작일부터 전개 — 기존 생성분은 (rule_id, period) 멱등(ON CONFLICT)으로 자동 스킵.
      // generated_through 기준 연장 방식은 폐기: 과거 버그로 거래 0건 상태에서 generated_through만
      // 기록된 규칙이 "이미 생성됨"으로 오판돼 영구 복구 불가였음. 이 방식이면 [생성] 재클릭만으로 치유됨.
      const occ = expandBetween({
        freq: rule.freq, start_date: startYmd,
        day_of_month: rule.day_of_month == null ? null : Number(rule.day_of_month),
        weekday: rule.weekday == null ? null : Number(rule.weekday), end_month: rule.end_month,
      }, startYmd, target);
      const fx = rule.currency === 'USD' ? (await getUsdMxnRate()).rate : 1;
      const amt = r2(rule.amount); const amountMxn = r2(amt * fx);
      let created = 0;
      if (occ.length) {
        const existing = new Set((await query(
          `SELECT recurring_period FROM transactions WHERE recurring_rule_id=$1 AND deleted_at IS NULL`, [id])).rows.map((r) => r.recurring_period));
        const fresh = occ.filter((o) => !existing.has(o.period));
        if (fresh.length) {
          const userId = req.ctx.perm.userId;
          const vals = []; const params = []; let i = 1;
          for (const o of fresh) {
            vals.push(`($${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},'plan','general',true,$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++})`);
            params.push(rule.account_id || null, o.date, rule.direction, amt, rule.currency, fx, amountMxn,
              rule.category_code || null, userId, `[고정비] ${rule.name}`, userId, rule.id, o.period, amt, o.date,
              rule.is_private === true);
          }
          const res = await query(
            `INSERT INTO transactions
               (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, memo, created_by, recurring_rule_id, recurring_period, plan_amount, plan_date, is_private)
             VALUES ${vals.join(',')}
             ON CONFLICT (recurring_rule_id, recurring_period) WHERE recurring_rule_id IS NOT NULL AND deleted_at IS NULL DO NOTHING`, params);
          created = res.rowCount || 0;
        }
      }
      // generated_through는 이제 표시용(어디까지 생성했는지) — 뒤로 가지 않게만 유지
      const newThrough = gthrough && gthrough > target ? gthrough : target;
      await query(`UPDATE recurring_rules SET generated_through=$1 WHERE id=$2`, [newThrough, id]);
      return { ok: true, created, generated_through: newThrough, capped: target >= cap };
    } finally {
      app.__recurGenerating = false;
    }
  });

  // 지급/입금 확인: 예정(plan) 거래 → 실제(actual). 날짜·금액 수정 가능(계획과 다를 수 있음).
  // body: { account_id, pay_date?, amount?, fx_rate?, memo? }
  // 디렉터 직접 삭제(소프트): 잔액·현금흐름에서 즉시 제외.
  // 매출연계(sales_invoice_id) 거래는 반제/정산 무결성 보호를 위해 금지 — 반제 취소 경로 사용.
  // general 외 kind(NC·정산차액 등)는 각자의 취소 절차가 있으므로 금지.
  app.delete('/api/transactions/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const t = (await query(`SELECT sales_invoice_id, kind, direction, amount, currency, memo FROM transactions WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (t.sales_invoice_id != null) return reply.code(400).send({ error: 'sales_linked' });
    if (t.kind !== 'general') return reply.code(400).send({ error: 'kind_not_deletable' });
    await query(`UPDATE transactions SET deleted_at=now(), updated_by=$1 WHERE id=$2`, [req.ctx.perm.userId, id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `transaction:${id}`,
      detail: { direction: t.direction, amount: Number(t.amount), currency: t.currency, memo: t.memo } });
    return { ok: true };
  });

  // ===== 💰 현금받아야함 (금고 회수 관리) =====
  // 회수 목록 — 디렉터 전용. summary: 미수령 건수·합계(MXN), 수령완료 건수.
  app.get('/api/transactions/cash-due', { preHandler: [authGuard, requireDirector] }, async () => {
    const items = (await query(
      `SELECT t.id, to_char(t.txn_date,'YYYY-MM-DD') AS txn_date, a.name AS account_name,
              t.category_code, cat.name AS category_name, t.amount, t.currency, t.amount_mxn,
              t.memo, t.approved, t.receipt_no, t.cash_due_done_at, u.name AS done_by_name
         FROM transactions t
         LEFT JOIN accounts a ON a.id=t.account_id
         LEFT JOIN categories cat ON cat.code=t.category_code
         LEFT JOIN users u ON u.id=t.cash_due_done_by
        WHERE t.cash_due=true AND t.deleted_at IS NULL
        ORDER BY (t.cash_due_done_at IS NOT NULL), t.txn_date DESC, t.id DESC`)).rows
      .map((t) => ({ ...t, amount: Number(t.amount), amount_mxn: Number(t.amount_mxn) || 0 }));
    const pending = items.filter((x) => !x.cash_due_done_at);
    return { items, summary: { pending_count: pending.length, pending_mxn: r2(pending.reduce((s, x) => s + x.amount_mxn, 0)),
      done_count: items.length - pending.length } };
  });

  // 지정/해제 {on:boolean} — 지출 거래만. 해제 시 수령기록도 초기화.
  app.post('/api/transactions/:id/cash-due', { preHandler: [authGuard, requirePage('transactions')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const on = req.body && req.body.on === true;
    const t = (await query(`SELECT direction FROM transactions WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (on && t.direction !== 'out') return reply.code(400).send({ error: 'expense_only' });
    await query(`UPDATE transactions SET cash_due=$1, cash_due_done_at=NULL, cash_due_done_by=NULL, updated_by=$2 WHERE id=$3`, [on, req.ctx.perm.userId, id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `transaction:${id}`, detail: { cash_due: on } });
    return { ok: true, cash_due: on };
  });

  // 수령완료/되돌리기 {done:boolean} — 디렉터 전용(실물 현금을 받는 사람).
  app.post('/api/transactions/:id/cash-due-done', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const done = req.body && req.body.done === true;
    const r = await query(
      `UPDATE transactions SET cash_due_done_at=${'CASE WHEN $1 THEN now() ELSE NULL END'},
              cash_due_done_by=CASE WHEN $1 THEN $2::int ELSE NULL END, updated_by=$2
        WHERE id=$3 AND deleted_at IS NULL AND cash_due=true RETURNING id`, [done, req.ctx.perm.userId, id]);
    if (!r.rows[0]) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `transaction:${id}`, detail: { cash_due_done: done } });
    return { ok: true };
  });

  app.post('/api/transactions/:id/confirm-pay', { preHandler: [authGuard, requirePage('transactions')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const t = (await query(`SELECT * FROM transactions WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (t.is_private && req.ctx.perm.role !== 'director') return reply.code(404).send({ error: 'not_found' });
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
    // 영수증 번호(선택): 예정 단계엔 영수증이 없으므로 확인 시 입력이 곧 최초 기록(빈값=null)
    const receiptNo = (req.body?.receipt_no != null && String(req.body.receipt_no).trim() !== '')
      ? String(req.body.receipt_no).trim().slice(0, 60) : null;
    // 계획 대비 변경 여부
    const planAmt = t.plan_amount != null ? Number(t.plan_amount) : Number(t.amount);
    // pg는 DATE 컬럼을 JS Date 객체로 반환 — String().slice는 'Mon Jul 06' 같은 깨진 값이 됨(잔액분리 INSERT 500의 원인)
    const planDate = toYMD(t.plan_date) || toYMD(t.txn_date);
    const changed = Math.abs(newAmount - planAmt) > 0.001 || toYMD(payDate) !== planDate;
    const memo = req.body?.memo ? String(req.body.memo).trim() : null;
    const newChangeCount = Number(t.change_count || 0) + (changed ? 1 : 0);
    const planMemo = changed && memo
      ? ((t.plan_memo ? t.plan_memo + ' | ' : '') + `${new Date().toISOString().slice(0, 10)}: ${memo}`)
      : t.plan_memo;
    // 지출(out)을 비디렉터가 확정하면 실적이지만 디렉터 승인 전까지 미반영(approved=false).
    const isDir = req.ctx.perm.role === 'director';
    const approved = !(t.direction === 'out' && !isDir);
    // ===== 잔액 처리: 실적 < 계획일 때 선택 =====
    // remainder='close'(기본): 그대로 마감 → plan_amount(계획)는 유지되어 차액이 "절감"으로 기록됨.
    // remainder='keep': 부분 집행 → 이 행의 계획을 실집행분으로 낮추고, 잔액을 새 예정(plan) 거래로 분리해 남김(절감 아님·미집행).
    const remainderMode = req.body?.remainder === 'keep' ? 'keep' : 'close';
    const rem = r2(planAmt - newAmount);
    if (remainderMode === 'keep') {
      if (!(rem > 0.001)) return reply.code(400).send({ error: 'remainder_not_applicable' });
      const planFx = Number(t.fx_rate) || 1; // 잔액 예정은 기존 계획 환율 유지
      const remMxn = r2(rem * planFx);
      const remPeriod = t.recurring_period ? `${t.recurring_period}#r${id}` : null; // (rule_id, period) 유니크 회피
      const remMemo = `${t.memo || ''}${t.memo ? ' ' : ''}(잔액)`.trim();
      const splitNote = `${new Date().toISOString().slice(0, 10)}: 부분 집행 — 잔액 ${rem} ${t.currency} 예정으로 유지${memo ? ` (${memo})` : ''}`;
      const planMemoKeep = (t.plan_memo ? t.plan_memo + ' | ' : '') + splitNote;
      let remId = null;
      await withTx(async (exec) => {
        await exec.query(
          `UPDATE transactions SET status='actual', account_id=$1, txn_date=$2, amount=$3, fx_rate=$4, amount_mxn=$5,
             approved=$10, change_count=$6, plan_memo=$7, plan_amount=$3, receipt_no=$11, updated_by=$8 WHERE id=$9`,
          [accountId, payDate, newAmount, fx, amountMxn, newChangeCount, planMemoKeep, req.ctx.perm.userId, id, approved, receiptNo]);
        const rr = await exec.query(
          `INSERT INTO transactions
             (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, memo, created_by, recurring_rule_id, recurring_period, plan_amount, plan_date, is_private)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'plan','general',true,$9,$10,$9,$11,$12,$4,$2,$13) RETURNING id`,
          [t.account_id || null, planDate, t.direction, rem, t.currency, planFx, remMxn, t.category_code || null,
           req.ctx.perm.userId, remMemo, t.recurring_rule_id || null, remPeriod, t.is_private === true]);
        remId = Number(rr.rows[0].id);
      });
      await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `transaction:${id}`, detail: { confirm_pay: true, changed, approved, remainder: 'keep', remainder_amount: rem, remainder_txn_id: remId } });
      return { ok: true, amount_mxn: amountMxn, changed, change_count: newChangeCount, approved,
        plan_amount: planAmt, diff: r2(newAmount - planAmt), remainder: 'keep', remainder_amount: rem, remainder_txn_id: remId };
    }
    await query(
      `UPDATE transactions SET status='actual', account_id=$1, txn_date=$2, amount=$3, fx_rate=$4, amount_mxn=$5,
         approved=$10, change_count=$6, plan_memo=$7, receipt_no=$11, updated_by=$8 WHERE id=$9`,
      [accountId, payDate, newAmount, fx, amountMxn, newChangeCount, planMemo, req.ctx.perm.userId, id, approved, receiptNo]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `transaction:${id}`, detail: { confirm_pay: true, changed, approved, remainder: 'close' } });
    return { ok: true, amount_mxn: amountMxn, changed, change_count: newChangeCount, approved,
      plan_amount: planAmt, diff: r2(newAmount - planAmt), remainder: 'close',
      saved: rem > 0.001 ? rem : 0, over: newAmount - planAmt > 0.001 ? r2(newAmount - planAmt) : 0 };
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
        WHERE t.recurring_rule_id IS NOT NULL AND t.status='actual' AND t.deleted_at IS NULL${privTxnCond(req.ctx.perm)}
        GROUP BY 1 ORDER BY 1 DESC LIMIT 60`)).rows;
    return { granularity: gran, items: rows.map((r) => {
      const plan = Number(r.plan_mxn) || 0, actual = Number(r.actual_mxn) || 0;
      return { period: r.period, plan_mxn: r2(plan), actual_mxn: r2(actual), diff_mxn: r2(actual - plan),
        items: Number(r.items), changed_items: Number(r.changed_items) };
    }) };
  });

  // 월별 고정비 집계 — 고정비 탭 상단(월간 총 고정비 3개월 카드)·추이 그래프·계정과목별 매트릭스용.
  // 데이터원: recurring_rule_id 보유 '지출' 거래의 amount_mxn. status로 실적(actual)/예정(plan) 분리.
  // 월 귀속: COALESCE(plan_date, txn_date) 기준(예정된 달에 귀속 — 고정비는 예정월이 곧 그 달 비용).
  // 게이팅: privTxnCond(비공개 고정비는 비디렉터에 제외) — 기존 고정비 variance와 동일 기준. (계좌 스코프는 미적용: variance와 대칭.)
  app.get('/api/recurring/monthly', { preHandler: [authGuard, requirePage('transactions')] }, async (req) => {
    const mRe = /^\d{4}-\d{2}$/;
    const from = mRe.test(String(req.query.from || '')) ? String(req.query.from) : null;
    const to = mRe.test(String(req.query.to || '')) ? String(req.query.to) : null;
    if (!from || !to || from > to) return { months: [], total: {}, by_cat: [], fx_rate: (await getUsdMxnRate()).rate, error: 'bad_range' };
    const fromDate = from + '-01';
    const [ty, tm] = to.split('-').map(Number);
    const nextY = tm === 12 ? ty + 1 : ty, nextM = tm === 12 ? 1 : tm + 1;
    const toExcl = `${nextY}-${String(nextM).padStart(2, '0')}-01`;
    const rows = (await query(
      `SELECT to_char(COALESCE(t.plan_date, t.txn_date), 'YYYY-MM') AS ym,
              t.category_code AS code, cat.name AS cat_name, t.status,
              SUM(t.amount_mxn) AS mxn
         FROM transactions t
         LEFT JOIN categories cat ON cat.code=t.category_code
        WHERE t.recurring_rule_id IS NOT NULL AND t.direction='out' AND t.deleted_at IS NULL
          AND COALESCE(t.plan_date, t.txn_date) >= $1::date
          AND COALESCE(t.plan_date, t.txn_date) <  $2::date${privTxnCond(req.ctx.perm)}
        GROUP BY 1, 2, 3, 4`, [fromDate, toExcl])).rows;
    // 연속 월 목록 생성
    const months = [];
    { let [y, m] = from.split('-').map(Number); const [ey, em] = to.split('-').map(Number);
      while (y < ey || (y === ey && m <= em)) { months.push(`${y}-${String(m).padStart(2, '0')}`);
        if (m === 12) { y++; m = 1; } else m++; } }
    const total = {}; months.forEach((ym) => { total[ym] = { actual: 0, plan: 0 }; });
    const catMap = new Map();
    const emptyM = () => { const o = {}; months.forEach((z) => { o[z] = { actual: 0, plan: 0 }; }); return o; };
    for (const r of rows) {
      const ym = r.ym; const v = Number(r.mxn) || 0;
      const bucket = r.status === 'actual' ? 'actual' : 'plan';
      if (!total[ym]) total[ym] = { actual: 0, plan: 0 };
      total[ym][bucket] = r2(total[ym][bucket] + v);
      const key = r.code || '(none)';
      if (!catMap.has(key)) catMap.set(key, { code: r.code || null, name: r.cat_name || '(미분류)', m: emptyM() });
      const c = catMap.get(key); if (!c.m[ym]) c.m[ym] = { actual: 0, plan: 0 };
      c.m[ym][bucket] = r2(c.m[ym][bucket] + v);
    }
    const by_cat = [...catMap.values()].sort((a, b) => {
      const sa = months.reduce((s, z) => s + a.m[z].actual + a.m[z].plan, 0);
      const sb = months.reduce((s, z) => s + b.m[z].actual + b.m[z].plan, 0);
      return sb - sa;
    });
    return { months, total, by_cat, fx_rate: (await getUsdMxnRate()).rate };
  });

  // ===== 예정(plan) 거래 계획 수정 =====
  // 매출에서 온 AR(sales_invoice_id)은 인보이스와 묶여 수정 불가. 일반 예정만 금액/날짜/메모 수정.
  app.patch('/api/transactions/:id/plan', { preHandler: [authGuard, requirePage('transactions')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const t = (await query(`SELECT * FROM transactions WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (t.is_private && req.ctx.perm.role !== 'director') return reply.code(404).send({ error: 'not_found' });
    if (t.status !== 'plan') return reply.code(409).send({ error: 'not_plan' });
    if (t.sales_invoice_id) return reply.code(409).send({ error: 'sales_linked' });
    if (!canOperateAccount(req.ctx.perm, t.account_id)) return reply.code(403).send({ error: 'account_not_operable' });
    const b = req.body || {};
    const newAmount = b.amount != null ? r2(b.amount) : Number(t.amount);
    if (!(newAmount > 0)) return reply.code(400).send({ error: 'invalid_amount' });
    const newDate = b.plan_date || toYMD(t.plan_date) || toYMD(t.txn_date);
    let fx = Number(t.fx_rate) || 1;
    if (t.currency === 'USD') fx = Number(b.fx_rate) > 0 ? Number(b.fx_rate) : (await getUsdMxnRate()).rate;
    const amountMxn = r2(newAmount * fx);
    const changed = Math.abs(newAmount - Number(t.amount)) > 0.001 || newDate !== toYMD(t.txn_date);
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

  // ===== 잔액 보완 스트림 =====
  // 원칙: "현금흐름의 누적잔고 = 잔액을 볼 수 있는 계좌(viewIds)들의 실제 잔액 합".
  // 세부내역(일자 상세·계획대비실적 항목)은 기존대로 detail 권한 기준이지만,
  // 잔액 계산에는 '잔액만' 계좌·세부차단(현금·불공제) 계좌·비공개 고정비 거래까지 전부 포함해야
  // 재무/계좌 화면의 잔액 합과 현금흐름 잔고가 일치한다.
  // 이 헬퍼는 detail 스트림(loadCashTxns)에서 빠지지만 잔액에는 반영돼야 하는 거래(보완분)만 돌려준다.
  // 항목화 금지 — 메모·계정과목 없이 금액·날짜·방향만 조회하고, 합산에만 쓴다.
  async function loadHiddenBalanceTxns(perm) {
    const a = perm && perm.accountAccess;
    const args = []; const ors = [];
    let baseCond;
    if (!a || a.all) {
      // 디렉터/소시오(all): 세부차단 계좌 + (비디렉터인 소시오는) 비공개 거래가 보완분.
      baseCond = 't.deleted_at IS NULL AND t.account_id IS NOT NULL';
      const block = blockedDetailAccountIds(perm);
      // 세부차단 계좌 보완분: '실적'만 — 예정은 이제 detail 스트림에 항목으로 직접 나가므로(위 참조) 여기 담으면 이중계상.
      if (block.length) { args.push(block); ors.push(`(t.account_id = ANY($${args.length}) AND t.status='actual')`); }
      if (perm.role !== 'director') ors.push('t.is_private=true');
      if (!ors.length) return []; // 디렉터 무제한 — detail 스트림이 이미 전체라 보완분 없음
    } else {
      const view = allowedAccountIds(perm);
      if (!view || !view.length) return [];
      args.push(view);
      baseCond = `t.deleted_at IS NULL AND t.account_id = ANY($${args.length})`;
      const detail = allowedDetailAccountIds(perm);
      ors.push('t.is_private=true'); // 비공개 고정비 실적도 잔액엔 반영(잔액=현실)
      if (detail.length) { args.push(detail); ors.push(`t.account_id <> ALL($${args.length})`); }
      else { ors.length = 0; } // detail 계좌가 하나도 없으면 view 전체가 보완분
    }
    const cond = ors.length ? `${baseCond} AND (${ors.join(' OR ')})` : baseCond;
    return (await query(
      `SELECT t.direction, t.status, to_char(t.txn_date,'YYYY-MM-DD') AS txn_date,
              to_char(t.plan_date,'YYYY-MM-DD') AS plan_date, t.amount_mxn
         FROM transactions t
        WHERE ${cond}`, args)).rows;
  }

  // 모든 거래(현금흐름용) 로딩 헬퍼 — 권한 계좌로 필터(잔고·AP용).
  // AR(수금예정)은 account_id=NULL 인 plan·in 거래라 비디렉터에선 자동 제외되고, 별도(전사)로 계산한다.
  async function loadCashTxns(perm) {
    const allow = allowedDetailAccountIds(perm);   // null = 전체(디렉터). "잔액만" 계좌 제외.
    const args = [];
    let cond = 't.deleted_at IS NULL';
    if (allow !== null) {
      if (allow.length === 0) return [];
      // 계좌미지정(NULL) 거래 = 회사 공통 예정(마케팅 계획·계좌미지정 수동 예정) — 계좌 권한과 무관하게 포함.
      // (아래 세부차단 필터의 'NULL 유지' 의도와 대칭. 기존엔 NULL 예외가 빠져 비디렉터 현금흐름에서 마케팅 예정이 통째로 누락)
      args.push(allow); cond += ` AND (t.account_id IS NULL OR t.account_id = ANY($${args.length}))`;
    }
    // 현금·불공제 세부 차단(디렉터 포함): '과거 실집행(actual)'만 숨긴다. 예정(plan)=자금계획은 민감 이력이
    // 아니므로 항목으로 통과 — "어떤 계좌든 계획은 계획으로 반영" 원칙(2026-07-04 디렉터 확정).
    // (이중계상 방지: loadHiddenBalanceTxns가 정확히 대칭으로 '실적만' 보완)
    const block = blockedDetailAccountIds(perm);
    if (block.length) { args.push(block); cond += ` AND (t.account_id IS NULL OR t.account_id <> ALL($${args.length}) OR t.status='plan')`; }
    // 비공개 고정비 거래(예정·실적): 디렉터 외 현금흐름·계획대비실적에서 제외
    cond += privTxnCond(perm);
    return (await query(
      `SELECT t.id, t.direction, t.status, to_char(t.txn_date,'YYYY-MM-DD') AS txn_date, t.amount, t.currency, t.fx_rate, t.amount_mxn,
              t.plan_amount, to_char(t.plan_date,'YYYY-MM-DD') AS plan_date, t.category_code, cat.name AS category_name,
              t.recurring_rule_id, t.sales_invoice_id, t.account_id, a.name AS account_name, t.memo, t.approved, t.report_excluded,
              (t.plan_amount * (CASE WHEN t.currency='USD' THEN t.fx_rate ELSE 1 END)) AS plan_amount_mxn
         FROM transactions t
         LEFT JOIN categories cat ON cat.code=t.category_code
         LEFT JOIN accounts a ON a.id=t.account_id
        WHERE ${cond}`, args)).rows;
  }
  async function openingBalanceMxn(perm) {
    const usd = (await getUsdMxnRate()).rate;
    // 잔액 열람(viewIds) 기준 — '잔액만' 계좌·세부차단(현금·불공제) 계좌도 기초잔고에 포함.
    // (현금흐름 잔고 = 잔액 열람 가능 계좌들의 실제 잔액 합. 세부내역만 detail 기준으로 숨긴다.)
    const allow = allowedAccountIds(perm);
    const args = [];
    let cond = 'deleted_at IS NULL';
    if (allow !== null) {
      if (allow.length === 0) return 0;
      args.push(allow); cond += ` AND id = ANY($${args.length})`;
    }
    const accs = (await query(`SELECT currency, open_balance FROM accounts WHERE ${cond}`, args)).rows;
    return accs.reduce((s, a) => s + Number(a.open_balance) * (a.currency === 'USD' ? usd : 1), 0);
  }

  // 현금흐름 집계: 기간별 유입/유출/순액/누적잔고
  // query: granularity=month|week|day, includePlan=0|1  (day = 현금잔액 워터폴용)
  app.get('/api/cashflow', { preHandler: [authGuard, requirePage('transactions')] }, async (req) => {
    const granularity = (req.query.granularity === 'week' || req.query.granularity === 'day') ? req.query.granularity : 'month';
    const includePlan = req.query.includePlan === '1' || req.query.includePlan === 'true';
    const txns = await loadCashTxns(req.ctx.perm);
    const opening = await openingBalanceMxn(req.ctx.perm);
    const hidden = await loadHiddenBalanceTxns(req.ctx.perm); // 잔액 보완분(항목 미노출, 누적잔고에만 합산)
    const mappedTx = txns.map((t) => ({
      direction: t.direction, status: t.status, amount_mxn: Number(t.amount_mxn) || 0,
      txn_date: String(t.txn_date).slice(0, 10), plan_date: t.plan_date ? String(t.plan_date).slice(0, 10) : null,
    }));
    for (const t of hidden) {
      if (t.status !== 'actual') {
        const eff = String(t.plan_date || t.txn_date).slice(0, 10);
        if (eff < todayStrCF) t.plan_date = todayStrCF; // 이월 규칙(보완분 예정)
      }
    }
    const mappedHidden = hidden.map((t) => ({
      direction: t.direction, status: t.status, amount_mxn: Number(t.amount_mxn) || 0,
      txn_date: String(t.txn_date).slice(0, 10), plan_date: t.plan_date ? String(t.plan_date).slice(0, 10) : null,
    }));
    // 이월 규칙: 예정(plan)의 유효일이 오늘보다 과거면 '오늘'로 귀속(집계·세부표 공통) — 데이터 불변, 계산만 이동
    const todayStrCF = new Date().toISOString().slice(0, 10);
    for (const t of mappedTx) {
      if (t.status !== 'plan') continue;
      const eff = String(t.plan_date || t.txn_date).slice(0, 10);
      if (eff < todayStrCF) t.plan_date = todayStrCF;
    }
    const rows = aggregateCashflow(mappedTx, { granularity, includePlan, openingBalance: opening });
    // breakdown=1: 기간별 계정과목 유입/유출 합 (현금잔액 워터폴의 툴팁·세부 표용)
    // aggregateCashflow와 동일 규칙: 실적=거래일, 예정=계획일(includePlan일 때만 포함). 보완분(hidden) 제외 — 항목화 금지 원칙.
    let breakdown = null;
    if (req.query.breakdown === '1') {
      breakdown = {};
      for (const t of txns) {
        if (!includePlan && t.status !== 'actual') continue;
        let date = t.status === 'actual' ? String(t.txn_date).slice(0, 10) : String(t.plan_date || t.txn_date).slice(0, 10);
        if (t.status !== 'actual' && date < todayStrCF) date = todayStrCF; // 이월 규칙 동일 적용
        const key = bucketKey(date, granularity);
        const name = t.category_name || t.category_code || '(계정없음)';
        const arr = (breakdown[key] = breakdown[key] || {});
        const cell = (arr[name] = arr[name] || { name, in: 0, out: 0, plan_in: 0, plan_out: 0 });
        const amt = Number(t.amount_mxn) || 0;
        const f = t.status === 'actual' ? (t.direction === 'in' ? 'in' : 'out') : (t.direction === 'in' ? 'plan_in' : 'plan_out');
        cell[f] = r2(cell[f] + amt);
      }
      for (const k of Object.keys(breakdown)) {
        breakdown[k] = Object.values(breakdown[k])
          .map((c) => ({ ...c, net: r2(c.in + c.plan_in - c.out - c.plan_out) }))
          .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
      }
    }
    // 실적 기준 누적잔고: 토글과 무관하게 실제 거래만 누적(= 실제 현금잔고). 표시 구간별로 정렬해 산출.
    // 잔액 보완분(hidden)도 포함해 재무/계좌 잔액 합과 일치시킨다.
    const actualNetByPeriod = new Map();
    for (const t of [...mappedTx, ...mappedHidden]) {
      if (t.status !== 'actual') continue;
      const key = bucketKey(t.txn_date, granularity);
      actualNetByPeriod.set(key, (actualNetByPeriod.get(key) || 0) + (t.direction === 'in' ? 1 : -1) * t.amount_mxn);
    }
    // 계획 포함 누적(cumulative) 보정: aggregateCashflow는 보이는 거래만 누적하므로,
    // 보완분의 순액을 기간 순서대로 더해 실제 잔고 궤적으로 맞춘다.
    const hiddenNetByPeriod = new Map();
    for (const t of mappedHidden) {
      if (!includePlan && t.status !== 'actual') continue;
      const date = t.status === 'actual' ? t.txn_date : (t.plan_date || t.txn_date);
      const key = bucketKey(date, granularity);
      hiddenNetByPeriod.set(key, (hiddenNetByPeriod.get(key) || 0) + (t.direction === 'in' ? 1 : -1) * t.amount_mxn);
    }
    const allKeys = [...new Set([...rows.map((r) => r.period), ...actualNetByPeriod.keys(), ...hiddenNetByPeriod.keys()])].sort();
    let runA = opening; let runH = 0;
    const cumActualByPeriod = {}; const cumHiddenByPeriod = {};
    for (const k of allKeys) {
      runA += (actualNetByPeriod.get(k) || 0); cumActualByPeriod[k] = r2(runA);
      runH += (hiddenNetByPeriod.get(k) || 0); cumHiddenByPeriod[k] = runH;
    }
    for (const r of rows) {
      r.cumulative_actual = cumActualByPeriod[r.period];
      r.cumulative = r2(r.cumulative + (cumHiddenByPeriod[r.period] || 0));
    }
    return { granularity, includePlan, opening_balance: r2(opening), rows, ...(breakdown ? { breakdown } : {}) };
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
              si.total_mxn AS total,
              COALESCE(SUM(spa.amount),0) AS collected,
              (si.total_mxn - COALESCE(SUM(spa.amount),0)) AS outstanding
         FROM sales_invoices si
         JOIN customers c ON c.id=si.customer_id
         LEFT JOIN sales_payment_allocations spa ON spa.invoice_id=si.id
        WHERE si.status='posted' AND si.deleted_at IS NULL
          AND (to_char(si.due_date,'YYYY-MM')=$1 OR ($1=$2 AND si.due_date < CURRENT_DATE))
        GROUP BY si.id, c.name`, [month, new Date().toISOString().slice(0, 7)])).rows
      .map((r) => ({ ...r, outstanding: Number(r.outstanding), total: Number(r.total), collected: Number(r.collected) }));
    // AP(지급예정): 권한 계좌의 예정(plan)·지출(out) 거래(plan_date 기준).
    const planOut = mapped.filter((t) => t.status === 'plan' && t.direction === 'out');
    // 수동 예정 수입(인보이스 미연결): AR 쪽에 합류시켜 달력·예상잔고에 반영 (인보이스 AR과 이중계상 없음)
    const planIn = mapped.filter((t) => t.status === 'plan' && t.direction === 'in' && !t.sales_invoice_id);
    // 실적화된(지급완료) 예정지출: 계획이 있었고 실제로 전환된 지출 — AP 자리에 회색+배지로 표시(잔고엔 실적으로만 반영, sum 미포함).
    const realizedOut = mapped.filter((t) => t.status === 'actual' && t.direction === 'out' && t.plan_amount_mxn != null);
    const { ar: arByDay, ap: apByDay, carry } = calendarArApByDay(invRows, planOut, month, realizedOut, planIn, today);
    // 일자별 집계 + 누적잔고(기초잔고부터 그 달 시작 직전까지 누적 후 일자별)
    const opening = await openingBalanceMxn(req.ctx.perm);
    // 잔액 보완분(항목 미노출): '잔액만'·세부차단 계좌 거래 + 비공개 고정비 거래 — 잔고 계산에만 합산.
    const hidden = (await loadHiddenBalanceTxns(req.ctx.perm)).map((t) => ({
      direction: t.direction, status: t.status, amount_mxn: Number(t.amount_mxn) || 0,
      txn_date: String(t.txn_date).slice(0, 10), plan_date: t.plan_date ? String(t.plan_date).slice(0, 10) : null,
    }));
    // 그 달 1일 직전까지의 모든 실적 순액 합 = 기초 + 과거 실적 (보완분 포함)
    const monthStart = month + '-01';
    let runBefore = opening;
    for (const t of [...mapped, ...hidden]) {
      if (t.status !== 'actual') continue;
      if (t.txn_date < monthStart) runBefore += (t.direction === 'in' ? 1 : -1) * t.amount_mxn;
    }
    // 예상 월초(2026-07-08): '미래 달' 조회 시 예상잔고는 전월 '예상' 말잔고에서 출발해야 달이 이어진다.
    // = runBefore(실적) + monthStart 이전 만기 미수 인보이스 잔액 + monthStart 이전 미실현 예정 순액(수동AR·AP·보완분).
    // 이번 달 조회는 종전 그대로(달 안 carry가 처리) / 과거 달 조회도 그대로(이력 보존). 연 경계 로직 없음 — 12월→1월 자동 연속.
    let runBeforeProj = runBefore;
    if (monthStart > today) {
      const prevAr = Number((await query(
        `SELECT COALESCE(SUM(si.total_mxn - COALESCE(p.paid,0)),0) AS a
           FROM sales_invoices si
           LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) p
                  ON p.invoice_id = si.id
          WHERE si.status='posted' AND si.deleted_at IS NULL
            AND si.due_date < $1
            AND (si.total_mxn - COALESCE(p.paid,0)) > 0`, [monthStart])).rows[0]?.a) || 0;
      runBeforeProj = r2(runBefore + prevAr + planNetBefore(planIn, planOut, hidden, monthStart));
    }
    // 보완분의 일자별 순액: 실적(잔고용) / 예정(예상잔고용, apByDay에 없으므로 이중계상 없음)
    const hiddenActualByDay = {}; const hiddenPlanByDay = {};
    for (const t of hidden) {
      const sign = t.direction === 'in' ? 1 : -1;
      if (t.status === 'actual') {
        if (String(t.txn_date).slice(0, 7) === month) hiddenActualByDay[t.txn_date] = (hiddenActualByDay[t.txn_date] || 0) + sign * t.amount_mxn;
      } else {
        let pd = t.plan_date || t.txn_date;
        // 이월 규칙: 오늘이 속한 달 조회 시, 과거 미실현 보완분(예정)도 오늘로 귀속(예상잔고 정확성)
        if (String(today).slice(0, 7) === month && pd < today) pd = today;
        if (String(pd).slice(0, 7) === month) hiddenPlanByDay[pd] = (hiddenPlanByDay[pd] || 0) + sign * t.amount_mxn;
      }
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
    // 누적잔고 2종:
    //  balance      = 실적만 누적 (오늘 기준 실제 실행분만) — '실제' 모드
    //  balance_proj = 실적 + 그날 AR(수금예정) - AP(지급예정) 누적 (예상잔고) — '예정' 모드
    // 둘 다 그 달 시작 직전 실적잔고(runBefore)에서 출발.
    // 이월 규칙(2026-07-05): 오늘보다 과거인 미실현 AR/AP(과거 달 포함)는 원래 날짜가 아니라 '오늘' 발생으로
    // 취급해 carry 버킷에 합산 — 날짜 데이터는 불변, 예상잔고·표시만 이동. 과거 달 조회 시엔 원래 자리.
    // 잔액 보완분(hidden)은 두 잔고 모두에 합산 — 항목(items/ap_items)에는 나타나지 않는다.
    let cumActual = runBefore;
    let cumProj = runBeforeProj;
    const days = Object.keys(byDay).sort().map((ds) => {
      const c = byDay[ds];
      const actualNet = c.items.filter((x) => x.status === 'actual').reduce((s, x) => s + (x.direction === 'in' ? 1 : -1) * x.amount_mxn, 0)
        + (hiddenActualByDay[ds] || 0);
      cumActual += actualNet;
      const arc = arByDay[ds] || { sum: 0, items: [] };
      const apc = apByDay[ds] || { sum: 0, items: [] };
      cumProj += actualNet + arc.sum - apc.sum + (hiddenPlanByDay[ds] || 0)
        + (carry && ds === carry.date ? carry.net : 0);
      return { date: ds, in: r2(c.in), out: r2(c.out), net: r2(c.in - c.out), cumulative: r2(cumActual), items: c.items,
        ar: r2(arc.sum), ap: r2(apc.sum), ar_items: arc.items, ap_items: apc.items,
        balance: r2(cumActual), balance_proj: r2(cumProj) };
    });
    // ===== 계좌별 일자 잔고 부족 경보 (2026-07-09, option A) =====
    // 예상 잔고 = 그 계좌 개설잔액 + 그 계좌 실적 순액 + 그 계좌 수동 예정수입 − 그 계좌 예정지출(AP).
    //   인보이스 AR(수금예정)은 계좌 귀속이 없으므로 제외 → "약속된 지출만으로 언제 바닥나는가"의 선제 경보.
    // 대상 계좌: 세부내역 열람 가능 계좌(loadCashTxns와 동일 스코프 → 잔고가 표시 항목과 일치). USD는 MXN 환산.
    // 판정: 잔고 ≤ 0 → 'neg'(빨강) / 0 < 잔고 ≤ ACCT_ALERT_LOW → 'low'(파랑). 위험 우선(0은 neg).
    // days[]에 acct_alerts(예상 기준)·acct_alerts_real(실적 기준) 둘 다 부착 → 프런트가 [실적/예상] 토글 따라 사용.
    const ACCT_ALERT_LOW = 10000;
    {
      const detailAllow = allowedDetailAccountIds(req.ctx.perm);   // null = 전체(디렉터)
      const blockSet = new Set((blockedDetailAccountIds(req.ctx.perm) || []).map(Number));
      let acctRows = [];
      if (!(detailAllow !== null && detailAllow.length === 0)) {
        const aargs = []; let acond = 'deleted_at IS NULL';
        if (detailAllow !== null) { aargs.push(detailAllow); acond += ` AND id = ANY($${aargs.length})`; }
        acctRows = (await query(`SELECT id, name, currency, open_balance FROM accounts WHERE ${acond}`, aargs)).rows
          .filter((a) => !blockSet.has(Number(a.id)));
      }
      const usdRate = (await getUsdMxnRate()).rate;
      const acctMeta = new Map(); // id -> { name, openMxn }
      for (const a of acctRows) acctMeta.set(Number(a.id), { name: a.name, openMxn: Number(a.open_balance) * (a.currency === 'USD' ? usdRate : 1) });

      // 계좌별 '월초 직전' 실적 순액(= 실적 기준 시작잔고)
      const actualBefore = new Map();
      for (const [id, m] of acctMeta) actualBefore.set(id, m.openMxn);
      for (const t of mapped) {
        if (t.status !== 'actual' || t.account_id == null) continue;
        const id = Number(t.account_id); if (!acctMeta.has(id)) continue;
        if (t.txn_date < monthStart) actualBefore.set(id, actualBefore.get(id) + (t.direction === 'in' ? 1 : -1) * t.amount_mxn);
      }
      // 예상 기준 시작잔고: 미래 달 조회 시 월초 이전 '미실현 예정'(AP·수동수입, AR 제외)도 반영 → 달 연속.
      const projBefore = new Map(actualBefore);
      if (monthStart > today) {
        for (const t of planOut) { if (t.account_id == null) continue; const id = Number(t.account_id); if (!acctMeta.has(id)) continue; const d = String(t.plan_date || t.txn_date).slice(0, 10); if (d < monthStart) projBefore.set(id, projBefore.get(id) - t.amount_mxn); }
        for (const t of planIn)  { if (t.account_id == null) continue; const id = Number(t.account_id); if (!acctMeta.has(id)) continue; const d = String(t.plan_date || t.txn_date).slice(0, 10); if (d < monthStart) projBefore.set(id, projBefore.get(id) + t.amount_mxn); }
      }
      // 계좌별 '그 달' 일자 순액: 실적(양 모드 공통)·예정(예상 모드만, 이월 규칙 동일)
      const aActualDay = {}; const aPlanDay = {};
      const bump = (bag, day, id, v) => { (bag[day] || (bag[day] = new Map())).set(id, ((bag[day].get(id)) || 0) + v); };
      for (const t of mapped) {
        if (t.status !== 'actual' || t.account_id == null) continue;
        const id = Number(t.account_id); if (!acctMeta.has(id)) continue;
        if (String(t.txn_date).slice(0, 7) !== month) continue;
        bump(aActualDay, t.txn_date, id, (t.direction === 'in' ? 1 : -1) * t.amount_mxn);
      }
      const carryDay = (String(today).slice(0, 7) === month) ? today : null; // 오늘 달이면 과거 미실현 예정은 오늘로 이월(예상 정확도)
      for (const t of planOut) {
        if (t.account_id == null) continue; const id = Number(t.account_id); if (!acctMeta.has(id)) continue;
        let d = String(t.plan_date || t.txn_date).slice(0, 10); if (carryDay && d < today) d = carryDay;
        if (String(d).slice(0, 7) !== month) continue;
        bump(aPlanDay, d, id, -t.amount_mxn);
      }
      for (const t of planIn) {
        if (t.account_id == null) continue; const id = Number(t.account_id); if (!acctMeta.has(id)) continue;
        let d = String(t.plan_date || t.txn_date).slice(0, 10); if (carryDay && d < today) d = carryDay;
        if (String(d).slice(0, 7) !== month) continue;
        bump(aPlanDay, d, id, t.amount_mxn);
      }
      // 일자별 누적 → 경보(정렬: 잔고 낮은 순)
      const runReal = new Map(actualBefore);
      const runProj = new Map(projBefore);
      const alertsOf = (runMap) => {
        const out = [];
        for (const [id, bal] of runMap) {
          const b = r2(bal); const meta = acctMeta.get(id); if (!meta) continue;
          if (b <= 0) out.push({ account_id: id, name: meta.name, balance: b, level: 'neg' });
          else if (b <= ACCT_ALERT_LOW) out.push({ account_id: id, name: meta.name, balance: b, level: 'low' });
        }
        return out.sort((a, b) => a.balance - b.balance);
      };
      for (const dobj of days) {
        const ds = dobj.date;
        const av = aActualDay[ds]; if (av) for (const [id, v] of av) { runReal.set(id, (runReal.get(id) || 0) + v); runProj.set(id, (runProj.get(id) || 0) + v); }
        const pv = aPlanDay[ds]; if (pv) for (const [id, v] of pv) { runProj.set(id, (runProj.get(id) || 0) + v); }
        dobj.acct_alerts = alertsOf(runProj);
        dobj.acct_alerts_real = alertsOf(runReal);
      }
    }
    const breakdown = monthBreakdown(mapped, month, today);
    return { month, today, opening_before_month: r2(runBefore), opening_before_month_proj: r2(runBeforeProj), days, carry: carry || null, acct_alert_low_threshold: ACCT_ALERT_LOW, ...breakdown };
  });

  // ===== 월 자금 리포트 (디렉터 전용) =====
  // 잔액(기초·기말)은 실제 장부(제외 무관, 보완분 포함). 분석치(요약 증감·계획대비·MoM·Top)는
  // report_excluded=true 인 실적 지출을 제외한다. 지출 중심(수입은 요약 총액만).
  app.get('/api/monthly-report', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
    const ymAdd = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
    const prevMonth = ymAdd(month, -1);
    const moms = [];                                 // 오래된 → 최신 6개월
    for (let i = 5; i >= 0; i--) moms.push(ymAdd(month, -i));
    const momStart = moms[0] + '-01';
    const monthStart = month + '-01';
    const nextStart = ymAdd(month, 1) + '-01';

    // 디렉터 전용 전체 스트림: loadCashTxns의 세부차단(현금·불공제) 제외 정책은 공유 화면(현금흐름)용.
    // 월 리포트는 디렉터만 보므로 전 계좌·비공개 포함 전체를 직접 조회 — 지출 요약에 현금 계좌가 빠지던 문제 수정.
    // (전체 스트림이므로 잔액 보완분(hidden) 별도 합산 불필요 — 이중계상 방지 차원에서 제거)
    const txns = (await query(
      `SELECT t.id, t.direction, t.status, to_char(t.txn_date,'YYYY-MM-DD') AS txn_date,
              to_char(t.plan_date,'YYYY-MM-DD') AS plan_date, t.amount, t.currency, t.fx_rate, t.amount_mxn,
              (t.plan_amount * (CASE WHEN t.currency='USD' THEN t.fx_rate ELSE 1 END)) AS plan_amount_mxn,
              t.category_code, cat.name AS category_name, t.memo, t.recurring_rule_id, t.report_excluded
         FROM transactions t
         LEFT JOIN categories cat ON cat.code=t.category_code
        WHERE t.deleted_at IS NULL`)).rows;
    const hidden = [];                               // 전체 스트림 사용 — 보완분 없음
    const opening0 = await openingBalanceMxn(req.ctx.perm);

    const mxn = (t) => Number(t.amount_mxn) || 0;
    const pMxn = (t) => t.plan_amount_mxn != null ? Number(t.plan_amount_mxn) : 0;
    const ymOf = (d) => String(d).slice(0, 7);
    const planDate = (t) => String(t.plan_date || t.txn_date).slice(0, 10);
    const catKey = (t) => t.category_code || '';
    const catName = (t) => t.category_name || t.category_code || '(계정없음)';
    const excl = (t) => t.report_excluded === true;

    // --- 잔액(실제): 기초 = 개설잔액 + 월시작 전 실적 순액(보완분 포함), 기말 = 기초 + 당월 실적 순액 ---
    let opening = opening0, monthNetReal = 0;
    for (const t of txns) {
      if (t.status !== 'actual') continue;
      const d = String(t.txn_date).slice(0, 10);
      const sgn = t.direction === 'in' ? 1 : -1;
      if (d < monthStart) opening += sgn * mxn(t);
      else if (d < nextStart) monthNetReal += sgn * mxn(t);
    }
    for (const t of hidden) {
      if (t.status !== 'actual') continue;
      const d = String(t.txn_date).slice(0, 10);
      const sgn = t.direction === 'in' ? 1 : -1;
      const v = Number(t.amount_mxn) || 0;
      if (d < monthStart) opening += sgn * v;
      else if (d < nextStart) monthNetReal += sgn * v;
    }
    const closing = opening + monthNetReal;

    // --- 분석용 월 수입/지출(제외 반영) — 당월·전월 ---
    const sums = { in_month: 0, out_month: 0, in_prev: 0, out_prev: 0 };
    for (const t of txns) {
      if (t.status !== 'actual' || excl(t)) continue;
      const ym = ymOf(t.txn_date);
      if (ym === month) { t.direction === 'in' ? sums.in_month += mxn(t) : sums.out_month += mxn(t); }
      else if (ym === prevMonth) { t.direction === 'in' ? sums.in_prev += mxn(t) : sums.out_prev += mxn(t); }
    }

    // --- ② 계획 vs 실적 (지출, 계정과목별) + 전월비 ---
    const pvaMap = new Map();
    const pvaRow = (t) => {
      const k = catKey(t);
      if (!pvaMap.has(k)) pvaMap.set(k, { code: k, name: catName(t), plan: 0, actual: 0, prev_actual: 0, recurring: false, items: [] });
      return pvaMap.get(k);
    };
    for (const t of txns) {
      if (t.direction !== 'out') continue;
      const pd = planDate(t), pym = pd.slice(0, 7);
      const isPlanSide = pMxn(t) > 0 || t.status === 'plan';
      if (isPlanSide && pym === month) {                     // 당월 계획(예정 + 실적화된 계획분)
        const row = pvaRow(t);
        row.plan = r2(row.plan + (pMxn(t) || (t.status === 'plan' ? mxn(t) : 0)));
        if (t.recurring_rule_id) row.recurring = true;
      }
      if (t.status === 'actual') {
        const ym = ymOf(t.txn_date);
        if (ym === month && !excl(t)) { const row = pvaRow(t); row.actual = r2(row.actual + mxn(t)); }
        if (ym === prevMonth && !excl(t)) { const row = pvaRow(t); row.prev_actual = r2(row.prev_actual + mxn(t)); }
      }
      // 드릴다운 항목: 당월에 걸린 지출(계획일 또는 실행일 기준) 전부 — 제외건 포함(복원용)
      const touch = (t.status === 'actual' ? ymOf(t.txn_date) : pym) === month;
      if (touch) {
        pvaRow(t).items.push({ id: t.id, date: t.status === 'actual' ? String(t.txn_date).slice(0, 10) : pd,
          status: t.status, memo: t.memo || '', amount_mxn: r2(t.status === 'actual' ? mxn(t) : (pMxn(t) || mxn(t))),
          recurring: !!t.recurring_rule_id, excluded: excl(t) });
      }
    }
    const memoOf = (m) => String(m || '').replace(/^\[고정비\]\s*/, '').replace(/^\[마케팅\]\s*/, '').trim();
    const pvaRows = [...pvaMap.values()].filter((r) => r.plan !== 0 || r.actual !== 0 || r.prev_actual !== 0 || r.items.length)
      .map((r) => ({ ...r,
        memos: [...new Set(r.items.map((x) => memoOf(x.memo)).filter(Boolean))], // 행 요약용 — 자르지 않음
        plan: r2(r.plan), actual: r2(r.actual), diff: r2(r.actual - r.plan),
        rate: r.plan > 0 ? Math.round((r.actual / r.plan) * 100) : null,
        mom_pct: r.prev_actual > 0 ? Math.round(((r.actual - r.prev_actual) / r.prev_actual) * 1000) / 10 : (r.actual > 0 ? null : 0),
        items: r.items.sort((a, b) => b.amount_mxn - a.amount_mxn) }))
      .sort((a, b) => b.plan - a.plan || b.actual - a.actual);
    const pvaTotal = { plan: r2(pvaRows.reduce((s, r) => s + r.plan, 0)), actual: r2(pvaRows.reduce((s, r) => s + r.actual, 0)) };
    pvaTotal.diff = r2(pvaTotal.actual - pvaTotal.plan);
    pvaTotal.rate = pvaTotal.plan > 0 ? Math.round((pvaTotal.actual / pvaTotal.plan) * 100) : null;

    // --- ③ 월간 지출 비교(최근 6개월, 실적·제외 반영) + 셀 드릴다운 ---
    const momMap = new Map(); const momItems = {};
    for (const t of txns) {
      if (t.direction !== 'out' || t.status !== 'actual') continue;
      const d = String(t.txn_date).slice(0, 10);
      if (d < momStart || d >= nextStart) continue;
      const ym = ymOf(d), k = catKey(t);
      if (!momMap.has(k)) momMap.set(k, { code: k, name: catName(t), vals: Object.fromEntries(moms.map((m) => [m, 0])), total: 0 });
      const row = momMap.get(k);
      if (!excl(t)) { row.vals[ym] = r2(row.vals[ym] + mxn(t)); row.total = r2(row.total + mxn(t)); }
      const ck = ym + '|' + k;
      (momItems[ck] = momItems[ck] || []).push({ id: t.id, date: d, memo: t.memo || '', amount_mxn: r2(mxn(t)), recurring: !!t.recurring_rule_id, excluded: excl(t) });
    }
    const momRows = [...momMap.values()].filter((r) => r.total > 0 || Object.values(r.vals).some((v) => v > 0))
      .sort((a, b) => b.total - a.total);
    Object.values(momItems).forEach((arr) => arr.sort((a, b) => b.amount_mxn - a.amount_mxn));
    const momTotals = moms.map((m) => r2(momRows.reduce((s, r) => s + (r.vals[m] || 0), 0)));

    // --- ④ Top 지출(당월 실적, 제외 반영) ---
    const top = txns.filter((t) => t.direction === 'out' && t.status === 'actual' && !excl(t) && ymOf(t.txn_date) === month)
      .sort((a, b) => mxn(b) - mxn(a)).slice(0, 10)
      .map((t) => ({ id: t.id, date: String(t.txn_date).slice(0, 10), memo: t.memo || '', category: catName(t), amount_mxn: r2(mxn(t)) }));

    // --- ⑤ 미집행 계획(당월 계획일의 예정 지출) ---
    const unexecuted = txns.filter((t) => t.direction === 'out' && t.status === 'plan' && planDate(t).slice(0, 7) === month)
      .sort((a, b) => (planDate(a) < planDate(b) ? -1 : 1))
      .map((t) => ({ id: t.id, plan_date: planDate(t), memo: t.memo || '', category: catName(t), amount_mxn: r2(pMxn(t) || mxn(t)), recurring: !!t.recurring_rule_id }));

    // --- 분석 제외 목록(당월에 걸린 제외건 — 복원용) ---
    const excluded_items = txns.filter((t) => excl(t) && t.status === 'actual' && ymOf(t.txn_date) === month)
      .map((t) => ({ id: t.id, date: String(t.txn_date).slice(0, 10), memo: t.memo || '', category: catName(t),
        direction: t.direction, amount_mxn: r2(mxn(t)) }));

    return { month, prev_month: prevMonth, months: moms,
      summary: { opening: r2(opening), closing: r2(closing),
        in_month: r2(sums.in_month), out_month: r2(sums.out_month), in_prev: r2(sums.in_prev), out_prev: r2(sums.out_prev) },
      pva: { rows: pvaRows, total: pvaTotal }, mom: { rows: momRows, totals: momTotals, items: momItems },
      top, unexecuted, excluded_items };
  });

  // 분석 제외 토글(디렉터) — 리포트 전용 플래그, 장부·잔액 무관
  app.patch('/api/transactions/:id/report-exclude', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const excluded = req.body && req.body.excluded === true;
    const r = await query(`UPDATE transactions SET report_excluded=$1, updated_by=$2 WHERE id=$3 AND deleted_at IS NULL RETURNING id`,
      [excluded, req.ctx.perm.userId, id]);
    if (!r.rows[0]) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `transaction:${id}`, detail: { report_excluded: excluded } });
    return { ok: true };
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
        WHERE t.status='plan' AND t.deleted_at IS NULL${privTxnCond(req.ctx.perm)}
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
