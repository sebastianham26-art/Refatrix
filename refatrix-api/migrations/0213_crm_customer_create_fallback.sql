-- 0213 · CRM 에 없는 고객을 **등록**하는 창구 + 자동 폴백
--
--   문제: 지금 쓰는 `customer_commercial` 은 RFC 로 CRM 고객을 **찾아서 상거래조건을 고치는**
--         창구다. CRM 에 없는 고객을 보내면 ERR_CUSTOMER_NOT_FOUND 가 돌아오고,
--         우리는 그걸 「재시도해도 소용없음」으로 판단해 skipped 로 닫는다(0207).
--         그래서 「전체 동기화」를 돌려도 **CRM 에 없는 고객은 조용히 빠져나간다.**
--
--   해법: 신규 등록용 창구를 하나 더 두고, **자동 폴백**으로 잇는다.
--
--         ① customer_commercial 로 보낸다
--              ├─ 성공 → 끝
--              └─ ERR_CUSTOMER_NOT_FOUND → ② customer_create 로 다시 보낸다 → 끝
--
--   왜 사람이 고르게 하지 않나: **어느 고객이 CRM 에 있는지 사람은 알 수 없다.**
--   알려면 결국 한 번 보내 봐야 하고, 그 답을 우리는 이미 받고 있다. 그 신호를 버리지 않는다.
--
--   폴백 규칙은 **등록부에 데이터로 둔다**(코드에 박지 않는다) — 상대가 오류코드를 바꾸거나
--   창구를 합치면 화면에서 고칠 수 있어야 한다.

ALTER TABLE integration_endpoints
  ADD COLUMN IF NOT EXISTS fallback_key   TEXT,
  ADD COLUMN IF NOT EXISTS fallback_codes TEXT NOT NULL DEFAULT 'ERR_CUSTOMER_NOT_FOUND';

-- 폴백으로 생긴 전송이 어느 건에서 나왔는지 — 이력에서 두 줄이 이어져 보여야 한다.
ALTER TABLE crm_customer_outbox
  ADD COLUMN IF NOT EXISTS fallback_of BIGINT REFERENCES crm_customer_outbox(id);

-- 신규 등록 창구 --------------------------------------------------------
--   URL 은 비워 둔다. 디렉터가 **연동 관리 화면에서** 개발자가 준 주소를 넣는다.
--   주소가 비어 있거나 꺼져 있으면 폴백은 일어나지 않는다(예전 그대로 skipped).
INSERT INTO integration_endpoints
  (key, category, label, description, enabled, env, direction,
   method_upsert, method_delete, auth_in, auth_param, auth_header, ok_code, user_field,
   timeout_ms, no_retry_codes, contract, sort_order)
VALUES (
  'customer_create', 'customer', '고객 신규 등록(CRM 에 없는 고객)',
  'ERP 에 있고 CRM 에 없는 고객을 CRM 에 새로 만든다. 상거래정보 전송이 ERR_CUSTOMER_NOT_FOUND 로 돌아오면 자동으로 이 창구로 다시 보낸다.',
  false, 'test', 'out',
  'POST', 'DELETE', 'header', 'apiKey', 'x-api-key', '0', 'login_id',
  10000, '',
  '{"fields":[
      {"name":"rfc","type":"string","required":true,"es":"RFC del cliente","ko":"RFC — CRM 조회·매칭 키"},
      {"name":"nombre","type":"string","required":true,"es":"Nombre o razon social","ko":"상호(고객명)"},
      {"name":"erpCustomerCode","type":"string","required":false,"es":"Codigo del cliente en el ERP (C-#### / P-####)","ko":"ERP 고객코드"},
      {"name":"telefono","type":"string","required":false,"es":"Telefono","ko":"전화"},
      {"name":"correo","type":"string","required":false,"es":"Correo electronico","ko":"이메일"},
      {"name":"direccion","type":"string","required":false,"es":"Direccion de entrega","ko":"배송지"},
      {"name":"discountPercent","type":"number","required":true,"es":"Descuento del cliente","ko":"할인율(%)"},
      {"name":"paymentDays","type":"integer","required":true,"es":"Dias de credito","ko":"신용일수"},
      {"name":"estatus","type":"string","required":true,"es":"aprobado | pendiente | rechazado","ko":"ERP 승인 상태"},
      {"name":"transactionUser","type":"string","required":true,"es":"Usuario del ERP que origina","ko":"작업한 ERP 사용자"}
    ],
   "sample_request":"{\n  \"rfc\": \"FEL990715AB1\",\n  \"nombre\": \"REFACCIONARIA EJEMPLO SA DE CV\",\n  \"erpCustomerCode\": \"C-0042\",\n  \"telefono\": \"8113843028\",\n  \"correo\": \"contacto@ejemplo.com\",\n  \"discountPercent\": 15,\n  \"paymentDays\": 45,\n  \"estatus\": \"aprobado\",\n  \"transactionUser\": \"admin\"\n}",
   "sample_response":"{\n  \"codigoError\": \"0\",\n  \"mensaje\": \"Cliente creado correctamente\"\n}",
   "raw":"",
   "notes":"⚠ 개발자 확인 필요: ① 주소(테스트/운영) ② 필수 필드 ③ 이미 있는 RFC 를 보내면 어떻게 되는지(중복 생성인지 갱신인지) ④ API 키가 기존과 같은지. 특히 ③ 이 「중복 생성」이면 동기화를 두 번 눌렀을 때 CRM 에 고객이 둘 생긴다."}'::jsonb,
  12)
ON CONFLICT (key) DO NOTHING;

-- 상거래정보 창구가 「없는 고객」을 만나면 위 창구로 넘긴다.
UPDATE integration_endpoints
   SET fallback_key = 'customer_create',
       fallback_codes = 'ERR_CUSTOMER_NOT_FOUND'
 WHERE key = 'customer_commercial' AND fallback_key IS NULL;
