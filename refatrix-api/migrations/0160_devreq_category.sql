-- =====================================================================
-- Refatrix ERP · 0160_devreq_category
--   개발필요내용(개발요청 대장)에 품목 카테고리 추가 — 6대 품목 구분.
--   rotula / terminal_ext / terminal_int / horquilla / buje / tornillo / otros
--   (차종별 부품 화면의 분류 체계와 동일 키.)
--   · 접수 시 선택 또는 개발필요내용 화면에서 SKU 단위 지정(수동).
--   · 코드가 기존 제품과 매칭되면 제품명 기반 자동 분류가 보조.
--   멱등(IF NOT EXISTS). 재실행 안전.
-- =====================================================================

ALTER TABLE product_dev_requests ADD COLUMN IF NOT EXISTS category TEXT;
CREATE INDEX IF NOT EXISTS idx_devreq_category ON product_dev_requests (category);
