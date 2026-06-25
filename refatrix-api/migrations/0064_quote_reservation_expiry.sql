-- =====================================================================
-- Refatrix ERP · 0064_quote_reservation_expiry
--   견적 재고 예약(블럭) + 24시간 만료(무효화) + 만료 시 부족/개발 백로그 적재
--   · quote_lines.reserved_qty : 라인별 예약(블럭) 수량 — 선착순 greedy 배분
--   · quotes.reserve_expires_at : 예약 만료시각(견적 생성 + 24h). 만료 후 무효화.
--   · status 에 'expired' 추가(무효화·회색·전환불가, 견적내역은 조회 가능)
--   · stock_shortages.source_quote_id : 부족 백로그가 어느 견적에서 비롯됐는지(추적·중복가드)
--   가용재고 = 현재고 − 타 미결·미만료 견적의 reserved_qty 합. 물리 stock_qty는 예약으로 안 건드림.
--   ※ migrate.js 가 파일마다 BEGIN/COMMIT 으로 감싸므로 여기선 트랜잭션 구문을 넣지 않는다.
-- =====================================================================

-- ① status 에 'expired' 추가 (CHECK 재정의 — 0047/0062 패턴과 동일)
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_status_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_status_check
  CHECK (status IN ('draft','confirmed','converted','cancelled','delete_pending','pricelist','expired'));

-- ② 예약 만료시각 (pricelist/converted 등은 NULL → 스위퍼 대상 아님)
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS reserve_expires_at TIMESTAMPTZ;

-- ③ 라인별 예약(블럭) 수량
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS reserved_qty NUMERIC(15,3) NOT NULL DEFAULT 0;

-- ④ 부족 백로그 추적용(어느 견적에서? — 전환분은 NULL, 만료분만 채움)
ALTER TABLE stock_shortages ADD COLUMN IF NOT EXISTS source_quote_id BIGINT REFERENCES quotes(id);

-- ⑤ 인덱스
CREATE INDEX IF NOT EXISTS idx_quotes_reserve_exp ON quotes (reserve_expires_at)
  WHERE status IN ('draft','confirmed');
CREATE INDEX IF NOT EXISTS idx_qlines_reserved ON quote_lines (product_id) WHERE reserved_qty > 0;
CREATE INDEX IF NOT EXISTS idx_shortage_srcquote ON stock_shortages (source_quote_id);

-- ⑥ 백필 1: 기존 미결견적에 24h 유예 부여(마이그레이션 직후 대량 만료·백로그 폭주 방지)
UPDATE quotes SET reserve_expires_at = now() + interval '24 hours'
 WHERE status IN ('draft','confirmed') AND reserve_expires_at IS NULL AND deleted_at IS NULL;

-- ⑦ 백필 2: 기존 미결견적 라인에 생성순(선착순) greedy 예약 배분
--    reserved = clamp( min(요청수량, 현재고 − 같은제품 직전까지의 누적요청), 0..요청 )
WITH alloc AS (
  SELECT ql.id,
         GREATEST(0, LEAST(ql.qty,
           COALESCE(p.stock_qty, 0) - (SUM(ql.qty) OVER w - ql.qty)))::numeric(15,3) AS rq
    FROM quote_lines ql
    JOIN quotes   q ON q.id = ql.quote_id
    JOIN products p ON p.id = ql.product_id
   WHERE q.status IN ('draft','confirmed') AND q.deleted_at IS NULL AND ql.product_id IS NOT NULL
  WINDOW w AS (PARTITION BY ql.product_id ORDER BY q.created_at, q.id, ql.line_no
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
)
UPDATE quote_lines SET reserved_qty = alloc.rq
  FROM alloc
 WHERE quote_lines.id = alloc.id;
