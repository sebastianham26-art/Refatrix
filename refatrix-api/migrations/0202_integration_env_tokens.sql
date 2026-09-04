-- 0202_integration_env_tokens.sql
-- 인증 키를 **환경별로** 나눈다 — 테스트 키와 운영 키가 서로 다르기 때문이다.
--
--   0201 은 URL 만 테스트/운영으로 나누고 키는 하나(auth_token)로 뒀다.
--   실제 CRM 은 서버마다 API key 가 다르므로, 운영으로 전환할 때마다 키를 지우고 다시 넣어야 했다
--   — URL 을 두 칸으로 둔 이유(되돌릴 때 옛 값을 다시 찾지 않게)가 키에도 그대로 적용된다.
--
--   기존 auth_token 은 **지우지 않는다.** 환경별 키가 비어 있으면 그 값으로 되돌아간다
--   (반쪽 배포·기존 설정 보호).

ALTER TABLE integration_endpoints ADD COLUMN IF NOT EXISTS auth_token_test TEXT;
ALTER TABLE integration_endpoints ADD COLUMN IF NOT EXISTS auth_token_prod TEXT;

-- 지금까지 넣어 둔 키는 테스트 서버용이었다(운영 URL 이 아직 없으므로).
UPDATE integration_endpoints
   SET auth_token_test = auth_token
 WHERE auth_token IS NOT NULL AND btrim(auth_token) <> '' AND auth_token_test IS NULL;
