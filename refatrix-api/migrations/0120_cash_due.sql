-- 0120: 💰 현금받아야함 (금고 회수 관리 — 디렉터)
-- 지출 등록 시 체크하면 디렉터의 회수 목록에 모임. 수령완료 시각·처리자 기록.
-- (프런트 fin-0705a가 이미 배포된 기능의 백엔드 짝 — 반배포 복구)
-- 멱등: IF NOT EXISTS — 재실행 안전.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cash_due boolean NOT NULL DEFAULT false;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cash_due_done_at timestamptz;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cash_due_done_by integer;
