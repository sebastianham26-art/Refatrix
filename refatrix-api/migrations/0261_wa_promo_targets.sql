-- 0261 · WhatsApp 마케팅 — 연락처를 골라서 보내기 (2026-10-08 디렉터 지시)
--   wa_campaigns.target_ids : 값이 있으면 그 연락처들 가운데 ✅ 동의자에게만 보낸다(메모 조건은 무시).
--                             NULL 이면 기존대로 ✅ 동의 전체(+메모 조건).
ALTER TABLE wa_campaigns ADD COLUMN IF NOT EXISTS target_ids BIGINT[];
