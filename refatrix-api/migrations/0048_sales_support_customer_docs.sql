-- =====================================================================
-- Refatrix ERP · 0048_sales_support_customer_docs
--   (1) 역할 sales_support(영업지원) 추가
--   (2) customers.constancia_fiscal (세무 등록상태 문구/번호)
--   (3) customer_documents : 고객 증빙서류 파일(PDF·JPEG 등) DB 저장(bytea)
-- =====================================================================

-- (1) 역할 추가: sales_support
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('director','treasury','marketing','ops','sales','sales_support','viewer'));

-- (2) 고객 세무 정보(우선 constancia_fiscal 만; 나머지는 추후)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS constancia_fiscal TEXT;

-- (3) 고객 증빙서류 (파일 본문은 bytea 로 직접 저장)
CREATE TABLE IF NOT EXISTS customer_documents (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id),
  doc_type     TEXT,                                  -- 'constancia' 등 분류(선택)
  file_name    TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  byte_size    BIGINT NOT NULL,
  content      BYTEA NOT NULL,                         -- 파일 본문
  uploaded_by  BIGINT REFERENCES users(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_custdocs_customer ON customer_documents (customer_id) WHERE deleted_at IS NULL;
