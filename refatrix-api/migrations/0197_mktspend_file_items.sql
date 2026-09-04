-- 0197_mktspend_file_items.sql
-- 마케팅 지출계획 증빙을 「집행 항목별 · 견적서/영수증」 으로 나눈다.
--
-- 배경: 증빙이 계획 단위 한 덩어리라, 어느 항목의 견적서인지 / 어느 집행의 영수증인지
--       파일명으로 추측해야 했다. 항목별로 계획(견적서)과 집행(영수증)을 나란히 두면
--       "이 항목은 얼마로 계획했고 실제로 얼마를 냈는가" 를 증빙으로 바로 확인할 수 있다.
--
--   doc_kind = 'quote'   견적서·계약서 — 계획의 근거
--              'receipt' 영수증·송금증  — 집행의 근거
--              'other'   계획 공통 문서(항목 미지정). 기존 첨부는 전부 여기로 남는다.
--
-- item_id 는 NULL 허용 = 계획 공통. 항목이 삭제돼도 증빙은 사라지지 않고
-- ON DELETE SET NULL 로 "계획 공통" 으로 내려앉는다 — 증빙은 절대 유실시키지 않는다.
--
-- 멱등: 전부 IF NOT EXISTS / 중복 제약 무시. 여러 번 적용해도 안전.

ALTER TABLE marketing_spend_files
  ADD COLUMN IF NOT EXISTS item_id  BIGINT REFERENCES marketing_spend_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS doc_kind TEXT NOT NULL DEFAULT 'other';

DO $$ BEGIN
  ALTER TABLE marketing_spend_files
    ADD CONSTRAINT msf_doc_kind_chk CHECK (doc_kind IN ('quote', 'receipt', 'other'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_msf_item      ON marketing_spend_files (item_id);
CREATE INDEX IF NOT EXISTS idx_msf_plan_kind ON marketing_spend_files (plan_id, doc_kind);

-- 기존 첨부는 손대지 않는다(item_id NULL · doc_kind 'other' = 계획 공통).
-- 어느 항목 것인지 서버가 추측하면 틀린 증빙이 붙을 수 있으므로, 사람이 옮기게 둔다.
