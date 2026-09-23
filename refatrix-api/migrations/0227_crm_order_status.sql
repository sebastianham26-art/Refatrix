-- 0227 · 오더상태 (전송) — ERP 의 수주 단계가 바뀌면 CRM(웹카달록)에 알린다
--
--   CRM 화면의 오더 단계는 4개다(디렉터 정의, 2026-09-23).
--     1 solicitud_nueva      Solicitud nueva       CRM 견적이 ERP 에 정상 접수돼 견적이 만들어졌다
--     2 surtiendo            Surtiendo             포장작업지시서가 출력됐다(포장 단계 진입)
--     3 preparando_despacho  Preparando despacho   포장이 끝나 SAT 발행을 기다린다
--     4 oc_enviada           OC Enviada            실제 SAT 번호가 등록돼 수금 단계로 넘어갔다
--
--   판정은 새로 만들지 않는다 — 수주 SLA 가 쓰는 computeQuoteStage 를 그대로 쓴다
--   (규칙이 두 군데 있으면 언젠가 엇갈린다. 「SLA 는 수금인데 CRM 은 포장중」 이 그 모습이다).
--
--   ① 단계별 발송 장부 — (견적, 단계) 1쌍에 1행. 기본키가 **중복 발송을 DB 에서 막는다.**
--      훅(즉시)과 감시(안전망)가 같은 순간에 같은 견적을 봐도 한 번만 나간다.
--   ② 연동 등록부 1행 — 주소·키 전달 방식은 「고객 상거래정보」 것을 그대로 쓴다.
--      키는 복사하지 않고 **물려받는다**(auth_from) — 키를 바꿀 때 한 곳만 고치면 된다.
--
--   멱등(IF NOT EXISTS / ON CONFLICT) — 재실행 안전.

-- ── ① 단계별 발송 장부 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_order_status_events (
  quote_id    BIGINT      NOT NULL REFERENCES quotes(id),
  seq         SMALLINT    NOT NULL CHECK (seq BETWEEN 1 AND 4),
  status      TEXT        NOT NULL,                  -- solicitud_nueva | surtiendo | preparando_despacho | oc_enviada
  event_at    TIMESTAMPTZ,                           -- ERP 에서 그 단계가 실제로 일어난 시각
  outbox_id   BIGINT,                                -- crm_customer_outbox.id (전송 이력)
  origin      TEXT,                                  -- 누가 일으켰나: crm_quote_created | packing_printed | packed | converted | sat_entered | sweep
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (quote_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_crm_ose_created ON crm_order_status_events (created_at DESC);

-- ── ② 연동 등록부 ───────────────────────────────────────────────────
--   처음에는 **꺼진 채로** 들어간다. CRM 개발자가 받는 쪽을 만들었다고 확인하면 화면에서 켠다.
--   꺼져 있는 동안은 아무것도 쌓지 않는다 — 켜는 순간 감시가 지금 단계까지 따라잡아 보낸다.
INSERT INTO integration_endpoints
  (key, category, label, description, enabled, env, direction,
   method_upsert, method_delete, auth_in, auth_param, auth_header, ok_code, user_field,
   timeout_ms, no_retry_codes, contract, sort_order)
VALUES (
  'order_status', 'order', '오더상태 (전송)',
  'ERP 수주 단계가 바뀌면 CRM 오더 단계(Solicitud nueva · Surtiendo · Preparando despacho · OC Enviada)를 보낸다. 웹카달록에서 들어온 견적(COT-…)만 대상. 주소·API 키는 「고객 상거래정보」와 같은 서버·같은 키.',
  false, 'test', 'out',
  'POST', 'DELETE', 'header', 'apiKey', 'Authorization', '0', 'login_id',
  10000, '',
  '{"fields":[
      {"name":"eventoId","type":"string","required":true,"es":"Identificador unico del evento (ERP-<quoteId>-<secuencia>). Si llega repetido, ignorarlo: es un reintento","ko":"이벤트 고유 ID — 같은 값이 다시 오면 재전송이므로 무시"},
      {"name":"cotizacionCrm","type":"string","required":true,"es":"Folio del portal (COT-...). Llave para encontrar el pedido en el CRM","ko":"포털 견적번호(COT-…) — CRM 이 오더를 찾는 키"},
      {"name":"cotizacionErp","type":"string","required":true,"es":"Numero de cotizacion en el ERP (normalmente igual al folio del portal)","ko":"ERP 견적번호(대개 COT 번호와 같다)"},
      {"name":"rfc","type":"string","required":true,"es":"RFC del cliente","ko":"고객 RFC"},
      {"name":"estatus","type":"string","required":true,"es":"solicitud_nueva | surtiendo | preparando_despacho | oc_enviada","ko":"오더 단계 코드"},
      {"name":"estatusTexto","type":"string","required":true,"es":"Texto para mostrar: Solicitud nueva | Surtiendo | Preparando despacho | OC Enviada","ko":"화면 표시 문구"},
      {"name":"secuencia","type":"integer","required":true,"es":"1 a 4. Nunca retrocede. Si llega una secuencia menor a la que ya tiene el pedido, ignorarla","ko":"단계 번호 1~4 — 뒤로 가지 않는다. 더 작은 값이 오면 무시"},
      {"name":"fechaEstatus","type":"string(ISO 8601)","required":true,"es":"Fecha y hora en que ocurrio la etapa en el ERP (UTC, con Z)","ko":"그 단계가 ERP 에서 일어난 시각(UTC)"},
      {"name":"folioSat","type":"string","required":false,"es":"Solo en oc_enviada: folio fiscal SAT de la factura","ko":"oc_enviada 에만 — SAT 번호"},
      {"name":"ordenCompraCliente","type":"string","required":false,"es":"Orden de compra del cliente, si existe","ko":"고객 PO 번호(있을 때만)"},
      {"name":"transactionUser","type":"string","required":true,"es":"Usuario del ERP que origina el envio","ko":"전송을 일으킨 ERP 사용자"}
    ],
   "sample_request":"{\n  \"eventoId\": \"ERP-142-2\",\n  \"cotizacionCrm\": \"COT-20260917120000001\",\n  \"cotizacionErp\": \"COT-20260917120000001\",\n  \"rfc\": \"AIAC8310204A0\",\n  \"estatus\": \"surtiendo\",\n  \"estatusTexto\": \"Surtiendo\",\n  \"secuencia\": 2,\n  \"fechaEstatus\": \"2026-09-23T16:05:12Z\",\n  \"transactionUser\": \"admin\"\n}",
   "sample_response":"{\n  \"codigoError\": \"0\",\n  \"mensaje\": \"Estatus actualizado\"\n}",
   "raw":"",
   "notes":"계약서 Contrato_API_Estatus_Pedido_v1.0. 주소는 고객 상거래정보와 같은 서버의 /api/integrations/erp/order-status 로 시드했다(개발자가 다른 경로를 주면 여기서 고친다). API 키는 고객 상거래정보에서 물려받는다. 웹(COT) 견적만 보낸다. 단계는 앞으로만 간다. 단계를 건너뛸 수 있다(예: 포장지시서 없이 바로 전환)."}'::jsonb,
  25)
ON CONFLICT (key) DO NOTHING;

-- 키는 **물려받는다**(0214 와 같은 방식). 자기 키를 발급하면 그 순간 분리된다.
UPDATE integration_endpoints
   SET auth_from = 'customer_commercial'
 WHERE key = 'order_status' AND auth_from IS NULL;

-- 환경·키를 싣는 자리는 상거래정보 창구의 **현재 설정**을 복사한다(0214 와 같은 판단).
--   주소는 같은 서버에서 경로 끝만 바꾼다:  …/customer-commercial  →  …/order-status
--   상거래정보 주소가 그 모양이 아니면 비워 둔다 — 고객 창구로 오더 본문을 쏘는 일은 없어야 한다.
UPDATE integration_endpoints t
   SET env         = s.env,
       auth_in     = s.auth_in,
       auth_param  = s.auth_param,
       auth_header = s.auth_header,
       url_test = CASE WHEN COALESCE(t.url_test,'') = '' AND s.url_test ~ '/customer-commercial/?$'
                       THEN regexp_replace(s.url_test, '/customer-commercial/?$', '/order-status')
                       ELSE t.url_test END,
       url_prod = CASE WHEN COALESCE(t.url_prod,'') = '' AND s.url_prod ~ '/customer-commercial/?$'
                       THEN regexp_replace(s.url_prod, '/customer-commercial/?$', '/order-status')
                       ELSE t.url_prod END
  FROM integration_endpoints s
 WHERE t.key = 'order_status' AND s.key = 'customer_commercial'
   AND t.updated_by IS NULL;          -- 사람이 한 번이라도 고쳤으면 다시 덮지 않는다
