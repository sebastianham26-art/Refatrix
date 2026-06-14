import { query, withTx } from '../db.js';
import { authGuard } from '../middleware/authGuard.js';
import { pageAllowed } from '../permissions.js';
import { logEvent } from '../audit.js';

function d10(d) { if (!d) return null; if (d instanceof Date) return d.toISOString().slice(0, 10); return String(d).slice(0, 10); }
function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = new Date(a), db = new Date(b);
  return Math.round((db - da) / 86400000);
}

// sales/products/marketing 중 하나라도 허용되면 통과 (디렉터 전체 허용)
function requireDevAccess() {
  return async (req, reply) => {
    const { perm, isRegistered } = req.ctx;
    const ok = ['sales', 'products', 'marketing'].some((k) => pageAllowed(perm, k, isRegistered));
    if (!ok) return reply.code(403).send({ error: 'forbidden' });
  };
}

function withDurations(r) {
  return {
    ...r,
    requested_at: d10(r.requested_at), reviewed_at: d10(r.reviewed_at),
    factory_requested_at: d10(r.factory_requested_at), developed_at: d10(r.developed_at),
    review_list_price: r.review_list_price != null ? Number(r.review_list_price) : null,
    requested_qty: r.requested_qty != null ? Number(r.requested_qty) : null,
    dur_review: daysBetween(r.requested_at, r.reviewed_at),          // 접수→검토
    dur_factory: daysBetween(r.reviewed_at, r.factory_requested_at), // 검토→공장요청
    dur_develop: daysBetween(r.factory_requested_at, r.developed_at),// 공장요청→완료
    dur_total: daysBetween(r.requested_at, r.developed_at),          // 전체
  };
}

// 제품·마케팅 담당(역할 marketing/ops 또는 products/marketing 페이지 권한) 알림 todo 생성
export async function notifyProductMarketing(c, { title, detail, createdBy }) {
  const rows = (await c.query(
    `SELECT DISTINCT u.id FROM users u
       LEFT JOIN user_page_access pa ON pa.user_id=u.id AND pa.page_key IN ('products','marketing') AND COALESCE(pa.device_req,'') <> 'blocked'
      WHERE u.deleted_at IS NULL AND (u.role IN ('marketing','ops') OR pa.user_id IS NOT NULL)`)).rows;
  let recipients = rows.map((r) => Number(r.id));
  if (!recipients.length) {
    // 폴백: 담당자가 없으면 디렉터에게
    const dirs = (await c.query(`SELECT id FROM users WHERE role='director' AND deleted_at IS NULL`)).rows;
    recipients = dirs.map((r) => Number(r.id));
  }
  const ids = [];
  for (const uid of recipients) {
    const t = (await c.query(
      `INSERT INTO todos (title, detail, assignee_id, due_date, kind, created_by) VALUES ($1,$2,$3,CURRENT_DATE,'dev_review',$4) RETURNING id`,
      [title, detail, uid, createdBy])).rows[0];
    ids.push(t.id);
  }
  return ids;
}

export default async function devRequestRoutes(app) {
  // 생성(오더 접수) — 영업. 생성 즉시 제품·마케팅 담당에게 검토 알림(todo)
  app.post('/api/dev-requests', { preHandler: [authGuard, requireDevAccess()] }, async (req) => {
    const b = req.body || {};
    const result = await withTx(async (c) => {
      const r = (await c.query(
        `INSERT INTO product_dev_requests (input_code, customer_id, requested_qty, order_memo, requested_at, source_quote_id, status, created_by)
         VALUES ($1,$2,$3,$4,COALESCE($5,CURRENT_DATE),$6,'received',$7) RETURNING id`,
        [b.input_code || null, b.customer_id || null, b.requested_qty || null, b.order_memo || null, b.requested_at || null, b.source_quote_id || null, req.ctx.perm.userId])).rows[0];
      let custName = '';
      if (b.customer_id) custName = (await c.query(`SELECT name FROM customers WHERE id=$1`, [b.customer_id])).rows[0]?.name || '';
      const todos = await notifyProductMarketing(c, {
        title: `개발검토 요청: ${b.input_code || ''}`,
        detail: `${custName ? custName + ' 고객 ' : ''}경쟁사 코드 ${b.input_code || '-'} 개발 검토가 필요합니다. (요청수량 ${b.requested_qty || '-'})`,
        createdBy: req.ctx.perm.userId,
      });
      return { id: r.id, todos: todos.length };
    });
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `dev_request:${result.id}`, detail: { notified: result.todos } });
    return result;
  });

  // 목록 + 소요기간
  app.get('/api/dev-requests', { preHandler: [authGuard, requireDevAccess()] }, async (req) => {
    const conds = ['d.deleted_at IS NULL']; const args = [];
    if (['received', 'reviewed', 'factory_requested', 'developed', 'cancelled'].includes(String(req.query.status))) { args.push(req.query.status); conds.push(`d.status=$${args.length}`); }
    if (req.query.open === '1') conds.push(`d.status IN ('received','reviewed','factory_requested')`);
    const rows = (await query(
      `SELECT d.*, c.name AS customer_name, c.owner_id AS customer_owner_id, p.code AS result_code_live
         FROM product_dev_requests d
         LEFT JOIN customers c ON c.id=d.customer_id
         LEFT JOIN products p ON p.id=d.result_product_id
        WHERE ${conds.join(' AND ')}
        ORDER BY d.requested_at DESC, d.id DESC`, args)).rows;
    return { items: rows.map((r) => ({ ...withDurations(r), customer_name: r.customer_name })) };
  });

  app.get('/api/dev-requests/:id', { preHandler: [authGuard, requireDevAccess()] }, async (req, reply) => {
    const r = (await query(
      `SELECT d.*, c.name AS customer_name FROM product_dev_requests d LEFT JOIN customers c ON c.id=d.customer_id WHERE d.id=$1 AND d.deleted_at IS NULL`, [Number(req.params.id)])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return withDurations(r);
  });

  // ② 검토완료 — 제품·마케팅 담당: syd_code/app/list_price/memo 입력 필수
  app.put('/api/dev-requests/:id/review', { preHandler: [authGuard, requireDevAccess()] }, async (req, reply) => {
    const id = Number(req.params.id); const b = req.body || {};
    if (!b.review_syd_code || b.review_list_price == null || b.review_list_price === '') {
      return reply.code(400).send({ error: 'review_fields_required', note: 'SYD 코드와 List price는 필수입니다.' });
    }
    const r = (await query(`SELECT status FROM product_dev_requests WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await query(
      `UPDATE product_dev_requests SET review_syd_code=$1, review_app=$2, review_list_price=$3, review_memo=$4,
              review_maker=$5, review_model=$6, review_year=$7,
              reviewed_at=COALESCE($8, reviewed_at, CURRENT_DATE), status=CASE WHEN status='received' THEN 'reviewed' ELSE status END,
              updated_by=$9, updated_at=now() WHERE id=$10`,
      [b.review_syd_code, b.review_app || null, Number(b.review_list_price), b.review_memo || null,
       b.review_maker || null, b.review_model || null, b.review_year || null,
       b.reviewed_at || null, req.ctx.perm.userId, id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `dev_request:${id}`, detail: { step: 'review' } });
    return { ok: true };
  });

  // ③ 공장 개발요청일
  app.put('/api/dev-requests/:id/factory', { preHandler: [authGuard, requireDevAccess()] }, async (req, reply) => {
    const id = Number(req.params.id); const b = req.body || {};
    const r = (await query(`SELECT status FROM product_dev_requests WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await query(
      `UPDATE product_dev_requests SET factory_requested_at=COALESCE($1, factory_requested_at, CURRENT_DATE),
              status=CASE WHEN status IN ('received','reviewed') THEN 'factory_requested' ELSE status END,
              updated_by=$2, updated_at=now() WHERE id=$3`,
      [b.factory_requested_at || null, req.ctx.perm.userId, id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `dev_request:${id}`, detail: { step: 'factory' } });
    return { ok: true };
  });

  // ④ 개발완료 — CTR 코드 입력 → SYD 자동매핑 + 담당영업·디렉터 할 일 생성
  app.put('/api/dev-requests/:id/develop', { preHandler: [authGuard, requireDevAccess()] }, async (req, reply) => {
    const id = Number(req.params.id); const b = req.body || {};
    const ctr = String(b.result_ctr_code || '').trim();
    if (!ctr) return reply.code(400).send({ error: 'ctr_code_required' });
    const d = (await query(
      `SELECT d.*, c.owner_id AS owner_id FROM product_dev_requests d LEFT JOIN customers c ON c.id=d.customer_id WHERE d.id=$1 AND d.deleted_at IS NULL`, [id])).rows[0];
    if (!d) return reply.code(404).send({ error: 'not_found' });
    if (d.status === 'developed') return reply.code(409).send({ error: 'already_developed' });
    // CTR 제품이 제품마스터에 있어야 매핑 가능
    const prod = (await query(`SELECT id, code FROM products WHERE code=$1 AND deleted_at IS NULL`, [ctr])).rows[0];
    if (!prod) return reply.code(404).send({ error: 'product_not_found', note: `제품마스터에 ${ctr} 가 없습니다. 먼저 제품을 등록하세요.` });

    const todos = [];
    await withTx(async (c) => {
      await c.query(
        `UPDATE product_dev_requests SET developed_at=COALESCE($1, developed_at, CURRENT_DATE), result_product_id=$2, result_ctr_code=$3, status='developed', updated_by=$4, updated_at=now() WHERE id=$5`,
        [b.developed_at || null, prod.id, prod.code, req.ctx.perm.userId, id]);
      // SYD(경쟁사) 코드 → 신규 CTR 제품 자동 매핑
      const syd = (d.review_syd_code || d.input_code || '').trim();
      if (syd) {
        await c.query(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,$2) ON CONFLICT (product_id, syd_code) DO NOTHING`, [prod.id, syd]);
      }
      // 알림 대상: 고객 담당영업(owner_id) + 디렉터들
      const recipients = new Set();
      if (d.owner_id) recipients.add(Number(d.owner_id));
      const dirs = (await c.query(`SELECT id FROM users WHERE role='director' AND deleted_at IS NULL`)).rows;
      for (const u of dirs) recipients.add(Number(u.id));
      const custName = d.customer_id ? ((await c.query(`SELECT name FROM customers WHERE id=$1`, [d.customer_id])).rows[0]?.name || '') : '';
      const title = `개발완료: ${syd || d.input_code || ''} → ${prod.code}`;
      const detail = `${custName ? custName + ' 고객에게 ' : ''}개발완료를 안내하세요. (경쟁사 ${syd || d.input_code || '-'} → 신규 ${prod.code})`;
      for (const uid of recipients) {
        const t = (await c.query(
          `INSERT INTO todos (title, detail, assignee_id, due_date, kind, created_by) VALUES ($1,$2,$3,CURRENT_DATE,'dev_complete',$4) RETURNING id`,
          [title, detail, uid, req.ctx.perm.userId])).rows[0];
        todos.push(t.id);
      }
    });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `dev_request:${id}`, detail: { step: 'developed', ctr: prod.code, todos: todos.length } });
    return { ok: true, mapped_to: prod.code, todos_created: todos.length };
  });

  app.put('/api/dev-requests/:id/cancel', { preHandler: [authGuard, requireDevAccess()] }, async (req, reply) => {
    const id = Number(req.params.id);
    await query(`UPDATE product_dev_requests SET status='cancelled', updated_by=$1, updated_at=now() WHERE id=$2 AND deleted_at IS NULL`, [req.ctx.perm.userId, id]);
    return { ok: true };
  });

  // KPI: 당월(또는 ym) 신규 개발 완료 건수 + 평균 소요일
  app.get('/api/dev-requests/kpi', { preHandler: [authGuard, requireDevAccess()] }, async (req) => {
    const ym = /^\d{4}-\d{2}$/.test(String(req.query.ym || '')) ? req.query.ym : new Date().toISOString().slice(0, 7);
    const r = (await query(
      `SELECT COUNT(*)::int AS completed,
              AVG(developed_at - requested_at) AS avg_days,
              COUNT(*) FILTER (WHERE status IN ('received','reviewed','factory_requested'))::int AS open_all
         FROM product_dev_requests
        WHERE deleted_at IS NULL AND to_char(developed_at,'YYYY-MM')=$1`, [ym])).rows[0];
    const openBreak = (await query(
      `SELECT
         COUNT(*) FILTER (WHERE status='received')::int AS received,
         COUNT(*) FILTER (WHERE status IN ('reviewed','factory_requested'))::int AS in_progress,
         COUNT(*) FILTER (WHERE status IN ('received','reviewed','factory_requested'))::int AS open_all
       FROM product_dev_requests WHERE deleted_at IS NULL`)).rows[0];
    return {
      ym, completed: r.completed || 0, avg_days: r.avg_days != null ? Math.round(Number(r.avg_days)) : null,
      open: openBreak.open_all || 0,
      open_received: openBreak.received || 0,     // 미접수(미검토)
      open_in_progress: openBreak.in_progress || 0, // 진행 중(검토~공장요청)
    };
  });

  // 당월 개발된 아이템 목록(위젯 클릭)
  app.get('/api/dev-requests/monthly', { preHandler: [authGuard, requireDevAccess()] }, async (req) => {
    const ym = /^\d{4}-\d{2}$/.test(String(req.query.ym || '')) ? req.query.ym : new Date().toISOString().slice(0, 7);
    const rows = (await query(
      `SELECT d.*, c.name AS customer_name FROM product_dev_requests d LEFT JOIN customers c ON c.id=d.customer_id
        WHERE d.deleted_at IS NULL AND to_char(d.developed_at,'YYYY-MM')=$1
        ORDER BY d.developed_at DESC, d.id DESC`, [ym])).rows;
    return { ym, items: rows.map((r) => ({ ...withDurations(r), customer_name: r.customer_name })) };
  });

  // ===== 수주 이후 흐름 종합 지표 (견적요청 → 즉시매출 / 부족·발주 / 개발) =====
  // GET /api/dashboard/order-funnel?months=2026-06,2026-05  (여러 월 합산)
  app.get('/api/dashboard/order-funnel', { preHandler: [authGuard, requireDevAccess()] }, async (req) => {
    const raw = String(req.query.months || '').split(',').map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}$/.test(s));
    const months = raw.length ? raw : [new Date().toISOString().slice(0, 7)];

    // ① 견적 라인 분류 (요청 시점 stock_flag 기준) — SKU=라인수, qty=수량
    const ql = (await query(
      `SELECT ql.stock_flag AS flag, COUNT(*)::int AS sku, COALESCE(SUM(ql.qty),0)::numeric AS qty
         FROM quote_lines ql JOIN quotes q ON q.id=ql.quote_id
        WHERE q.deleted_at IS NULL AND to_char(q.quote_date,'YYYY-MM') = ANY($1)
        GROUP BY ql.stock_flag`, [months])).rows;
    const flag = { ok: { sku: 0, qty: 0 }, low_stock: { sku: 0, qty: 0 }, not_found: { sku: 0, qty: 0 } };
    let reqSku = 0, reqQty = 0;
    for (const r of ql) { const f = flag[r.flag] || (flag[r.flag] = { sku: 0, qty: 0 }); f.sku = r.sku; f.qty = Number(r.qty); reqSku += r.sku; reqQty += Number(r.qty); }

    // ② 부족분 → 발주됨(resolved) / 미발주(open) (occurred_at 월)
    const sh = (await query(
      `SELECT COUNT(DISTINCT product_id) FILTER (WHERE status='resolved')::int AS ord_sku,
              COALESCE(SUM(shortage_qty) FILTER (WHERE status='resolved'),0)::numeric AS ord_qty,
              COUNT(DISTINCT product_id) FILTER (WHERE status='open')::int AS open_sku,
              COALESCE(SUM(shortage_qty) FILTER (WHERE status='open'),0)::numeric AS open_qty
         FROM stock_shortages WHERE to_char(occurred_at,'YYYY-MM') = ANY($1)`, [months])).rows[0];

    // ③ 개발요청 → 개발완료 (requested_at 월)
    const dv = (await query(
      `SELECT COUNT(*)::int AS total_sku, COALESCE(SUM(requested_qty),0)::numeric AS total_qty,
              COUNT(*) FILTER (WHERE status='developed')::int AS done_sku,
              COALESCE(SUM(requested_qty) FILTER (WHERE status='developed'),0)::numeric AS done_qty
         FROM product_dev_requests
        WHERE deleted_at IS NULL AND status<>'cancelled' AND to_char(requested_at,'YYYY-MM') = ANY($1)`, [months])).rows[0];

    return {
      months,
      requested: { sku: reqSku, qty: reqQty },
      immediate: { sku: flag.ok.sku, qty: flag.ok.qty },
      shortage: { sku: flag.low_stock.sku, qty: flag.low_stock.qty },
      ordered: { sku: sh.ord_sku || 0, qty: Number(sh.ord_qty) || 0 },
      shortage_open: { sku: sh.open_sku || 0, qty: Number(sh.open_qty) || 0 },
      dev_needed: { sku: flag.not_found.sku, qty: flag.not_found.qty },
      dev_total: { sku: dv.total_sku || 0, qty: Number(dv.total_qty) || 0 },
      dev_done: { sku: dv.done_sku || 0, qty: Number(dv.done_qty) || 0 },
    };
  });

  // ===== 월별 추이 (즉시매출 비중 KPI 추적용) =====
  // GET /api/dashboard/order-funnel/trend?by=month&n=12  또는  ?by=order&n=20
  app.get('/api/dashboard/order-funnel/trend', { preHandler: [authGuard, requireDevAccess()] }, async (req) => {
    const by = req.query.by === 'order' ? 'order' : 'month';
    const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

    if (by === 'order') {
      // 오더(견적)별: 최근 n건, 과거→현재
      const n = Math.min(Math.max(Number(req.query.n) || 20, 1), 100);
      const qs = (await query(
        `SELECT q.id, q.quote_no, to_char(q.quote_date,'YYYY-MM-DD') AS qdate,
                c.name AS customer_name,
                COUNT(ql.*)::int AS req_sku, COALESCE(SUM(ql.qty),0)::numeric AS req_qty,
                COUNT(*) FILTER (WHERE ql.stock_flag='ok')::int AS ok_sku,
                COALESCE(SUM(ql.qty) FILTER (WHERE ql.stock_flag='ok'),0)::numeric AS ok_qty,
                COUNT(*) FILTER (WHERE ql.stock_flag='low_stock')::int AS short_sku,
                COALESCE(SUM(ql.qty) FILTER (WHERE ql.stock_flag='low_stock'),0)::numeric AS short_qty,
                COUNT(*) FILTER (WHERE ql.stock_flag='not_found')::int AS dev_sku,
                COALESCE(SUM(ql.qty) FILTER (WHERE ql.stock_flag='not_found'),0)::numeric AS dev_qty
           FROM quotes q
           JOIN quote_lines ql ON ql.quote_id=q.id
           LEFT JOIN customers c ON c.id=q.customer_id
          WHERE q.deleted_at IS NULL
          GROUP BY q.id, q.quote_no, q.quote_date, c.name
          ORDER BY q.quote_date DESC, q.id DESC
          LIMIT $1`, [n])).rows;
      const rows = qs.reverse().map((o) => ({
        label: o.quote_no || ('#' + o.id), quote_no: o.quote_no, qdate: o.qdate, customer_name: o.customer_name,
        req_sku: o.req_sku, req_qty: Number(o.req_qty),
        ok_sku: o.ok_sku, ok_qty: Number(o.ok_qty), short_sku: o.short_sku, short_qty: Number(o.short_qty), dev_sku: o.dev_sku, dev_qty: Number(o.dev_qty),
        ok_sku_pct: pct(o.ok_sku, o.req_sku), ok_qty_pct: pct(Number(o.ok_qty), Number(o.req_qty)),
        short_sku_pct: pct(o.short_sku, o.req_sku), short_qty_pct: pct(Number(o.short_qty), Number(o.req_qty)),
        dev_sku_pct: pct(o.dev_sku, o.req_sku), dev_qty_pct: pct(Number(o.dev_qty), Number(o.req_qty)),
      }));
      return { by, rows };
    }

    // 월별: 최근 n개월 (과거→현재)
    const n = Math.min(Math.max(Number(req.query.n) || 12, 1), 36);
    const months = [];
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1).toISOString().slice(0, 7));
    const ql = (await query(
      `SELECT to_char(q.quote_date,'YYYY-MM') AS ym, ql.stock_flag AS flag,
              COUNT(*)::int AS sku, COALESCE(SUM(ql.qty),0)::numeric AS qty
         FROM quote_lines ql JOIN quotes q ON q.id=ql.quote_id
        WHERE q.deleted_at IS NULL AND to_char(q.quote_date,'YYYY-MM') = ANY($1)
        GROUP BY 1,2`, [months])).rows;
    const map = {};
    for (const m of months) map[m] = { ym: m, label: m, req_sku: 0, req_qty: 0, ok_sku: 0, ok_qty: 0, short_sku: 0, short_qty: 0, dev_sku: 0, dev_qty: 0 };
    for (const r of ql) {
      const o = map[r.ym]; if (!o) continue;
      const sku = r.sku, qty = Number(r.qty);
      o.req_sku += sku; o.req_qty += qty;
      if (r.flag === 'ok') { o.ok_sku += sku; o.ok_qty += qty; }
      else if (r.flag === 'low_stock') { o.short_sku += sku; o.short_qty += qty; }
      else if (r.flag === 'not_found') { o.dev_sku += sku; o.dev_qty += qty; }
    }
    const rows = months.map((m) => {
      const o = map[m];
      return {
        ...o,
        ok_sku_pct: pct(o.ok_sku, o.req_sku), ok_qty_pct: pct(o.ok_qty, o.req_qty),
        short_sku_pct: pct(o.short_sku, o.req_sku), short_qty_pct: pct(o.short_qty, o.req_qty),
        dev_sku_pct: pct(o.dev_sku, o.req_sku), dev_qty_pct: pct(o.dev_qty, o.req_qty),
      };
    });
    return { by, months, rows };
  });
}
