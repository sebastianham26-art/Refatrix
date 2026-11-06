-- =====================================================================
-- 0319 · ERP 에서 특정 문의를 고객 포털(플랫폼)에 안 보이게 차단 (2026-11-05 디렉터)
--   대화를 보다가 「🚫 플랫폼에서 숨기기」 → 모든 refaccionaria 포털에서 사라짐(디렉터 코드는 보임 · 표시).
--   사내 번호(직원 · 알림 받는 번호)의 WhatsApp 대화는 이 칸과 상관없이 포털에 안 나간다.
-- 재실행 안전.
-- =====================================================================
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS portal_hidden BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS portal_hidden_by BIGINT REFERENCES users(id);
ALTER TABLE meta_threads ADD COLUMN IF NOT EXISTS portal_hidden_at TIMESTAMPTZ;
