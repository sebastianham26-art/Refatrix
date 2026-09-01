-- =====================================================================
-- Refatrix ERP · 0193_customer_rfc_optional_claim
--
--   고객 등록에서 **RFC 를 선택 입력**으로 내리고, 그 대신
--   「RFC 를 먼저 입력한 사람이 그 고객을 선점한다」를 명시적인 이관 절차로 만든다.
--
--   배경: 0188 은 RFC 를 등록 필수로 만들어 선점을 앞당겼다. 그런데 현장에서는
--        RFC 조차 못 받은 상태로 상담이 먼저 시작되는 경우가 많고, 그때 고객을
--        ERP 에 못 넣으면 상담·방문 이력이 통째로 유실된다.
--        → RFC 없이도 등록은 되게 하되, **RFC 가 채워지는 순간 선점이 확정**되고
--          그 시점·그 사람에게 우선권이 간다.
--
--   (1) customers.rfc_claimed_at / rfc_claimed_by — 선점이 성립한 시점과 선점자.
--       기존 RFC 보유 고객은 created_at · owner_id 로 백필(회귀 없음).
--   (2) customer_rfc_claims — 남의(=RFC 없는) 고객에 내 RFC 를 넣어 선점을 가져오는 요청.
--       **요청 시각(requested_at)이 우선권의 근거**이고, 확정은 디렉터 승인에서 한다.
--       같은 RFC 로는 대기 요청이 하나만 존재할 수 있다(먼저 넣은 사람이 우선).
--   (3) uq_customers_rfc_claim(0188)은 그대로다 — RFC 가 NULL 인 행은 애초에 인덱스에 안 들어간다.
--
--   멱등: 전부 IF NOT EXISTS / 재실행해도 같은 결과.
-- =====================================================================

-- (1) 선점 시점·선점자 -------------------------------------------------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS rfc_claimed_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS rfc_claimed_by BIGINT REFERENCES users(id);

COMMENT ON COLUMN customers.rfc_claimed_at IS
  'RFC 가 채워져 선점이 성립한 시점. 커미션 귀속 분쟁의 1차 근거(등록일이 아니라 이 값을 본다).';
COMMENT ON COLUMN customers.rfc_claimed_by IS
  'RFC 를 입력해 선점한 사용자. 이관 승인 시 owner_id 와 함께 갱신된다.';

--   기존 RFC 보유 고객: 등록 시점에 선점된 것으로 본다(0188 이전 데이터 포함).
UPDATE customers
   SET rfc_claimed_at = created_at,
       rfc_claimed_by = owner_id
 WHERE rfc_norm IS NOT NULL
   AND rfc_claimed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_customers_rfc_claimed
  ON customers (rfc_claimed_at) WHERE rfc_claimed_at IS NOT NULL AND deleted_at IS NULL;

--   RFC 가 비어 있는(=선점 미성립) 고객 조회용 — 디렉터 정리 화면·매출 관문에서 쓴다.
CREATE INDEX IF NOT EXISTS idx_customers_rfc_missing
  ON customers (created_at) WHERE rfc_norm IS NULL AND deleted_at IS NULL;

-- (2) RFC 선점 이관 요청 ----------------------------------------------
CREATE TABLE IF NOT EXISTS customer_rfc_claims (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id    BIGINT NOT NULL REFERENCES customers(id),
  rfc            TEXT   NOT NULL,                       -- 정리본(대문자·구분자 제거) 저장
  rfc_norm       TEXT   GENERATED ALWAYS AS
                   (NULLIF(upper(regexp_replace(coalesce(rfc, ''), '[^A-Za-z0-9]', '', 'g')), '')) STORED,
  requested_by   BIGINT REFERENCES users(id),
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),    -- ★ 우선권의 근거
  status         TEXT   NOT NULL DEFAULT 'pending',     -- pending|approved|rejected|superseded
  transfer_owner BOOLEAN NOT NULL DEFAULT true,         -- false = 본인 고객에 RFC 만 채우는 경우
  note           TEXT,
  decided_by     BIGINT REFERENCES users(id),
  decided_at     TIMESTAMPTZ,
  decided_reason TEXT
);

ALTER TABLE customer_rfc_claims DROP CONSTRAINT IF EXISTS customer_rfc_claims_status_check;
ALTER TABLE customer_rfc_claims ADD CONSTRAINT customer_rfc_claims_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'superseded'));

--   ★ 같은 RFC 로 대기 중인 요청은 하나뿐이다 = **먼저 입력한 사람이 우선권**.
--     뒤에 넣은 사람은 여기서 막히고 "누가 언제 먼저 넣었는지" 를 안내받는다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rfc_claims_pending_rfc
  ON customer_rfc_claims (rfc_norm) WHERE status = 'pending';

--   한 고객에 서로 다른 RFC 로 여러 요청이 붙는 것은 허용한다(디렉터가 판단).
--   목록은 requested_at 오름차순 = 우선순위 순.
CREATE INDEX IF NOT EXISTS idx_rfc_claims_pending
  ON customer_rfc_claims (status, requested_at);
CREATE INDEX IF NOT EXISTS idx_rfc_claims_customer
  ON customer_rfc_claims (customer_id, requested_at DESC);

COMMENT ON TABLE customer_rfc_claims IS
  'RFC 미입력 고객에 대한 선점(claim) 요청. requested_at 이 우선권의 근거이고, 확정은 디렉터 승인.';
