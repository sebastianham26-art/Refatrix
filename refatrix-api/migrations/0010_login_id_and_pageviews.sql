-- =====================================================================
-- Refatrix ERP · 0010_login_id_and_pageviews
-- 로그인 아이디(아이디+PIN) · 페이지 열람 일별 요약 테이블
-- =====================================================================

-- 로그인 아이디(아이디 + PIN 조합) ---------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_id TEXT;
-- 기존 행 대비 부분 유니크(중복/NULL 허용 안전): NULL 제외 유니크
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_login_id
  ON users (login_id) WHERE login_id IS NOT NULL;

-- 페이지 열람 일별 요약(감사 로그 혼합 방식의 '요약' 쪽) -------------
CREATE TABLE IF NOT EXISTS page_view_daily (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  view_date  DATE NOT NULL,
  page_key   TEXT NOT NULL,
  view_count INT NOT NULL DEFAULT 1,
  last_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, view_date, page_key)
);
CREATE INDEX IF NOT EXISTS idx_pvd_user_date ON page_view_daily (user_id, view_date);
