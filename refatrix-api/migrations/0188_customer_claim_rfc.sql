-- =====================================================================
-- Refatrix ERP · 0188_customer_claim_rfc
--
--   고객 선점(claim) 조건을 **CONSTANCIA → RFC** 로 전환.
--
--   배경: 0185 는 "CONSTANCIA 번호 + PDF 스캔본" 을 넣어야 고객이 선점되게 만들었다.
--        현장에서는 영업사원이 RFC 를 먼저 확보하고 CONSTANCIA 는 한참 뒤에 받는다.
--        그 사이 다른 영업사원이 같은 고객을 잡아 버리는 게 커미션 분쟁의 원인이라
--        선점 시점을 **RFC 입력 시점**으로 앞당긴다.
--        CONSTANCIA(번호·PDF)는 이제 선택 증빙이다(넣으면 그 번호도 함께 잠긴다 — 0185 인덱스 유지).
--
--   문제: 운영 DB 에는 이미 같은 RFC 를 쓰는 고객이 있다(지점 분리 등).
--        rfc_norm 에 그냥 유니크 인덱스를 걸면 마이그레이션이 실패한다.
--   해법: `rfc_claim_exempt` 플래그 — 기존 중복 그룹에서 **가장 먼저 등록된 1건만 선점 보유**,
--        나머지는 예외로 표시해 인덱스 대상에서 뺀다.
--        그 뒤 새로 등록되는 고객은 전부 exempt=false 라 DB 유니크가 동시성까지 막는다.
--
--   ⚠ 예외로 표시된 기존 고객은 "RFC 로 선점 보호를 받지 못한다"(화면에 안내 표시).
--     단, 신규 등록은 애플리케이션 사전조회에서 예외 여부와 무관하게 같은 RFC 를 막으므로
--     그 고객을 다른 영업사원이 새로 등록해 가져갈 수는 없다.
--
--   멱등: 전부 IF NOT EXISTS / 재실행해도 같은 결과.
-- =====================================================================

-- (1) 선점 예외 플래그 -------------------------------------------------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS rfc_claim_exempt BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN customers.rfc_claim_exempt IS
  'true = 0188 이전부터 RFC 가 중복이던 레거시 행. RFC 선점 유니크 인덱스에서 제외된다(신규 등록은 항상 false).';

-- (2) 기존 RFC 중복 → 최초 1건만 남기고 예외 처리 ----------------------
--   살아있고(deleted_at IS NULL) 반려가 아닌 행끼리만 본다 = 유니크 인덱스와 같은 모집합.
--   재실행해도 같은 행이 rn=1 이 되므로 결과가 변하지 않는다.
WITH dupes AS (
  SELECT id,
         row_number() OVER (PARTITION BY rfc_norm ORDER BY created_at, id) AS rn
    FROM customers
   WHERE rfc_norm IS NOT NULL
     AND deleted_at IS NULL
     AND COALESCE(approval_status, 'approved') <> 'rejected'
)
UPDATE customers c
   SET rfc_claim_exempt = true
  FROM dupes d
 WHERE d.id = c.id
   AND d.rn > 1
   AND c.rfc_claim_exempt = false;

-- (3) RFC 선점 유니크 ---------------------------------------------------
--   0185 의 idx_customers_rfc_norm(조회용)은 그대로 두고, 선점 판정용 유니크를 따로 만든다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_rfc_claim
  ON customers (rfc_norm)
  WHERE rfc_norm IS NOT NULL
    AND deleted_at IS NULL
    AND COALESCE(approval_status, 'approved') <> 'rejected'
    AND rfc_claim_exempt = false;
