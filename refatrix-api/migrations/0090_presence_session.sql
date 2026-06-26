-- 0090_presence_session.sql
-- 로그인 세션 이력. nav.js 하트비트(45초)를 gap 기준으로 묶어 '로그인 구간'을 기록한다.
-- user_presence(마지막 시각 1행, 현재 접속 카드용)와는 별개로, 일자별 타임라인 그래프용 이력 테이블.
-- 같은 사용자의 최근 세션이 gap 이내면 last_seen 을 연장하고, gap 을 넘으면 새 세션을 연다.
CREATE TABLE IF NOT EXISTS presence_session (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 최근 세션 조회(연장 판정) 및 사용자별 정렬용
CREATE INDEX IF NOT EXISTS idx_presence_session_user_seen
  ON presence_session (user_id, last_seen DESC);

-- 일자별 구간 교차 조회용
CREATE INDEX IF NOT EXISTS idx_presence_session_span
  ON presence_session (started_at, last_seen);
