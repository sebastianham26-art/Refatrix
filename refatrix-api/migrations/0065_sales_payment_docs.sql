-- =====================================================================
-- Refatrix ERP · 0065_sales_payment_docs
--   입금(반제) 건의 은행 입금증 등 증빙 파일 보관.
--   · 입금 1건당 1개(payment_id PK). 최신 업로드가 교체(UPSERT).
--   · file_data = data URL(base64). 목록/집계 쿼리는 이 테이블을 건드리지 않음(성능 보호).
--   · 입금이 삭제되면 증빙도 함께 삭제(ON DELETE CASCADE).
-- =====================================================================

CREATE TABLE IF NOT EXISTS sales_payment_docs (
  payment_id   BIGINT PRIMARY KEY REFERENCES sales_payments(id) ON DELETE CASCADE,
  file_name    TEXT,
  mime_type    TEXT,
  file_data    TEXT NOT NULL,
  uploaded_by  BIGINT REFERENCES users(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
