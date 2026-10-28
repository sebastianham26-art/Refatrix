-- =====================================================================
-- Refatrix ERP · 0305_rfc_placeholder_null  (2026-10-28 hotfix)
--
--   증상: RFC 없는 고객(P-0024 Luis Gurrola · P-0021 francisco cuenca)의 수정 요청을
--         승인하면 「승인 실패: 이미 등록된 고객입니다 — JOEL FUANTOS LUNA / REFACCIONARIA
--         FUANTOS · 담당 dante · 선점일 2026-09-25」 가 떴다.
--   원인: applyCustomerUpdate 가 proposed.rfc = null 을 String(null) = 'null' 로 바꿔
--         「새 RFC 'null' 입력」 으로 취급했다 → 선점키 'NULL' 로 충돌 검사.
--         예전에 같은 경로로 'null' 문자열이 RFC 로 저장된 고객이 있어 그 고객이 잡혔다.
--         (코드 수정: routes/customerRoutes.js — null·'null'·'undefined' 는 입력 없음으로 본다)
--
--   무엇을 하나: RFC 칸에 굳어 버린 자리표시 문자열(null · undefined · none · n/a)을
--                진짜 NULL 로 되돌리고, 그 값으로 생긴 선점 시각·예외 플래그도 지운다.
--   ⚠ 독점(excl_*) 컬럼은 건드리지 않는다 — 독점은 디렉터 판단 영역이다.
--   ⚠ 정상 RFC 는 한 글자도 건드리지 않는다(대상은 정규화 키가 정확히 4개 값인 행뿐).
--   멱등: 재실행하면 대상 0건.
-- =====================================================================

-- ① 이력부터 남긴다 — 어떤 고객이 어떤 값을 갖고 있었는지 나중에 확인할 수 있게.
INSERT INTO customer_registration_events (customer_id, action, reason, snapshot, acted_by)
SELECT c.id, 'rfc_placeholder_clear',
       '0305 · RFC 칸의 자리표시 문자열(null 등)을 비움 — 선점 키가 아님',
       jsonb_build_object('rfc_before', c.rfc), NULL
  FROM customers c
 WHERE c.rfc IS NOT NULL
   AND upper(regexp_replace(c.rfc, '[^A-Za-z0-9]', '', 'g')) IN ('NULL', 'UNDEFINED', 'NONE', 'NA');

-- ② RFC 비우기 (rfc_norm 은 생성컬럼이라 자동으로 NULL)
UPDATE customers
   SET rfc = NULL
 WHERE rfc IS NOT NULL
   AND upper(regexp_replace(rfc, '[^A-Za-z0-9]', '', 'g')) IN ('NULL', 'UNDEFINED', 'NONE', 'NA');

-- ③ 그 값으로 찍힌 선점 시각·선점자·예외 플래그 정리 (0193 컬럼이 있을 때만)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='customers' AND column_name='rfc_claimed_at') THEN
    EXECUTE $q$
      UPDATE customers c
         SET rfc_claimed_at = NULL, rfc_claimed_by = NULL
       WHERE c.rfc IS NULL AND c.rfc_claimed_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM customer_registration_events e
                      WHERE e.customer_id = c.id AND e.action = 'rfc_placeholder_clear')
    $q$;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='customers' AND column_name='rfc_claim_exempt') THEN
    EXECUTE 'UPDATE customers SET rfc_claim_exempt = false WHERE rfc_claim_exempt = true AND rfc_norm IS NULL';
  END IF;
END $$;

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM customers
   WHERE rfc IS NOT NULL
     AND upper(regexp_replace(rfc, '[^A-Za-z0-9]', '', 'g')) IN ('NULL', 'UNDEFINED', 'NONE', 'NA');
  RAISE NOTICE '0305: 남은 자리표시 RFC % 건 (0 이어야 정상)', n;
END $$;
