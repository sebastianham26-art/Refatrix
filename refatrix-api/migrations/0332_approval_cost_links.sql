-- 0332: 전자결재 원가·운반비 연결 (디렉터 2026-11-20)
--   ① 결재 카테고리의 재무 과목이 5030 수입부대비용 / 5040 수입운송비 → 작성 때 「수입 인보이스」를 고른다.
--      고른 인보이스는 수입 부대비용 분배 화면(재무에서 가져오기)이 분배 대상(승인된 수입배치)을 자동 선택하는 데 쓴다 → 원가 반영.
--      · import_shipment_ids = 입고 선적(inbound_shipments — 패킹리스트 인보이스, 도착 전 선적 포함)
--      · import_batch_ids    = 선적 연결이 없는 수입배치(import_batches — 과거·수동 등록분)
--   ② 재무 과목이 6160 운반비(매출출고) → 매출 인보이스(또는 고객, 또는 「공통 — 매출비중 자동배분」)를 고른다.
--      결재의 자금계획 예정 거래(및 실적 거래에 태그가 비어 있으면 실적 거래)에 거래등록과 같은 운반비 태그를 단다.
-- 멱등: IF NOT EXISTS — 재실행 안전.

ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS import_shipment_ids BIGINT[];
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS import_batch_ids    BIGINT[];
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS freight_customer_id BIGINT REFERENCES customers(id);
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS freight_invoice_ids BIGINT[];
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS freight_common      BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN approval_documents.import_shipment_ids IS '0332 원가(5030/5040) 대상 입고 선적(inbound_shipments.id)';
COMMENT ON COLUMN approval_documents.import_batch_ids    IS '0332 원가(5030/5040) 대상 수입배치(선적 연결 없는 import_batches.id)';
COMMENT ON COLUMN approval_documents.freight_customer_id IS '0332 운반비(6160) 귀속 고객 — 인보이스를 고르면 한 고객일 때 자동';
COMMENT ON COLUMN approval_documents.freight_invoice_ids IS '0332 운반비(6160) 귀속 매출 인보이스(sales_invoices.id) — 거래금액 균등 배분';
COMMENT ON COLUMN approval_documents.freight_common      IS '0332 운반비(6160) 공통 — 고객 미지정(손익 화면 매출비중 자동배분)';
