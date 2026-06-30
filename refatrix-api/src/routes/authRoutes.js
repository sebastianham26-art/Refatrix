import { query } from '../db.js';
import { verifyPin, hashDeviceKey } from '../auth.js';
import { logEvent } from '../audit.js';

export default async function authRoutes(app) {
  // 로그인: 아이디 + PIN (+ device_key: 기기 식별 키, 브라우저 localStorage 보관)
  app.post('/api/login', async (req, reply) => {
    const { login_id, pin, device_key } = req.body || {};
    if (!login_id || !pin) return reply.code(400).send({ error: 'login_id_and_pin_required' });

    const u = (await query(
      `SELECT id, name, role, pin_hash, device_locked FROM users
         WHERE login_id=$1 AND deleted_at IS NULL`, [login_id])).rows[0];

    if (!u || !verifyPin(pin, u.pin_hash)) {
      // 로그인 실패도 기록(사용자 식별되면 user_id, 아니면 null)
      await logEvent({ userId: u?.id ?? null, action: 'login_fail', target: login_id, result: 'denied' });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    // ── 기기 게이트 ───────────────────────────────────────────────
    // 디렉터가 'device_locked' 로 지정한 사용자만 강제한다(디렉터 본인은 항상 통과 = 잠금사고 방지).
    // 비상 킬스위치: 환경변수 DEVICE_GATE_DISABLED=1 이면 게이트 전체 무력화.
    const gateOn = process.env.DEVICE_GATE_DISABLED !== '1';
    if (gateOn && u.device_locked === true && u.role !== 'director') {
      if (!device_key) {
        // 기기키를 못 받음(로컬저장소 차단 등) → 등록 자체가 불가하므로 차단.
        await logEvent({ userId: u.id, action: 'login_fail', target: login_id, result: 'device_required' });
        return reply.code(403).send({ error: 'device_required' });
      }
      const h = hashDeviceKey(device_key);
      // 1) 이 사용자 전용으로 승인된 기기
      const mine = (await query(
        `SELECT id FROM devices WHERE user_id=$1 AND device_key_hash=$2 AND status='approved'`,
        [u.id, h])).rows[0];
      // 2) 공용(누구나)으로 승인된 기기 — 해시 전역 매칭
      const sharedDev = mine ? null : (await query(
        `SELECT id FROM devices WHERE device_key_hash=$1 AND shared=true AND status='approved' LIMIT 1`,
        [h])).rows[0];

      if (!mine && !sharedDev) {
        // 미승인 기기 → 승인요청(pending) 생성/갱신 + 접속 차단(토큰 미발급).
        // 기존 행이 revoked 면 상태 유지(자동 재pending 안 함) → '차단' 안내.
        await query(
          `INSERT INTO devices (user_id, device_key_hash, status, last_seen)
             VALUES ($1,$2,'pending',now())
           ON CONFLICT (user_id, device_key_hash)
             DO UPDATE SET last_seen=now()`, [u.id, h]);
        const cur = (await query(
          `SELECT status FROM devices WHERE user_id=$1 AND device_key_hash=$2`, [u.id, h])).rows[0];
        await logEvent({ userId: u.id, action: 'device_request', target: 'self' });
        return reply.code(403).send({ error: cur?.status === 'revoked' ? 'device_revoked' : 'device_pending' });
      }
      // 승인된 기기 → 최근 접속시각 갱신
      await query(`UPDATE devices SET last_seen=now() WHERE id=$1`, [mine?.id || sharedDev.id]);
    }
    // ──────────────────────────────────────────────────────────────

    const token = await reply.jwtSign({ sub: u.id, role: u.role });
    await logEvent({ userId: u.id, action: 'login' });
    return { token, user: { id: u.id, name: u.name, role: u.role } };
  });
}
