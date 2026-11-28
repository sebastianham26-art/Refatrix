-- =====================================================================
-- Refatrix ERP · 0346_pf_vehicles  (2026-11-27 · REFATRIX Platform 신규 차종 수신)
--   POST /api/pf-catalog/vehicles 로 플랫폼(📈 시장 데이터 · EMA 신차 판매)이 보낸 신규 차종을 저장한다.
--   ERP 에는 차종 마스터 표가 없었다 — 제품찾기 메이커 · 모델 · 연식 목록은 제품 적용차종 분해표
--   (product_applications) 에서만 만들어졌다. 이 표는 「제품이 아직 연결되지 않은 차종」도 목록에 보이게 한다.
--
--   같은 차종 = 이름 키(대소문자 · 공백 · 하이픈 · 점 · 악센트 무시, vehicleMap.nameKey) 의 brand_key|model_key
--               또는 같은 ref. 이름 키는 서버(JS)가 계산해 넣는다 — 제품찾기와 같은 함수.
--   가격 · 재고 · 제품 데이터는 건드리지 않는다. oe_ref 는 참고 자료(플랫폼 견적서 OE · 단가)일 뿐이다.
-- =====================================================================
CREATE TABLE IF NOT EXISTS pf_vehicles (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand       TEXT NOT NULL,
  model       TEXT NOT NULL,
  brand_key   TEXT NOT NULL,                 -- nameKey(brand)  예: 'GEELY'
  model_key   TEXT NOT NULL,                 -- nameKey(model)  예: 'EMGRAND'
  norm_key    TEXT NOT NULL,                 -- brand_key || '|' || model_key
  year_from   INT,
  year_to     INT,                           -- NULL = 현재 판매 중(열린 범위)
  segment     TEXT NOT NULL DEFAULT '',
  origin      TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'passenger',
  source      TEXT NOT NULL DEFAULT '',      -- 'refatrix-market'
  ref         TEXT,                          -- 'NEW|GEELY|Emgrand'
  sales_ytd   INT,
  oe_ref      JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{cat,pos,oe,price,src}] 참고
  created_by  TEXT NOT NULL DEFAULT '',      -- pf-catalog 로그인 사용자 이름
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pf_vehicles_norm ON pf_vehicles (norm_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pf_vehicles_ref  ON pf_vehicles (ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pf_vehicles_brand ON pf_vehicles (brand_key);
CREATE INDEX IF NOT EXISTS idx_pf_vehicles_model ON pf_vehicles (model_key);
