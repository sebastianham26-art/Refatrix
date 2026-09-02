-- =====================================================================
-- Refatrix ERP · 0194_bank_deposit_alloc_recalc
-- 미배분 입금(통지)의 「소진액」(allocated_amount)을 원천에서 소급 재계산.
--
-- 배경(디렉터 보고 2026-09-02):
--   LUEMI 통지 #12·#13 이 「부분배분」으로 인박스에 계속 남고 취소·삭제도 막혔다.
--   실측: 통지 #12 소진액 6,798.95 / #13 소진액 481.63 인데
--         folio 13(481.63)·folio 25(6,798.95) 는 **입금 0 · 배분 0건**, 선수금도 0건.
--         → 반제는 전부 지워졌는데 통지의 소진액만 «유령»으로 남았다.
--
-- 원인: bdReleaseAmount 의 레거시 분기가
--         UPDATE ... WHERE payment_id=$1 AND status='allocated'
--       였다. 부분배분 통지는 status='pending' 이라 이 WHERE 에 걸리지 않아
--       소진액이 되돌려지지 않았고, 반제 헤더는 삭제되어 되돌릴 수단도 사라졌다.
--       (통지를 닫지 않은 부분배분은 0191 에서 새로 생긴 상태인데, 되돌리기 경로가
--        그 상태를 몰랐다 — "상태를 만들면 푸는 경로도 같이 만든다"를 또 놓친 것.)
--
-- 수정: allocated_amount 는 증감으로 관리하지 않고 **링크행 합계에서 매번 재계산**한다
--       (bdRecalcDeposit). 이 마이그레이션은 그 이전에 어긋난 값을 한 번 맞춘다.
--
-- 규칙: 소진액 = Σ bank_deposit_payments.amount (반제가 실존하는 링크만)
--       · 잔여 < 0.5  → status='allocated'(닫힘)
--       · 잔여가 남음 → status='pending'
--       · 소진액 0    → payment_id·allocated_by·allocated_at 정리
--       void·booked 통지는 건드리지 않는다. 두 번 돌려도 결과가 같다(멱등).
--       거래(transactions)는 손대지 않는다 — 통지 등록은 원래 원장에 기표되지 않으므로
--       계좌 잔액·현금흐름에 영향이 전혀 없다.
-- =====================================================================

WITH used AS (
  SELECT d.id,
         ROUND(COALESCE((SELECT SUM(l.amount)
                           FROM bank_deposit_payments l
                           JOIN sales_payments p ON p.id = l.payment_id
                          WHERE l.deposit_id = d.id), 0), 2) AS u
    FROM bank_deposits_pending d
   WHERE d.status IN ('pending', 'allocated')
)
UPDATE bank_deposits_pending d
   SET allocated_amount = used.u,
       status = CASE WHEN used.u > 0.001 AND (d.amount - used.u) < 0.5
                     THEN 'allocated' ELSE 'pending' END,
       payment_id   = CASE WHEN used.u > 0.001 THEN d.payment_id ELSE NULL END,
       allocated_by = CASE WHEN used.u > 0.001 AND (d.amount - used.u) < 0.5
                           THEN d.allocated_by ELSE NULL END,
       allocated_at = CASE WHEN used.u > 0.001 AND (d.amount - used.u) < 0.5
                           THEN d.allocated_at ELSE NULL END
  FROM used
 WHERE used.id = d.id
   AND ABS(COALESCE(d.allocated_amount, 0) - used.u) > 0.005;

-- 같은 계좌·같은 입금일·같은 금액의 통지 중복 탐지용(등록 시 되묻기 · 목록 「중복 의심」 칩)
CREATE INDEX IF NOT EXISTS idx_bdp_dup ON bank_deposits_pending (account_id, deposit_date, amount);
