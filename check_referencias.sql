-- =====================================================================
-- REFATRIX · 대응품번 원천 데이터 점검 (2026-09-19)
--   「제품/마케팅 화면이 보여 주는 것」 vs 「카탈로그 API 가 보내던 것」
--
--   화면      : products.scode          (SYD 전용 · 한 칸에 ' // ' 로 여러 개)
--   API(종전) : product_xref_codes      (BAW·GROB·VASLO·KYB·MOOG·YOKOMITSU·SYD1 …)
--
--   ⚠ 읽기 전용.  실행:  psql "$DATABASE_URL" -f check_referencias.sql
--   Railway 웹 쿼리창에서는 \echo 줄을 빼고 블록을 하나씩 붙여넣는다.
-- =====================================================================

\echo '=== ① 한눈에 — 두 출처의 규모 ================================='
SELECT
  (SELECT count(*) FROM products WHERE deleted_at IS NULL)                                   AS 제품_전체,
  (SELECT count(*) FROM products WHERE deleted_at IS NULL
      AND COALESCE(btrim(scode),'') <> '')                                                   AS scode_보유,
  (SELECT count(*) FROM products WHERE deleted_at IS NULL
      AND COALESCE(btrim(scode),'') = '')                                                    AS scode_없음,
  (SELECT count(DISTINCT product_id) FROM product_xref_codes)                                AS xref_보유제품,
  (SELECT count(*) FROM product_xref_codes)                                                  AS xref_코드수;

\echo ''
\echo '=== ② 교차참조표는 어느 브랜드로 채워져 있나 ==================='
SELECT COALESCE(NULLIF(btrim(brand),''),'(브랜드 없음)') AS marca,
       count(*) AS 코드수, count(DISTINCT product_id) AS 제품수
  FROM product_xref_codes
 GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '=== ③ 두 출처가 겹치나 — 제품 단위 ============================='
SELECT
  count(*) FILTER (WHERE s AND x)        AS 둘다있음,
  count(*) FILTER (WHERE s AND NOT x)    AS scode만,
  count(*) FILTER (WHERE NOT s AND x)    AS xref만,
  count(*) FILTER (WHERE NOT s AND NOT x) AS 둘다없음
FROM (
  SELECT p.id,
         COALESCE(btrim(p.scode),'') <> '' AS s,
         EXISTS (SELECT 1 FROM product_xref_codes x WHERE x.product_id = p.id) AS x
    FROM products p WHERE p.deleted_at IS NULL
) t;

\echo ''
\echo '=== ④ 샘플 10건 — 화면 값과 교차참조표 값을 나란히 =============='
SELECT p.code AS ctr,
       p.scode AS 화면_경쟁사코드,
       (SELECT string_agg(x.brand || ':' || x.xref_code, ' | ' ORDER BY x.brand, x.xref_code)
          FROM product_xref_codes x WHERE x.product_id = p.id) AS 교차참조표
  FROM products p
 WHERE p.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM product_xref_codes x WHERE x.product_id = p.id)
 ORDER BY p.code
 LIMIT 10;

\echo ''
\echo '=== ⑤ 화면에는 있는데 교차참조표에 없는 SYD 코드 (표본 20) ======'
--  같은 SYD 코드를 두 표가 다르게 갖고 있는지 본다(정규화 비교).
WITH s AS (
  SELECT p.id, p.code,
         upper(regexp_replace(btrim(v), '[^A-Za-z0-9]', '', 'g')) AS norm, btrim(v) AS raw
    FROM products p,
         LATERAL regexp_split_to_table(COALESCE(p.scode,''), '\s*//\s*') AS v
   WHERE p.deleted_at IS NULL AND btrim(v) <> ''
)
SELECT s.code AS ctr, s.raw AS scode_값
  FROM s
 WHERE NOT EXISTS (
   SELECT 1 FROM product_xref_codes x
    WHERE x.product_id = s.id AND upper(x.norm_code) = s.norm)
 ORDER BY s.code
 LIMIT 20;

\echo ''
\echo '=== ⑥ scode 형식 분해 — 고객 검색이 걸릴 수 있는 지점 ==========='
WITH s AS (
  SELECT btrim(v) AS raw
    FROM products p,
         LATERAL regexp_split_to_table(COALESCE(p.scode,''), '\s*//\s*') AS v
   WHERE p.deleted_at IS NULL AND btrim(v) <> ''
)
SELECT count(*) AS 코드_총계,
       count(*) FILTER (WHERE raw ~ '^[0-9]+$')      AS 숫자형,
       count(*) FILTER (WHERE raw !~ '^[0-9]+$')     AS 영문_기호_포함
  FROM s;

\echo ''
\echo '=== ⑦ 한 제품에 SYD 코드가 여러 개인 경우 (표본 15) ============'
SELECT code, scode
  FROM products
 WHERE deleted_at IS NULL AND scode LIKE '%//%'
 ORDER BY code LIMIT 15;

\echo ''
\echo '=== ⑧ 고객에게 실제로 나갈 대상 기준 (PRO 제외 · 활성/비활성 포함) ='
SELECT count(*) AS 고객에게_나갈_제품수,
       count(*) FILTER (WHERE COALESCE(btrim(scode),'') <> '') AS 그중_대응품번_있음,
       count(*) FILTER (WHERE COALESCE(btrim(scode),'') = '')  AS 그중_대응품번_없음
  FROM products
 WHERE deleted_at IS NULL AND code IS NOT NULL AND code <> ''
   AND upper(code) NOT LIKE 'PRO%';
