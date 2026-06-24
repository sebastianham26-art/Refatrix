import { query } from '../db.js';
import { authGuard, requirePage, requirePageEdit } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';

// WBR(주간 비즈니스 리뷰) 보드 — 팀별 이슈 불릿 + 회의 메모를 단일 JSON 문서로 영속.
// 권한: 페이지키 'wbr'. 열람(view) 이상이면 조회, 수정(edit) 이상이면 저장. 디렉터는 항상 전체.
// 단일 행(id=1) 싱글톤.
export default async function wbrRoutes(app) {
  // 보드 조회 — 'wbr' 열람 권한 필요. can_edit 를 함께 내려 프런트가 열람 전용 UI 를 구성.
  app.get('/api/wbr/board', { preHandler: [authGuard, requirePage('wbr')] }, async (req) => {
    const r = (await query(`SELECT data, updated_at FROM wbr_board WHERE id=1`)).rows[0];
    const perm = req.ctx.perm;
    const canEdit = perm.role === 'director'
      || ((perm.pageAccess && perm.pageAccess['wbr']) === 'edit');
    return { data: (r && r.data) || {}, updated_at: r ? r.updated_at : null, can_edit: canEdit };
  });

  // 보드 저장(전체 덮어쓰기) — 'wbr' 수정 권한 필요. 프런트가 { data:{ issues, memo } } 전체 상태를 보냄
  app.put('/api/wbr/board', { preHandler: [authGuard, requirePageEdit('wbr')] }, async (req, reply) => {
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
