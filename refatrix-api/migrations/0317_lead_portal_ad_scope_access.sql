-- =====================================================================
-- 0317 · 고객 포털 — 광고별 열람 범위 · 접속 기록 (2026-11-05 디렉터)
--   ① 접속코드마다 볼 수 있는 광고를 고른다(scope_ads = 광고 ID 목록, NULL = 모든 광고).
--      문의의 광고는 ERP 「Meta 광고 문의」와 같은 규칙(직접 지정 > Meta 웹훅 > 대화 속 광고 ID > 구분 문구).
--   ② 접속 기록 — 로그인 · 화면 열기 · 사용 중(5분마다 1번) → 고객별 · 날짜별 접속 시각.
-- 재실행 안전.
-- =====================================================================
ALTER TABLE lead_portal_codes ADD COLUMN IF NOT EXISTS scope_ads TEXT[];

CREATE TABLE IF NOT EXISTS lead_portal_access (
  id       BIGSERIAL PRIMARY KEY,
  code_id  BIGINT NOT NULL REFERENCES lead_portal_codes(id),
  kind     TEXT   NOT NULL CHECK (kind IN ('login','open','active')),
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip       TEXT,
  ua       TEXT
);
CREATE INDEX IF NOT EXISTS lead_portal_access_code_at ON lead_portal_access (code_id, at);
CREATE INDEX IF NOT EXISTS lead_portal_access_at ON lead_portal_access (at);
