-- =====================================================================
-- Refatrix ERP · 0028_product_master_fields
-- 제품 마스터 실데이터 컬럼 확장 + 경쟁사(SyD) 코드 분해 저장.
-- 파일 필드: Clave CTR(=code), Clave SyD(=scode 원문), Aplicacion(=app),
--   Nombre del producto(=name), List Price(=list_price), IVA(=iva_rate),
--   Barcode(=ean), + 신규: Clave SAT, Origen, Fast Movement Location,
--   List Price de SYD, Precio Cliente de SYD, Precio Cliente de CTR.
-- Clave SyD는 한 제품에 1~5개(' // ' 구분) → 원문은 scode에 보관하고,
--   개별 코드는 product_syd_codes로 분해 저장(SyD 코드 역검색용).
-- =====================================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS sat_code           TEXT;       -- Clave SAT
ALTER TABLE products ADD COLUMN IF NOT EXISTS origin             TEXT;       -- Origen
ALTER TABLE products ADD COLUMN IF NOT EXISTS location           TEXT;       -- Fast Movement Location
ALTER TABLE products ADD COLUMN IF NOT EXISTS list_price_syd     NUMERIC(15,2); -- List Price de SYD
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_customer_syd NUMERIC(15,2); -- Precio Cliente de SYD
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_customer_ctr NUMERIC(15,2); -- Precio Cliente de CTR

-- 경쟁사(SyD) 개별 코드: 한 제품에 여러 개. 역검색(SyD코드→CTR제품)용.
CREATE TABLE IF NOT EXISTS product_syd_codes (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id  BIGINT NOT NULL REFERENCES products(id),
  syd_code    TEXT NOT NULL,
  UNIQUE (product_id, syd_code)
);
CREATE INDEX IF NOT EXISTS idx_psc_syd ON product_syd_codes (syd_code);
CREATE INDEX IF NOT EXISTS idx_psc_product ON product_syd_codes (product_id);
