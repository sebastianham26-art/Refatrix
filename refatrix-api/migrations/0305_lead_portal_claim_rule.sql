-- =====================================================================
-- 0305 · 고객 포털 — 선점 규칙 통합 (2026-10-28 디렉터 결정)
--   「고객을 선점하려면 고객정보를 열람하고 연락한 뒤 내용을 기록 — 그러면 3일간 다른 refaccionaria 는
--    그 고객의 연락처를 못 본다. 거짓으로 입력하면 접속코드를 잃을 수 있다」
--   · 모든 채널(WhatsApp · Messenger · Instagram) 공통. 선점 = 「Ver contacto」 + 연락 내용 기록(메모),
--     Messenger 는 포털에서 보낸 첫 메시지도 연락 기록으로 친다.
--   · via = note(메모로 선점) · messenger(포털 메시지로 선점) · legacy(0300 「Atender」 버튼 — 이번에 없앰)
-- 재실행 안전.
-- =====================================================================
ALTER TABLE lead_portal_claims ADD COLUMN IF NOT EXISTS via TEXT;
UPDATE lead_portal_claims SET via = 'legacy' WHERE via IS NULL;
ALTER TABLE lead_portal_claims ADD COLUMN IF NOT EXISTS note_id BIGINT REFERENCES lead_portal_notes(id);
