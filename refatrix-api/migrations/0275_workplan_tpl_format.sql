-- =====================================================================
-- 0275 · 업무일지 직원 알림 — Meta 템플릿 형식 선택 (2026-10-15)
--   custom4 : 직접 만든 템플릿(본문 변수 4개: 이름·무엇·날짜·마감시각) — 기존 동작
--   event5  : Meta 템플릿 라이브러리 「이벤트 상세정보 알림」(Event details reminder)
--             "Reminder: You RSVP'ed to {{1}} by {{2}}. The event starts on {{3}} at {{4}} at {{5}} location."
--             {{3}} 은 날짜 형식, {{5}} 는 실제 주소여야 Meta 가 발송을 받아준다 → 주소는 설정값.
--   재실행 안전.
-- =====================================================================
ALTER TABLE workplan_settings ADD COLUMN IF NOT EXISTS remind_template_format  TEXT NOT NULL DEFAULT 'custom4';
ALTER TABLE workplan_settings ADD COLUMN IF NOT EXISTS remind_template_address TEXT NOT NULL DEFAULT 'Monterrey, Nuevo León, México';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workplan_settings_tpl_format_chk') THEN
    ALTER TABLE workplan_settings ADD CONSTRAINT workplan_settings_tpl_format_chk CHECK (remind_template_format IN ('custom4','event5'));
  END IF;
END $$;
