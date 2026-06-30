import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';

export default async function deviceRoutes(app) {
  // 전체 기기 목록 (디렉터) — pending/approved/revoked 모두. 화면에서 그룹핑.
  app.get('/api/devices', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(
      `SELECT d.id, d.user_id, u.name, u.login_id, u.role, u.dept, u.device_locked,
              d.label, d.status, d.shared, d.created_at, d.last_seen,
              d.approved_at, ab.name AS approved_by_name
         FROM devices d
         JOIN users u  ON u.id = d.user_id
         LEFT JOIN users ab ON ab.id = d.approved_by
        WHERE u.deleted_at IS NULL
        ORDER BY (d.status='pending') DESC, d.last_seen DESC NULLS LAST, d.created_at DESC`)).rows;
    return {
      items: rows.map((r) => ({
        id: Number(r.id), user_id: Number(r.user_id), name: r.name, login_id: r.login_id,
        role: r.role, dept: r.dept, device_locked: r.device_locked === true,
        label: r.label, status: r.status, shared: r.shared === true,
        created_at: r.created_at, last_seen: r.last_seen,
        approved_at: r.approved_at, approved_by_name: r.approved_by_name,
      })),
    };
  });

  // 등록 대기 목록 (디렉터) — 하위호환 유지
  app.get('/api/devices/pending', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(
      `SELECT d.id, d.user_id, u.name, u.dept, d.label, d.created_at, d.last_seen
         FROM devices d JOIN users u ON u.id=d.user_id
        WHERE d.status='pending' ORDER BY d.created_at`)).rows;
    return { pending: rows };
  });

  // 기기 승인 (디렉터) — body.shared=true 면 공용(누구나), 아니면 그 사용자 전용.
  //   pending 뿐 아니라 revoked 였던 기기도 다시 승인 가능.
  app.post('/api/devices/:id/approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const shared = req.body?.shared === true;
    const r = await query(
      `UPDATE devices
          SET status='approved', shared=$1, approved_by=$2, approved_at=now(), revoked_at=NULL
        WHERE id=$3 AND status IN ('pending','revoked','approved')
        RETURNING user_id`, [shared, req.ctx.perm.userId, id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found_or_not_pending' });
    await logEvent({ userId: req.ctx.perm.userId, deviceId: id, action: 'device_approve', target: `device:${id}`, detail: { shared } });
    return { ok: true, shared };
  });

  // 기기 해지 (디렉터) — 분실·퇴사
  app.post('/api/devices/:id/revoke', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const r = await query(
      `UPDATE devices SET status='revoked', shared=false, revoked_at=now() WHERE id=$1 RETURNING user_id`, [id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, deviceId: id, action: 'device_revoke', target: `device:${id}` });
    return { ok: true };
  });

  // 기기 이름(라벨) 변경 (디렉터)
  app.patch('/api/devices/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const label = (req.body?.label ?? '').toString().slice(0, 80) || null;
    const r = await query(`UPDATE devices SET label=$1 WHERE id=$2 RETURNING id`, [label, id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true, label };
  });

  // 기기 행 삭제 (디렉터) — 잘못 들어온 pending/오래된 항목 정리. 같은 기기로 재로그인하면 다시 pending 생성됨.
  app.delete('/api/devices/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const r = await query(`DELETE FROM devices WHERE id=$1 RETURNING id`, [id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, deviceId: id, action: 'device_revoke', target: `device:${id}`, result: 'deleted' });
    return { ok: true };
  });
}
