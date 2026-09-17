-- 0220 · CRM 견적요청 **수신 창구** — 웹카달록에서 고객이 누른 견적을 ERP 가 정식으로 받는다
--
--   왜 필요했나 (2026-09-17 점검)
--     CRM 은 지금 ERP **화면용 API**(`POST /api/quotes`)를 직원 계정으로 호출하고 있었다.
--     그 API 는 `customer_id` 숫자를 **그대로 믿는다.** CRM 의 5번과 ERP 의 5번은 다른 회사다 —
--     그래서 품목·금액은 맞는데 고객만 엉뚱한 NAJAR 가 되는 사고가 났다.
--     게다가 실패하면 **아무 기록도 남지 않아서**, 「보냈는데 없다」를 추측으로만 다뤘다.
--
--   설계는 이미 검증된 0208(신규고객 등록 수신)을 그대로 따른다.
--     · 인증은 **우리가 발급한 API 키**. 직원 계정으로 로그인시키지 않는다.
--     · 고객은 **RFC 또는 CRM 고객코드**로 찾는다. 숫자 id 는 받지 않는다.
--     · CRM 견적번호(COT-…)를 칼럼에 보관하고 UNIQUE 로 **멱등**을 만든다.
--     · 수신 1건 = 이력 1행. 거절도 남는다.

-- ── ① CRM 에서 온 견적임을 quotes 에 남긴다 ────────────────────────────
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS external_quote_no TEXT;   -- CRM 번호(COT-…) 원문
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS origin            TEXT;   -- 'crm' = 웹에서 들어옴

-- 멱등의 근거. 같은 COT 가 두 번 와도 견적은 하나다.
--   ⚠ 메모 안에만 적어 두면(예전 방식) 중복을 막을 수단이 아예 없다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_quotes_external_no
  ON quotes (external_quote_no) WHERE external_quote_no IS NOT NULL;

-- 담당자 지정 — 웹 가입 신청(0211)과 같은 방식. 디렉터가 지정하고, 지정받은 사람에게 팝업이 뜬다.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS assigned_to BIGINT REFERENCES users(id);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS assigned_by BIGINT REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_quotes_crm_open
  ON quotes (created_at DESC)
  WHERE origin = 'crm' AND status = 'draft' AND deleted_at IS NULL;

-- ── ② 문제 있는 줄에 이유를 적어 둔다 ──────────────────────────────────
--   not_found(코드를 못 찾음) · multi_match(SYD 가 여러 제품에 걸림) · inactive(판매중단)
--   이 값이 하나라도 있으면 **견적 확정을 막는다** — 단가 0 짜리 줄이 붙은 견적이
--   고객에게 나가는 것이 지금 가장 위험한 일이다.
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS issue TEXT;

-- ── ③ 견적 알림을 받을 사람 ────────────────────────────────────────────
--   ⚠ 가입 신청(crm_lead_notify_targets)과 **따로** 둔다. 새 고객을 맞는 사람과
--     견적을 처리하는 사람은 같지 않다. 한 표를 같이 쓰면 언젠가 한쪽이 틀린다.
CREATE TABLE IF NOT EXISTS crm_quote_notify_targets (
  user_id   BIGINT PRIMARY KEY REFERENCES users(id),
  added_by  BIGINT REFERENCES users(id),
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── ④ 연동 등록부에 수신 창구 1건 ──────────────────────────────────────
INSERT INTO integration_endpoints
  (key, category, label, description, enabled, env, direction, inbound_path,
   method_upsert, auth_in, auth_param, ok_code, contract, sort_order)
VALUES (
  'crm_quote_request', 'quote', '견적요청 (수신)',
  '고객이 웹카달록에서 견적을 요청하면 CRM 이 이 주소로 보낸다. ERP 가 고객을 RFC 로 찾아 견적서를 만들고 담당자에게 팝업으로 알린다.',
  true, 'prod', 'in', '/api/integrations/crm/quote',
  'POST', 'header', 'x-api-key', '0',
  '{"fields":[
      {"name":"rfc","type":"string","required":true,"es":"RFC del cliente — asi identificamos al cliente en el ERP","ko":"고객 RFC (필수) — 고객을 찾는 열쇠. 숫자 id 는 받지 않는다"},
      {"name":"lineas","type":"array","required":true,"es":"Lineas de la cotizacion: [{codigo, cantidad}]","ko":"견적 줄 배열: [{codigo, cantidad}]"},
      {"name":"lineas[].codigo","type":"string","required":true,"es":"Codigo CTR o codigo SYD equivalente","ko":"CTR 코드 또는 SYD 코드"},
      {"name":"lineas[].cantidad","type":"number","required":true,"es":"Cantidad solicitada (entero > 0)","ko":"수량"},
      {"name":"cotizacionCrm","type":"string","required":false,"es":"Folio de la cotizacion en el portal (COT-...). Se guarda y evita duplicados: si reenvias el mismo folio devolvemos la misma cotizacion","ko":"CRM 견적번호 — 저장되고 **중복 방지 키**가 된다. 같은 번호 재전송 시 기존 견적을 돌려준다"},
      {"name":"clienteCrm","type":"string","required":false,"es":"Codigo del cliente en el CRM (alternativa al RFC)","ko":"CRM 고객코드 — RFC 대신 쓸 수 있다"},
      {"name":"fecha","type":"string","required":false,"es":"Fecha de la solicitud (YYYY-MM-DD). Por omision, hoy","ko":"견적일자 — 비우면 오늘"},
      {"name":"comentario","type":"string","required":false,"es":"Comentario del cliente","ko":"고객 메모"},
      {"name":"solicitante","type":"string","required":false,"es":"Nombre o correo de quien pidio la cotizacion","ko":"요청한 사람"}
    ],
   "sample_request":"{\n  \"cotizacionCrm\": \"COT-20260917120000001\",\n  \"rfc\": \"AIAC8310204A0\",\n  \"fecha\": \"2026-09-17\",\n  \"comentario\": \"Urgente para el jueves\",\n  \"lineas\": [\n    { \"codigo\": \"GV0022\", \"cantidad\": 3 },\n    { \"codigo\": \"CB0145\", \"cantidad\": 2 }\n  ]\n}",
   "sample_response":"{\n  \"codigoError\": \"0\",\n  \"mensaje\": \"Cotizacion recibida\",\n  \"cotizacionErp\": \"Q-2026-0142\",\n  \"quoteId\": 142,\n  \"lineasConProblema\": []\n}",
   "raw":"",
   "notes":"고객은 RFC(또는 CRM 고객코드)로만 찾는다 — 숫자 id 는 받지 않는다(남의 고객에 붙는 사고를 막기 위해). 같은 cotizacionCrm 을 다시 보내면 견적은 새로 생기지 않고 기존 번호를 돌려준다. 못 찾은 코드·판매중단 SKU 가 있어도 견적은 만들어지되 그 줄이 표시되고 **확정이 잠긴다**."}'::jsonb,
  19)
ON CONFLICT (key) DO NOTHING;
