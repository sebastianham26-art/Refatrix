import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { WIDGETS, WIDGET_BY_KEY, ROLE_DEFAULTS, defaultSettings } from '../widgetRegistry.js';

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
    return { user_id: userId, config, is_default: !(await query(`SELECT 1 FROM dashboard_widgets WHERE user_id=$1 LIMIT 1`, [userId])).rows.length };
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
}
