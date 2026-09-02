-- =====================================================================
-- Refatrix ERP · 0194_rfc_claim_exempt_cleanup
--
--   0188 이 남긴 **철 지난 선점 예외 플래그**를 정리한다.
--
--   무슨 일이 있었나:
--     0188 은 `rfc_norm` 에 유니크를 걸기 위해, 마이그레이션이 도는 그 순간
--     같은 RFC 를 쓰던 고객 그룹에서 최초 1건만 남기고 나머지에 `rfc_claim_exempt=true` 를 찍었다.
--     그런데 이 플래그는 **그 시점의 스냅샷**이다. 그 뒤 상대 고객이 삭제되거나
--     반려되거나 RFC 가 정정돼서 중복이 사라져도 플래그는 그대로 남는다.
--     → 화면에는 "RFC 중복(기존 데이터)이라 선점 보호 제외" 가 계속 뜨는데
--       정작 그 RFC 를 쓰는 고객은 이 한 건뿐인 상태가 된다.
--       (그리고 그 고객은 실제로 DB 유니크 보호를 못 받고 있다 — 표시만 이상한 게 아니다.)
--
--   무엇을 하나:
--     지금 기준으로 **그 RFC 를 쓰는 살아있는 고객이 자기 하나뿐인 행**의 예외를 해제한다.
--     해제하면 그 행이 `uq_customers_rfc_claim` 의 대상이 되어 선점 보호를 되찾는다.
--     아직 진짜로 중복인 그룹은 손대지 않는다 — 유니크가 깨지고, 어느 쪽이 진짜인지는 사람이 판단할 일이다.
--
--   ⚠ 데이터는 한 줄도 지우거나 바꾸지 않는다(플래그만 false 로 되돌린다).
--   멱등: 재실행해도 같은 결과. 이후 운영 중 생기는 건은
--         디렉터 화면의 「선점 예외 정리」(재검사/개별 해제)로 같은 규칙을 돌린다.
-- =====================================================================

UPDATE customers c
   SET rfc_claim_exempt = false
 WHERE c.rfc_claim_exempt = true
   AND c.rfc_norm IS NOT NULL
   AND c.deleted_at IS NULL
   AND COALESCE(c.approval_status, 'approved') <> 'rejected'
   -- 같은 RFC 를 쓰는 다른 살아있는 고객이 하나도 없다 = 중복이 이미 해소됐다
   AND NOT EXISTS (
     SELECT 1 FROM customers o
      WHERE o.id <> c.id
        AND o.rfc_norm = c.rfc_norm
        AND o.deleted_at IS NULL
        AND COALESCE(o.approval_status, 'approved') <> 'rejected'
   );

-- 해제 결과 확인용(운영 콘솔에서 눈으로 보라고 남긴다 — 남아 있는 건 = 진짜 중복 그룹).
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM customers
   WHERE rfc_claim_exempt = true AND deleted_at IS NULL
     AND COALESCE(approval_status,'approved') <> 'rejected';
  RAISE NOTICE '0194: 남은 선점 예외 고객 % 건 (전부 실제 RFC 중복 그룹 — 디렉터 정리 대상)', n;
END $$;
