-- =====================================================================
-- Refatrix ERP · 0285_wa_contact_info — WhatsApp 마케팅 연락처에 주 · 차종(연식) · 찾는 부품 (2026-10-16 디렉터 지시)
--   「Meta 문의에서 받은 엑셀(refatrix_meta_consultas)의 Estado · Vehículo (año) · Piezas buscadas 를 연락처에 기록」
--   엑셀 업로드가 이 머리글을 알아보고 새 연락처에 넣는다. 이미 등록된 번호는 파일에 값이 있는 칸만 고친다.
--   멱등(IF NOT EXISTS) — 재실행 안전.
-- =====================================================================
ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS estado   TEXT;
ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS vehiculo TEXT;
ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS piezas   TEXT;
CREATE INDEX IF NOT EXISTS idx_wa_contacts_estado ON wa_contacts (estado) WHERE deleted_at IS NULL;
