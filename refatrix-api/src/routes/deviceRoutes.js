import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';

export default async function deviceRoutes(app) {
  // 등록 대기 목록 (디렉터)
  app.get('/api/devices/pending', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(
      `SELECT d.id, d.user_id, u.name, u.dept, d.label, d.created_at
         FROM devices d JOIN users u ON u.id=d.user_id
        WHERE d.status='pending' ORDER BY d.created_at`)).rows;
    return { pending: rows };
  });

  // 기기 승인 (디렉터)
  app.post('/api/devices/:id/approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const r = await query(
      `UPDATE devices SET status='approved', approved_by=$1, approved_at=now()
        WHERE id=$2 AND status='pending' RETURNING user_id`, [req.ctx.perm.userId, id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found_or_not_pending' });
    await logEvent({ userId: req.ctx.perm.userId, deviceId: id, action: 'device_approve', target: `device:${id}` });
    return { ok: true };
  });

  // 기기 해지 (디렉터) — 분실·퇴사
  app.post('/api/devices/:id/revoke', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const r = await query(
      `UPDATE devices SET status='revoked', revoked_at=now() WHERE id=$1 RETURNING user_id`, [id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, deviceId: id, action: 'device_revoke', target: `device:${id}` });
    return { ok: true };
  });
}
