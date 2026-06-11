-- =====================================================================
-- Refatrix ERP · 0022_txn_kind_payment
-- transactions.kind CHECK 제약에 'payment'(입금배분), 'advance'(선수금) 추가.
-- 0021의 반제 기능이 이 종류로 거래를 기록하므로 필요.
-- =====================================================================

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_kind_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_kind_check
  CHECK (kind IN ('general','sales','invoice','payment','advance'));
