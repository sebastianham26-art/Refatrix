-- 0118: 계좌 잠금(안씀) 기능 — accounts.disabled 플래그 추가
-- '안씀' 계좌는 신규 사용(거래등록·수정·지급확인·고정비·엑셀 일괄입력)의
-- 계좌 드롭다운에서 제외된다. 기존 거래·잔액·목록 필터에는 계속 표시(자금은 그대로).
-- 멱등: IF NOT EXISTS — 재실행 안전.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS disabled boolean NOT NULL DEFAULT false;
