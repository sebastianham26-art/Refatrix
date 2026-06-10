-- =====================================================================
-- Refatrix ERP · 0019_fx_rates
-- 일자별 환율 캐시 (외부 API에서 하루 1회 받아 저장, 실패 시 마지막값 유지).
-- 예상 MXN 환산(환전 전 USD)에 사용하고, 환율 이력은 요약페이지에서 조회.
-- =====================================================================

CREATE TABLE IF NOT EXISTS fx_rates (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rate_date   DATE NOT NULL,                          -- 환율 기준일
  base        TEXT NOT NULL DEFAULT 'USD',
  quote       TEXT NOT NULL DEFAULT 'MXN',
  rate        NUMERIC(15,6) NOT NULL,                 -- 1 base = rate quote (USD→MXN)
  source      TEXT,                                   -- 예: 'open.er-api.com'
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rate_date, base, quote)
);

CREATE INDEX IF NOT EXISTS idx_fx_rates_date ON fx_rates (base, quote, rate_date DESC);
