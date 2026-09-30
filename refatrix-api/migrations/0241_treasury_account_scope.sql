-- 0241 · 일일 자금·월간실적 — 집계 대상 계좌(출처계좌) 지정
--   treasury_exclude: NULL = 자동 규칙(불공제 계좌·금고/현금 계좌 제외) · true = 강제 제외 · false = 강제 포함
--   자동 규칙의 금고 판별 = 계좌 이름·유형에 금고/caja/efectivo/현금/cash 포함 (src/treasuryDaily.js CASH_BOX_RE)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS treasury_exclude BOOLEAN;
