-- 0214 · 전송 창구가 **다른 창구의 API 키를 물려받는다**
--
--   CRM 개발자 확인: 신규 등록 창구도 **기존과 같은 API 키**를 쓴다.
--
--   그러면 키를 두 행에 각각 저장할 수도 있지만, 그렇게 하면 **나중에 키를 바꿀 때
--   한쪽만 고치고 잊는다.** 그날부터 한 창구는 조용히 401 을 맞는다 —
--   이 프로젝트에서 이미 겪은 종류의 사고다(규칙이 두 군데 있으면 반드시 엇갈린다).
--
--   그래서 키는 **한 곳에만 둔다.** 새 창구는 「어디서 물려받을지」만 가리킨다.
--     · 자기 키가 있으면 그걸 쓴다(나중에 분리하고 싶으면 그냥 발급하면 된다).
--     · 자기 키가 없으면 auth_from 이 가리키는 창구의 키를 쓴다.
--   0208 의 수신 창구 키 폴백과 같은 생각이고, 이번엔 **전송** 쪽이다.

ALTER TABLE integration_endpoints
  ADD COLUMN IF NOT EXISTS auth_from TEXT;

-- 신규 등록 창구는 상거래정보 창구의 키를 함께 쓴다.
UPDATE integration_endpoints
   SET auth_from = 'customer_commercial'
 WHERE key = 'customer_create' AND auth_from IS NULL;

-- 인증을 **어디에 싣는지**도 맞춰 둔다.
--   이 CRM 은 쿼리스트링(?apiKey=)으로 받는다는 걸 0204 에서 실측으로 확인했다.
--   같은 서버·같은 키라면 싣는 자리도 같을 가능성이 크므로, 상거래정보 창구의
--   현재 설정을 그대로 복사한다(다르면 화면에서 고치면 된다).
UPDATE integration_endpoints t
   SET auth_in    = s.auth_in,
       auth_param = s.auth_param,
       auth_header = s.auth_header
  FROM integration_endpoints s
 WHERE t.key = 'customer_create' AND s.key = 'customer_commercial';
