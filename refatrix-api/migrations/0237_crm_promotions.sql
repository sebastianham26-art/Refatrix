-- =====================================================================
-- Refatrix ERP · 0237_crm_promotions
-- 프로모션 배너 연동 (ERP → CRM 여러 곳)
--
--   무엇을
--     · ERP 에서 프로모션(설명·할인·기간·배너 이미지)을 등록하면
--       「프로모션」 분류의 전송 창구 **전부(선택한 것)** 로 자동 전송한다.
--     · 창구 1개 = CRM(고객사) 1곳. 창구는 연동 관리의 「+ 새 연동」 과 같은 등록부
--       (integration_endpoints, category='promotion') 를 쓴다 — 주소·키·재시도·이력이 그대로 재사용된다.
--     · 전송 건은 기존 아웃박스(crm_customer_outbox)에 `entity='promo'` 로 쌓인다.
--       새 전송 엔진을 만들지 않는다(고객·제품·오더와 같은 재시도·재전송·이력 화면).
--     · 배너 이미지는 DB 에 보관하고, CRM 은 **공개 주소**로 불러간다
--       (`/api/public/promo-banners/<id>-<hash>.<ext>` — 이미지를 바꾸면 주소도 바뀐다).
--
--   멱등(IF NOT EXISTS / ON CONFLICT) — 재실행 안전.
-- =====================================================================

-- ① 창구별 배너 규격(가로×세로 px). 비어 있으면 검사하지 않는다.
--    CRM 마다 배너 자리가 다를 수 있어 창구 단위로 둔다.
ALTER TABLE integration_endpoints ADD COLUMN IF NOT EXISTS banner_w INT;
ALTER TABLE integration_endpoints ADD COLUMN IF NOT EXISTS banner_h INT;

-- ② 프로모션 본체 ------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_promotions (
  id              BIGSERIAL PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT,
  promo_type      TEXT NOT NULL DEFAULT 'porcentaje',   -- porcentaje | monto | otro
  discount_value  NUMERIC(12,2),                        -- % 또는 MXN (otro 면 NULL)
  conditions      TEXT,                                 -- 적용 조건(대상 품목·최소 구매 등)
  start_date      DATE NOT NULL,                        -- 멕시코 날짜 기준, 포함
  end_date        DATE NOT NULL,                        -- 멕시코 날짜 기준, 포함
  link_url        TEXT,                                 -- 배너 클릭 시 이동(선택)
  priority        INT  NOT NULL DEFAULT 100,            -- 작을수록 먼저 노출
  auto_withdraw   BOOLEAN NOT NULL DEFAULT true,        -- 종료일 다음 날 CRM 에서 자동으로 내린다
  status          TEXT NOT NULL DEFAULT 'draft',        -- draft | published | cancelled
  version         INT  NOT NULL DEFAULT 0,              -- 전송할 때마다 +1 (CRM 이 옛 건을 무시하는 기준)
  image           BYTEA,
  image_mime      TEXT,
  image_name      TEXT,
  image_bytes     INT,
  image_w         INT,
  image_h         INT,
  image_sha       TEXT,                                 -- 내용 해시 — 공개 주소에 들어간다(캐시 무효화)
  published_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  withdrawn_at    TIMESTAMPTZ,                          -- 종료 후 자동 내리기를 적재한 시각(한 번만)
  created_by      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      BIGINT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

DO $$ BEGIN
  ALTER TABLE crm_promotions ADD CONSTRAINT crm_promo_status_ck CHECK (status IN ('draft','published','cancelled'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'crm_promo_status_ck 이미 존재'; END $$;
DO $$ BEGIN
  ALTER TABLE crm_promotions ADD CONSTRAINT crm_promo_type_ck CHECK (promo_type IN ('porcentaje','monto','otro'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'crm_promo_type_ck 이미 존재'; END $$;
DO $$ BEGIN
  ALTER TABLE crm_promotions ADD CONSTRAINT crm_promo_dates_ck CHECK (end_date >= start_date);
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'crm_promo_dates_ck 이미 존재'; END $$;

CREATE INDEX IF NOT EXISTS idx_crm_promo_live ON crm_promotions (status, end_date) WHERE deleted_at IS NULL;

-- ③ 프로모션별 전송 대상(창구) -----------------------------------------
CREATE TABLE IF NOT EXISTS crm_promotion_targets (
  promotion_id  BIGINT NOT NULL REFERENCES crm_promotions(id) ON DELETE CASCADE,
  endpoint_key  TEXT   NOT NULL,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (promotion_id, endpoint_key)
);

-- ④ 기본 창구 1개 — 우리 웹 카달록 CRM. 주소는 비워 두고(개발자 확인 후 입력) 꺼 둔다.
--    키는 「고객 상거래정보」 것을 **물려받는다**(같은 CRM 이면 새 키를 받을 필요가 없다).
INSERT INTO integration_endpoints (key, category, label, description, enabled, env, method_upsert, method_delete, contract, sort_order, auth_from)
VALUES (
  'promo_crm', 'promotion', '프로모션 배너 (웹 카달록)',
  'ERP 프로모션 등록 → CRM 배너 자동 반영. 계약서 Contrato_API_Promociones_v1.0.',
  false, 'test', 'POST', 'DELETE',
  '{"fields":[
      {"name":"promocionId","type":"string","required":true,"es":"Clave unica de la promocion en el ERP (PR-000001). Un mismo ID = misma promocion: actualizar, no duplicar","ko":"프로모션 고유키 — 같은 ID 면 새로 만들지 말고 갱신"},
      {"name":"version","type":"integer","required":true,"es":"Sube en cada envio. Ignorar si llega una version menor a la ya guardada","ko":"전송마다 +1 — 더 작은 버전은 무시"},
      {"name":"estatus","type":"string","required":true,"es":"activa | cancelada | finalizada. Solo activa se muestra","ko":"activa 만 노출. cancelada·finalizada 는 내린다"},
      {"name":"titulo","type":"string(120)","required":true,"es":"Titulo de la promocion","ko":"제목"},
      {"name":"descripcion","type":"string","required":false,"es":"Texto descriptivo (puede tener saltos de linea)","ko":"설명(줄바꿈 가능)"},
      {"name":"tipoPromocion","type":"string","required":true,"es":"porcentaje | monto | otro","ko":"할인 종류 — %·금액·기타"},
      {"name":"valorDescuento","type":"number|null","required":false,"es":"Porcentaje (15 = 15%) o monto en MXN. null si tipo = otro","ko":"할인값(15=15%) 또는 MXN"},
      {"name":"condiciones","type":"string","required":false,"es":"Condiciones de aplicacion","ko":"적용 조건"},
      {"name":"fechaInicio","type":"string(AAAA-MM-DD)","required":true,"es":"Primer dia visible (hora de Ciudad de Mexico), incluido","ko":"노출 시작일(멕시코시티 시간, 포함)"},
      {"name":"fechaFin","type":"string(AAAA-MM-DD)","required":true,"es":"Ultimo dia visible (hora de Ciudad de Mexico), incluido. Despues de este dia NO mostrar aunque no llegue aviso","ko":"노출 종료일(포함) — 이후에는 통보가 없어도 감춘다"},
      {"name":"zonaHoraria","type":"string","required":true,"es":"Siempre America/Mexico_City","ko":"항상 America/Mexico_City"},
      {"name":"bannerUrl","type":"string(url)","required":true,"es":"Imagen del banner. Mostrar desde el enlace o descargar y guardar; la URL cambia si cambia la imagen","ko":"배너 이미지 주소 — 이미지가 바뀌면 주소도 바뀐다"},
      {"name":"bannerAncho","type":"integer","required":true,"es":"Ancho real de la imagen en px","ko":"이미지 가로 px"},
      {"name":"bannerAlto","type":"integer","required":true,"es":"Alto real de la imagen en px","ko":"이미지 세로 px"},
      {"name":"bannerTipo","type":"string","required":true,"es":"image/png | image/jpeg | image/webp | image/gif","ko":"이미지 형식"},
      {"name":"enlace","type":"string(url)","required":false,"es":"A donde lleva el clic en el banner (opcional)","ko":"배너 클릭 시 이동 주소(선택)"},
      {"name":"prioridad","type":"integer","required":true,"es":"Orden de aparicion: menor = primero","ko":"노출 순서 — 작을수록 먼저"},
      {"name":"transactionUser","type":"string","required":true,"es":"Usuario del ERP que origina el envio","ko":"전송을 일으킨 ERP 사용자"}
    ],
   "sample_request":"{\n  \"promocionId\": \"PR-000001\",\n  \"version\": 1,\n  \"estatus\": \"activa\",\n  \"titulo\": \"Octubre CTR -15%\",\n  \"descripcion\": \"15% de descuento en terminales y rotulas CTR\",\n  \"tipoPromocion\": \"porcentaje\",\n  \"valorDescuento\": 15,\n  \"condiciones\": \"Pedido minimo 5,000 MXN\",\n  \"fechaInicio\": \"2026-10-01\",\n  \"fechaFin\": \"2026-10-31\",\n  \"zonaHoraria\": \"America/Mexico_City\",\n  \"bannerUrl\": \"https://refatrix-production.up.railway.app/api/public/promo-banners/1-3f9a0c1b2d4e5f60.png\",\n  \"bannerAncho\": 1200,\n  \"bannerAlto\": 400,\n  \"bannerTipo\": \"image/png\",\n  \"enlace\": \"\",\n  \"prioridad\": 100,\n  \"transactionUser\": \"admin\"\n}",
   "sample_response":"{\n  \"codigoError\": \"0\",\n  \"mensaje\": \"Promocion registrada\"\n}",
   "raw":"",
   "notes":"계약서 v1.0 (Contrato_API_Promociones_v1.0). 등록·수정은 method_upsert(POST), 취소·종료는 method_delete(기본 DELETE, 주소 뒤에 ?promocionId= 가 붙는다). 상대가 POST 로 estatus 만 바꾸길 원하면 method_delete 를 POST 로 바꾸면 된다. 개발자 확인 대기: ① URL ② 키 ③ 배너 규격(px)."}'::jsonb,
  60, 'customer_commercial')
ON CONFLICT (key) DO NOTHING;
