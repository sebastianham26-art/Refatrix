-- =====================================================================
-- Refatrix ERP · 0075_bank_deposits_pending
-- 미배분 입금함: 재무담당/디렉터가 은행에 들어온 "매출 입금"을 통지로 등록한다.
--  - 이 등록은 회계 기표(transactions)가 아니다. 단순 핸드오프 통지다.
--  - 영업지원이 수금/정산에서 어느 고객·인보이스인지 매칭해 "반제"하면,
--    그 반제 시점에만 transactions 가 1건 생성되어 계좌 잔액에 반영된다.
--  - 따라서 거래등록(수입)과의 이중계상이 구조적으로 발생하지 않는다.
-- =====================================================================

CREATE TABLE IF NOT EXISTS bank_deposits_pending (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   BIGINT NOT NULL REFERENCES accounts(id),
  deposit_date DATE NOT NULL,
  amount       NUMERIC(15,2) NOT NULL,                 -- 통장에 찍힌 입금액(MXN)
  payer_memo   TEXT,                                   -- 송금인/적요 (영업지원 매칭 단서)
  customer_id  BIGINT REFERENCES customers(id),        -- (선택) 재무담당 추정 고객
  status       TEXT NOT NULL DEFAULT 'pending',        -- pending | allocated | void
  payment_id   BIGINT REFERENCES sales_payments(id),   -- 반제 연결(닫힘)
  note         TEXT,
  created_by   BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  allocated_by BIGINT REFERENCES users(id),
  allocated_at TIMESTAMPTZ,
  voided_by    BIGINT REFERENCES users(id),
  voided_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bdp_status  ON bank_deposits_pending (status);
CREATE INDEX IF NOT EXISTS idx_bdp_created ON bank_deposits_pending (created_at);

-- 사용자별 읽음 표시(미배분 입금 팝업 안읽음 배지용)
CREATE TABLE IF NOT EXISTS bank_deposit_reads (
  deposit_id BIGINT NOT NULL REFERENCES bank_deposits_pending(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (deposit_id, user_id)
);
