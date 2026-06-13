import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { visibleTeamIds } from '../teams.js';
import { fieldVisible } from '../permissions.js';
import { WIDGETS, WIDGET_BY_KEY, ROLE_DEFAULTS, defaultSettings } from '../widgetRegistry.js';

function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
async function safeLog(args) { try { await logEvent(args); } catch (_) { /* ignore */ } }

// 유저의 위젯 구성을 해석(없으면 역할 기본값으로 시드 형태 반환)
async function resolveConfig(userId, role) {
  const rows = (await query(
    `SELECT widget_key, sort_order, enabled, settings FROM dashboard_widgets WHERE user_id=$1 ORDER BY sort_order, id`, [userId])).rows;
  if (rows.length) {
    return rows.filter((r) => WIDGET_BY_KEY[r.widget_key]).map((r) => ({
      widget_key: r.widget_key, sort_order: r.sort_order, enabled: r.enabled,
      settings: r.settings || defaultSettings(r.widget_key),
    }));
  }
  // 기본값(역할별)
  const keys = ROLE_DEFAULTS[role] || ROLE_DEFAULTS.default;
  return keys.map((k, i) => ({ widget_key: k, sort_order: i, enabled: true, settings: defaultSettings(k) }));
}

export default async function dashboardRoutes(app) {
  // 로그인 유저의 화면별 권한(none/view/edit) — 화면이 읽기전용 잠금 판단에 사용
  app.get('/api/me/access', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const KNOWN = ['customers', 'targets', 'pipeline', 'marketing', 'sales', 'products', 'finance', 'budget', 'importcost', 'users'];
    const access = {};
    for (const k of KNOWN) {
      if (perm.role === 'director') { access[k] = 'edit'; continue; }
      if (perm.pages && perm.pages[k] != null) access[k] = (perm.pageAccess && perm.pageAccess[k]) || 'edit';
      else access[k] = 'none';
    }
    return { role: perm.role, isDirector: perm.role === 'director', access };
  });

  // 위젯 카탈로그(레지스트리) — 구성 화면이 사용
  app.get('/api/dashboard/registry', { preHandler: [authGuard] }, async () => {
    return { widgets: WIDGETS };
  });

  // 내 대시보드 구성(유저) 또는 특정 유저 구성(디렉터가 user_id로 조회)
  app.get('/api/dashboard/config', { preHandler: [authGuard] }, async (req, reply) => {
    let userId = req.ctx.perm.userId, role = req.ctx.perm.role;
    if (req.query.user_id) {
      if (req.ctx.perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
      userId = Number(req.query.user_id);
      const u = (await query(`SELECT role FROM users WHERE id=$1`, [userId])).rows[0];
      if (!u) return reply.code(404).send({ error: 'not_found' });
      role = u.role;
    }
    const config = await resolveConfig(userId, role);
    // 대시보드 민감 필드 부여 상태
    const fkeys = ['fin_amount', 'ar_amount', 'mkt_amount', 'sales_amount'];
    const granted = {};
    if (role === 'director') { for (const k of fkeys) granted[k] = true; }
    else {
      for (const k of fkeys) granted[k] = false;
      for (const r of (await query(`SELECT field_key FROM user_field_access WHERE user_id=$1 AND visible=true AND field_key = ANY($2)`, [userId, fkeys])).rows) granted[r.field_key] = true;
    }
    return { user_id: userId, config, sensitive: granted, is_default: !(await query(`SELECT 1 FROM dashboard_widgets WHERE user_id=$1 LIMIT 1`, [userId])).rows.length };
  });

  // 대시보드 민감 필드 부여(디렉터)
  app.post('/api/dashboard/sensitive', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const userId = Number(req.body?.user_id);
    const fkeys = ['fin_amount', 'ar_amount', 'mkt_amount', 'sales_amount'];
    const key = req.body?.field_key;
    if (!userId || !fkeys.includes(key)) return reply.code(400).send({ error: 'bad_request' });
    await query(
      `INSERT INTO user_field_access (user_id, field_key, visible) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, field_key) DO UPDATE SET visible=EXCLUDED.visible`,
      [userId, key, req.body?.visible === true]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'permission_change', target: `dash_sensitive:${userId}` });
    return { ok: true };
  });

  // 유저 구성 저장(디렉터). widgets:[{widget_key,enabled,settings}] 순서대로 sort_order 부여.
  app.post('/api/dashboard/config', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const userId = Number(req.body?.user_id);
    if (!userId) return reply.code(400).send({ error: 'user_required' });
    const widgets = Array.isArray(req.body?.widgets) ? req.body.widgets : [];
    await query(`DELETE FROM dashboard_widgets WHERE user_id=$1`, [userId]);
    let i = 0;
    for (const w of widgets) {
      if (!WIDGET_BY_KEY[w.widget_key]) continue;
      // settings: 레지스트리에 정의된 필드만 허용
      const allowed = {};
      for (const f of WIDGET_BY_KEY[w.widget_key].fields) {
        allowed[f.key] = (w.settings && w.settings[f.key] != null) ? !!w.settings[f.key] : f.def;
      }
      await query(
        `INSERT INTO dashboard_widgets (user_id, widget_key, sort_order, enabled, settings, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [userId, w.widget_key, i++, w.enabled !== false, JSON.stringify(allowed), req.ctx.perm.userId]);
    }
    await safeLog({ userId: req.ctx.perm.userId, action: 'permission_change', target: `dashboard:${userId}` });
    return { ok: true };
  });

  // ===== 유저의 조정 요청 → 디렉터 승인 =====
  app.post('/api/dashboard/request', { preHandler: [authGuard] }, async (req, reply) => {
    const note = String(req.body?.note || '').trim();
    if (!note) return reply.code(400).send({ error: 'note_required' });
    const row = (await query(
      `INSERT INTO dashboard_requests (user_id, note, payload) VALUES ($1,$2,$3) RETURNING id`,
      [req.ctx.perm.userId, note, req.body?.payload ? JSON.stringify(req.body.payload) : null])).rows[0];
    await safeLog({ userId: req.ctx.perm.userId, action: 'create', target: `dash_request:${row.id}` });
    return { ok: true, id: row.id };
  });

  // 요청 목록(디렉터) — 미처리 우선
  app.get('/api/dashboard/requests', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(
      `SELECT r.id, r.note, r.status, to_char(r.created_at,'YYYY-MM-DD HH24:MI') AS created_at,
              u.id AS user_id, u.name AS user_name, u.role AS user_role,
              to_char(r.decided_at,'YYYY-MM-DD HH24:MI') AS decided_at, r.decide_note
         FROM dashboard_requests r JOIN users u ON u.id=r.user_id
        ORDER BY (r.status<>'open'), r.created_at DESC LIMIT 200`)).rows;
    const open = rows.filter((r) => r.status === 'open').length;
    return { items: rows, open };
  });

  // 요청 승인/반려(디렉터). 승인은 표시만 — 실제 반영은 디렉터가 구성화면에서.
  app.post('/api/dashboard/requests/:id/decide', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const approve = req.body?.approve === true;
    await query(`UPDATE dashboard_requests SET status=$1, decided_by=$2, decided_at=now(), decide_note=$3 WHERE id=$4`,
      [approve ? 'approved' : 'rejected', req.ctx.perm.userId, req.body?.note || null, id]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `dash_request_decide:${id}` });
    return { ok: true };
  });

  // 미처리 요청 수(디렉터 배지용)
  app.get('/api/dashboard/requests/count', { preHandler: [authGuard, requireDirector] }, async () => {
    const n = (await query(`SELECT COUNT(*) AS n FROM dashboard_requests WHERE status='open'`)).rows[0].n;
    return { open: Number(n) };
  });

  // 영업 카테고리 표시형 위젯용 요약(한 번에). 팀 가시성 적용.
  app.get('/api/dashboard/salesdata', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const vis = visibleTeamIds(perm);
    const teamArr = vis === null ? null : (vis.length ? vis : [-1]);
    const seeAr = fieldVisible(perm, 'ar_amount');
    const out = {};

    // 고객 현황: 고객 수 / 연체 고객 수 / 총 미수금(민감)
    {
      let q = `SELECT COUNT(DISTINCT c.id) AS cust_n,
                      COUNT(DISTINCT CASE WHEN i.due_date < CURRENT_DATE AND (i.total_mxn - COALESCE(p.paid,0)) > 0.01 THEN c.id END) AS overdue_n,
                      COALESCE(SUM(CASE WHEN i.status='posted' THEN (i.total_mxn - COALESCE(p.paid,0)) ELSE 0 END),0) AS outstanding
                 FROM customers c
                 LEFT JOIN sales_invoices i ON i.customer_id=c.id AND i.status='posted'
                 LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) p ON p.invoice_id=i.id
                WHERE c.deleted_at IS NULL`;
      const params = [];
      if (teamArr) { params.push(teamArr); q += ` AND c.team_id = ANY($1)`; }
      const r = (await query(q, params)).rows[0];
      out.customers = { count: Number(r.cust_n), overdue: Number(r.overdue_n), outstanding: seeAr ? r2(r.outstanding) : null, locked: !seeAr };
    }

    // 매출목표 승인 현황: 팀별 상태
    {
      let q = `SELECT t.name AS team, COALESCE(s.status,'draft') AS status
                 FROM sales_teams t LEFT JOIN target_team_status s ON s.team_id=t.id
                WHERE t.deleted_at IS NULL AND t.is_sales=true`;
      const params = [];
      if (teamArr) { params.push(teamArr); q += ` AND t.id = ANY($1)`; }
      q += ` ORDER BY t.sort_order, t.id`;
      out.target_status = (await query(q, params)).rows;
    }

    // 최근 미팅 활동(팀 가시성) 최신 6건
    {
      let q = `SELECT to_char(m.meeting_date,'YYYY-MM-DD') AS d, c.name AS customer, sa.name AS stage_after,
                      (m.stage_before IS DISTINCT FROM m.stage_after) AS advanced
                 FROM customer_meetings m JOIN customers c ON c.id=m.customer_id
                 LEFT JOIN stages sa ON sa.id=m.stage_after
                WHERE c.deleted_at IS NULL`;
      const params = [];
      if (teamArr) { params.push(teamArr); q += ` AND c.team_id = ANY($1)`; }
      q += ` ORDER BY m.meeting_date DESC, m.id DESC LIMIT 6`;
      out.recent_meetings = (await query(q, params)).rows;
    }

    // 디렉터 지시 현황(전체 카운트) — 디렉터만, 그 외엔 내 미읽음만
    if (perm.role === 'director') {
      const r = (await query(`SELECT status, COUNT(*) AS n FROM customer_directives GROUP BY status`)).rows;
      const c = { open: 0, read: 0, done: 0 }; for (const x of r) c[x.status] = Number(x.n);
      out.directives = c;
    } else {
      let q = `SELECT COUNT(*) AS n FROM customer_directives d JOIN customers c ON c.id=d.customer_id WHERE d.status='open' AND c.deleted_at IS NULL`;
      const params = [];
      if (teamArr) { params.push(teamArr); q += ` AND c.team_id = ANY($1)`; }
      out.directives = { unread: Number((await query(q, params)).rows[0].n) };
    }

    return out;
  });

  // 마케팅·재무 카테고리 표시형 위젯용 요약(한 번에).
  app.get('/api/dashboard/findata', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const seeFin = fieldVisible(perm, 'fin_amount');
    const seeAr = fieldVisible(perm, 'ar_amount');
    const seeMkt = fieldVisible(perm, 'mkt_amount');
    const out = {};
    const ym = new Date().toISOString().slice(0, 7);

    // 이번 달 캐시플로(실현 in/out) — 민감(fin_amount)
    {
      const r = (await query(
        `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount_mxn ELSE 0 END),0) AS inflow,
                COALESCE(SUM(CASE WHEN direction='out' THEN amount_mxn ELSE 0 END),0) AS outflow
           FROM transactions WHERE status='actual' AND to_char(txn_date,'YYYY-MM')=$1`, [ym])).rows[0];
      out.cashflow = seeFin
        ? { ym, inflow: r2(r.inflow), outflow: r2(r.outflow), net: r2(r.inflow - r.outflow), locked: false }
        : { ym, locked: true };
    }
    // 계획 대비 실적(이번 달 지출) — 민감(fin_amount). 비율은 비민감으로 노출.
    {
      const r = (await query(
        `SELECT COALESCE(SUM(CASE WHEN status='plan' AND direction='out' THEN amount_mxn ELSE 0 END),0) AS plan_out,
                COALESCE(SUM(CASE WHEN status='actual' AND direction='out' THEN amount_mxn ELSE 0 END),0) AS act_out
           FROM transactions WHERE to_char(txn_date,'YYYY-MM')=$1`, [ym])).rows[0];
      const plan = Number(r.plan_out), act = Number(r.act_out);
      const rate = plan > 0 ? r2(act / plan * 100) : null;
      out.plan_vs_actual = seeFin
        ? { ym, plan: r2(plan), actual: r2(act), rate, locked: false }
        : { ym, rate, locked: true };
    }
    // AR 연체 총액·건수 — 건수는 비민감, 금액은 민감(ar_amount)
    {
      const r = (await query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(i.total_mxn - COALESCE(p.paid,0)),0) AS overdue
           FROM sales_invoices i
           LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) p ON p.invoice_id=i.id
          WHERE i.status='posted' AND i.due_date < CURRENT_DATE AND (i.total_mxn - COALESCE(p.paid,0)) > 0.01`)).rows[0];
      out.ar_overdue = { count: Number(r.n), total: seeAr ? r2(r.overdue) : null, locked: !seeAr };
    }
    // 승인 대기 거래 수 — 비민감
    {
      const r = (await query(`SELECT COUNT(*) AS n FROM sales_change_requests WHERE status='pending'`)).rows[0];
      out.pending_approvals = Number(r.n);
    }
    // 최신 환율 — 비민감
    {
      const r = (await query(`SELECT rate, to_char(rate_date,'YYYY-MM-DD') AS d FROM fx_rates WHERE base='USD' AND quote='MXN' ORDER BY rate_date DESC LIMIT 1`)).rows[0];
      out.fx = r ? { rate: Number(r.rate), date: r.d } : null;
    }
    // 마케팅 상태 — 비민감
    {
      const r = (await query(`SELECT status FROM marketing_plan_status WHERE id=1`)).rows[0];
      out.marketing_status = r ? r.status : 'draft';
    }
    // 마케팅 예산/배분(연간) + 고객 TOP — 금액 민감(mkt_amount), 소진율은 비민감
    {
      const months = [];
      const base = new Date();
      for (let i = 0; i < 12; i++) { const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + i, 1)); months.push(d.toISOString().slice(0, 7)); }
      const bud = (await query(`SELECT COALESCE(SUM(amount),0) AS s FROM marketing_budget_months WHERE ym = ANY($1)`, [months])).rows[0];
      const al = (await query(`SELECT COALESCE(SUM(qty*unit_budget),0) AS s FROM marketing_alloc WHERE ym = ANY($1)`, [months])).rows[0];
      const budget = Number(bud.s), alloc = Number(al.s);
      const rate = budget > 0 ? r2(alloc / budget * 100) : 0;
      const top = (await query(
        `SELECT c.name, COALESCE(SUM(a.qty*a.unit_budget),0) AS total
           FROM marketing_alloc a JOIN customers c ON c.id=a.customer_id
          WHERE a.ym = ANY($1) AND c.deleted_at IS NULL
          GROUP BY c.id, c.name HAVING COALESCE(SUM(a.qty*a.unit_budget),0) > 0
          ORDER BY total DESC LIMIT 5`, [months])).rows;
      out.marketing = seeMkt
        ? { budget: r2(budget), alloc: r2(alloc), rate, top: top.map((t) => ({ name: t.name, total: r2(t.total) })), locked: false }
        : { rate, top: top.map((t) => ({ name: t.name })), locked: true };
    }
    out._see = { fin: seeFin, ar: seeAr, mkt: seeMkt };
    return out;
  });

  // 제품·기타 카테고리 표시형 위젯용 요약(한 번에).
  app.get('/api/dashboard/miscdata', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const out = {};
    // 제품 수
    {
      const r = (await query(`SELECT COUNT(*) AS n FROM products WHERE deleted_at IS NULL`)).rows[0];
      out.products = { count: Number(r.n) };
    }
    // 수입원가 승인 대기 수
    {
      const r = (await query(`SELECT COUNT(*) AS n FROM import_cost_docs WHERE status='pending' AND deleted_at IS NULL`)).rows[0];
      out.import_pending = { count: Number(r.n) };
    }
    // 마감 기간 수 + 최신
    {
      const rows = (await query(`SELECT period AS p FROM period_closings ORDER BY period DESC`)).rows;
      out.closed_periods = { count: rows.length, latest: rows[0] ? rows[0].p : null };
    }
    // 사용자 현황(디렉터만)
    if (perm.role === 'director') {
      const rows = (await query(`SELECT role, COUNT(*) AS n FROM users WHERE deleted_at IS NULL GROUP BY role`)).rows;
      const byRole = {}; let total = 0; for (const r of rows) { byRole[r.role] = Number(r.n); total += Number(r.n); }
      out.users = { count: total, by_role: byRole };
    }
    return out;
  });
}
