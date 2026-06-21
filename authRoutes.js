import { query } from '../db.js';
import { verifyPin, hashDeviceKey } from '../auth.js';
import { logEvent } from '../audit.js';

export default async function authRoutes(app) {
  // 로그인: 아이디 + PIN
  app.post('/api/login', async (req, reply) => {
    const { login_id, pin, device_key } = req.body || {};
    if (!login_id || !pin) return reply.code(400).send({ error: 'login_id_and_pin_required' });

    const u = (await query(
      `SELECT id, login_id, name, role, pin_hash FROM users
         WHERE login_id=$1 AND deleted_at IS NULL`, [login_id])).rows[0];

    if (!u || !verifyPin(pin, u.pin_hash)) {
      // 로그인 실패도 기록(사용자 식별되면 user_id, 아니면 null)
      await logEvent({ userId: u?.id ?? null, action: 'login_fail', target: login_id, result: 'denied' });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    // 기기 상태 판단(있으면) — 미등록이면 등록요청 안내
    let device = { registered: false, status: null };
    if (device_key) {
      const h = hashDeviceKey(device_key);
      const d = (await query(
        `SELECT id, status FROM devices WHERE user_id=$1 AND device_key_hash=$2`, [u.id, h])).rows[0];
      if (d) device = { registered: d.status === 'approved', status: d.status };
      else {
        // 새 기기 → 등록요청(pending) 생성
        await query(
          `INSERT INTO devices (user_id, device_key_hash, status) VALUES ($1,$2,'pending')
             ON CONFLICT (user_id, device_key_hash) DO NOTHING`, [u.id, h]);
        device = { registered: false, status: 'pending' };
        await logEvent({ userId: u.id, action: 'device_request', target: 'self' });
      }
    }

    const token = await reply.jwtSign({ sub: u.id, role: u.role });
    await logEvent({ userId: u.id, action: 'login' });
    return { token, user: { id: u.id, login_id: u.login_id, name: u.name, role: u.role }, device };
  });
}
