-- =====================================================================
-- Refatrix ERP · 0241_quote_stock_flag_restate  (2026-09-30)
--   수주흐름 추이(오더퍼널)의 「즉시 가용」이 실제 예약보다 크게 찍히던 기록을 바로잡는다.
--
--   원인: 견적 줄의 stock_flag 가 저장 시 **물리 재고만** 보고 매겨졌다(다른 견적의 예약을 빼지 않음).
--         Q-2026-0280: 4개 요청 · 예약 2개(부족)인데 stock_flag='ok' → 추이에 100% 가용.
--   이후 저장분은 quoteBuild.assignReservations 가 실제 배분 결과로 stock_flag 를 적는다.
--
--   여기서 고치는 것: **서로 모순인 줄만** — stock_flag='ok' 인데 예약 < 요청.
--     · reserve_expires_at 이 있는 견적만(= 0064 예약 제도 이후). 그 전 견적은 reserved_qty 가 0 기본값이라
--       이 조건에 걸면 과거 매출이 전부 「부족」이 된다 — 건드리지 않는다.
--     · 반대 방향(low_stock 인데 나중에 재검증으로 확보)은 「요청 시점」 기록이므로 그대로 둔다.
--     · reserved_qty · 금액 · 상태는 손대지 않는다.
--   ※ migrate.js 가 파일마다 BEGIN/COMMIT 으로 감싼다.
-- =====================================================================
UPDATE quote_lines ql
   SET stock_flag = 'low_stock'
  FROM quotes q
 WHERE q.id = ql.quote_id
   AND q.reserve_expires_at IS NOT NULL
   AND ql.product_id IS NOT NULL
   AND ql.stock_flag = 'ok'
   AND COALESCE(ql.reserved_qty, 0) < ql.qty;
