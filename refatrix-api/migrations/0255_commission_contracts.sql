-- =====================================================================
-- 0255 · 커미션 계약서 파일 (2026-10-06 · 디렉터 결정)
--   디렉터가 커미션 대상자별로 서명된 계약서(PDF·이미지·Word)를 올린다.
--   열람은 **본인과 디렉터만**. 원본은 file_data(BYTEA) — 목록 쿼리는 원본을 읽지 않는다(0234 와 같은 방식).
--   삭제는 디렉터만, 소프트 삭제(deleted_at) — 기록은 남고 본인 화면에서만 사라진다.
-- =====================================================================

CREATE TABLE IF NOT EXISTS commission_contracts (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id),     -- 계약 당사자(커미션 대상자)
  title        TEXT,                                     -- 예: Contrato de comisión 2026
  file_name    TEXT   NOT NULL,
  mime_type    TEXT   NOT NULL,
  file_size    INTEGER NOT NULL,
  sha256       TEXT   NOT NULL,
  file_data    BYTEA  NOT NULL,
  signed_date  DATE,                                     -- 계약(서명)일 — 선택
  uploaded_by  BIGINT REFERENCES users(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  deleted_by   BIGINT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_comm_contract_user ON commission_contracts (user_id, uploaded_at DESC) WHERE deleted_at IS NULL;
