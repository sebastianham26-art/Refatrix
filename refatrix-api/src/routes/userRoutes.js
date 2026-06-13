import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { hashPin } from '../auth.js';
import { logEvent } from '../audit.js';
import { ROLE_DEFAULTS, SCREEN_PAGE_KEY, applyRoleDefaults } from '../roleDefaults.js';

function genPin() { return String(Math.floor(1000 + Math.random() * 9000)); }

export default async function userRoutes(app) {
  // 사용자 목록(디렉터): 역할·팀·페이지 권한
  app.get('/api/users', { preHandler: [authGuard, requireDirector] }, async () => {
    const users = (await query(
      `SELECT u.id, u.name, u.login_id, u.role, u.dept, u.team_id, t.name AS team_name
         FROM users u LEFT JOIN sales_teams t ON t.id=u.team_id
        WHERE u.deleted_at IS NULL ORDER BY u.role, u.name`)).rows;
    const pages = (await query(`SELECT user_id, page_key, access FROM user_page_access`)).rows;
    const pagesByUser = {};
    const accessByUser = {};
    for (const p of pages) { (pagesByUser[p.user_id] ||= []).push(p.page_key); (accessByUser[p.user_id] ||= {})[p.page_key] = p.access || 'edit'; }
    return { items: users.map((u) => ({ ...u, pages: pagesByUser[u.id] || [], page_access: accessByUser[u.id] || {} })) };
  });

  // 사용자 생성(디렉터). PIN 지정 가능(미지정 시 자동), 팀·페이지 권한 일괄 부여.
  app.post('/api/users', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const { name, dept, role, login_id, lang = 'ko', pin: pinReq, team_id, pages } = req.body || {};
    if (!name || !role || !login_id) return reply.code(400).send({ error: 'name_role_login_id_required' });
    const dup = (await query(`SELECT 1 FROM users WHERE login_id=$1`, [login_id])).rows[0];
    if (dup) return reply.code(409).send({ error: 'login_id_taken' });
    const pin = (pinReq && /^\d{4,8}$/.test(String(pinReq))) ? String(pinReq) : genPin();
    const u = (await query(
      `INSERT INTO users (name, dept, role, login_id, pin_hash, lang, team_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [name, dept || null, role, login_id, hashPin(pin), lang, team_id || null, req.ctx.perm.userId])).rows[0];
    const explicitPages = Array.isArray(pages) ? pages : [];
    for (const pk of explicitPages) {
      await query(`INSERT INTO user_page_access (user_id, page_key, device_req) VALUES ($1,$2,'anywhere') ON CONFLICT (user_id, page_key) DO NOTHING`, [u.id, pk]);
    }
    // 명시 페이지가 없으면 역할 기본 권한 자동 부여
    let applied = null;
    if (!explicitPages.length) applied = await applyRoleDefaults(u.id, role);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `user:${u.id}`, detail: applied ? { role_defaults: applied } : undefined });
    return { id: u.id, login_id, pin, applied, note: '이 PIN을 사용자에게 통보하세요. 서버에는 해시만 저장됩니다.' };
  });

  // PIN 재발급(디렉터). 지정 가능.
  app.post('/api/users/:id/reset-pin', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const id = Number(req.params.id);
    const pin = (req.body?.pin && /^\d{4,8}$/.test(String(req.body.pin))) ? String(req.body.pin) : genPin();
    await query(`UPDATE users SET pin_hash=$1, updated_by=$2 WHERE id=$3`, [hashPin(pin), req.ctx.perm.userId, id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'pin_reset', target: `user:${id}` });
    return { id, pin };
  });

  // 페이지 권한 회수(디렉터)
  app.delete('/api/users/:id/page-access', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const id = Number(req.params.id);
    const pageKey = String(req.query.page_key || '');
    await query(`DELETE FROM user_page_access WHERE user_id=$1 AND page_key=$2`, [id, pageKey]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'permission_change', target: `user:${id}`, detail: { remove_page: pageKey } });
    return { ok: true };
  });

  // 메뉴 접근/기기요구 설정(디렉터) — 권한 변경은 감사 로그에 남김
  app.put('/api/users/:id/page-access', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const id = Number(req.params.id);
    const { page_key, device_req, access } = req.body || {};
    const acc = (access === 'view' || access === 'edit') ? access : 'edit';
    await query(
      `INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, page_key) DO UPDATE SET device_req=EXCLUDED.device_req, access=EXCLUDED.access`,
      [id, page_key, device_req || 'anywhere', acc]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'permission_change', target: `user:${id}`, detail: { page_key, access: acc } });
    return { ok: true };
  });

  // 민감 필드 노출 설정(디렉터)
  app.put('/api/users/:id/field-access', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const id = Number(req.params.id);
    const { field_key, visible } = req.body || {};
    await query(
      `INSERT INTO user_field_access (user_id, field_key, visible) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, field_key) DO UPDATE SET visible=EXCLUDED.visible`,
      [id, field_key, !!visible]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'permission_change', target: `user:${id}`, detail: { field_key, visible } });
    return { ok: true };
  });

  // 기존 사용자에게 역할 기본 권한 적용(디렉터). 수동 설정은 보존하고 누락분만 추가.
  app.post('/api/users/:id/apply-role-defaults', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const u = (await query(`SELECT role FROM users WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!u) return reply.code(404).send({ error: 'not_found' });
    const applied = await applyRoleDefaults(id, u.role);
    await logEvent({ userId: req.ctx.perm.userId, action: 'permission_change', target: `user:${id}`, detail: { apply_role_defaults: u.role, applied } });
    return { ok: true, role: u.role, applied };
  });

  // 역할별 기본 권한 표(디렉터)
  app.get('/api/role-defaults', { preHandler: [authGuard, requireDirector] }, async () => {
    return { roleDefaults: ROLE_DEFAULTS, screenPageKey: SCREEN_PAGE_KEY };
  });
}
