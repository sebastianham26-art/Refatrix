-- =====================================================================
-- Refatrix ERP · 0283_wa_contact_groups — WhatsApp 마케팅 연락처 그룹 (2026-10-16 디렉터 지시)
--   「연락처를 카테고리 그룹으로 자유롭게 구분 → 그룹별로 발송 · 대량의 연락처를 한 번에 구분」
--   · wa_groups          : 이름(대소문자 무시 유일) · 색 · 설명. 지우면 소프트 삭제(소속 기록은 남지만 어디에도 안 보임).
--   · wa_contact_groups  : 연락처 ↔ 그룹(한 사람이 여러 그룹에 들어갈 수 있음).
--   · wa_campaigns.target_groups : 이 그룹들 중 하나라도 들어 있는 ✅ 동의자에게 — 발송 시점의 소속으로 센다.
--   멱등(IF NOT EXISTS) — 재실행 안전.
-- =====================================================================
CREATE TABLE IF NOT EXISTS wa_groups (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT,
  memo        TEXT,
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_groups_name ON wa_groups (lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS wa_contact_groups (
  contact_id  BIGINT NOT NULL REFERENCES wa_contacts(id),
  group_id    BIGINT NOT NULL REFERENCES wa_groups(id),
  added_by    BIGINT REFERENCES users(id),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_wa_contact_groups_group ON wa_contact_groups (group_id);

ALTER TABLE wa_campaigns ADD COLUMN IF NOT EXISTS target_groups BIGINT[];
