-- Refatrix ERP · 0249_e_approval_doc_delete
--   전자결재: 디렉터 문서 삭제(결재중·승인·반려·완결 모두) · 복구 (디렉터 요청 2026-10-02).
--   행은 지우지 않고 숨긴다(deleted_at). 누가·왜 지웠는지 남기고, 디렉터는 「삭제된 문서」에서 복구할 수 있다.
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS deleted_by BIGINT REFERENCES users(id);
ALTER TABLE approval_documents ADD COLUMN IF NOT EXISTS delete_reason TEXT;
