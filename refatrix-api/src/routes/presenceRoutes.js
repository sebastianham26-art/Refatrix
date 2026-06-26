import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { query } from '../db.js';
import geoip from 'geoip-lite';

// IPv6-매핑 IPv4(::ffff:1.2.3.4) 정리 + 사설/로컬 IP 제외(위치 추정 불가).
function normalizeIp(ip) {
  if (!ip) return null;
  ip = String(ip).trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1' || ip === '127.0.0.1') return null;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return null;
  if (/^(fc|fd)/i.test(ip)) return null; // IPv6 ULA
  return ip;
}

// 온라인 판정 임계(초). nav.js 하트비트 주기(45s)의 약 2배 + 여유.
// 사용자가 탭을 닫으면 하트비트가 멈추고, 이 시간이 지나면 오프라인으로 표시된다.
// 이때 last_seen 은 '마지막 하트비트(=페이지를 닫기 직전)' 시각 ≈ 마지막 접속 시각.
const ONLINE_WINDOW_SECONDS = 100;

// 세션 병합 gap(초). 직전 하트비트로부터 이 시간 이내면 같은 로그인 세션으로 보고 last_seen 만 연장,
// 넘으면 새 세션을 연다. 하트비트 45s + 백그라운드 탭/일시 비활성 여유를 감안해 5분.
const SESSION_GAP_SECONDS = 300;

// 타임라인 일자 기준 타임존(멕시코시티). 로그인 시각을 현지 벽시계 기준으로 0~24시에 매핑.
const TIMELINE_TZ = 'America/Mexico_City';

export default async function presenceRoutes(app) {
  // ── 하트비트 ──────────────────────────────────────────────
  // 모든 로그인 사용자(역할 무관)가 주기적으로 호출. 마지막 활동 시각 갱신 + 세션 이력 기록.
  app.post('/api/presence/ping', { preHandler: [authGuard] }, async (req) => {
    const userId = req.ctx.perm.userId;
    let path = null;
    if (req.body && typeof req.body.path === 'string') path = req.body.path.slice(0, 200);

    // 클라이언트 IP → 위치 추정(오프라인 GeoLite2). 사설/로컬 IP는 null.
    const ip = normalizeIp(req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0]);
    let g = null;
    if (ip) { try { g = geoip.lookup(ip); } catch (e) { g = null; } }
    const geoCity    = g && g.city    ? g.city    : null;
    const geoRegion  = g && g.region  ? g.region  : null;
    const geoCountry = g && g.country ? g.country : null;
    const geoLat     = g && g.ll      ? g.ll[0]   : null;
    const geoLng     = g && g.ll      ? g.ll[1]   : null;

    // (1) 현재 접속 카드용: 마지막 시각 + IP/위치 upsert.
    //     공인 IP가 있을 때만 위치를 갱신, 사설/로컬이면 직전 위치를 유지(COALESCE/CASE).
    await query(
      `INSERT INTO user_presence
            (user_id, last_seen, last_path, updated_at,
             last_ip, geo_city, geo_region, geo_country, geo_lat, geo_lng, geo_at)
            VALUES ($1, now(), $2, now(),
             $3, $4, $5, $6, $7, $8, CASE WHEN $3 IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (user_id) DO UPDATE SET
             last_seen   = now(),
             updated_at  = now(),
             last_path   = COALESCE($2, user_presence.last_path),
             last_ip     = COALESCE($3, user_presence.last_ip),
             geo_city    = CASE WHEN $3 IS NULL THEN user_presence.geo_city    ELSE $4 END,
             geo_region  = CASE WHEN $3 IS NULL THEN user_presence.geo_region  ELSE $5 END,
             geo_country = CASE WHEN $3 IS NULL THEN user_presence.geo_country ELSE $6 END,
             geo_lat     = CASE WHEN $3 IS NULL THEN user_presence.geo_lat     ELSE $7 END,
             geo_lng     = CASE WHEN $3 IS NULL THEN user_presence.geo_lng     ELSE $8 END,
             geo_at      = CASE WHEN $3 IS NULL THEN user_presence.geo_at      ELSE now() END`,
      [userId, path, ip, geoCity, geoRegion, geoCountry, geoLat, geoLng]
    );

    // (2) 타임라인용: 최근 세션이 gap 이내면 연장, 아니면 새 세션 시작 (단일 문장으로 원자적 처리)
    await query(
      `WITH recent AS (
         SELECT id FROM presence_session
          WHERE user_id = $1
            AND last_seen > now() - ($2 || ' seconds')::interval
          ORDER BY last_seen DESC
          LIMIT 1
       ), upd AS (
         UPDATE presence_session ps
            SET last_seen = now()
          WHERE ps.id = (SELECT id FROM recent)
          RETURNING ps.id
       )
       INSERT INTO presence_session (user_id, started_at, last_seen)
       SELECT $1, now(), now()
        WHERE NOT EXISTS (SELECT 1 FROM upd)`,
      [userId, String(SESSION_GAP_SECONDS)]
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
              p.last_ip, p.geo_city, p.geo_region, p.geo_country, p.geo_lat, p.geo_lng, p.geo_at,
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
      last_ip: r.last_ip,
      geo_city: r.geo_city,
      geo_region: r.geo_region,
      geo_country: r.geo_country,
      geo_lat: r.geo_lat == null ? null : Number(r.geo_lat),
      geo_lng: r.geo_lng == null ? null : Number(r.geo_lng),
      geo_at: r.geo_at,
      seconds_ago: r.seconds_ago == null ? null : Number(r.seconds_ago),
      online: r.online === true,
    }));

    return {
      items,
      online_window_seconds: ONLINE_WINDOW_SECONDS,
      server_now: new Date().toISOString(),
    };
  });

  // ── 로그인 타임라인(디렉터 전용) ─────────────────────────
  // 지정 일자(현지 기준)에 각 사용자가 로그인되어 있던 '구간'을 분 단위(0~1440)로 반환.
  // 그래프: 세로축 0~24시, 가로축 사용자, 막대 = 로그인 구간.
  app.get('/api/presence/timeline', { preHandler: [authGuard, requireDirector] }, async (req) => {
    // date=YYYY-MM-DD (현지). 없거나 형식이 틀리면 현지 오늘.
    let date = req.query && req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      date = (await query(
        `SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [TIMELINE_TZ]
      )).rows[0].d;
    }

    // 컬럼이 될 활성 사용자 전체(접속 카드와 동일 정렬)
    const users = (await query(
      `SELECT u.id, u.name, u.login_id, u.role, t.name AS team_name,
              p.geo_city, p.geo_region, p.geo_country
         FROM users u
         LEFT JOIN sales_teams t   ON t.id = u.team_id
         LEFT JOIN user_presence p ON p.user_id = u.id
        WHERE u.deleted_at IS NULL
        ORDER BY u.role, u.name`, []
    )).rows.map((r) => ({
      id: Number(r.id), name: r.name, login_id: r.login_id, role: r.role, team_name: r.team_name,
      geo_city: r.geo_city, geo_region: r.geo_region, geo_country: r.geo_country,
    }));

    // 해당 현지 일자와 겹치는 세션을 분 단위로 잘라 반환
    const segments = (await query(
      `WITH d AS (
         SELECT $1::timestamp AS day0,
                $1::timestamp + interval '1 day' AS day1,
                $2::text AS tz
       )
       SELECT ps.user_id,
              GREATEST(0,    EXTRACT(EPOCH FROM ((ps.started_at AT TIME ZONE d.tz) - d.day0)) / 60.0) AS start_min,
              LEAST(1440.0,  EXTRACT(EPOCH FROM ((ps.last_seen  AT TIME ZONE d.tz) - d.day0)) / 60.0) AS end_min
         FROM presence_session ps, d
        WHERE (ps.started_at AT TIME ZONE d.tz) < d.day1
          AND (ps.last_seen  AT TIME ZONE d.tz) > d.day0
        ORDER BY ps.user_id, start_min`,
      [date, TIMELINE_TZ]
    )).rows
      .map((r) => ({
        user_id: Number(r.user_id),
        start_min: Math.max(0, Number(r.start_min)),
        end_min: Math.min(1440, Number(r.end_min)),
      }))
      .filter((s) => s.end_min > s.start_min);

    return { date, tz: TIMELINE_TZ, users, segments };
  });
}
