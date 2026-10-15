-- =====================================================================
-- Refatrix ERP · 0277_shortage_receipt_resolution
--   2026-10-15 · 디렉터 결정: 부족분은 **입고 시 해소**된다(수입배치 승인 = 재고 등재 시점).
--     · 해소 원장(stock_shortage_resolutions)에 source='receipt' 추가 + 어느 입고 배치가 해소했는지(import_batch_id).
--     · 배치를 삭제·안전삭제·되돌리면 그 배치가 만든 해소를 되돌린다(원장 행 삭제 + resolved_qty 복원).
--     · 발주(구매라인)와 부족분의 연결은 저장하지 않고 **FIFO 로 계산**한다(src/shortageReceipt.js) —
--       오래된 발주 잔량이 오래된 부족분부터 덮는다. 입고도 같은 순서(consumeBackorder FIFO)로 들어오므로
--       「발주됨 → 입고 해소」 가 같은 짝으로 이어진다. 발주 삭제·수정 시 되돌릴 저장값이 없다.
--   ※ migrate.js 가 파일마다 BEGIN/COMMIT 으로 감싼다.
-- =====================================================================

ALTER TABLE stock_shortage_resolutions
  ADD COLUMN IF NOT EXISTS import_batch_id BIGINT REFERENCES import_batches(id);

ALTER TABLE stock_shortage_resolutions DROP CONSTRAINT IF EXISTS stock_shortage_resolutions_source_check;
ALTER TABLE stock_shortage_resolutions ADD CONSTRAINT stock_shortage_resolutions_source_check
  CHECK (source IN ('sale','scan','manual','receipt'));

CREATE INDEX IF NOT EXISTS idx_ssr_batch ON stock_shortage_resolutions (import_batch_id);

COMMENT ON COLUMN stock_shortage_resolutions.import_batch_id IS '입고 해소(source=receipt)를 만든 수입배치';
