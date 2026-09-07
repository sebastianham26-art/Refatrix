-- 0204_integration_auth_location.sql
-- 인증 키를 **어디에 실을지**를 설정으로 뺀다.
--   발견(2026-09-07): CRM 운영 엔드포인트는 API key 를 헤더에서 찾지 않는다.
--   헤더 7종은 전부 401 ERR_API_KEY 였고, **쿼리스트링(?apiKey=…)** 으로 보내자 인증을 통과해
--   404 ERR_CUSTOMER_NOT_FOUND(=더미 RFC 조회 실패)가 돌아왔다.
--   → 헤더만 지원하던 전송 엔진에 위치(header|query|body)와 이름을 설정으로 추가한다.
ALTER TABLE integration_endpoints ADD COLUMN IF NOT EXISTS auth_in    TEXT NOT NULL DEFAULT 'header';
ALTER TABLE integration_endpoints ADD COLUMN IF NOT EXISTS auth_param TEXT;
UPDATE integration_endpoints SET auth_param='apiKey' WHERE auth_param IS NULL;
