-- =====================================================================
-- Refatrix ERP · 0003_accounts_categories_transactions
-- 계좌 · 사용자×계좌 · 과목(P&L) · 거래 · 반복 고정비
-- =====================================================================

-- 계좌 ---------------------------------------------------------------
CREATE TABLE accounts (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT,                               -- 은행/현금 등
  currency      TEXT NOT NULL CHECK (currency IN ('MXN','USD')),
  open_balance  NUMERIC(15,2) NOT NULL DEFAULT 0,
  open_date     DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT REFERENCES users(id),
  deleted_at    TIMESTAMPTZ
);
CREATE TRIGGER trg_accounts_upd BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 사용자×계좌 열람/운영 -------------------------------------------
CREATE TABLE user_account_access (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  account_id   BIGINT NOT NULL REFERENCES accounts(id),
  can_operate  BOOLEAN NOT NULL DEFAULT false,      -- false면 열람만
  UNIQUE (user_id, account_id)
);

-- 과목(차변·P&L 분류) -----------------------------------------------
CREATE TABLE categories (
  code        TEXT PRIMARY KEY,                     -- 예: 4010, 6070
  name        TEXT NOT NULL,
  group_name  TEXT NOT NULL,                        -- 수익/매출원가/판관비/영업외/비손익
  sort_order  INT NOT NULL DEFAULT 0
);

-- 거래(실적·계획) ----------------------------------------------------
CREATE TABLE transactions (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id     BIGINT REFERENCES accounts(id),    -- 승인 전 NULL 가능
  txn_date       DATE NOT NULL,                     -- 거래일/수금예상일
  direction      TEXT NOT NULL CHECK (direction IN ('in','out')),
  amount         NUMERIC(15,2) NOT NULL,            -- 원통화 금액
  currency       TEXT NOT NULL DEFAULT 'MXN',
  fx_rate        NUMERIC(15,6) NOT NULL DEFAULT 1,
  amount_mxn     NUMERIC(15,2) NOT NULL,            -- MXN 환산
  category_code  TEXT REFERENCES categories(code),
  status         TEXT NOT NULL CHECK (status IN ('plan','actual')),
  kind           TEXT CHECK (kind IN ('general','sales','invoice')) DEFAULT 'general',
  approved        BOOLEAN NOT NULL DEFAULT false,
  owner_id       BIGINT REFERENCES users(id),
  memo           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT REFERENCES users(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     BIGINT REFERENCES users(id),
  deleted_at     TIMESTAMPTZ
);
CREATE TRIGGER trg_transactions_upd BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_txn_date     ON transactions (txn_date);
CREATE INDEX idx_txn_status   ON transactions (status, approved);
CREATE INDEX idx_txn_owner    ON transactions (owner_id);

-- 반복 고정비 규칙 ---------------------------------------------------
CREATE TABLE recurring_rules (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           TEXT NOT NULL,
  category_code  TEXT REFERENCES categories(code),
  amount         NUMERIC(15,2) NOT NULL DEFAULT 0,
  direction      TEXT NOT NULL DEFAULT 'out' CHECK (direction IN ('in','out')),
  freq           TEXT NOT NULL CHECK (freq IN ('month','week')),
  day_or_wday    INT,                                -- 월=일자(1-31), 주=요일(0-6)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE TRIGGER trg_recurring_upd BEFORE UPDATE ON recurring_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
