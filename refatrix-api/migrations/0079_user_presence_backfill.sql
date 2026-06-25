-- =====================================================================
-- Refatrix ERP · 0079_user_presence_backfill
-- 기존 사용자의 "마지막 접속" 초기값을 과거 활동 기록에서 채운다.
-- 출처: audit_log(로그인 등 모든 감사 이벤트의 occurred_at)
--      + page_view_daily(열람 일별 요약의 last_at)
--      → 사용자별 가장 최근 시각을 last_seen 으로 시드.
-- 이렇게 해야 배포 직후 기존 사용자가 '접속 기록 없음' 으로 잘못 표시되지 않고,
-- 마지막 로그인/활동 시각이 그대로 보인다.
-- 이미 user_presence 행이 있는(=배포 후 실제 하트비트가 들어온) 사용자는 건드리지 않는다(DO NOTHING).
-- =====================================================================

INSERT INTO user_presence (user_id, last_seen, last_path, updated_at)
SELECT s.user_id, s.last_seen, NULL, now()
  FROM (
    SELECT user_id, MAX(ts) AS last_seen
      FROM (
        SELECT user_id, occurred_at AS ts FROM audit_log       WHERE user_id IS NOT NULL
        UNION ALL
        SELECT user_id, last_at     AS ts FROM page_view_daily WHERE user_id IS NOT NULL
      ) z
     GROUP BY user_id
  ) s
  JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
ON CONFLICT (user_id) DO NOTHING;
