-- =====================================================================
-- Refatrix ERP · 0091_sales_invoice_files
--   매출확정(인보이스) 건의 인보이스 관련 첨부파일 보관.
--   · 인보이스 1건당 여러 파일 가능(자체 id PK, invoice_id 인덱스).
--   · file_data = data URL(base64). 목록/집계 쿼리는 이 테이블을 건드리지 않음(성능 보호).
--   · 인보이스가 (소프트)삭제돼도 파일은 남길 수 있으나, 물리 삭제 시 함께 제거(ON DELETE CASCADE).
--   · 허용 형식: PDF·이미지·XML(CFDI)·Excel·Word·CSV·ZIP 등(백엔드에서 검증).
-- =====================================================================

CREATE TABLE IF NOT EXISTS sales_invoice_files (
  id           BIGSERIAL PRIMARY KEY,
  invoice_id   BIGINT NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
  file_name    TEXT,
  mime_type    TEXT,
  file_data    TEXT NOT NULL,
  file_size    BIGINT,
  uploaded_by  BIGINT REFERENCES users(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_invoice_files_inv
  ON sales_invoice_files(invoice_id);
