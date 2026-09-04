-- 0201_integration_endpoints.sql
-- 외부 연동(CRM · 웹 카달록) 관리 — URL·계약서·인증을 **ERP 관리자 화면에서** 고치기 위한 등록부.
--
--   왜: 0200 은 전송 설정을 환경변수(CRM_SYNC_*)에 두었다. 그러면 URL 하나 바꾸는 데
--   Railway 콘솔이 필요하고, 연동이 고객·제품으로 늘어나면 변수가 종류만큼 늘어난다.
--   → 연동 1건 = 이 테이블의 1행. 켜고 끄기·테스트/운영 전환·계약서 보관까지 화면에서 한다.
--
--   환경변수는 남지만 **DB 행이 우선**이다(행이 없거나 테이블이 없으면 환경변수로 되돌아간다).

CREATE TABLE IF NOT EXISTS integration_endpoints (
  id            BIGSERIAL PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,               -- customer_commercial | product | …
  category      TEXT NOT NULL DEFAULT 'other',      -- customer | product | other
  label         TEXT NOT NULL,
  description   TEXT,
  enabled       BOOLEAN NOT NULL DEFAULT false,     -- 실제 전송 여부(관리자 화면 스위치)
  env           TEXT NOT NULL DEFAULT 'test',       -- test | prod — 어느 URL 을 쓸지
  url_test      TEXT,
  url_prod      TEXT,
  method_upsert TEXT NOT NULL DEFAULT 'POST',
  method_delete TEXT NOT NULL DEFAULT 'DELETE',
  auth_header   TEXT NOT NULL DEFAULT 'Authorization',
  auth_token    TEXT,                               -- 화면에는 마스킹해서 내려간다
  ok_code       TEXT NOT NULL DEFAULT '0',          -- 성공으로 볼 codigoError
  user_field    TEXT NOT NULL DEFAULT 'login_id',   -- transactionUser 로 보낼 사용자 필드
  timeout_ms    INT  NOT NULL DEFAULT 10000,
  -- 계약서: {fields:[{name,type,required,es,ko}], sample_request, sample_response, raw, notes}
  contract      JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order    INT  NOT NULL DEFAULT 100,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT
);

-- 설정 변경 이력 — "언제 누가 운영 URL 로 바꿨나"에 답할 수 있어야 한다.
CREATE TABLE IF NOT EXISTS integration_endpoint_changes (
  id          BIGSERIAL PRIMARY KEY,
  endpoint_id BIGINT NOT NULL REFERENCES integration_endpoints(id) ON DELETE CASCADE,
  changed_by  BIGINT,
  changes     JSONB NOT NULL,                        -- {field:{old,new}} · 토큰은 값 대신 '(변경됨)'
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_int_ep_changes ON integration_endpoint_changes (endpoint_id, changed_at DESC);

-- ===== 아웃박스 일반화 — 고객 외 연동(제품 등)도 같은 이력에 남는다 =====
ALTER TABLE crm_customer_outbox ADD COLUMN IF NOT EXISTS endpoint_key   TEXT NOT NULL DEFAULT 'customer_commercial';
ALTER TABLE crm_customer_outbox ADD COLUMN IF NOT EXISTS entity         TEXT NOT NULL DEFAULT 'customer';
ALTER TABLE crm_customer_outbox ADD COLUMN IF NOT EXISTS entity_id      BIGINT;
ALTER TABLE crm_customer_outbox ADD COLUMN IF NOT EXISTS entity_label   TEXT;   -- 코드·상호 스냅샷(고객이 지워져도 이력이 남게)
ALTER TABLE crm_customer_outbox ADD COLUMN IF NOT EXISTS env            TEXT;   -- 전송 당시 환경
ALTER TABLE crm_customer_outbox ADD COLUMN IF NOT EXISTS url            TEXT;   -- 전송 당시 주소
ALTER TABLE crm_customer_outbox ADD COLUMN IF NOT EXISTS request_method TEXT;

UPDATE crm_customer_outbox SET entity_id = customer_id WHERE entity_id IS NULL;

-- 제품 등 고객이 아닌 전송 건은 customer_id 가 비어 있어야 한다.
DO $$ BEGIN
  ALTER TABLE crm_customer_outbox ALTER COLUMN customer_id DROP NOT NULL;
EXCEPTION WHEN others THEN RAISE NOTICE 'customer_id NOT NULL 해제 생략'; END $$;

CREATE INDEX IF NOT EXISTS idx_crm_outbox_endpoint ON crm_customer_outbox (endpoint_key, created_at DESC);

-- ===== 초기 등록: 고객(운영 중) · 제품(계약서 준비 단계) =====
INSERT INTO integration_endpoints (key, category, label, description, enabled, env, url_test, url_prod, contract, sort_order)
VALUES (
  'customer_commercial', 'customer', '고객 상거래정보',
  'ERP 승인(등록·수정·삭제) → CRM 고객 상거래조건 반영. 조회 키는 RFC.',
  false, 'test',
  'http://138.197.25.94/api/integrations/erp/customer-commercial',
  NULL,
  '{"fields":[
      {"name":"rfc","type":"string(13)","required":true,"es":"RFC del cliente para consultarlo","ko":"고객 RFC — CRM 조회·매칭 키"},
      {"name":"discountPercent","type":"number","required":true,"es":"El descuento para un cliente","ko":"고객 할인율(%)"},
      {"name":"paymentDays","type":"integer","required":true,"es":"Los dias de pago","ko":"결제 기일(신용 일수)"},
      {"name":"transactionUser","type":"string","required":true,"es":"El usuario de ERP que esta haciendo la operacion (admin, marketing…)","ko":"작업을 수행한 ERP 사용자"}
    ],
   "sample_request":"{\n  \"rfc\": \"FEL990715AB1\",\n  \"discountPercent\": 15,\n  \"paymentDays\": 45,\n  \"transactionUser\": \"admin\"\n}",
   "sample_response":"{\n  \"codigoError\": \"0\",\n  \"mensaje\": \"Cliente Actualizado correctamente\"\n}",
   "raw":"","notes":"오류코드 목록·인증 방식·HTTPS 여부는 개발자 확인 대기."}'::jsonb,
  10)
ON CONFLICT (key) DO NOTHING;

INSERT INTO integration_endpoints (key, category, label, description, enabled, env, contract, sort_order)
VALUES (
  'product', 'product', '제품정보',
  '제품 마스터(코드·가격·재고 등) → CRM 자동 전송. 계약서 확정 후 사용.',
  false, 'test',
  '{"fields":[],"sample_request":"","sample_response":"{\n  \"codigoError\": \"0\",\n  \"mensaje\": \"\"\n}","raw":"","notes":"계약서 준비 중 — 개발자에게 받은 내용을 이 화면에 붙여넣는다."}'::jsonb,
  20)
ON CONFLICT (key) DO NOTHING;
