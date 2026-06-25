import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { query } from '../db.js';

// 온라인 판정 임계(초). nav.js 하트비트 주기(45s)의 약 2배 + 여유.
// 사용자가 탭을 닫으면 하트비트가 멈추고, 이 시간이 지나면 오프라인으로 표시된다.
// 이때 last_seen 은 '마지막 하트비트(=페이지를 닫기 직전)' 시각 ≈ 마지막 접속 시각.
const ONLINE_WINDOW_SECONDS = 100;

export default async function presenceRoutes(app) {
  // ── 하트비트 ──────────────────────────────────────────────
  // 모든 로그인 사용자(역할 무관)가 주기적으로 호출. 마지막 활동 시각 갱신.
  app.post('/api/presence/ping', { preHandler: [authGuard] }, async (req) => {
    const userId = req.ctx.perm.userId;
    let path = null;
    if (req.body && typeof req.body.path === 'string') path = req.body.path.slice(0, 200);
    await query(
      `INSERT INTO user_presence (user_id, last_seen, last_path, updated_at)
            VALUES ($1, now(), $2, now())
       ON CONFLICT (user_id) DO UPDATE
            SET last_seen  = now(),
                last_path  = COALESCE($2, user_presence.last_path),
                updated_at = now()`,
      [userId, path]
    );
    return { ok: true };
  });

  // ── 접속 현황(디렉터 전용) ────────────────────────────────
  // 활성 사용자 전체 + 온라인 여부 + 마지막 활동 시각.
  app.get('/api/presence', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(
      `SELECT u.id, u.name, u.login_id, u.role, u.dept,
              t.name AS team_name,
              p.last_seen, p.last_path,
              EXTRACT(EPOCH FROM (now() - p.last_seen)) AS seconds_ago,
              (p.last_seen IS NOT NULL
                AND p.last_seen > now() - ($1 || ' seconds')::interval) AS online
         FROM users u
         LEFT JOIN user_presence p ON p.user_id = u.id
         LEFT JOIN sales_teams  t ON t.id = u.team_id
        WHERE u.deleted_at IS NULL
        ORDER BY u.role, u.name`,
      [String(ONLINE_WINDOW_SECONDS)]
    )).rows;

    const items = rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      login_id: r.login_id,
      role: r.role,
      dept: r.dept,
      team_name: r.team_name,
      last_seen: r.last_seen,                                  // ISO 문자열 또는 null
      last_path: r.last_path,
      seconds_ago: r.seconds_ago == null ? null : Number(r.seconds_ago),
      online: r.online === true,
    }));

    return {
      items,
      online_window_seconds: ONLINE_WINDOW_SECONDS,
      server_now: new Date().toISOString(),
    };
  });
}
