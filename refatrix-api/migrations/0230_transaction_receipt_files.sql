-- =====================================================================
-- Refatrix ERP · 0230_transaction_receipt_files
--   재무 > 거래등록 · 거래목록의 거래 1건에 영수증 파일(사진·PDF·CFDI XML)을 붙인다.
--   · 거래 1건당 여러 파일(자체 id PK, transaction_id 인덱스).
--   · file_data = data URL(base64). 거래목록·현금흐름 쿼리는 이 테이블의 file_data 를 읽지 않는다
--     (목록은 건수만 센다 — 성능 보호, 0091 인보이스 첨부와 같은 방식).
--   · 거래는 소프트삭제(deleted_at)라 파일은 남는다. 물리 삭제 시에만 함께 제거(ON DELETE CASCADE).
--   · 형식·크기 검증은 백엔드(src/txnFiles.js)에서 한다.
-- 0229 는 가격 마스터(설계 승인 대기)용으로 비워 둔다.
-- =====================================================================

CREATE TABLE IF NOT EXISTS transaction_files (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  BIGINT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  file_name       TEXT,
  mime_type       TEXT NOT NULL,
  file_data       TEXT NOT NULL,
  file_size       BIGINT,
  uploaded_by     BIGINT REFERENCES users(id),
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transaction_files_txn
  ON transaction_files(transaction_id);
