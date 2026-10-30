-- =====================================================================
-- 0309 · 소개 계약 본인 작성 (2026-10-30 · 디렉터 결정)
--   소개자(A)가 ERP 에서 직접: 피소개 커미셔너(B) 선택 · B 회사 정보 · 본인(A) 정보 입력 ·
--   서류 업로드 · 손서명+PIN. 디렉터는 마지막에 「승인」만 한다.
--   · referrer_info = A 정보(계약서 진술 II · EL REFERIDOR 표): name·rfc·address·phone·email·persona
--   · approved_at/by = 디렉터 승인. 효력일 = max(시작일, 서류 완비일, A 첫 서명일, 승인일)
--   · requested_by = A 가 직접 신청한 계약이면 A (디렉터 등록이면 NULL)
--   기존 계약(디렉터 등록)은 등록 시점에 승인된 것으로 채운다 → 효력일 변화 없음.
-- =====================================================================
ALTER TABLE commission_referrals ADD COLUMN IF NOT EXISTS referrer_info JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE commission_referrals ADD COLUMN IF NOT EXISTS approved_at  TIMESTAMPTZ;
ALTER TABLE commission_referrals ADD COLUMN IF NOT EXISTS approved_by  BIGINT REFERENCES users(id);
ALTER TABLE commission_referrals ADD COLUMN IF NOT EXISTS requested_by BIGINT REFERENCES users(id);

UPDATE commission_referrals SET approved_at = created_at, approved_by = created_by
 WHERE approved_at IS NULL AND requested_by IS NULL;
