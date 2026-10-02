-- =====================================================================
-- Refatrix ERP · 0247_customer_terms_override  (2026-10-02)
-- 서류 관문(0235) 디렉터 PIN 승인 예외
--
--   증상: 서류가 모자란 신규 고객은 실효 할인·외상일이 0 이라 CRM 에도 0 이 나간다.
--   디렉터 지시: 조건이 안 돼도 **디렉터 PIN 승인**이 있으면 조건을 충족한 것으로 보고
--               약정 할인율·외상일이 그대로 적용·전송되게 한다.
--
--   · discount_override = true → 서류(Constancia + 주소 증빙) 없이도 약정 할인 적용
--   · credit_override   = true → 경쟁사 인보이스 없이도 약정 외상일 적용(약정 0 이면 기본 30일)
--   · 누가·언제·왜 는 컬럼 + customer_registration_events('terms_override') 에 남는다.
--   · 해제하면 즉시 서류 기준으로 돌아간다.
--   재실행 멱등.
-- =====================================================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS discount_override BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_override   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS terms_override_by     BIGINT REFERENCES users(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS terms_override_at     TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS terms_override_reason TEXT;

COMMENT ON COLUMN customers.discount_override IS '디렉터 PIN 승인 — 서류 없이 약정 할인 적용. 0247';
COMMENT ON COLUMN customers.credit_override   IS '디렉터 PIN 승인 — 경쟁사 인보이스 없이 약정 외상일 적용. 0247';

-- 0235 트리거 함수를 그대로 두고 (b) 실효값 계산에 예외 플래그만 더한다.
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

  -- (b) 실효값 = 관문 적용 결과. 0247 · 디렉터 PIN 승인(override)이면 서류가 없어도 충족.
  IF NEW.doc_gate THEN
    IF TG_OP = 'UPDATE' THEN
      SELECT bool_or(doc_type = 'constancia'), bool_or(doc_type = 'domicilio'), bool_or(doc_type = 'factura_compra')
        INTO has_con, has_dom, has_fac
        FROM customer_documents WHERE customer_id = NEW.id AND deleted_at IS NULL;
    END IF;
    NEW.discount := CASE WHEN (COALESCE(has_con,false) AND COALESCE(has_dom,false)) OR COALESCE(NEW.discount_override,false)
                         THEN COALESCE(NEW.discount_agreed, 0) ELSE 0 END;
    NEW.credit_days := CASE WHEN COALESCE(has_fac,false) OR COALESCE(NEW.credit_override,false)
                            THEN COALESCE(NULLIF(NEW.credit_days_agreed, 0), 30) ELSE 0 END;
  ELSIF sync_mode THEN
    NEW.discount    := COALESCE(NEW.discount_agreed, NEW.discount);
    NEW.credit_days := COALESCE(NEW.credit_days_agreed, NEW.credit_days);
  END IF;

  -- (c) RFC 독점 기산 (0235 그대로)
  rfc_clean := NULLIF(upper(regexp_replace(COALESCE(NEW.rfc, ''), '[^A-Za-z0-9]', '', 'g')), '');
  IF NEW.excl_policy AND NEW.rfc_excl_from IS NULL AND rfc_clean IS NOT NULL
     AND NEW.deleted_at IS NULL AND COALESCE(NEW.approval_status, 'approved') = 'approved' THEN
    NEW.rfc_excl_from     := (now() AT TIME ZONE 'America/Mexico_City')::date;
    NEW.rfc_excl_agent_id := COALESCE(NEW.rfc_claimed_by, NEW.owner_id);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
