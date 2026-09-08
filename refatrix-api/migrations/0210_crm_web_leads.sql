-- 0210 · 웹 카달록 회원가입 신청(리드) 수신 + 알림
--
--   문제: 고객이 홈페이지에서 회원가입을 하면 CRM 에만 기초정보가 쌓인다.
--         영업사원이 그걸 들여다보지 않으면 고객은 **가격도 재고도 못 본 채 계속 「승인 대기」** 다.
--         아무도 모른 채로 며칠이 지나는 게 지금의 진짜 손실이다.
--
--   해법: 가입 신청이 들어오는 즉시 그 원문을 ERP 로 보내게 하고(단순 알림),
--         ERP 는 상시 켜져 있으니 **팝업**으로 사람에게 들이민다.
--         누구에게 띄울지는 디렉터가 연동 관리 화면에서 사람 단위로 고른다.
--
--   설계 요지
--     · 리드는 **고객이 아니다.** customers 에 행을 만들지 않는다 —
--       상업정보(할인·신용일수·기준단가)가 하나도 없는 채로 고객이 생기면
--       승인 대기함이 쓰레기로 찬다. 리드는 리드로 쌓고, 사람이 판단해 고객으로 옮긴다.
--     · 고객이 입력한 **모든 값**을 payload 에 원문 그대로 박제한다.
--       화면에 뽑아 쓰는 몇 개만 컬럼으로 둔다(검색·중복 판정용).
--     · 기록은 지우지 않는다. 처리 상태(new·claimed·done·dismissed)만 바뀐다.

CREATE TABLE IF NOT EXISTS crm_web_leads (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  crm_lead_code  TEXT,                      -- CRM 쪽 식별자(WEB-128 등). 멱등 키.
  empresa        TEXT,                      -- 회사명
  nombre         TEXT,                      -- 가입자 이름
  apellido       TEXT,
  telefono       TEXT,
  correo         TEXT,
  rfc            TEXT,
  rfc_norm       TEXT GENERATED ALWAYS AS
                   (NULLIF(upper(regexp_replace(coalesce(rfc, ''), '[^A-Za-z0-9]', '', 'g')), '')) STORED,
  ciudad         TEXT,
  estado         TEXT,
  direccion      TEXT,
  mensaje        TEXT,                      -- 고객이 남긴 문의·비고
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- 고객이 입력한 전부(원문)
  remote_ip      TEXT,
  auth_in        TEXT,
  status         TEXT NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new','claimed','done','dismissed')),
  claimed_by     BIGINT REFERENCES users(id),
  claimed_at     TIMESTAMPTZ,
  closed_by      BIGINT REFERENCES users(id),
  closed_at      TIMESTAMPTZ,
  close_reason   TEXT,
  customer_id    BIGINT REFERENCES customers(id),      -- 고객이 되면 연결
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 같은 신청을 두 번 보내와도 하나로 본다(상대가 재시도해도 팝업이 두 번 뜨지 않게).
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_web_leads_code
  ON crm_web_leads (crm_lead_code) WHERE crm_lead_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_web_leads_open
  ON crm_web_leads (received_at DESC) WHERE status IN ('new','claimed');
CREATE INDEX IF NOT EXISTS idx_crm_web_leads_rfc ON crm_web_leads (rfc_norm);

-- 알림 대상 — **사람 단위**로 고른다(디렉터는 설정과 무관하게 항상 받는다).
CREATE TABLE IF NOT EXISTS crm_lead_notify_targets (
  user_id   BIGINT PRIMARY KEY REFERENCES users(id),
  added_by  BIGINT REFERENCES users(id),
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 수신 연동 1건 추가 — 연동 관리 화면에서 주소·키·계약서를 관리한다(0208 과 같은 구조).
INSERT INTO integration_endpoints
  (key, category, label, description, enabled, env, direction, inbound_path,
   method_upsert, auth_in, auth_param, ok_code, contract, sort_order)
VALUES (
  'crm_web_lead', 'customer', '웹 가입 신청 알림(수신)',
  '고객이 웹카달록에서 회원가입을 누르는 즉시 기초정보를 ERP 로 알린다. 고객을 만들지 않고 알림·이력만 남긴다.',
  true, 'prod', 'in', '/api/integrations/crm/customer-lead',
  'POST', 'header', 'x-api-key', '0',
  '{"fields":[
      {"name":"empresa","type":"string","required":true,"es":"Nombre de la empresa","ko":"회사명(필수)"},
      {"name":"nombre","type":"string","required":true,"es":"Nombre de quien se registra","ko":"가입자 이름(필수)"},
      {"name":"telefono","type":"string","required":true,"es":"Telefono de contacto","ko":"연락처(필수)"},
      {"name":"correo","type":"string","required":true,"es":"Correo electronico","ko":"이메일(필수)"},
      {"name":"rfc","type":"string","required":true,"es":"RFC de la empresa","ko":"RFC(필수)"},
      {"name":"crmLeadCode","type":"string","required":false,"es":"Identificador del registro en el CRM","ko":"CRM 신청 식별자 — 중복 알림 방지 키"},
      {"name":"apellido","type":"string","required":false,"es":"Apellido","ko":"성"},
      {"name":"ciudad","type":"string","required":false,"es":"Ciudad","ko":"도시"},
      {"name":"estado","type":"string","required":false,"es":"Estado","ko":"주"},
      {"name":"direccion","type":"string","required":false,"es":"Direccion","ko":"주소"},
      {"name":"mensaje","type":"string","required":false,"es":"Comentario que dejo el cliente","ko":"고객이 남긴 메모"},
      {"name":"solicitadoEn","type":"string","required":false,"es":"Fecha y hora del registro (ISO 8601)","ko":"가입 신청 시각"}
    ],
   "sample_request":"{\n  \"crmLeadCode\": \"WEB-128\",\n  \"empresa\": \"REFACCIONARIA HEBRY\",\n  \"nombre\": \"Adrian\",\n  \"apellido\": \"Lira\",\n  \"telefono\": \"8113843028\",\n  \"correo\": \"adrian@ejemplo.com\",\n  \"rfc\": \"CQR1603288MA\",\n  \"ciudad\": \"Monterrey\",\n  \"estado\": \"Nuevo Leon\"\n}",
   "sample_response":"{\n  \"codigoError\": \"0\",\n  \"mensaje\": \"Solicitud recibida, un asesor lo contactara\",\n  \"leadId\": 12\n}",
   "raw":"","notes":"고객을 만들지 않는다 — 알림과 이력만. 상업정보는 영업사원이 통화 후 채운다. 보내온 필드는 전부 보관·표시된다."}'::jsonb,
  18)
ON CONFLICT (key) DO NOTHING;
