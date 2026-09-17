-- 0223 · 카탈로그 조회 API — 고객에게 보내지 않을 제품코드 접두어
--
--   PRO 로 시작하는 코드는 고객에게 나가면 안 된다(디렉터 결정 2026-09-17).
--   코드에 박아 두지 않고 화면에서 바꿀 수 있게 칼럼으로 둔다 — 나중에 다른 코드군이
--   생겼을 때 배포 없이 막을 수 있어야 한다. 콤마로 여러 개, 대소문자 구분 없음.
ALTER TABLE catalog_api_clients
  ADD COLUMN IF NOT EXISTS exclude_prefixes TEXT DEFAULT 'PRO';

-- 이미 만들어 둔 고객사에도 같은 규칙을 적용한다.
UPDATE catalog_api_clients SET exclude_prefixes = 'PRO' WHERE exclude_prefixes IS NULL;
