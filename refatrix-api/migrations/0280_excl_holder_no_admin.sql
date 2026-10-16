-- =====================================================================
-- 0280 · 관리자·디렉터 계정은 고객 독점권자가 되지 않는다 (2026-10-16)
--
--   문제: 관리자 계정으로 고객을 등록하면 RFC 독점 30일의 독점권자가
--         COALESCE(rfc_claimed_by, owner_id) = 관리자로 잡혀, 영업사원이 견적을 저장할 수 없었다
--         (C-0142 · Oscar). 담당자를 영업사원으로 바꿔도 독점권자는 바뀌지 않고,
--         6시간마다 도는 재계산이 담당자를 다시 관리자로 되돌렸다.
--
--   규칙: role IN ('director','socio') 는 독점권자 자격이 없다.
--         · RFC 독점권자가 관리자면 → 담당자가 자격이 있으면 담당자, 없으면 독점 없음(개방).
--         · 개방 고객은 처음 인보이스를 낸 영업사원이 1년 독점을 가져간다(exclusivity.js 와 동일 규칙).
--
--   구현: 0247 의 refx_customer_terms_gate 는 그대로 두고, 그 뒤에 도는 BEFORE 트리거를 하나 더 건다.
--         같은 시점의 트리거는 이름 순으로 실행된다:
--           trg_customers_terms_gate → trg_customers_terms_gate_zexcl
-- =====================================================================

CREATE OR REPLACE FUNCTION refx_excl_eligible(uid BIGINT) RETURNS BOOLEAN AS $$
  SELECT uid IS NOT NULL AND EXISTS (
    SELECT 1 FROM users u WHERE u.id = uid AND COALESCE(u.role, '') NOT IN ('director', 'socio'));
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION refx_customer_excl_holder() RETURNS trigger AS $$
BEGIN
  IF NEW.rfc_excl_agent_id IS NOT NULL AND NOT refx_excl_eligible(NEW.rfc_excl_agent_id) THEN
    IF refx_excl_eligible(NEW.owner_id) THEN
      NEW.rfc_excl_agent_id := NEW.owner_id;
    ELSE
      -- 기산일도 비운다: 나중에 디렉터가 영업사원을 담당자로 지정하면
      -- 0247 트리거가 그날부터 새 30일을 그 영업사원에게 준다.
      NEW.rfc_excl_agent_id := NULL;
      NEW.rfc_excl_from     := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customers_terms_gate_zexcl ON customers;
CREATE TRIGGER trg_customers_terms_gate_zexcl BEFORE INSERT OR UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION refx_customer_excl_holder();

-- 기존 데이터 정리: 관리자·디렉터가 RFC 독점권자인 고객 → 트리거 규칙으로 다시 판정
UPDATE customers c
   SET rfc_excl_agent_id = c.rfc_excl_agent_id
 WHERE c.rfc_excl_agent_id IS NOT NULL
   AND NOT refx_excl_eligible(c.rfc_excl_agent_id);

-- 목록 배지 캐시: 관리자·디렉터가 독점권자로 캐시돼 있으면 비운다(다음 재계산에서 다시 채움)
UPDATE customers c
   SET excl_kind = NULL, excl_agent_id = NULL, excl_until = NULL
 WHERE c.excl_agent_id IS NOT NULL
   AND NOT refx_excl_eligible(c.excl_agent_id);
