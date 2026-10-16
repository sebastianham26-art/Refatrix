-- =====================================================================
-- Refatrix ERP · 0286_wa_contact_tipo — WhatsApp 마케팅 연락처 직업(고객 유형) (2026-10-16 디렉터 지시)
--   「직업과 차종 정보 정도는 고객정보에 기록」 — Meta 문의 엑셀의 Tipo de cliente
--   (Particular · Taller mecánico · Refaccionaria · Mayorista · Flotilla · Taxi / app …)를 연락처에 남긴다.
--   관심 차종은 0285 vehiculo(여러 대면 「; 」로 이어 씀).
--   멱등(IF NOT EXISTS) — 재실행 안전.
-- =====================================================================
ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS tipo TEXT;
CREATE INDEX IF NOT EXISTS idx_wa_contacts_tipo ON wa_contacts (tipo) WHERE deleted_at IS NULL;
