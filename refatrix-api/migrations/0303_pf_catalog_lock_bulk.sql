-- =====================================================================
-- Refatrix ERP · 0303_pf_catalog_lock_bulk — 플랫폼 카탈로그 점검: 확인 후 잠금 · ERP 엑셀 일괄 검토완료 (2026-10-27 디렉터 지시)
--
--   ① 확인완료(또는 검토완료)된 품목은 플랫폼에서 다시 고칠 수 없다(잠금).
--      ERP 에서 값이 바뀌면 「재확인」 이 되어 다시 열린다 — 잠금은 저장하지 않고 상태로 계산한다.
--   ② 디렉터가 ERP 에서 CTR 코드 목록(엑셀)을 올리면 그 품목들을 「검토완료」 로 표시한다.
--      CTR 이 플랫폼에서 누른 「확인완료」 와 구분해 보이도록 출처(confirmed_source)를 남긴다.
--
--   멱등(IF NOT EXISTS) — 재실행 안전.
-- =====================================================================

-- 마지막 확인의 출처: 'platform' = CTR 확인완료 · 'bulk' = ERP 엑셀 일괄 검토완료
ALTER TABLE pf_catalog_review   ADD COLUMN IF NOT EXISTS confirmed_source TEXT;
UPDATE pf_catalog_review SET confirmed_source = 'platform' WHERE confirmed_source IS NULL AND confirmed_hash IS NOT NULL;

ALTER TABLE pf_catalog_confirms ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'platform';

-- 일괄 검토완료 업로드 1건 = 1행 (누가 · 언제 · 어떤 파일 · 몇 건 · 못 찾은 코드)
CREATE TABLE IF NOT EXISTS pf_catalog_bulk_batches (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT REFERENCES users(id),
  file_name     TEXT,
  codes_in      INT NOT NULL DEFAULT 0,   -- 파일에서 읽은 코드 수(중복 제거)
  marked        INT NOT NULL DEFAULT 0,   -- 이번에 검토완료로 바꾼 수
  already       INT NOT NULL DEFAULT 0,   -- 이미 확인 · 검토완료였던 수(그대로 둠)
  skipped_draft JSONB,                    -- CTR 수정안이 있어 건너뛴 코드
  missing       JSONB                     -- ERP 에 없는 코드(삭제 · PRO · 키트 포함)
);
CREATE INDEX IF NOT EXISTS idx_pfcb_created ON pf_catalog_bulk_batches (created_at DESC);
