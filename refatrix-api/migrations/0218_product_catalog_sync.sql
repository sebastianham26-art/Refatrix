-- =====================================================================
-- Refatrix ERP · 0218_product_catalog_sync
-- 제품 카탈로그 전송(ERP → CRM 웹카달록) — 계약서 v1.0 구현.
--
--   무엇을
--     · 하루 1회 전체 카탈로그를 묶음(lote)으로 나눠 CRM 에 POST 한다.
--     · 전송 건은 기존 아웃박스(crm_customer_outbox)에 `entity='product'` 로 쌓인다 —
--       재시도·이력·재전송·화면은 고객 연동 것을 **그대로** 재사용한다(새 엔진을 만들지 않는다).
--     · 이 마이그레이션은 ① 연동 설정 칸 4개 ② 실행 이력 표 ③ 제품 창구 계약서 시드만 넣는다.
--
--   왜 실행 이력(product_sync_runs)을 따로 두나
--     아웃박스 행은 「묶음 1개」 단위다. "오늘 전체 전송을 이미 돌렸나"는 묶음을 세서는 알 수 없고,
--     자동 전송이 하루 두 번 나가는 사고가 바로 여기서 난다. 실행 1건 = 이 표의 1행으로 잠근다.
--
--   멱등(IF NOT EXISTS / ON CONFLICT) — 재실행 안전.
-- =====================================================================

-- ① 연동 설정 칸 -------------------------------------------------------
--   img_base_url : 사진 주소 규칙. `{code}` 가 있으면 그 자리에 제품코드를,
--                  없으면 끝에 `/제품코드.jpg` 를 붙인다. 비우면 imagenUrl 은 빈 값.
--   batch_size   : 한 번에 보낼 제품 수(묶음 크기). 상대가 요구하면 화면에서 바꾼다.
--   send_hour_mx : 자동 전송 시각(멕시코 중부시간, 0~23).
--   auto_send    : 자동 전송 사용 여부. 꺼 두면 「지금 보내기」 수동 전송만 된다.
ALTER TABLE integration_endpoints ADD COLUMN IF NOT EXISTS img_base_url TEXT;
ALTER TABLE integration_endpoints ADD COLUMN IF NOT EXISTS batch_size   INT     NOT NULL DEFAULT 500;
ALTER TABLE integration_endpoints ADD COLUMN IF NOT EXISTS send_hour_mx INT     NOT NULL DEFAULT 6;
ALTER TABLE integration_endpoints ADD COLUMN IF NOT EXISTS auto_send    BOOLEAN NOT NULL DEFAULT false;

-- ② 실행 이력 ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_sync_runs (
  id              BIGSERIAL PRIMARY KEY,
  envio_id        TEXT NOT NULL,                    -- 상대에게 보내는 envioId (같은 실행의 모든 묶음이 공유)
  fecha_corte     DATE NOT NULL,                    -- 데이터 기준일(멕시코 날짜)
  mode            TEXT NOT NULL DEFAULT 'full'      -- full = 전체(마지막 묶음에 esUltimoLote) · test = 시험(닫지 않는다)
                  CHECK (mode IN ('full','test')),
  origin          TEXT NOT NULL DEFAULT 'manual',   -- manual | auto
  total_productos INT  NOT NULL DEFAULT 0,
  total_lotes     INT  NOT NULL DEFAULT 0,
  batch_size      INT  NOT NULL DEFAULT 500,
  env             TEXT,                             -- 적재 시점 환경(test|prod)
  note            TEXT,
  created_by      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_psr_created ON product_sync_runs (created_at DESC);
-- 같은 날 전체 전송은 자동으로 한 번만 — 수동은 막지 않는다(사람이 일부러 누른 것).
CREATE UNIQUE INDEX IF NOT EXISTS uq_psr_auto_day
  ON product_sync_runs (fecha_corte) WHERE origin = 'auto' AND mode = 'full';

-- 아웃박스에서 제품 건만 빨리 찾기(이력 화면 · 실행별 조회).
CREATE INDEX IF NOT EXISTS idx_crm_outbox_entity ON crm_customer_outbox (entity, entity_id);

-- ③ 제품 창구 계약서 시드 ---------------------------------------------
--   0201 이 넣어 둔 빈 틀을 계약서 v1.0 내용으로 채운다.
--   **이미 사람이 채워 넣었으면 건드리지 않는다** (fields 가 비어 있을 때만).
UPDATE integration_endpoints
   SET description = 'ERP → CRM(웹카달록) 제품 카탈로그 전송. 하루 1회 전체, 묶음(lote) 단위. 계약서 v1.0.',
       method_upsert = 'POST',
       contract = '{"fields":[
      {"name":"envioId","type":"string","required":true,"es":"Identificador del envio del dia; igual en todos sus lotes","ko":"전송 식별자 — 같은 날 묶음은 모두 동일"},
      {"name":"fechaCorte","type":"string(AAAA-MM-DD)","required":true,"es":"Fecha de corte de la informacion","ko":"데이터 기준일"},
      {"name":"lote","type":"number","required":true,"es":"Numero de lote; empieza en 1","ko":"묶음 번호(1부터)"},
      {"name":"totalLotes","type":"number","required":true,"es":"Cuantos lotes componen el envio","ko":"전체 묶음 수"},
      {"name":"totalProductos","type":"number","required":true,"es":"Total de productos del envio completo","ko":"전체 제품 수"},
      {"name":"esUltimoLote","type":"boolean","required":true,"es":"true en el ultimo lote: los productos que no llegaron en ese envioId se ocultan","ko":"마지막 묶음 — 이번 전송에 없는 제품은 CRM 에서 감춘다"},
      {"name":"transactionUser","type":"string","required":true,"es":"Usuario del ERP que origina el envio","ko":"전송을 일으킨 ERP 사용자"},
      {"name":"productos[].codigo","type":"string","required":true,"es":"Codigo CTR. Clave unica del producto","ko":"CTR 코드 — 고유키"},
      {"name":"productos[].descripcion","type":"string","required":true,"es":"Nombre del producto","ko":"제품명"},
      {"name":"productos[].aplicaciones","type":"string","required":false,"es":"Vehiculos separados por // ; puede traer notas entre corchetes","ko":"적용차종 — 여러 건은 // 구분"},
      {"name":"productos[].referenciaSyd","type":"string","required":false,"es":"Codigos SYD equivalentes separados por // ","ko":"SYD 참조코드"},
      {"name":"productos[].precioLista","type":"number","required":true,"es":"Precio de lista en MXN sin IVA; el descuento por cliente lo aplica el CRM","ko":"정가(MXN, IVA 미포함) — 고객 할인은 CRM 이 적용"},
      {"name":"productos[].moneda","type":"string","required":true,"es":"Siempre MXN","ko":"통화 — 항상 MXN"},
      {"name":"productos[].existencia","type":"string","required":true,"es":"Rango: 0 | 1-10 | 11-20 | 21-30 | +30. Referencia con corte diario","ko":"가용재고 구간 — 참고용, 하루 1회 기준"},
      {"name":"productos[].imagenUrl","type":"string","required":false,"es":"Enlace publico a la foto; mostrar desde el enlace, no descargar","ko":"사진 URL — 링크로 표시(다운로드 금지)"},
      {"name":"productos[].activo","type":"boolean","required":true,"es":"false = no mostrar en el catalogo","ko":"false = 카탈로그에서 감춤"}
    ],
   "sample_request":"{\n  \"envioId\": \"CAT-2026-09-15\",\n  \"fechaCorte\": \"2026-09-15\",\n  \"lote\": 1,\n  \"totalLotes\": 4,\n  \"totalProductos\": 1688,\n  \"esUltimoLote\": false,\n  \"transactionUser\": \"admin\",\n  \"productos\": [\n    {\n      \"codigo\": \"CE0427\",\n      \"descripcion\": \"TERMINAL EXTERIOR\",\n      \"aplicaciones\": \"MITSUBISHI Asx 2013-2015 // MITSUBISHI Lancer 2008-2016\",\n      \"referenciaSyd\": \"1115007 // 1115008\",\n      \"precioLista\": 245.50,\n      \"moneda\": \"MXN\",\n      \"existencia\": \"11-20\",\n      \"imagenUrl\": \"\",\n      \"activo\": true\n    }\n  ]\n}",
   "sample_response":"{\n  \"codigoError\": \"0\",\n  \"mensaje\": \"OK\",\n  \"recibidos\": 500,\n  \"creados\": 12,\n  \"actualizados\": 488,\n  \"errores\": []\n}",
   "raw":"",
   "notes":"계약서 v1.0 (Contrato_API_Producto_v1.0). 개발자 확인 대기: ① 테스트/운영 URL ② 키 위치와 이름(상거래정보 키와 같은지) ③ 묶음 최대 크기 ④ 응답 형식 ⑤ 허용 IP 필요 여부. 5xx/ERR_INTERNAL 만 재시도 대상이고 4xx 는 재시도하지 않는다."}'::jsonb
 WHERE key = 'product'
   AND COALESCE(jsonb_array_length(contract->'fields'), 0) = 0;
