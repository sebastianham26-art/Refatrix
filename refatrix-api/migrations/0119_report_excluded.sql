-- 0119: 월 자금 리포트 — 분석 제외 플래그
-- 디렉터가 특정 집행 내역을 "분석에서 제외"로 지정하면 월 리포트의
-- 계획대비·월간비교·Top지출·요약 증감 계산에서 빠진다(일회성 이상치 제거용).
-- 잔액·거래목록·현금흐름 등 실제 장부에는 영향 없음 — 리포트 전용 표시 플래그.
-- 멱등: IF NOT EXISTS — 재실행 안전.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS report_excluded boolean NOT NULL DEFAULT false;
