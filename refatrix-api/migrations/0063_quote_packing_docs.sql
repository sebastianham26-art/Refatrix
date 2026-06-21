-- =====================================================================
-- Refatrix ERP · 0063_quote_packing_docs
--   포장작업지시서(서명 스캔본) 보관 + 매출전환 게이트용 테이블.
--   · 견적당 1건(quote_id PK). 최신 업로드가 교체(UPSERT).
--   · file_data = data URL(base64). 목록 쿼리는 이 테이블을 건드리지 않음(성능 보호).
-- =====================================================================

CREATE TABLE IF NOT EXISTS quote_packing_docs (
  quote_id     BIGINT PRIMARY KEY REFERENCES quotes(id) ON DELETE CASCADE,
  file_name    TEXT,
  mime_type    TEXT,
  file_data    TEXT NOT NULL,
  uploaded_by  BIGINT REFERENCES users(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
