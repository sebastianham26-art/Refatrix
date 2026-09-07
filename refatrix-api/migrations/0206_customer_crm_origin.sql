-- 0206_customer_crm_origin.sql
-- 카탈로그(CRM)에서 들어온 고객을 ERP 에서 구분한다.
--   코드 접두어(P-####)만으로도 눈에 띄지만, "어디서 왔는가"는 코드 형식이 아니라
--   **데이터**로 남아야 한다(나중에 코드 규칙이 바뀌어도 출처는 유지된다).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS crm_customer_code TEXT;   -- CRM 쪽 코드(WEB-14 등)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS crm_registered_at TIMESTAMPTZ;

-- 같은 CRM 코드가 두 고객에 붙지 않게(비어 있는 값은 제외).
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_crm_code
  ON customers (crm_customer_code) WHERE crm_customer_code IS NOT NULL;

-- 이미 P- 로 시작하는 고객이 있다면(수기 등록 등) 출처를 채워 준다.
UPDATE customers SET crm_registered_at = COALESCE(crm_registered_at, created_at)
 WHERE code ILIKE 'P-%' AND crm_registered_at IS NULL;
