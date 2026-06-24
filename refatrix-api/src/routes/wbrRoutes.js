import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';

// WBR(주간 비즈니스 리뷰) 보드 — 팀별 이슈 불릿 + 회의 메모를 단일 JSON 문서로 영속.
// 디렉터 전용(화면 자체가 전체 비즈니스 요약이라 민감). 단일 행(id=1) 싱글톤.
export default async function wbrRoutes(app) {
  // 보드 조회
  app.get('/api/wbr/board', { preHandler: [authGuard, requireDirector] }, async () => {
    const r = (await query(`SELECT data, updated_at FROM wbr_board WHERE id=1`)).rows[0];
    return { data: (r && r.data) || {}, updated_at: r ? r.updated_at : null };
  });

  // 보드 저장(전체 덮어쓰기) — 프런트가 { data:{ issues, memo } } 전체 상태를 보냄
  app.put('/api/wbr/board', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const data = req.body && req.body.data;
    if (data == null || typeof data !== 'object' || Array.isArray(data)) {
      return reply.code(400).send({ error: 'bad_data' });
    }
    let json;
    try { json = JSON.stringify(data); } catch { return reply.code(400).send({ error: 'bad_json' }); }
    if (json.length > 200000) return reply.code(413).send({ error: 'too_large' }); // 과대 페이로드 방어
    const uid = req.ctx.perm.userId;
    await query(
      `INSERT INTO wbr_board (id, data, updated_by, updated_at)
         VALUES (1, $1::jsonb, $2, now())
       ON CONFLICT (id) DO UPDATE
         SET data=EXCLUDED.data, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [json, uid]
    );
    logEvent({ userId: uid, deviceId: req.ctx.deviceId, action: 'wbr_board_save', target: 'wbr_board:1' });
    const r = (await query(`SELECT updated_at FROM wbr_board WHERE id=1`)).rows[0];
    return { ok: true, updated_at: r ? r.updated_at : null };
  });
}
