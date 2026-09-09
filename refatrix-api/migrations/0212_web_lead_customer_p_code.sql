-- 0212 · 웹에서 들어온 고객은 P-#### (이미 C 로 채번된 건 정정)
--
--   원칙: 유입 경로가 **코드 계열로 한눈에** 보여야 한다.
--     C-#### = ERP 에서 영업사원·디렉터가 등록한 고객
--     P-#### = 웹카달록에서 들어온 고객
--
--   무엇이 어긋나 있었나:
--     CRM 이 직접 보낸 신규고객(0208 수신)만 P 를 받았고,
--     **웹 가입 신청 → 「이 정보로 고객 등록」** 경로는 기본값 C 로 채번했다.
--     원칙이 반쪽만 지켜지고 있었던 것이다. 코드는 0212 에서 고쳤고,
--     이 마이그레이션은 **이미 잘못 붙은 번호를 되돌린다.**
--
--   안전한가:
--     customers.code 를 텍스트로 **저장**하는 테이블은 없다. 견적·매출·수금 등 모든 화면은
--     customer_id 로 조인해 `c.code` 를 그때그때 읽는다(전부 `c.code AS customer_code` 별칭).
--     따라서 코드를 바꾸면 과거 문서의 표시도 함께 새 코드로 따라온다 — 같은 고객이므로 맞다.
--
--   무엇을 고치나: **웹 유입인데 C 계열인 고객만.** 그 외에는 한 줄도 건드리지 않는다.
--   멱등: 재실행하면 대상이 0건이라 아무 일도 일어나지 않는다.

DO $$
DECLARE
  n_fixed INT := 0;
BEGIN
  IF to_regclass('public.crm_web_leads') IS NULL THEN
    RAISE NOTICE '0212: crm_web_leads 없음 — 건너뜀';
    RETURN;
  END IF;

  WITH target AS (
    SELECT DISTINCT c.id
      FROM customers c
     WHERE c.code ~ '^[Cc]-?[0-9]+$'
       AND (EXISTS (SELECT 1 FROM crm_web_leads l WHERE l.customer_id = c.id)
            OR (c.crm_customer_code IS NOT NULL AND btrim(c.crm_customer_code) <> ''))
  ),
  base AS (
    -- 삭제된 고객의 번호까지 센다 — code 는 유니크라 재사용하면 충돌한다.
    SELECT COALESCE(MAX((regexp_replace(code, '^[Pp]-?', ''))::int), 0) AS maxn
      FROM customers WHERE code ~ '^[Pp]-?[0-9]+$'
  ),
  numbered AS (
    SELECT t.id, row_number() OVER (ORDER BY t.id) AS rn FROM target t
  ),
  moved AS (
    UPDATE customers c
       SET code = 'P-' || lpad(((SELECT maxn FROM base) + n.rn)::text, 4, '0')
      FROM numbered n
     WHERE c.id = n.id
     RETURNING c.id, c.code
  )
  SELECT count(*) INTO n_fixed FROM moved;

  RAISE NOTICE '0212: 웹 유입 고객 % 건의 코드를 P 계열로 정정했습니다.', n_fixed;
END $$;

-- 바뀐 코드는 등록 이력에 남긴다 — 코드가 조용히 바뀌면 나중에 아무도 이유를 모른다.
INSERT INTO customer_registration_events (customer_id, action, reason, snapshot, acted_by)
SELECT c.id, 'submit',
       '고객코드 정정 — 웹 유입 고객은 P 계열(0212)',
       jsonb_build_object('migration', '0212', 'new_code', c.code,
                          'origin', 'web_lead', 'note', '이전 코드는 C 계열이었습니다'),
       NULL
  FROM customers c
 WHERE c.code ~ '^[Pp]-?[0-9]+$'
   AND EXISTS (SELECT 1 FROM crm_web_leads l WHERE l.customer_id = c.id)
   AND NOT EXISTS (
     SELECT 1 FROM customer_registration_events e
      WHERE e.customer_id = c.id AND e.snapshot->>'migration' = '0212');
