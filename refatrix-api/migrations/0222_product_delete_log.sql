-- =====================================================================
-- Refatrix ERP · 0222_product_delete_log
-- 제품(SKU) 영구 삭제 기능에 필요한 이력 스키마 보정.
--
--  · product_change_log.action 에 'delete' 를 허용한다(0141 은 create/update 만 허용).
--    삭제된 제품의 행은 product_id 가 NULL 이 되고 code 스냅샷만 남으므로,
--    「그 코드가 언제·누가·왜 지워졌나」가 제품 이력 화면에 영구히 보인다.
--  · product_change_log.product_id 는 0141 부터 NULL 허용이라 컬럼 변경은 필요 없다.
--    (혹시 과거에 NOT NULL 로 만들어진 DB 가 있으면 여기서 풀어 준다 — 멱등)
--
-- 멱등(재실행 안전). products 데이터는 건드리지 않는다.
-- =====================================================================

ALTER TABLE product_change_log DROP CONSTRAINT IF EXISTS product_change_log_action_check;
ALTER TABLE product_change_log
  ADD CONSTRAINT product_change_log_action_check
  CHECK (action IN ('create', 'update', 'delete'));

ALTER TABLE product_change_log ALTER COLUMN product_id DROP NOT NULL;

-- 삭제 이력 조회(코드 기준)용 — 0141 의 idx_pcl_code 가 이미 있으면 그대로 둔다.
CREATE INDEX IF NOT EXISTS idx_pcl_code ON product_change_log (code);
