-- =====================================================================
-- 0164: 오퍼시트 KPI — 월별 bono 프로모션 설정 (디렉터 확정 2026-08-03)
--   부족분 → 오퍼시트 발송 → (30일 내) 인보이스 매출 자동 매칭 실적이
--   월 목표 금액(IVA 제외) 이상인 직원에게 상품(bono) 지급.
--   예: 2026-08 목표 10,000 MXN → "Tarjeta de supermercado $500 × 2"
--   실적 매칭 자체는 스냅샷 없이 조회 시 계산(offerKpi.js) — 이 테이블은 설정만.
-- =====================================================================
CREATE TABLE IF NOT EXISTS offer_promos (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ym               TEXT NOT NULL UNIQUE,                -- 'YYYY-MM' (인보이스 발행 월 기준)
  goal_amount_mxn  NUMERIC(15,2) NOT NULL DEFAULT 0,    -- 직원별 목표 매출(IVA 제외)
  prize_text       TEXT,                                -- 상품 설명 (예: Tarjeta $500 × 2)
  active           BOOLEAN NOT NULL DEFAULT true,
  created_by       BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_offer_promos_ym ON offer_promos(ym);
