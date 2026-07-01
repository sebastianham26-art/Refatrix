-- =====================================================================
-- Refatrix ERP · 0106_bank_deposit_book_income
-- 미배분(대기) 입금을 "거래등록 수입"으로 직접 기표(전환)할 수 있게 한다.
--  - 반제(sales_payment) 경로 대신, 디렉터가 직접 일반 수입 거래 1건으로 확정.
--  - 전환 시 입금은 status='booked' 로 닫히고, 생성된 transactions.id 를 txn_id 에 연결.
--  - booked 는 pending 이 아니므로 반제 인박스/폴링에서 사라져 이중계상이 불가능하다.
--    (반제 연결은 WHERE status='pending' 조건이 걸려 있어 booked 건은 절대 다시 열리지 않음)
-- status 값: pending | allocated | void | booked
-- =====================================================================

ALTER TABLE bank_deposits_pending
  ADD COLUMN IF NOT EXISTS txn_id     BIGINT REFERENCES transactions(id),
  ADD COLUMN IF NOT EXISTS booked_by  BIGINT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS booked_at  TIMESTAMPTZ;
