import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { hashPin } from '../auth.js';
import { logEvent } from '../audit.js';

function genPin() { return String(Math.floor(1000 + Math.random() * 9000)); }

export default async function userRoutes(app) {
  // 사용자 생성(디렉터). 아이디 + 자동 PIN 발급(해시 저장), PIN 평문은 1회만 반환.
  app.post('/api/users', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const { name, dept, role, login_id, lang = 'ko' } = req.body || {};
    if (!name || !role || !login_id) return reply.code(400).send({ error: 'name_role_login_id_required' });
    const dup = (await query(`SELECT 1 FROM users WHERE login_id=$1`, [login_id])).rows[0];
    if (dup) return reply.code(409).send({ error: 'login_id_taken' });

    const pin = genPin();
    const u = (await query(
      `INSERT INTO users (name, dept, role, login_id, pin_hash, lang, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [name, dept || null, role, login_id, hashPin(pin), lang, req.ctx.perm.userId])).rows[0];

    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `user:${u.id}` });
    // PIN 평문은 이 응답에서만 반환 → 디렉터가 사용자에게 통보
    return { id: u.id, login_id, pin, note: '이 PIN을 사용자에게 통보하세요. 서버에는 해시만 저장됩니다.' };
  });

  // PIN 재발급(디렉터)
  app.post('/api/users/:id/reset-pin', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const id = Number(req.params.id);
    const pin = genPin();
    await query(`UPDATE users SET pin_hash=$1, updated_by=$2 WHERE id=$3`, [hashPin(pin), req.ctx.perm.userId, id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'pin_reset', target: `user:${id}` });
    return { id, pin };
  });

  // 메뉴 접근/기기요구 설정(디렉터) — 권한 변경은 감사 로그에 남김
  app.put('/api/users/:id/page-access', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const id = Number(req.params.id);
    const { page_key, device_req } = req.body || {};
    await query(
      `INSERT INTO user_page_access (user_id, page_key, device_req) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, page_key) DO UPDATE SET device_req=EXCLUDED.device_req`,
      [id, page_key, device_req]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'permission_change', target: `user:${id}`, detail: { page_key, device_req } });
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
}
