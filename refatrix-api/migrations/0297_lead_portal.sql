-- =====================================================================
-- 0297 · Meta 광고 문의 → refaccionaria 고객 포털 (2026-10-26 디렉터 지시)
--   「ERP 주소는 공개하지 않고, 우리 refaccionaria 고객이 Meta 광고 문의를 보고 우리 부품을 팔게 하고 싶다」
--   · 고객별 접속코드(디렉터 발급 · 만료일 직접 입력 · 정지/재개 · 재발급 · 삭제 · 열람 범위(주))
--   · 고객 화면 = REFATRIX Platform(Netlify) leads.html — Netlify 가 /lp-api/* 를 ERP 로 전달(ERP·Railway 주소 비노출)
--   · 연락처 공개 기록 · 고객 매장 재고(고객 · 담당 영업사원 · 디렉터가 수정, 이력) · 포털 주문 → ERP 견적(초안)
-- 재실행 안전.
-- =====================================================================

-- 접속코드 — 코드는 해시만 저장(발급 직후 한 번만 전체가 보인다)
CREATE TABLE IF NOT EXISTS lead_portal_codes (
  id             BIGSERIAL PRIMARY KEY,
  customer_id    BIGINT NOT NULL REFERENCES customers(id),
  code_hash      TEXT NOT NULL UNIQUE,
  code_last4     TEXT NOT NULL,
  expires_on     DATE NOT NULL,                       -- 이 날 23:59(멕시코시티)까지 열람
  basis_amount   NUMERIC(15,2),                       -- 기준 금액(디렉터 입력 · 기록용)
  memo           TEXT,                                -- 조건 메모(고객에게 안 보임)
  scope_states   TEXT[],                              -- NULL = 전체 문의, 아니면 그 주(州)들만
  active         BOOLEAN NOT NULL DEFAULT true,       -- false = 정지
  token_version  INT NOT NULL DEFAULT 1,              -- 재발급 · 삭제 시 증가 → 나간 토큰 즉시 무효
  last_seen_at   TIMESTAMPTZ,
  created_by     BIGINT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     BIGINT REFERENCES users(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS lead_portal_codes_customer_idx ON lead_portal_codes (customer_id);

-- 접속코드 변경 이력(발급 · 기한 변경 · 정지 · 재개 · 재발급 · 범위 · 삭제)
CREATE TABLE IF NOT EXISTS lead_portal_code_log (
  id        BIGSERIAL PRIMARY KEY,
  code_id   BIGINT NOT NULL REFERENCES lead_portal_codes(id),
  action    TEXT NOT NULL,
  detail    JSONB,
  user_id   BIGINT REFERENCES users(id),
  at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_portal_code_log_code_idx ON lead_portal_code_log (code_id, at DESC);

-- 연락처 공개 기록 — 같은 고객이 같은 문의를 다시 열면 한 줄(횟수 · 마지막 시각만 갱신)
CREATE TABLE IF NOT EXISTS lead_portal_reveals (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id),
  code_id      BIGINT NOT NULL REFERENCES lead_portal_codes(id),
  thread_id    BIGINT NOT NULL REFERENCES meta_threads(id) ON DELETE CASCADE,   -- 문의가 지워지면 공개 기록도 의미 없음
  first_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  n            INT NOT NULL DEFAULT 1,
  UNIQUE (customer_id, thread_id)
);
CREATE INDEX IF NOT EXISTS lead_portal_reveals_thread_idx ON lead_portal_reveals (thread_id);
CREATE INDEX IF NOT EXISTS lead_portal_reveals_at_idx ON lead_portal_reveals (first_at DESC);

-- 고객 매장 재고 — 고객(포털) · 담당 영업사원 · 디렉터(ERP)가 같은 값을 고친다. 최근 값만 여기, 이력은 _log
CREATE TABLE IF NOT EXISTS customer_shelf_stock (
  customer_id   BIGINT NOT NULL REFERENCES customers(id),
  product_id    BIGINT NOT NULL REFERENCES products(id),
  qty           NUMERIC(15,3) NOT NULL CHECK (qty >= 0),
  src           TEXT NOT NULL CHECK (src IN ('customer','staff')),
  user_id       BIGINT REFERENCES users(id),           -- src=staff
  code_id       BIGINT REFERENCES lead_portal_codes(id), -- src=customer
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, product_id)
);
CREATE TABLE IF NOT EXISTS customer_shelf_stock_log (
  id            BIGSERIAL PRIMARY KEY,
  customer_id   BIGINT NOT NULL REFERENCES customers(id),
  product_id    BIGINT NOT NULL REFERENCES products(id),
  old_qty       NUMERIC(15,3),
  new_qty       NUMERIC(15,3),                         -- NULL = 지움
  src           TEXT NOT NULL CHECK (src IN ('customer','staff')),
  user_id       BIGINT REFERENCES users(id),
  code_id       BIGINT REFERENCES lead_portal_codes(id),
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_shelf_stock_log_idx ON customer_shelf_stock_log (customer_id, product_id, at DESC);

-- 포털 주문 → 견적(origin='lead_portal')
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS lead_portal_code_id BIGINT REFERENCES lead_portal_codes(id);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS lead_portal_key     TEXT;     -- 같은 주문 두 번 눌러도 견적 하나(멱등)
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS lead_thread_ids     BIGINT[]; -- 어느 Meta 문의에서 나온 주문인가
CREATE UNIQUE INDEX IF NOT EXISTS quotes_lead_portal_key_uq ON quotes (lead_portal_key) WHERE lead_portal_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS quotes_lead_portal_code_idx ON quotes (lead_portal_code_id) WHERE lead_portal_code_id IS NOT NULL;
