-- 0290 · 일일 자금 설정 (2026-10-19)
--   ar_roll: 예정일이 지났는데 안 들어온 수금(AR) 예정을 첫 예정일(오늘/내일) 칸으로 이월해 보여줄지 — 디렉터 선택.
--            true(기본) = 이월 표시·잔고 예측 포함 · false = 이월 안 함(지난 날짜 미처리 경고만, 예측 제외)
--   화면(일일 자금 주간표)과 WhatsApp 일일 보고서에 함께 적용.
CREATE TABLE IF NOT EXISTS treasury_settings (
  id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ar_roll     BOOLEAN NOT NULL DEFAULT true,
  updated_by  BIGINT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO treasury_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
