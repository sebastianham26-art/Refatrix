-- =====================================================================
-- Refatrix ERP · 0136_bank_deposit_docs
--   입금통지(bank_deposits_pending)의 은행 입금내역 스크린캡처 필수 첨부.
--   · 통지 1건당 1개(deposit_id PK). 수정 시 교체(UPSERT).
--   · file_data = data URL(base64). 목록 쿼리는 EXISTS 판단만(성능 보호).
--   · 통지가 하드삭제되면 캡처도 함께 삭제(ON DELETE CASCADE).
--   · 등록 API가 파일 없이는 400(file_required)을 반환하므로,
--     이 마이그레이션은 백엔드 배포 직후 반드시 실행해야 함(npm run migrate).
-- =====================================================================

CREATE TABLE IF NOT EXISTS bank_deposit_docs (
  deposit_id   BIGINT PRIMARY KEY REFERENCES bank_deposits_pending(id) ON DELETE CASCADE,
  file_name    TEXT,
  mime_type    TEXT,
  file_data    TEXT NOT NULL,
  uploaded_by  BIGINT REFERENCES users(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
