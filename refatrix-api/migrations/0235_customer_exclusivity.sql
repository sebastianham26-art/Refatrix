-- =====================================================================
-- Refatrix ERP · 0235_customer_exclusivity  (2026-09-29)
-- 공지 「고객 독점 정책 및 거래 조건」(2026-09-28 시행) — 디렉터 확정 사항
--
--   ① 판매 영업사원: 인보이스·견적에 seller_id. 커미션은 인보이스 날짜의 독점권자로 고정
--      (sales_invoices.commission_agent_id — 앱의 exclusivity.js 가 채운다).
--   ② 독점 대상(excl_policy): 2026-09-28 이전에 거래(매출)가 한 번도 없던 고객.
--      · RFC 독점 30일 — **디렉터 승인일**(RFC 가 나중에 들어오면 그 RFC 승인일)부터.
--      · 판매 독점 1년 — 첫 인보이스 날짜부터. 1년 안에 서로 다른 6개월 매출 → +1년 자동 연장.
--      · 연장 못 하면 다시 개방, 다음 인보이스를 낸 사람이 새 1년.
--   ③ 서류 관문(doc_gate): **2026-09-28 이후 등록된 신규 고객만.**
--      · 할인 = Constancia + Comprobante de domicilio 둘 다 있을 때만.
--      · 외상 = 경쟁사 서스펜션 구매 인보이스가 있을 때만(기본 30일), 없으면 선입금(0일).
--      → customers.discount / credit_days 는 **실효값**, 약정값은 *_agreed 에 보관.
--        30여 곳의 기존 코드가 discount·credit_days 를 그대로 읽어도 관문이 적용되도록
--        트리거로 동기화한다(아래 ⑤·⑥).
--
--   기존 데이터는 지우지 않는다. 재실행 멱등(IF NOT EXISTS / CREATE OR REPLACE).
-- =====================================================================

-- ── ① 판매 영업사원 · 커미션 귀속 스냅샷 ─────────────────────────────
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS seller_id           BIGINT REFERENCES users(id);
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS commission_agent_id BIGINT REFERENCES users(id);
ALTER TABLE quotes         ADD COLUMN IF NOT EXISTS seller_id           BIGINT REFERENCES users(id);

COMMENT ON COLUMN sales_invoices.seller_id IS
  '판매 영업사원(인보이스·출력물 표시). 등록자(owner_id)와 다르다. 0235';
COMMENT ON COLUMN sales_invoices.commission_agent_id IS
  '커미션 귀속 = 인보이스 날짜의 독점권자(독점 대상 고객) / 발행 시점 고객 담당자(기존 고객). 0235';

-- 기존 인보이스 백필: 연결된 견적의 담당(배정자 → 작성자) → 고객 담당자 순.
UPDATE sales_invoices i
   SET seller_id = COALESCE(
         (SELECT COALESCE(q.assigned_to, q.created_by) FROM quotes q
           WHERE q.invoice_id = i.id AND q.deleted_at IS NULL ORDER BY q.id DESC LIMIT 1),
         (SELECT c.owner_id FROM customers c WHERE c.id = i.customer_id))
 WHERE i.seller_id IS NULL;

UPDATE quotes q
   SET seller_id = COALESCE(q.assigned_to,
         (SELECT c.owner_id FROM customers c WHERE c.id = q.customer_id))
 WHERE q.seller_id IS NULL AND q.customer_id IS NOT NULL;

-- 기존 인보이스의 커미션 귀속 = 지금의 고객 담당자로 고정(오늘 기준 최선의 정보).
--   독점 대상 고객의 인보이스는 서버 기동 시 exclusivity.js 가 다시 계산해 덮어쓴다.
UPDATE sales_invoices i
   SET commission_agent_id = (SELECT c.owner_id FROM customers c WHERE c.id = i.customer_id)
 WHERE i.commission_agent_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_si_seller ON sales_invoices (seller_id) WHERE deleted_at IS NULL;

-- ── ② 독점 대상 / 서류 관문 플래그 ────────────────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS excl_policy BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS doc_gate    BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN customers.excl_policy IS
  'true = 독점 정책 대상(2026-09-28 이전 매출 없음). false = 기존 거래 고객(담당자 규칙 유지). 0235';
COMMENT ON COLUMN customers.doc_gate IS
  'true = 서류 관문 적용(2026-09-28 이후 등록 신규 고객). 0235';

-- 2026-09-28 이전 인보이스(삭제 제외)가 한 건이라도 있으면 기존 거래 고객.
--   ⚠ 0235 를 처음 적용할 때만 판정한다(_migrations 로 한 번만 도는 파일).
UPDATE customers c SET excl_policy = false
 WHERE EXISTS (SELECT 1 FROM sales_invoices i
                WHERE i.customer_id = c.id AND i.deleted_at IS NULL
                  AND COALESCE(i.status,'posted') <> 'deleted'
                  AND i.inv_date < DATE '2026-09-28');

UPDATE customers SET doc_gate = false
 WHERE created_at < (TIMESTAMP '2026-09-28 00:00' AT TIME ZONE 'America/Mexico_City');

-- ── ③ RFC 독점 기산 ───────────────────────────────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS rfc_excl_from     DATE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS rfc_excl_agent_id BIGINT REFERENCES users(id);

COMMENT ON COLUMN customers.rfc_excl_from IS
  'RFC 독점 30일 기산일 = 디렉터 승인일(RFC 가 나중에 승인되면 그 날). 0235';

-- 백필: 승인일과 RFC 승인(선점 요청 승인)일 중 늦은 날. 승인 기록이 없는 레거시는 등록일.
UPDATE customers c
   SET rfc_excl_from = (GREATEST(
             COALESCE(c.approved_at, c.created_at),
             c.rfc_claimed_at,
             (SELECT max(k.decided_at) FROM customer_rfc_claims k
               WHERE k.customer_id = c.id AND k.status = 'approved'))
           AT TIME ZONE 'America/Mexico_City')::date,
       rfc_excl_agent_id = COALESCE(c.rfc_claimed_by, c.owner_id)
 WHERE c.excl_policy
   AND c.rfc_norm IS NOT NULL
   AND c.deleted_at IS NULL
   AND COALESCE(c.approval_status,'approved') = 'approved'
   AND c.rfc_excl_from IS NULL;

-- ── ④ 현재 독점 상태 캐시(목록 배지용 — 판정은 매번 exclusivity.js 가 새로 계산) ──
ALTER TABLE customers ADD COLUMN IF NOT EXISTS excl_kind     TEXT;     -- 'rfc' | 'sale' | NULL(개방)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS excl_agent_id BIGINT REFERENCES users(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS excl_until    DATE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS excl_synced_at TIMESTAMPTZ;

-- ── ⑤ 약정값 보관 + 서류 관문 트리거 ─────────────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS discount_agreed    NUMERIC(5,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_days_agreed INT;
UPDATE customers SET discount_agreed = discount       WHERE discount_agreed    IS NULL;
UPDATE customers SET credit_days_agreed = credit_days WHERE credit_days_agreed IS NULL;

CREATE OR REPLACE FUNCTION refx_customer_terms_gate() RETURNS trigger AS $$
DECLARE
  sync_mode BOOLEAN := COALESCE(current_setting('refatrix.terms_sync', true), '') = '1';
  has_con BOOLEAN := false;
  has_dom BOOLEAN := false;
  has_fac BOOLEAN := false;
  rfc_clean TEXT;
BEGIN
  -- (a) 앱이 할인/외상일을 쓰면 그것이 **약정값**이다. 서류 동기화(sync_mode)는 약정값을 건드리지 않는다.
  IF NOT sync_mode THEN
    IF TG_OP = 'INSERT' OR NEW.discount IS DISTINCT FROM OLD.discount THEN
      NEW.discount_agreed := NEW.discount;
    END IF;
    IF TG_OP = 'INSERT' OR NEW.credit_days IS DISTINCT FROM OLD.credit_days THEN
      NEW.credit_days_agreed := NEW.credit_days;
    END IF;
  END IF;

  -- (b) 실효값 = 관문 적용 결과
  IF NEW.doc_gate THEN
    IF TG_OP = 'UPDATE' THEN
      SELECT bool_or(doc_type = 'constancia'), bool_or(doc_type = 'domicilio'), bool_or(doc_type = 'factura_compra')
        INTO has_con, has_dom, has_fac
        FROM customer_documents WHERE customer_id = NEW.id AND deleted_at IS NULL;
    END IF;   -- INSERT 시점엔 서류가 아직 없다(서류 INSERT 가 ⑥ 으로 다시 계산한다)
    NEW.discount := CASE WHEN COALESCE(has_con,false) AND COALESCE(has_dom,false)
                         THEN COALESCE(NEW.discount_agreed, 0) ELSE 0 END;
    NEW.credit_days := CASE WHEN COALESCE(has_fac,false)
                            THEN COALESCE(NULLIF(NEW.credit_days_agreed, 0), 30) ELSE 0 END;
  ELSIF sync_mode THEN
    NEW.discount    := COALESCE(NEW.discount_agreed, NEW.discount);
    NEW.credit_days := COALESCE(NEW.credit_days_agreed, NEW.credit_days);
  END IF;

  -- (c) RFC 독점 기산: 독점 대상 고객이 **승인 + RFC** 를 처음 갖춘 날 = 디렉터 승인일.
  rfc_clean := NULLIF(upper(regexp_replace(COALESCE(NEW.rfc, ''), '[^A-Za-z0-9]', '', 'g')), '');
  IF NEW.excl_policy AND NEW.rfc_excl_from IS NULL AND rfc_clean IS NOT NULL
     AND NEW.deleted_at IS NULL AND COALESCE(NEW.approval_status, 'approved') = 'approved' THEN
    NEW.rfc_excl_from     := (now() AT TIME ZONE 'America/Mexico_City')::date;
    NEW.rfc_excl_agent_id := COALESCE(NEW.rfc_claimed_by, NEW.owner_id);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customers_terms_gate ON customers;
CREATE TRIGGER trg_customers_terms_gate BEFORE INSERT OR UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION refx_customer_terms_gate();

-- ── ⑥ 서류가 올라오거나 지워지면 그 고객의 실효 조건을 다시 계산 ─────
CREATE OR REPLACE FUNCTION refx_customer_docs_sync() RETURNS trigger AS $$
DECLARE cid BIGINT;
BEGIN
  cid := CASE WHEN TG_OP = 'DELETE' THEN OLD.customer_id ELSE NEW.customer_id END;
  PERFORM set_config('refatrix.terms_sync', '1', true);
  UPDATE customers SET discount = discount WHERE id = cid AND doc_gate;
  PERFORM set_config('refatrix.terms_sync', '0', true);
  IF TG_OP = 'UPDATE' AND OLD.customer_id IS DISTINCT FROM NEW.customer_id THEN
    PERFORM set_config('refatrix.terms_sync', '1', true);
    UPDATE customers SET discount = discount WHERE id = OLD.customer_id AND doc_gate;
    PERFORM set_config('refatrix.terms_sync', '0', true);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customer_docs_sync ON customer_documents;
CREATE TRIGGER trg_customer_docs_sync AFTER INSERT OR UPDATE OR DELETE ON customer_documents
  FOR EACH ROW EXECUTE FUNCTION refx_customer_docs_sync();

-- 이미 관문 대상인 고객(09-28 이후 등록)의 실효값을 한 번 맞춘다.
SELECT set_config('refatrix.terms_sync', '1', true);
UPDATE customers SET discount = discount WHERE doc_gate;
SELECT set_config('refatrix.terms_sync', '0', true);
