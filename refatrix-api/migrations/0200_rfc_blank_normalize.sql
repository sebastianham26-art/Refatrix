-- =====================================================================
-- Refatrix ERP · 0200_rfc_blank_normalize
--
--   「RFC 가 없거나 `.` 만 찍은 고객」이 서로 중복으로 보이던 문제의 **데이터 쪽 정리**.
--
--   무슨 일이 있었나:
--     customers.rfc 에 `.` · `-` · 공백처럼 **영숫자가 하나도 없는 값**이 들어간 행이 있다.
--     생성컬럼 rfc_norm 은 NULLIF(...) 이라 이런 값은 NULL 이 된다 —
--     즉 DB 기준으로는 「RFC 없음(선점 없음)」이 맞다.
--     그런데 화면·API 는 `c.rfc` 문자열이 비었는지로 갈랐기 때문에
--     이 행들은 「RFC 가 있는 고객」 분기를 타고, 선점 예외·중복 안내까지 떴다.
--     결과적으로 RFC 가 없는 고객끼리 서로 중복인 것처럼 보였다.
--
--   무엇을 하나:
--     ① 선점 키가 없는 값(rfc_norm IS NULL 인데 rfc 는 비어있지 않은 행)을 NULL 로 접는다.
--        → 목록·상세·엑셀 어디서나 「미등록」으로 한 가지로 보인다.
--     ② 그런 행에 남아 있는 rfc_claim_exempt 를 해제한다.
--        선점 키가 없으면 uq_customers_rfc_claim 대상 자체가 아니므로 플래그가 무의미하고,
--        남아 있으면 화면이 중복 분기를 탄다.
--
--   ⚠ **정상 RFC 는 한 글자도 건드리지 않는다.** 지저분하지만 영숫자가 있는 레거시 값
--     (`RFC 123 SUCURSAL-B` 등)도 그대로 둔다 — 그건 rfc_norm 이 살아 있어 선점 키로 동작한다.
--   ⚠ rfc_norm 은 생성컬럼이라 자동으로 따라온다(원래 NULL 이었으므로 값 변화 없음).
--     따라서 uq_customers_rfc_claim · idx_customers_rfc_norm 에 영향이 없다.
--   멱등: 재실행해도 대상이 0건이 된다.
-- =====================================================================

-- ① 영숫자가 하나도 없는 RFC → NULL
UPDATE customers
   SET rfc = NULL
 WHERE rfc IS NOT NULL
   AND NULLIF(upper(regexp_replace(rfc, '[^A-Za-z0-9]', '', 'g')), '') IS NULL;

-- ② 선점 키가 없는 행의 선점 예외 플래그 해제(유니크 인덱스 대상이 아니라 안전)
UPDATE customers
   SET rfc_claim_exempt = false
 WHERE rfc_claim_exempt = true
   AND rfc_norm IS NULL;

DO $$
DECLARE n INT; m INT;
BEGIN
  SELECT count(*) INTO n FROM customers
   WHERE rfc IS NOT NULL
     AND NULLIF(upper(regexp_replace(rfc, '[^A-Za-z0-9]', '', 'g')), '') IS NULL;
  SELECT count(*) INTO m FROM customers
   WHERE rfc_claim_exempt = true AND rfc_norm IS NULL;
  RAISE NOTICE '0200: 남은 껍데기 RFC % 건 · 선점키 없는 예외 % 건 (둘 다 0 이어야 정상)', n, m;
END $$;
