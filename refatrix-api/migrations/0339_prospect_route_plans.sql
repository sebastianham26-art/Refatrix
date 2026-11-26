-- 🧭 고객개발 11차 (디렉터 요청 2026-11-26) — 루트를 먼저 짜 두고 날짜는 본인이 고른다
--   prospect_routes.route_date 를 비울 수 있게(NULL = 「방문 목록」 · 날짜 미정). 날짜를 고르면 그날의 루트가 된다.
--   UNIQUE(user_id, route_date) 는 그대로 — NULL 은 서로 겹치지 않으므로 날짜 미정 목록은 여러 개 둘 수 있다.
--   name: 목록 이름(예: 「Guadalupe 11/26 · 1/3」)
-- 멱등 — 재실행 안전.
ALTER TABLE prospect_routes ALTER COLUMN route_date DROP NOT NULL;
ALTER TABLE prospect_routes ADD COLUMN IF NOT EXISTS name TEXT;
CREATE INDEX IF NOT EXISTS ix_prospect_routes_plans ON prospect_routes(user_id) WHERE route_date IS NULL;
