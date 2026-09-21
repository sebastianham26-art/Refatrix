-- =====================================================================
-- Refatrix ERP · 0226_quote_devreq_backfill (2026-09-21)
--   견적의 「카탈로그 미등록 코드」를 개발요청 대장에 **소급** 적재한다.
--
--   왜: 지금까지는 매출 전환 · 24시간 만료 때만 적었다. 그래서
--       ⓐ 아직 열려 있는 견적(draft/confirmed)과
--       ⓑ 포장지시서를 출력한 뒤 전환하지 않은 견적(만료 처리 대상에서 빠짐)
--       의 미등록 코드가 대장에 없다. (사례: CQ0988L)
--   이번 배포부터는 저장 시점에 적는다(src/quoteDevDemand.js). 이 파일은 그 이전분을 한 번 채운다.
--
--   규칙은 quoteDevDemand.js 와 같다.
--     · 같은 견적 + 같은 코드(대문자·영숫자만 비교)는 한 줄 — 이미 있으면(지운 것 포함) 건너뜀
--     · 지금 카탈로그(CTR 코드 또는 SYD 코드)에서 풀리는 코드는 제외
--     · 취소·삭제·가격표(pricelist) 견적 제외
--     · 요청일 = 견적일, 수량 = 같은 코드 줄의 합
--   몇 번 돌려도 결과가 같다(NOT EXISTS).
-- =====================================================================
INSERT INTO product_dev_requests
       (input_code, customer_id, requested_qty, requested_at, source_quote_id, status, created_by)
SELECT g.code, g.customer_id, g.qty, g.quote_date, g.quote_id, 'received', g.created_by
  FROM (
        SELECT q.id AS quote_id, q.customer_id, q.quote_date, q.created_by,
               upper(regexp_replace(ql.input_code, '[^A-Za-z0-9]', '', 'g')) AS norm,
               min(btrim(ql.input_code))                                    AS code,
               NULLIF(sum(COALESCE(ql.qty, 0)), 0)                          AS qty
          FROM quote_lines ql
          JOIN quotes q ON q.id = ql.quote_id
         WHERE ql.product_id IS NULL
           AND COALESCE(btrim(ql.input_code), '') <> ''
           AND q.deleted_at IS NULL
           AND q.status NOT IN ('cancelled', 'pricelist')
         GROUP BY q.id, q.customer_id, q.quote_date, q.created_by,
                  upper(regexp_replace(ql.input_code, '[^A-Za-z0-9]', '', 'g'))
       ) g
 WHERE g.norm <> ''
   AND NOT EXISTS (
         SELECT 1 FROM product_dev_requests d
          WHERE d.source_quote_id = g.quote_id
            AND upper(regexp_replace(COALESCE(d.input_code, ''), '[^A-Za-z0-9]', '', 'g')) = g.norm)
   AND NOT EXISTS (
         SELECT 1 FROM products p WHERE p.deleted_at IS NULL AND p.code = g.code)
   AND NOT EXISTS (
         SELECT 1 FROM product_syd_codes s
           JOIN products p ON p.id = s.product_id AND p.deleted_at IS NULL
          WHERE s.syd_code = g.code);
