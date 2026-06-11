import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { resolvePlanDate, lineAmount, budgetLimit, groupByCategory, periodSummary } from '../budget.js';

function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

export default async function budgetRoutes(app) {
  // ===== 예산 기간 =====
  // 목록(마케팅·디렉터 모두 조회). 페이지 권한 'budget'.
  app.get('/api/budget/periods', { preHandler: [authGuard, requirePage('budget')] }, async () => {
    const rows = (await query(
      `SELECT p.*, to_char(p.created_at,'YYYY-MM-DD') AS created_date,
              (SELECT COUNT(*) FROM marketing_budget_items i WHERE i.period_id=p.id AND i.deleted_at IS NULL) AS item_count
         FROM marketing_budget_periods p WHERE p.deleted_at IS NULL
        ORDER BY p.start_month DESC, p.id DESC`)).rows;
    return { items: rows.map((p) => ({
      id: p.id, title: p.title, start_month: p.start_month, end_month: p.end_month,
      sales_target: Number(p.sales_target), pct: Number(p.pct), limit_amount: Number(p.limit_amount),
      status: p.status, memo: p.memo, item_count: Number(p.item_count), created_date: p.created_date,
    })) };
  });

  // 개설(디렉터). sales_target + pct → limit 자동(조정 가능)
  app.post('/api/budget/periods', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const b = req.body || {};
    if (!b.title || !/^\d{4}-\d{2}$/.test(b.start_month || '') || !/^\d{4}-\d{2}$/.test(b.end_month || '')) {
      return reply.code(400).send({ error: 'missing_fields' });
    }
    if (b.end_month < b.start_month) return reply.code(400).send({ error: 'bad_range' });
    const salesTarget = r2(b.sales_target || 0);
    const pct = b.pct != null ? Number(b.pct) : 5;
    const limit = b.limit_amount != null ? r2(b.limit_amount) : budgetLimit(salesTarget, pct);
    const row = (await query(
      `INSERT INTO marketing_budget_periods (title, start_month, end_month, sales_target, pct, limit_amount, memo, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [b.title, b.start_month, b.end_month, salesTarget, pct, limit, b.memo || null, req.ctx.perm.userId])).rows[0];
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `budget_period:${row.id}` });
    return { ok: true, id: row.id, limit_amount: limit };
  });

  // 기간 수정(디렉터): 매출목표·비율·한도·상태·제목
  app.patch('/api/budget/periods/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const p = (await query(`SELECT * FROM marketing_budget_periods WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {};
    const salesTarget = b.sales_target != null ? r2(b.sales_target) : Number(p.sales_target);
    const pct = b.pct != null ? Number(b.pct) : Number(p.pct);
    const limit = b.limit_amount != null ? r2(b.limit_amount) : budgetLimit(salesTarget, pct);
    const title = b.title || p.title;
    const status = ['open', 'closed'].includes(b.status) ? b.status : p.status;
    await query(
      `UPDATE marketing_budget_periods SET title=$1, sales_target=$2, pct=$3, limit_amount=$4, status=$5, memo=$6, updated_by=$7 WHERE id=$8`,
      [title, salesTarget, pct, limit, status, b.memo != null ? b.memo : p.memo, req.ctx.perm.userId, id]);
    return { ok: true, limit_amount: limit };
  });

  // 기간 상세: 항목(카테고리별 묶음) + 한도 집계
  app.get('/api/budget/periods/:id', { preHandler: [authGuard, requirePage('budget')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const p = (await query(`SELECT * FROM marketing_budget_periods WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const items = (await query(
      `SELECT i.*, to_char(i.plan_date,'YYYY-MM-DD') AS plan_date_str,
              t.status AS txn_status
         FROM marketing_budget_items i
         LEFT JOIN transactions t ON t.id=i.txn_id
        WHERE i.period_id=$1 AND i.deleted_at IS NULL
        ORDER BY i.category NULLS LAST, i.plan_month, i.id`, [id])).rows;
    const mapped = items.map((i) => ({
      id: i.id, category: i.category, name: i.name, plan_month: i.plan_month, date_unknown: i.date_unknown,
      plan_date: i.plan_date_str, qty: Number(i.qty), unit_price: Number(i.unit_price), amount: Number(i.amount),
      category_code: i.category_code, memo: i.memo, status: i.status, txn_id: i.txn_id,
    }));
    const groups = groupByCategory(mapped.map((i) => ({ category: i.category, amount: i.amount, status: i.status })));
    // 묶음에 실제 항목 배열을 붙임
    const byCat = {};
    for (const g of groups) byCat[g.category] = { ...g, items: [] };
    for (const i of mapped) (byCat[i.category || '(미분류)'] || (byCat[i.category || '(미분류)'] = { category: i.category || '(미분류)', items: [], total: 0, approved: 0, pending: 0, rejected: 0 })).items.push(i);
    const summary = periodSummary({ limit: Number(p.limit_amount), items: mapped });
    // 기존 카테고리 목록(드롭다운용)
    const cats = [...new Set(items.map((i) => i.category).filter(Boolean))].sort();
    return {
      period: { id: p.id, title: p.title, start_month: p.start_month, end_month: p.end_month,
        sales_target: Number(p.sales_target), pct: Number(p.pct), limit_amount: Number(p.limit_amount), status: p.status, memo: p.memo },
      summary, groups: Object.values(byCat), categories: cats, items: mapped,
    };
  });

  // ===== 예산 항목 =====
  // 작성(마케팅 또는 디렉터). 금액=수량*단가. 예측불허면 그 달 마지막 워킹데이.
  app.post('/api/budget/periods/:id/items', { preHandler: [authGuard, requirePage('budget')] }, async (req, reply) => {
    const periodId = Number(req.params.id);
    const p = (await query(`SELECT * FROM marketing_budget_periods WHERE id=$1 AND deleted_at IS NULL`, [periodId])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (p.status !== 'open') return reply.code(409).send({ error: 'period_closed' });
    const b = req.body || {};
    if (!b.name || !/^\d{4}-\d{2}$/.test(b.plan_month || '')) return reply.code(400).send({ error: 'missing_fields' });
    if (b.plan_month < p.start_month || b.plan_month > p.end_month) return reply.code(400).send({ error: 'month_out_of_range' });
    const qty = Number(b.qty) || 0, unitPrice = Number(b.unit_price) || 0;
    const amount = lineAmount(qty, unitPrice);
    if (!(amount > 0)) return reply.code(400).send({ error: 'invalid_amount' });
    const dateUnknown = !!b.date_unknown;
    const planDate = resolvePlanDate({ month: b.plan_month, dateUnknown, planDate: b.plan_date });
    const row = (await query(
      `INSERT INTO marketing_budget_items (period_id, category, name, plan_month, date_unknown, plan_date, qty, unit_price, amount, memo, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [periodId, b.category || null, b.name, b.plan_month, dateUnknown, planDate, qty, unitPrice, amount, b.memo || null, req.ctx.perm.userId])).rows[0];
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `budget_item:${row.id}` });
    return { ok: true, id: row.id, amount, plan_date: planDate };
  });

  // 수정(작성자/디렉터, 승인 전만)
  app.patch('/api/budget/items/:id', { preHandler: [authGuard, requirePage('budget')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const it = (await query(`SELECT * FROM marketing_budget_items WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!it) return reply.code(404).send({ error: 'not_found' });
    if (it.status === 'approved') return reply.code(409).send({ error: 'already_approved' });
    const b = req.body || {};
    const qty = b.qty != null ? Number(b.qty) : Number(it.qty);
    const unitPrice = b.unit_price != null ? Number(b.unit_price) : Number(it.unit_price);
    const amount = lineAmount(qty, unitPrice);
    const planMonth = /^\d{4}-\d{2}$/.test(b.plan_month || '') ? b.plan_month : it.plan_month;
    const dateUnknown = b.date_unknown != null ? !!b.date_unknown : it.date_unknown;
    const planDate = resolvePlanDate({ month: planMonth, dateUnknown, planDate: b.plan_date });
    await query(
      `UPDATE marketing_budget_items SET category=$1, name=$2, plan_month=$3, date_unknown=$4, plan_date=$5,
         qty=$6, unit_price=$7, amount=$8, memo=$9, status='pending', updated_by=$10 WHERE id=$11`,
      [b.category != null ? b.category : it.category, b.name || it.name, planMonth, dateUnknown, planDate,
       qty, unitPrice, amount, b.memo != null ? b.memo : it.memo, req.ctx.perm.userId, id]);
    return { ok: true, amount, plan_date: planDate };
  });

  // 삭제(작성자/디렉터, 승인 전만)
  app.delete('/api/budget/items/:id', { preHandler: [authGuard, requirePage('budget')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const it = (await query(`SELECT * FROM marketing_budget_items WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!it) return reply.code(404).send({ error: 'not_found' });
    if (it.status === 'approved') return reply.code(409).send({ error: 'already_approved' });
    await query(`UPDATE marketing_budget_items SET deleted_at=now(), updated_by=$1 WHERE id=$2`, [req.ctx.perm.userId, id]);
    return { ok: true };
  });

  // 승인(디렉터): 승인 시 마케팅(6070) 계획 거래 생성 + 연결
  app.post('/api/budget/items/:id/approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    let result;
    try {
      result = await withTx(async (c) => {
        const it = (await c.query(`SELECT *, to_char(plan_date,'YYYY-MM-DD') AS plan_date_str FROM marketing_budget_items WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0];
        if (!it) return { error: 'not_found' };
        if (it.status === 'approved') return { error: 'already_approved' };
        const planDate = it.plan_date_str || resolvePlanDate({ month: it.plan_month, dateUnknown: it.date_unknown });
        const amount = Number(it.amount);
        const memo = `[마케팅] ${it.category ? it.category + ' · ' : ''}${it.name}`;
        const txn = (await c.query(
          `INSERT INTO transactions
             (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, memo, created_by, plan_amount, plan_date)
           VALUES (NULL,$1,'out',$2,'MXN',1,$2,'6070','plan','general',true,$3,$4,$3,$2,$1) RETURNING id`,
          [planDate, amount, req.ctx.perm.userId, memo])).rows[0];
        await c.query(
          `UPDATE marketing_budget_items SET status='approved', txn_id=$1, decided_by=$2, decided_at=now(), updated_by=$2 WHERE id=$3`,
          [txn.id, req.ctx.perm.userId, id]);
        return { ok: true, txn_id: txn.id };
      });
    } catch (e) {
      req.log?.error?.(e);
      return reply.code(500).send({ error: 'insert_failed', detail: String(e.message || e) });
    }
    if (result.error) return reply.code(result.error === 'not_found' ? 404 : 409).send(result);
    await logEvent({ userId: req.ctx.perm.userId, action: 'approve', target: `budget_item:${id}`, detail: { txn_id: result.txn_id } });
    return result;
  });

  // 전체 승인(디렉터): 기간 내 pending 항목 모두 승인
  app.post('/api/budget/periods/:id/approve-all', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const periodId = Number(req.params.id);
    const pend = (await query(`SELECT id FROM marketing_budget_items WHERE period_id=$1 AND status='pending' AND deleted_at IS NULL`, [periodId])).rows;
    let count = 0;
    for (const row of pend) {
      const r = await withTx(async (c) => {
        const it = (await c.query(`SELECT *, to_char(plan_date,'YYYY-MM-DD') AS plan_date_str FROM marketing_budget_items WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [row.id])).rows[0];
        if (!it || it.status !== 'pending') return { skip: true };
        const planDate = it.plan_date_str || resolvePlanDate({ month: it.plan_month, dateUnknown: it.date_unknown });
        const amount = Number(it.amount);
        const memo = `[마케팅] ${it.category ? it.category + ' · ' : ''}${it.name}`;
        const txn = (await c.query(
          `INSERT INTO transactions
             (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, memo, created_by, plan_amount, plan_date)
           VALUES (NULL,$1,'out',$2,'MXN',1,$2,'6070','plan','general',true,$3,$4,$3,$2,$1) RETURNING id`,
          [planDate, amount, req.ctx.perm.userId, memo])).rows[0];
        await c.query(`UPDATE marketing_budget_items SET status='approved', txn_id=$1, decided_by=$2, decided_at=now(), updated_by=$2 WHERE id=$3`,
          [txn.id, req.ctx.perm.userId, row.id]);
        return { ok: true };
      });
      if (r.ok) count++;
    }
    await logEvent({ userId: req.ctx.perm.userId, action: 'approve', target: `budget_period:${periodId}`, detail: { approved: count } });
    return { ok: true, approved: count };
  });

  // 반려(디렉터)
  app.post('/api/budget/items/:id/reject', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const it = (await query(`SELECT * FROM marketing_budget_items WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!it) return reply.code(404).send({ error: 'not_found' });
    if (it.status === 'approved' && it.txn_id) {
      // 승인 취소: 생성된 계획 거래 삭제(아직 실적 전환 안 된 경우만)
      const txn = (await query(`SELECT status FROM transactions WHERE id=$1 AND deleted_at IS NULL`, [it.txn_id])).rows[0];
      if (txn && txn.status === 'actual') return reply.code(409).send({ error: 'already_executed' });
      if (txn) await query(`UPDATE transactions SET deleted_at=now(), updated_by=$1 WHERE id=$2`, [req.ctx.perm.userId, it.txn_id]);
    }
    await query(`UPDATE marketing_budget_items SET status='rejected', txn_id=NULL, decided_by=$1, decided_at=now(), updated_by=$1 WHERE id=$2`,
      [req.ctx.perm.userId, id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'reject', target: `budget_item:${id}` });
    return { ok: true };
  });

  // 카테고리 자동완성(쌓인 카테고리 드롭다운)
  app.get('/api/budget/categories', { preHandler: [authGuard, requirePage('budget')] }, async () => {
    const rows = (await query(
      `SELECT DISTINCT category FROM marketing_budget_items WHERE category IS NOT NULL AND deleted_at IS NULL ORDER BY category`)).rows;
    return { items: rows.map((r) => r.category) };
  });
}
