-- 0208 · CRM → ERP 수신(신규고객 등록)
--
--   지금까지 연동은 ERP → CRM 한 방향(out)뿐이었다. 웹카달록에서 고객이 스스로 등록하면
--   그 데이터가 ERP 로 넘어와 **승인 대기**에 쌓여야 한다. 그 수신 창구를 등록부에 넣는다.
--
--   설계 요지
--     · integration_endpoints 를 그대로 쓴다(방향만 direction 으로 구분).
--       - out : 우리가 상대에게 보낸다 → url_test/url_prod = 상대 주소, auth_token_* = 상대가 준 키
--       - in  : 상대가 우리에게 보낸다 → inbound_path = 우리 주소, auth_token_* = **우리가 발급한 키**
--     · 수신 키는 화면에서 「새 키 발급」으로 서버가 만든다(사람이 타이핑하지 않는다).
--     · 수신 1건마다 crm_inbound_log 에 원문·판정·응답을 남긴다 — 전송 이력의 반대편.

ALTER TABLE integration_endpoints
  ADD COLUMN IF NOT EXISTS direction    TEXT NOT NULL DEFAULT 'out',
  ADD COLUMN IF NOT EXISTS inbound_path TEXT;

DO $$ BEGIN
  ALTER TABLE integration_endpoints
    ADD CONSTRAINT integration_endpoints_direction_chk CHECK (direction IN ('out','in'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 수신 연동 1건 — CRM 신규고객 등록 -------------------------------------
--   auth_in/auth_param 은 "우리가 어디서 키를 읽는가"의 **기본 표시**다.
--   실제 수신부는 헤더·쿼리·본문 셋 다 받는다(상대 구현을 막지 않기 위해).
INSERT INTO integration_endpoints
  (key, category, label, description, enabled, env, direction, inbound_path,
   method_upsert, auth_in, auth_param, ok_code, contract, sort_order)
VALUES (
  'crm_customer_registration', 'customer', 'CRM 신규고객 등록(수신)',
  '웹카달록에서 고객이 등록 → ERP 승인 대기함으로 수신. 고객코드는 P-#### 로 채번된다.',
  true, 'prod', 'in', '/api/integrations/crm/customer-registration',
  'POST', 'header', 'x-api-key', '0',
  '{"fields":[
      {"name":"rfc","type":"string","required":true,"es":"RFC del cliente","ko":"RFC — 매칭 키(필수)"},
      {"name":"nombre","type":"string","required":true,"es":"Nombre o razon social","ko":"상호·성명(필수)"},
      {"name":"apellido","type":"string","required":true,"es":"Apellido","ko":"성(필수)"},
      {"name":"telefono","type":"string","required":true,"es":"Telefono","ko":"전화(필수)"},
      {"name":"correo","type":"string","required":true,"es":"Correo electronico","ko":"이메일(필수)"},
      {"name":"crmCustomerCode","type":"string","required":false,"es":"Codigo del cliente en el CRM","ko":"CRM 고객코드(customerCode 도 허용)"},
      {"name":"discountPercent","type":"number","required":false,"es":"Descuento solicitado","ko":"요청 할인율 — 최종값은 디렉터가 정한다"},
      {"name":"paymentDays","type":"integer","required":false,"es":"Dias de credito solicitados","ko":"요청 신용일수"},
      {"name":"sydRefBuyPrice","type":"number","required":false,"es":"Precio compra sin IVA codigo #1516050","ko":"기준품목 구매단가 — 할인 제안 근거"},
      {"name":"vendedorCorreo","type":"string","required":false,"es":"Correo del asesor asignado","ko":"담당 영업 식별 키(ERP login_id 와 대조)"},
      {"name":"estado","type":"string","required":false,"es":"Estado","ko":"주"},
      {"name":"ciudad","type":"string","required":false,"es":"Ciudad","ko":"도시"},
      {"name":"direccion","type":"string","required":false,"es":"Direccion","ko":"주소"},
      {"name":"transactionUser","type":"string","required":false,"es":"Usuario del CRM que origina","ko":"CRM 측 작업자"}
    ],
   "sample_request":"{\n  \"rfc\": \"CQR1603288MA\",\n  \"nombre\": \"COMERCIALIZADORA QUALI DE REFACCIONES\",\n  \"apellido\": \"LIRA\",\n  \"telefono\": \"8113843028\",\n  \"correo\": \"adrian@ejemplo.com\"\n}",
   "sample_response":"{\n  \"codigoError\": \"0\",\n  \"mensaje\": \"Cliente recibido, pendiente de aprobacion del director\",\n  \"erpCustomerCode\": \"P-0001\",\n  \"estatus\": \"pendiente\"\n}",
   "raw":"","notes":"필수 5개 외에는 모두 선택. 같은 RFC 재전송은 중복 생성 없이 갱신(멱등)."}'::jsonb,
  15)
ON CONFLICT (key) DO NOTHING;

-- 수신 이력 -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_inbound_log (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  endpoint_key   TEXT NOT NULL DEFAULT 'crm_customer_registration',
  remote_ip      TEXT,
  auth_in        TEXT,                        -- 키가 실제로 어디로 왔는가(header|query|body|none)
  auth_ok        BOOLEAN NOT NULL DEFAULT false,
  rfc            TEXT,
  crm_code       TEXT,
  customer_id    BIGINT REFERENCES customers(id),
  erp_code       TEXT,
  result         TEXT,                        -- created | updated | rejected
  http_status    INT,
  codigo_error   TEXT,
  mensaje        TEXT,
  payload        JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_inbound_at  ON crm_inbound_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_inbound_rfc ON crm_inbound_log (rfc);
