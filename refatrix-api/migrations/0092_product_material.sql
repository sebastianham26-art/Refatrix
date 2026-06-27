-- =====================================================================
-- Refatrix ERP · 0092_product_material
-- 제품 마스터에 소재(material) 컬럼 추가.
--   material = 제품 소재 구분 텍스트. 알루미늄 제품 = 'aluminio', 그 외 NULL(미지정).
--   견적 화면의 「알루미늄만」 필터와 제품마스터 목록 표시·필터·일괄지정에 사용된다.
--   (재고수량·평균원가 등 다른 값에는 영향 없음 — 표시·필터용 텍스트 컬럼만 추가.)
--   값은 정규화 저장: 'aluminio'/'aluminum'/'알루미늄' 계열 → 'aluminio'.
--   초기 알루미늄 지정은 마이그레이션에 코드를 박지 않고,
--   제품마스터 > 소재 일괄지정(CTR 코드 목록 업로드) 또는 마스터 업로드의 Material 컬럼으로 운영한다.
-- =====================================================================
ALTER TABLE products ADD COLUMN IF NOT EXISTS material TEXT;
CREATE INDEX IF NOT EXISTS idx_products_material ON products (material);
