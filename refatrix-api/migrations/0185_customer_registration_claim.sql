-- =====================================================================
-- Refatrix ERP · 0185_customer_registration_claim
--
--   100% 커미션 영업사원 도입에 따른 「고객 선점(claim) + 등록 디렉터 승인」 고도화.
--
--   (1) customers.approval_status  — 신규 등록은 디렉터 승인 전까지 pending.
--                                    기존 고객은 전부 approved 로 백필(회귀 없음).
--   (2) customers.constancia_no    — CONSTANCIA 번호(선점 키). 정규화 컬럼 + 부분 유니크 인덱스.
--                                    ⚠ 신규 컬럼이므로 인덱스 생성 시 기존 데이터 충돌이 없다.
--   (3) 기준품목(SYD 1516049) 구매단가 스냅샷 + 산출/제안 할인율 보관 컬럼.
--   (4) customers.rejected_reason / approved_by / approved_at / registered_at
--   (5) rfc 정규화 인덱스(유니크 아님 — 기존 중복 데이터가 있어 조회용으로만).
--
--   멱등: 전부 IF NOT EXISTS. 재실행 안전.
-- =====================================================================

-- (1) 등록 승인 상태 --------------------------------------------------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS approval_status TEXT;
UPDATE customers SET approval_status = 'approved' WHERE approval_status IS NULL;
ALTER TABLE customers ALTER COLUMN approval_status SET DEFAULT 'approved';

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_approval_status_check;
ALTER TABLE customers ADD CONSTRAINT customers_approval_status_check
  CHECK (approval_status IN ('pending', 'approved', 'rejected'));

ALTER TABLE customers ADD COLUMN IF NOT EXISTS approved_by      BIGINT REFERENCES users(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS approved_at      TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS rejected_reason  TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS submitted_at     TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_customers_approval
  ON customers (approval_status) WHERE deleted_at IS NULL;

COMMENT ON COLUMN customers.approval_status IS
  'pending=디렉터 승인 대기(견적·매출 사용 불가) / approved=정상 / rejected=반려(선점 해제)';

-- (2) CONSTANCIA 번호 = 선점 키 ---------------------------------------
--   기존 constancia_fiscal(자유 텍스트 "RFC · Régimen · 상태")은 그대로 두고,
--   선점 판정에 쓸 "번호"만 별도 컬럼으로 분리한다.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS constancia_no TEXT;

-- 정규화(영숫자만·대문자) — 하이픈/공백/점 표기 차이로 선점을 우회하지 못하게.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS constancia_no_norm TEXT
  GENERATED ALWAYS AS (NULLIF(upper(regexp_replace(coalesce(constancia_no, ''), '[^A-Za-z0-9]', '', 'g')), '')) STORED;

-- 선점 유니크: 살아있고 반려되지 않은 고객끼리는 같은 CONSTANCIA 번호를 못 쓴다.
--   (신규 컬럼이라 기존 행은 전부 NULL → 인덱스 생성 시 충돌 없음)
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_constancia_no
  ON customers (constancia_no_norm)
  WHERE constancia_no_norm IS NOT NULL AND deleted_at IS NULL AND approval_status <> 'rejected';

-- (5) RFC 정규화 — 조회용 인덱스만(기존 중복 데이터가 있어 유니크로 걸지 않는다).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS rfc_norm TEXT
  GENERATED ALWAYS AS (NULLIF(upper(regexp_replace(coalesce(rfc, ''), '[^A-Za-z0-9]', '', 'g')), '')) STORED;
CREATE INDEX IF NOT EXISTS idx_customers_rfc_norm
  ON customers (rfc_norm) WHERE rfc_norm IS NOT NULL AND deleted_at IS NULL;

-- (3) 기준품목 구매단가 → 할인율 산출 스냅샷 ---------------------------
--   등록 시점의 근거를 박제한다. 이후 정가가 바뀌어도 "왜 이 할인율로 승인했는지"가 남는다.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS syd_ref_code       TEXT;             -- 기준 SYD 코드(기본 1516049)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS syd_ref_buy_price  NUMERIC(14,2);    -- 고객이 SYD에서 사는 구매단가(MXN)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS syd_ref_list_price NUMERIC(14,2);    -- 그 시점 SYD List Price
ALTER TABLE customers ADD COLUMN IF NOT EXISTS syd_ref_discount   NUMERIC(6,3);     -- 산출된 SYD 할인율(%)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ctr_ref_code       TEXT;             -- 매칭된 CTR 코드
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ctr_ref_list_price NUMERIC(14,2);    -- 그 시점 CTR List Price
ALTER TABLE customers ADD COLUMN IF NOT EXISTS suggested_discount NUMERIC(6,3);     -- 제안 CTR 할인율(%) — 고객가 대비 5% 우위

COMMENT ON COLUMN customers.suggested_discount IS
  '제안 할인율(%) = 1 − (SYD 구매단가 × 0.95) ÷ CTR List Price. 실제 적용값은 customers.discount.';

-- (6) 등록 승인 이력 ---------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_registration_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id),
  action       TEXT NOT NULL,                 -- 'submit' | 'approve' | 'reject'
  reason       TEXT,
  snapshot     JSONB,                         -- 그 시점 할인/기준단가 근거
  acted_by     BIGINT REFERENCES users(id),
  acted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_custreg_events_customer
  ON customer_registration_events (customer_id, acted_at DESC);
