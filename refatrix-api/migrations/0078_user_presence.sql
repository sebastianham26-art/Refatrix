-- =====================================================================
-- Refatrix ERP · 0078_user_presence
-- 사용자 접속 현황(온라인 여부 + 마지막 활동 시각).
-- 관리 화면(디렉터 전용) "접속 현황" 카드에서 사용.
-- nav.js 하트비트가 user_id별 last_seen 을 주기적으로 갱신한다.
-- =====================================================================

CREATE TABLE IF NOT EXISTS user_presence (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),  -- 마지막 하트비트(=마지막 활동) 시각
  last_path  TEXT,                                -- 마지막으로 머문 화면 파일명
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_presence_last_seen
  ON user_presence (last_seen DESC);
