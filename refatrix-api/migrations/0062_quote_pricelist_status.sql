-- =====================================================================
-- Refatrix ERP · 0062_quote_pricelist_status
--   전체 가격표 다운로드 시 견적 목록에 '가용재고 및 견적'(pricelist) 상태로 기록.
--   · quotes.status CHECK 에 'pricelist' 추가.
-- =====================================================================

ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_status_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_status_check
  CHECK (status IN ('draft','confirmed','converted','cancelled','delete_pending','pricelist'));
