-- =====================================================================
-- Refatrix ERP · 0178_import_batch_shipment_link
-- 수입원가 배치 ↔ 입고 선적 연결 (2026-08-18 밤, 디렉터 요구)
--   "수입원가 등록할 때 분배 대상(이번에 입고한 인보이스)을 보여주고 선택하게 해서
--    해당 인보이스 수입에 원가가 반영되어야 한다."
--   배치에 inbound_shipment_id 를 달아 어느 선적의 원가 배부인지 기록하고,
--   같은 선적으로 배치가 이중 등록되는 것을 막는 기준으로 쓴다.
-- =====================================================================

ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS inbound_shipment_id BIGINT REFERENCES inbound_shipments(id);
CREATE INDEX IF NOT EXISTS idx_import_batches_ship ON import_batches (inbound_shipment_id) WHERE inbound_shipment_id IS NOT NULL;
