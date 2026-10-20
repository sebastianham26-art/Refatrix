-- =====================================================================
-- Refatrix ERP · 0291_wa_customer_sync — WhatsApp 마케팅 연락처에 영업 고객 가져오기 (2026-10-20 디렉터 지시)
--   「등록된 영업 고객의 연락처를 저장해 액티브 / 잠재 고객으로 자동으로 나눔 — 기준: 1페소 이상 SAT 인보이스를 한 번이라도 발행.
--    지역(estado) · RFC · 고객번호 · 이름 · 연락처 · 구매금액 · 영업담당자 · 팀 · 영업담당자 이름으로 그룹」
--   · wa_contacts.customer_id 로 고객과 잇는다(같은 번호의 기존 연락처는 그대로 두고 연결만).
--   · cust_status : active(발행 인보이스 1페소 이상 있음) | potential(없음)
--   · 담당자 그룹은 자동 그룹(wa_groups.auto_key = 'rep:<user id>') — 가져올 때마다 소속을 다시 맞춘다(담당이 바뀌면 옮김).
--   · wa_campaigns.target_cust : 그룹 대상 발송에 「액티브만 / 잠재만」 조건.
--   멱등(IF NOT EXISTS) — 재실행 안전.
-- =====================================================================
-- 연락처 출처에 'customer'(영업 고객 가져오기) 추가 — 0260 의 CHECK 를 넓힌다
ALTER TABLE wa_contacts DROP CONSTRAINT IF EXISTS wa_contacts_source_chk;
ALTER TABLE wa_contacts ADD CONSTRAINT wa_contacts_source_chk CHECK (source IN ('manual','excel','survey','customer'));

ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS customer_id    BIGINT REFERENCES customers(id);
ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS cust_status    TEXT;           -- active | potential
ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS cust_code      TEXT;
ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS cust_name      TEXT;
ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS rfc            TEXT;
ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS purchase_mxn   NUMERIC(14,2);
ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS last_inv_date  DATE;
ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS rep_id         BIGINT REFERENCES users(id);
ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS rep_name       TEXT;
ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS team_name      TEXT;
ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS cust_synced_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_wa_contacts_customer ON wa_contacts (customer_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wa_contacts_cust_status ON wa_contacts (cust_status) WHERE deleted_at IS NULL;

ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS auto_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_groups_auto ON wa_groups (auto_key) WHERE deleted_at IS NULL AND auto_key IS NOT NULL;

ALTER TABLE wa_campaigns ADD COLUMN IF NOT EXISTS target_cust TEXT;   -- NULL(전체) | active | potential
