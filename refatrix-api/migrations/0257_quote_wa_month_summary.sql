-- 0257 · 신규 견적 WhatsApp 알림 — 메시지 맨 아래 「당월 요약」(견적·매출 추적 상단 KPI 7칸) (2026-10-07 디렉터 지시)
--   수신자별로 고른다: full = 7칸 전부 · no_profit = 이익 두 칸(매출총이익 실현 · 이익 실현불가) 제외 · off = 안 붙임
--   기본 full(디렉터 지시). 이익은 원가 정보이므로 영업사원 등에게는 no_profit 를 권장.
ALTER TABLE quote_wa_recipients ADD COLUMN IF NOT EXISTS month_summary TEXT NOT NULL DEFAULT 'full';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quote_wa_recipients_month_summary_chk') THEN
    ALTER TABLE quote_wa_recipients ADD CONSTRAINT quote_wa_recipients_month_summary_chk
      CHECK (month_summary IN ('full','no_profit','off'));
  END IF;
END $$;
