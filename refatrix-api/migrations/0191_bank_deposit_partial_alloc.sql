-- =====================================================================
-- Refatrix ERP · 0191_bank_deposit_partial_alloc
-- 미배분 입금(통지)의 "부분 배분" 지원.
--
-- 배경(버그):
--   고객이 인보이스 여러 건을 한 번에 송금하면 통지는 1건 · 반제할 인보이스는 N건이다.
--   기존 구조는 반제 1회에 통지를 무조건 status='allocated' 로 닫아버리고
--   배분하고 남은 금액을 전부 '선수금(과입금)'으로 처리했다.
--   → 인보이스 1건만 먼저 반제하면 남은 돈이 인박스에 "잔여"로 남지 않고 통지가 사라져
--     나머지 인보이스를 이어서 반제할 방법이 없었다.
--
-- 해결:
--   1) allocated_amount — 이 통지에서 지금까지 소진된 금액(배분 + 선수금 확정분).
--      잔여 = amount - allocated_amount.  잔여가 남아 있으면 status 는 'pending' 유지 →
--      인박스에 "부분배분 · 잔여 MX$X" 로 계속 보이고 나중에 이어서 반제할 수 있다.
--   2) bank_deposit_payments — 한 통지 : 여러 반제(sales_payments) 연결 테이블.
--      기존 bank_deposits_pending.payment_id 는 "마지막 반제" 포인터로만 남긴다(하위호환).
--
-- 회계 원칙은 그대로: 통지 등록은 transactions 미생성. 배분한 금액만큼만 그때그때 거래 생성.
-- =====================================================================

ALTER TABLE bank_deposits_pending
  ADD COLUMN IF NOT EXISTS allocated_amount NUMERIC(15,2) NOT NULL DEFAULT 0;

-- 한 통지 → 여러 반제(부분 배분). payment 삭제 시 링크도 함께 사라짐.
CREATE TABLE IF NOT EXISTS bank_deposit_payments (
  deposit_id BIGINT NOT NULL REFERENCES bank_deposits_pending(id) ON DELETE CASCADE,
  payment_id BIGINT NOT NULL REFERENCES sales_payments(id) ON DELETE CASCADE,
  amount     NUMERIC(15,2) NOT NULL,          -- 이 반제가 통지에서 소진한 금액(배분합 + 선수금)
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (deposit_id, payment_id)
);
CREATE INDEX IF NOT EXISTS idx_bdpay_payment ON bank_deposit_payments (payment_id);

-- ---------------------------------------------------------------------
-- 백필: 기존에 닫힌(allocated) 통지는 "전액 소진"으로 간주한다.
--   기존 동작이 항상 통지 전액(배분 + 나머지 선수금)을 소진했으므로 의미가 정확히 일치한다.
-- ---------------------------------------------------------------------
UPDATE bank_deposits_pending
   SET allocated_amount = amount
 WHERE status = 'allocated' AND COALESCE(allocated_amount,0) = 0;

INSERT INTO bank_deposit_payments (deposit_id, payment_id, amount, created_by, created_at)
SELECT d.id, d.payment_id, d.amount, d.allocated_by, COALESCE(d.allocated_at, now())
  FROM bank_deposits_pending d
 WHERE d.status = 'allocated' AND d.payment_id IS NOT NULL
ON CONFLICT (deposit_id, payment_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_bdp_alloc ON bank_deposits_pending (status, allocated_amount);
