-- 0293 · VIO 프로모션(키트) — 프로모션 번호 K0001… 연번 · 부품별 수량 · 정가 합계 · 할인 · 키트 제품
--   프로모션 만들기 창에서 「💾 저장(번호 받기)」 → 한 줄. 목록은 VIO 제품찾기·프로모션 › 📋 프로모션 목록.
--   키트 제품: 제품 마스터에 코드 = 프로모션 번호(K0001), 이름 = KIT T {차종} {연식}_{코드}_{코드}…,
--   List price = 정가 합계(부품 정가 × 수량). 재고는 따로 두지 않는다 — 견적·주문에 넣으면
--   구성 부품 줄로 풀려 각 부품 재고가 예약·출고된다(quoteBuild.expandKitLines).

CREATE SEQUENCE IF NOT EXISTS vio_promo_no_seq START 1;

CREATE TABLE IF NOT EXISTS vio_promos (
  id            BIGSERIAL PRIMARY KEY,
  promo_no      TEXT NOT NULL UNIQUE,                 -- K0001
  model_key     TEXT,                                 -- 대기열 차종 키(브랜드|모델)
  title         TEXT NOT NULL,                        -- 차종 표기(KIA Sportage)
  years         TEXT,                                 -- 2016-2022
  discount_pct  NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct < 100),
  show_totals   BOOLEAN NOT NULL DEFAULT false,       -- 이미지에 합계·할인 금액 넣기
  total_list    NUMERIC(14,2) NOT NULL DEFAULT 0,     -- 정가 합계(저장 시점)
  total_promo   NUMERIC(14,2) NOT NULL DEFAULT 0,     -- 할인 적용 금액
  kit_name      TEXT,                                 -- 만들 키트 제품 이름(손으로 고칠 수 있음)
  product_id    BIGINT,                               -- 만든 키트 제품(products.id)
  image_id      BIGINT,                               -- 이미지 뱅크에 저장한 이미지
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  memo          TEXT,
  created_by    BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vio_promos_product_uq ON vio_promos (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS vio_promos_created_idx ON vio_promos (created_at DESC);

CREATE TABLE IF NOT EXISTS vio_promo_items (
  id          BIGSERIAL PRIMARY KEY,
  promo_id    BIGINT NOT NULL REFERENCES vio_promos(id) ON DELETE CASCADE,
  line_no     INT NOT NULL,
  product_id  BIGINT NOT NULL,
  ctr_code    TEXT NOT NULL,
  name        TEXT,
  qty         INT NOT NULL CHECK (qty > 0),
  list_price  NUMERIC(14,2)                           -- 저장 시점 정가(1개)
);
CREATE INDEX IF NOT EXISTS vio_promo_items_promo_idx ON vio_promo_items (promo_id);
