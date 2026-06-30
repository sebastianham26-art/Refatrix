import { query, withTx } from '../db.js';
import { authGuard } from '../middleware/authGuard.js';
import { pageAllowed, allowPastMonthSalesEdit } from '../permissions.js';
import { visibleTeamIds, teamArr, canViewTeam } from '../teams.js';
import { logEvent } from '../audit.js';
import { mxTodayStr } from '../workingHours.js';
import { computeQuoteStage } from '../quoteStage.js';
import { sweepStageAlerts } from '../stageAlerts.js';

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
    const ok = ['devrequest', 'quote', 'sales', 'products', 'marketing'].some((k) => pageAllowed(perm, k, isRegistered));
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
    // 월 다중 필터(YYYY-MM,YYYY-MM …) — 접수월(requested_at) 기준
    const months = String(req.query.months || '').split(',').map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}$/.test(s));
    if (months.length) { args.push(months); conds.push(`to_char(d.requested_at,'YYYY-MM') = ANY($${args.length})`); }
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
        WHERE q.deleted_at IS NULL AND q.status <> 'delete_pending' AND to_char(q.quote_date,'YYYY-MM') = ANY($1)
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
      const oargs = [n]; const otc = teamFilterClause(req.ctx.perm, oargs);
      const qs = (await query(
        `SELECT q.id, q.quote_no, to_char(q.quote_date,'YYYY-MM-DD') AS qdate,
                c.name AS customer_name,
                COUNT(ql.*)::int AS req_sku, COALESCE(SUM(ql.qty),0)::numeric AS req_qty,
                COUNT(*) FILTER (WHERE ql.stock_flag='ok')::int AS ok_sku,
                COALESCE(SUM(ql.qty) FILTER (WHERE ql.stock_flag='ok'),0)::numeric AS ok_qty,
                COUNT(*) FILTER (WHERE ql.stock_flag='low_stock')::int AS short_sku,
                COALESCE(SUM(ql.qty) FILTER (WHERE ql.stock_flag='low_stock'),0)::numeric AS short_qty,
                COUNT(*) FILTER (WHERE ql.stock_flag='not_found')::int AS dev_sku,
                COALESCE(SUM(ql.qty) FILTER (WHERE ql.stock_flag='not_found'),0)::numeric AS dev_qty,
                COALESCE(SUM(ql.line_total) FILTER (WHERE ql.stock_flag='ok'),0)::numeric AS ok_amt,
                COALESCE(SUM(ql.line_total) FILTER (WHERE ql.stock_flag='low_stock'),0)::numeric AS short_amt,
                q.status AS qstatus, q.created_at AS created_at,
                q.packing_printed_at AS packing_printed_at, q.packing_due_at AS packing_due_at,
                q.invoice_id AS invoice_id,
                q.packed_at AS packed_at,
                si.created_at AS converted_at, si.sat_no AS sat_no, si.sat_entered_at AS sat_entered_at,
                to_char(si.due_date,'YYYY-MM-DD') AS due_date, si.total_mxn AS total_mxn,
                (SELECT COALESCE(SUM(spa.amount),0) FROM sales_payment_allocations spa WHERE spa.invoice_id = si.id) AS paid_sum,
                c.owner_id AS owner_id, ou.name AS owner_name
           FROM quotes q
           JOIN quote_lines ql ON ql.quote_id=q.id
           LEFT JOIN customers c ON c.id=q.customer_id
           LEFT JOIN users ou ON ou.id=c.owner_id
           LEFT JOIN quote_packing_docs pd ON pd.quote_id=q.id
           LEFT JOIN sales_invoices si ON si.id=q.invoice_id
          WHERE q.deleted_at IS NULL AND q.status <> 'delete_pending'${otc}
          GROUP BY q.id, q.quote_no, q.quote_date, c.name, q.status, q.created_at,
                   q.packing_printed_at, q.packing_due_at, q.invoice_id,
                   q.packed_at, si.id, si.created_at, si.sat_no, si.sat_entered_at, si.due_date, si.total_mxn,
                   c.owner_id, ou.name
          ORDER BY q.quote_date DESC, q.id DESC
          LIMIT $1`, oargs)).rows;
      const nowTs = new Date();
      const rows = qs.reverse().map((o) => {
        const st = computeQuoteStage({
          status: o.qstatus, created_at: o.created_at,
          packing_printed_at: o.packing_printed_at, packing_due_at: o.packing_due_at, packed_at: o.packed_at,
          invoice_id: o.invoice_id, converted_at: o.converted_at,
          sat_no: o.sat_no, sat_entered_at: o.sat_entered_at,
          due_date: o.due_date, total_mxn: o.total_mxn, paid_sum: o.paid_sum,
        }, nowTs);
        return ({
        quote_id: Number(o.id),
        label: o.quote_no || ('#' + o.id), quote_no: o.quote_no, qdate: o.qdate, customer_name: o.customer_name,
        req_sku: o.req_sku, req_qty: Number(o.req_qty),
        ok_sku: o.ok_sku, ok_qty: Number(o.ok_qty), short_sku: o.short_sku, short_qty: Number(o.short_qty), dev_sku: o.dev_sku, dev_qty: Number(o.dev_qty),
        ok_amt: Number(o.ok_amt), short_amt: Number(o.short_amt),
        ok_sku_pct: pct(o.ok_sku, o.req_sku), ok_qty_pct: pct(Number(o.ok_qty), Number(o.req_qty)),
        short_sku_pct: pct(o.short_sku, o.req_sku), short_qty_pct: pct(Number(o.short_qty), Number(o.req_qty)),
        dev_sku_pct: pct(o.dev_sku, o.req_sku), dev_qty_pct: pct(Number(o.dev_qty), Number(o.req_qty)),
        stage_key: st.stage_key, stage_label: st.stage_label, stage_rank: st.stage_rank,
        status_key: st.status_key, deadline: st.deadline, warn: st.warn, warn_rank: st.warn_rank, warn_label: st.warn_label,
        owner_id: o.owner_id != null ? Number(o.owner_id) : null, owner_name: o.owner_name || null,
        ts_created: o.created_at ? new Date(o.created_at).toISOString() : null,
        ts_printed: o.packing_printed_at ? new Date(o.packing_printed_at).toISOString() : null,
        ts_packing_due: o.packing_due_at ? new Date(o.packing_due_at).toISOString() : null,
        ts_packed: o.packed_at ? new Date(o.packed_at).toISOString() : null,
        ts_converted: o.converted_at ? new Date(o.converted_at).toISOString() : null,
        ts_sat: o.sat_entered_at ? new Date(o.sat_entered_at).toISOString() : null,
        due_date: o.due_date || null,
        });
      });
      return { by, rows };
    }

    // 월별: 최근 n개월 (과거→현재)
    const n = Math.min(Math.max(Number(req.query.n) || 12, 1), 36);
    const months = [];
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1).toISOString().slice(0, 7));
    const margs = [months]; const mtc = teamFilterClause(req.ctx.perm, margs);
    const ql = (await query(
      `SELECT to_char(q.quote_date,'YYYY-MM') AS ym, ql.stock_flag AS flag,
              COUNT(*)::int AS sku, COALESCE(SUM(ql.qty),0)::numeric AS qty, COALESCE(SUM(ql.line_total),0)::numeric AS amt
         FROM quote_lines ql JOIN quotes q ON q.id=ql.quote_id
         LEFT JOIN customers c ON c.id=q.customer_id
        WHERE q.deleted_at IS NULL AND q.status <> 'delete_pending' AND to_char(q.quote_date,'YYYY-MM') = ANY($1)${mtc}
        GROUP BY 1,2`, margs)).rows;
    const map = {};
    for (const m of months) map[m] = { ym: m, label: m, req_sku: 0, req_qty: 0, ok_sku: 0, ok_qty: 0, short_sku: 0, short_qty: 0, dev_sku: 0, dev_qty: 0, ok_amt: 0, short_amt: 0 };
    for (const r of ql) {
      const o = map[r.ym]; if (!o) continue;
      const sku = r.sku, qty = Number(r.qty), amt = Number(r.amt);
      o.req_sku += sku; o.req_qty += qty;
      if (r.flag === 'ok') { o.ok_sku += sku; o.ok_qty += qty; o.ok_amt += amt; }
      else if (r.flag === 'low_stock') { o.short_sku += sku; o.short_qty += qty; o.short_amt += amt; }
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

  // 견적 팀 필터 절: 디렉터/영업지원=전체(''), 그 외=자기 팀 고객 견적 + 본인이 만든 불특정 견적.
  // args 배열에 파라미터를 push 하고, WHERE 에 붙일 ' AND (...)' 문자열을 반환(없으면 '').
  function teamFilterClause(perm, args) {
    const ta = teamArr(perm);
    if (!ta) return '';
    args.push(ta); const ti = args.length;
    args.push(perm.userId); const ui = args.length;
    return ` AND (c.team_id = ANY($${ti}) OR (q.customer_id IS NULL AND q.created_by = $${ui}))`;
  }

  // ===== 드릴다운: 기간(months) 파라미터 공통 =====
  function parseMonths(req) {
    const raw = String(req.query.months || '').split(',').map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}$/.test(s));
    return raw.length ? raw : [new Date().toISOString().slice(0, 7)];
  }
  const pctOf = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

  // 매출 확정 요약: 선택 월(들) 직전 동기간 월 목록
  function prevMonthWindow(monthsArr) {
    const sorted = [...new Set(monthsArr)].sort();
    const n = sorted.length || 1;
    let [yy, mm] = sorted[0].split('-').map(Number);
    const out = [];
    for (let k = 0; k < n; k++) { mm--; if (mm === 0) { mm = 12; yy--; } out.push(yy + '-' + String(mm).padStart(2, '0')); }
    return out.reverse();
  }
  // 매출 확정 요약 5개 지표 (선택 월 합계, owner/team 필터 동일 적용)
  async function salesSummaryMetrics(ms, ownerId, teamId) {
    const args = [ms]; const conds = [];
    if (ownerId) { args.push(ownerId); conds.push(`c.owner_id = $${args.length}`); }
    if (teamId) { args.push(teamId); conds.push(`c.team_id = $${args.length}`); }
    const w = `i.deleted_at IS NULL AND i.status='posted' AND to_char(i.inv_date,'YYYY-MM') = ANY($1)` + (conds.length ? ' AND ' + conds.join(' AND ') : '');
    const hdr = (await query(
      `SELECT COUNT(*)::int AS invoices, COUNT(DISTINCT i.customer_id)::int AS customers, COALESCE(SUM(i.total_mxn),0)::numeric AS amount
         FROM sales_invoices i JOIN customers c ON c.id=i.customer_id WHERE ${w}`, args)).rows[0];
    const ln = (await query(
      `SELECT COUNT(DISTINCT sl.product_id)::int AS sku, COALESCE(SUM(sl.qty),0)::numeric AS qty
         FROM sales_invoice_lines sl JOIN sales_invoices i ON i.id=sl.invoice_id JOIN customers c ON c.id=i.customer_id WHERE ${w}`, args)).rows[0];
    return { sku: ln.sku || 0, qty: Number(ln.qty) || 0, amount: Number(hdr.amount) || 0, invoices: hdr.invoices || 0, customers: hdr.customers || 0 };
  }

  // ① 견적 요청 드릴다운: 견적 목록 + 각 견적 SKU 라인
  app.get('/api/dashboard/funnel/quotes', { preHandler: [authGuard, requireDevAccess()] }, async (req) => {
    const months = parseMonths(req);
    const fargs = [months]; const ftc = teamFilterClause(req.ctx.perm, fargs);
    const qs = (await query(
      `SELECT q.id, q.quote_no, to_char(q.quote_date,'YYYY-MM-DD') AS qdate, q.invoice_id,
              c.name AS customer_name, q.guest_name, q.customer_id,
              COUNT(ql.*)::int AS req_sku, COALESCE(SUM(ql.qty),0)::numeric AS req_qty,
              COUNT(*) FILTER (WHERE ql.stock_flag='ok')::int AS ok_sku,
              COALESCE(SUM(ql.qty) FILTER (WHERE ql.stock_flag='ok'),0)::numeric AS ok_qty,
              COUNT(*) FILTER (WHERE ql.stock_flag='low_stock')::int AS short_sku,
              COALESCE(SUM(ql.qty) FILTER (WHERE ql.stock_flag='low_stock'),0)::numeric AS short_qty,
              COUNT(*) FILTER (WHERE ql.stock_flag='not_found')::int AS dev_sku,
              COALESCE(SUM(ql.qty) FILTER (WHERE ql.stock_flag='not_found'),0)::numeric AS dev_qty
         FROM quotes q JOIN quote_lines ql ON ql.quote_id=q.id
         LEFT JOIN customers c ON c.id=q.customer_id
        WHERE q.deleted_at IS NULL AND q.status <> 'delete_pending' AND to_char(q.quote_date,'YYYY-MM') = ANY($1)${ftc}
        GROUP BY q.id, q.quote_no, q.quote_date, q.invoice_id, c.name, q.guest_name, q.customer_id
        ORDER BY q.quote_date DESC, q.id DESC`, fargs)).rows;
    return {
      months,
      items: qs.map((o) => ({
        id: o.id, quote_no: o.quote_no, qdate: o.qdate, converted: o.invoice_id != null,
        customer_name: o.customer_id == null ? (o.guest_name || '불특정 고객') : o.customer_name,
        req_sku: o.req_sku, req_qty: Number(o.req_qty),
        ok_sku: o.ok_sku, ok_qty: Number(o.ok_qty), short_sku: o.short_sku, short_qty: Number(o.short_qty), dev_sku: o.dev_sku, dev_qty: Number(o.dev_qty),
        ok_qty_pct: pctOf(Number(o.ok_qty), Number(o.req_qty)), short_qty_pct: pctOf(Number(o.short_qty), Number(o.req_qty)), dev_qty_pct: pctOf(Number(o.dev_qty), Number(o.req_qty)),
      })),
    };
  });

  // 견적 1건의 SKU 라인 (2단계)
  app.get('/api/dashboard/funnel/quote-lines', { preHandler: [authGuard, requireDevAccess()] }, async (req, reply) => {
    const id = Number(req.query.quote_id);
    if (!id) return reply.code(400).send({ error: 'quote_id_required' });
    // 팀 가드: 담당팀 밖 견적 직접 조회 차단. 불특정(고객 없음) 견적은 작성자 본인만. 디렉터·영업지원(vis=null)은 통과.
    const qvis = visibleTeamIds(req.ctx.perm);
    if (qvis !== null) {
      const qo = (await query(
        `SELECT q.customer_id, q.created_by, c.team_id
           FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id WHERE q.id=$1`, [id])).rows[0];
      if (!qo) return reply.code(404).send({ error: 'not_found' });
      const ownGuest = (qo.customer_id == null && Number(qo.created_by) === Number(req.ctx.perm.userId));
      if (!ownGuest && !canViewTeam(req.ctx.perm, qo.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    }
    const lines = (await query(
      `SELECT ql.input_code, ql.ctr_code, ql.product_name, ql.qty, ql.stock_flag, ql.avail_stock, ql.line_total
         FROM quote_lines ql WHERE ql.quote_id=$1 ORDER BY ql.line_no, ql.id`, [id])).rows;
    return { items: lines.map((l) => ({ ...l, qty: Number(l.qty), avail_stock: l.avail_stock != null ? Number(l.avail_stock) : null, line_total: Number(l.line_total) })) };
  });

  // ② 즉시매출 드릴다운: 발행가능(미전환·재고충분 견적) + 이미발행(전환된 견적)
  app.get('/api/dashboard/funnel/immediate', { preHandler: [authGuard, requireDevAccess()] }, async (req) => {
    const months = parseMonths(req);
    const perm = req.ctx.perm;
    const isDirector = perm.role === 'director' || visibleTeamIds(perm) === null;
    // 권한: 디렉터/상위는 owner/team 필터 자유, 영업담당자는 본인 매출만
    let ownerId = req.query.owner_id ? Number(req.query.owner_id) : null;
    let teamId = req.query.team_id ? Number(req.query.team_id) : null;
    if (!isDirector) { ownerId = Number(perm.userId); teamId = null; }
    // 발행 가능: 미전환 + 즉시(ok) 라인이 있는 견적 (+ 견적 후 경과일) — 팀 스코프(디렉터/영업지원=전체)
    const aargs = [months];
    const aTeam = teamFilterClause(perm, aargs);
    const able = (await query(
      `SELECT q.id, q.quote_no, to_char(q.quote_date,'YYYY-MM-DD') AS qdate,
              (CURRENT_DATE - q.quote_date)::int AS age_days,
              c.name AS customer_name, q.guest_name, q.customer_id,
              COUNT(*) FILTER (WHERE ql.stock_flag='ok')::int AS ok_sku,
              COALESCE(SUM(ql.qty) FILTER (WHERE ql.stock_flag='ok'),0)::numeric AS ok_qty
         FROM quotes q JOIN quote_lines ql ON ql.quote_id=q.id LEFT JOIN customers c ON c.id=q.customer_id
        WHERE q.deleted_at IS NULL AND q.status IN ('draft','confirmed') AND to_char(q.quote_date,'YYYY-MM') = ANY($1)${aTeam}
        GROUP BY q.id, q.quote_no, q.quote_date, c.name, q.guest_name, q.customer_id
        HAVING COUNT(*) FILTER (WHERE ql.stock_flag='ok') > 0
        ORDER BY q.quote_date ASC`, aargs)).rows;   // 오래된 것 먼저(팔로업 우선)
    // 이미 발행: 전환된(인보이스 생성) 견적 — 담당자/팀 필터 적용
    const dargs = [months]; const dconds = [];
    if (ownerId) { dargs.push(ownerId); dconds.push(`c.owner_id = $${dargs.length}`); }
    if (teamId) { dargs.push(teamId); dconds.push(`c.team_id = $${dargs.length}`); }
    const done = (await query(
      `SELECT i.id AS invoice_id, q.quote_no, to_char(i.inv_date,'YYYY-MM-DD') AS inv_date, i.sat_no,
              (i.sat_no IS NULL OR i.sat_no = '' OR i.sat_no LIKE 'TMP-%') AS temp_sat,
              c.id AS customer_id, c.name AS customer_name,
              i.total_mxn, cu.name AS cust_owner_name,
              (SELECT COUNT(*)::int FROM sales_invoice_lines sl WHERE sl.invoice_id=i.id) AS inv_sku,
              (SELECT COALESCE(SUM(sl.qty),0)::numeric FROM sales_invoice_lines sl WHERE sl.invoice_id=i.id) AS inv_qty
         FROM sales_invoices i
              JOIN customers c ON c.id=i.customer_id
              LEFT JOIN quotes q ON q.invoice_id=i.id AND q.deleted_at IS NULL
              LEFT JOIN users cu ON cu.id=c.owner_id
        WHERE i.deleted_at IS NULL AND i.status='posted' AND to_char(i.inv_date,'YYYY-MM') = ANY($1)
              ${dconds.length ? 'AND ' + dconds.join(' AND ') : ''}
        ORDER BY i.inv_date DESC, i.id DESC`, dargs)).rows;
    // 디렉터용 필터 옵션(팀·담당자)
    let filterOpts = null;
    if (isDirector) {
      const teams = (await query(`SELECT id, name FROM sales_teams WHERE COALESCE(is_sales,true)=true ORDER BY sort_order, id`)).rows;
      const owners = (await query(
        `SELECT DISTINCT u.id, u.name
           FROM users u JOIN customers c ON c.owner_id=u.id
          WHERE u.deleted_at IS NULL AND c.deleted_at IS NULL
          ORDER BY u.name`)).rows;
      filterOpts = { teams: teams.map((t) => ({ id: Number(t.id), name: t.name })), owners: owners.map((o) => ({ id: Number(o.id), name: o.name })) };
    }
    // 매출 확정 요약(고정 박스용) — 선택 월 합계 + 직전 동기간 비교
    const curM = await salesSummaryMetrics(months, ownerId, teamId);
    const prevMonths = prevMonthWindow(months);
    const prevM = await salesSummaryMetrics(prevMonths, ownerId, teamId);
    const SK = ['sku', 'qty', 'amount', 'invoices', 'customers'];
    const sdelta = {}, spct = {};
    for (const k of SK) {
      sdelta[k] = Math.round((curM[k] - prevM[k]) * 100) / 100;
      spct[k] = prevM[k] > 0 ? Math.round(((curM[k] - prevM[k]) / prevM[k]) * 1000) / 10 : null;
    }
    const summary = { label: months.length === 1 ? '전월 대비' : ('직전 ' + months.length + '개월 대비'), cur: curM, prev: prevM, delta: sdelta, pct: spct, prev_months: prevMonths };
    return {
      months, can_filter: isDirector, applied: { owner_id: ownerId, team_id: teamId }, filters: filterOpts, summary,
      able: able.map((o) => ({ id: o.id, quote_no: o.quote_no, qdate: o.qdate, age_days: o.age_days, customer_name: o.customer_id == null ? (o.guest_name || '불특정 고객') : o.customer_name, ok_sku: o.ok_sku, ok_qty: Number(o.ok_qty) })),
      done: done.map((o) => ({ id: o.invoice_id, quote_no: o.quote_no || '(직접)', invoice_id: o.invoice_id, inv_date: o.inv_date, sat_no: o.sat_no || '', temp_sat: !!o.temp_sat, customer_name: o.customer_name, owner_name: o.cust_owner_name || '', total_mxn: Number(o.total_mxn), inv_sku: o.inv_sku, inv_qty: Number(o.inv_qty) })),
    };
  });

  // 인보이스 1건의 SKU 라인 (2단계)
  app.get('/api/dashboard/funnel/invoice-lines', { preHandler: [authGuard, requireDevAccess()] }, async (req, reply) => {
    const id = Number(req.query.invoice_id);
    if (!id) return reply.code(400).send({ error: 'invoice_id_required' });
    const inv = (await query(
      `SELECT s.id, s.sat_no, s.inv_date, s.subtotal_mxn, s.iva_mxn, s.total_mxn, s.status, s.credit_days,
              to_char(s.inv_date,'YYYY-MM') AS inv_ym, to_char(now(),'YYYY-MM') AS now_ym,
              to_char(s.inv_date,'YYYY-MM-DD') AS inv_date_str, to_char(s.due_date,'YYYY-MM-DD') AS due_date,
              c.code AS customer_code, c.name AS customer_name, c.rfc AS customer_rfc, c.phone AS customer_phone,
              c.team_id AS customer_team_id,
              c.owner_id AS owner_id, cu.name AS owner_name,
              c.credit_days AS base_credit_days, s.credit_days_req, s.credit_req_memo, ru.name AS credit_req_by_name
         FROM sales_invoices s JOIN customers c ON c.id=s.customer_id
              LEFT JOIN users cu ON cu.id=c.owner_id
              LEFT JOIN users ru ON ru.id=s.credit_req_by
        WHERE s.id=$1`, [id])).rows[0];
    if (!inv) return reply.code(404).send({ error: 'not_found' });
    if (!canViewTeam(req.ctx.perm, inv.customer_team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const lines = (await query(
      `SELECT p.code AS ctr_code, p.name AS product_name, p.app, sl.qty, sl.unit_price, sl.line_amount_mxn,
              (SELECT string_agg(syd_code, ' / ' ORDER BY syd_code) FROM product_syd_codes WHERE product_id=p.id) AS syd_codes
         FROM sales_invoice_lines sl JOIN products p ON p.id=sl.product_id WHERE sl.invoice_id=$1 ORDER BY sl.id`, [id])).rows;
    // 삭제/일자변경/매출액수정 버튼 노출용 플래그.
    // 반드시 실제 디렉터(role==='director')만 true — 전체 팀 조회권(sales_support 등)은 제외.
    // 백엔드 실제 동작(requireDirector)과 동일 기준으로 맞춰 버튼이 새지 않게 함.
    const isDirector = (req.ctx.perm.role === 'director');
    const canAdjust = isDirector && (allowPastMonthSalesEdit() || inv.inv_ym === inv.now_ym);
    return {
      invoice: {
        id: inv.id, sat_no: inv.sat_no, inv_date: inv.inv_date, inv_date_str: inv.inv_date_str, due_date: inv.due_date, status: inv.status,
        credit_days: inv.credit_days == null ? 0 : Number(inv.credit_days),
        base_credit_days: inv.base_credit_days == null ? 0 : Number(inv.base_credit_days),
        credit_days_req: inv.credit_days_req == null ? null : Number(inv.credit_days_req),
        credit_req_memo: inv.credit_req_memo || null,
        credit_req_by_name: inv.credit_req_by_name || null,
        customer_code: inv.customer_code, customer_name: inv.customer_name,
        customer_rfc: inv.customer_rfc || null, customer_phone: inv.customer_phone || null,
        owner_id: inv.owner_id == null ? null : Number(inv.owner_id), owner_name: inv.owner_name || null,
        subtotal_mxn: Number(inv.subtotal_mxn) || 0, iva_mxn: Number(inv.iva_mxn) || 0, total_mxn: Number(inv.total_mxn) || 0,
        can_adjust: canAdjust, is_director: isDirector, past_edit_enabled: allowPastMonthSalesEdit(),
      },
      items: lines.map((l) => ({ ...l, qty: Number(l.qty), unit_price: Number(l.unit_price), line_amount_mxn: Number(l.line_amount_mxn) })),
    };
  });

  // ③ 부족·발주 드릴다운: SKU별 부족·발주 (occurred_at 월)
  app.get('/api/dashboard/funnel/shortage', { preHandler: [authGuard, requireDevAccess()] }, async (req) => {
    const months = parseMonths(req);
    const rows = (await query(
      `SELECT sh.product_id, p.code AS ctr_code, p.name AS product_name, p.stock_qty,
              COALESCE(SUM(sh.shortage_qty) FILTER (WHERE sh.status='open'),0)::numeric AS open_qty,
              COALESCE(SUM(sh.shortage_qty) FILTER (WHERE sh.status='resolved'),0)::numeric AS ordered_qty,
              COUNT(*) FILTER (WHERE sh.status='open')::int AS open_cnt,
              COUNT(*) FILTER (WHERE sh.status='resolved')::int AS ordered_cnt
         FROM stock_shortages sh JOIN products p ON p.id=sh.product_id
        WHERE sh.status<>'cancelled' AND to_char(sh.occurred_at,'YYYY-MM') = ANY($1)
        GROUP BY sh.product_id, p.code, p.name, p.stock_qty
        ORDER BY open_qty DESC, ordered_qty DESC`, [months])).rows;
    return { months, items: rows.map((r) => ({ product_id: r.product_id, ctr_code: r.ctr_code, product_name: r.product_name, stock_qty: r.stock_qty != null ? Number(r.stock_qty) : null, open_qty: Number(r.open_qty), ordered_qty: Number(r.ordered_qty), open_cnt: r.open_cnt, ordered_cnt: r.ordered_cnt })) };
  });

  // SKU 1개의 부족 발생 내역 (2단계: 어느 고객·매출에서)
  app.get('/api/dashboard/funnel/shortage-detail', { preHandler: [authGuard, requireDevAccess()] }, async (req, reply) => {
    const pid = Number(req.query.product_id);
    if (!pid) return reply.code(400).send({ error: 'product_id_required' });
    const months = parseMonths(req);
    const rows = (await query(
      `SELECT sh.id, to_char(sh.occurred_at,'YYYY-MM-DD') AS occurred_at, sh.requested_qty, sh.fulfilled_qty, sh.shortage_qty, sh.status,
              c.name AS customer_name, sh.sales_invoice_id
         FROM stock_shortages sh LEFT JOIN customers c ON c.id=sh.customer_id
        WHERE sh.product_id=$1 AND sh.status<>'cancelled' AND to_char(sh.occurred_at,'YYYY-MM') = ANY($2)
        ORDER BY sh.occurred_at DESC, sh.id DESC`, [pid, months])).rows;
    return { items: rows.map((r) => ({ ...r, requested_qty: Number(r.requested_qty), fulfilled_qty: Number(r.fulfilled_qty), shortage_qty: Number(r.shortage_qty) })) };
  });

  // ④ 개발 필요 드릴다운: 개발요청 목록 + 단계 (requested_at 월)
  app.get('/api/dashboard/funnel/dev', { preHandler: [authGuard, requireDevAccess()] }, async (req) => {
    const months = parseMonths(req);
    const rows = (await query(
      `SELECT d.*, c.name AS customer_name FROM product_dev_requests d LEFT JOIN customers c ON c.id=d.customer_id
        WHERE d.deleted_at IS NULL AND d.status<>'cancelled' AND to_char(d.requested_at,'YYYY-MM') = ANY($1)
        ORDER BY d.requested_at DESC, d.id DESC`, [months])).rows;
    return { months, items: rows.map((r) => ({ ...withDurations(r), customer_name: r.customer_name })) };
  });

  // 수주 단계 경고 → 담당자 팝업 노티스 sweep (5분 주기 + 시작 15초 후 1회).
  //  · 정확히 1회/일 멱등은 quote_stage_alerts 가 보장(스위퍼 중복 무해).
  if (!globalThis.__refatrixStageAlertSweeper) {
    globalThis.__refatrixStageAlertSweeper = setInterval(() => { sweepStageAlerts().catch(() => {}); }, 300000);
    setTimeout(() => { sweepStageAlerts().catch(() => {}); }, 15000);
  }
}
