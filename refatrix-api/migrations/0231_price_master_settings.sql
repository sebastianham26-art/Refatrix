-- 0231 · 가격 마스터 설정 — ⑦ 제품 수익성의 판관비율(디렉터가 정함)
--   key/value 한 표. 지금은 'sga_pct'(매출 대비 판관비 %) 하나. 값이 없으면(NULL) 화면이 「미설정」으로 안내한다.
--   전부 IF NOT EXISTS / ON CONFLICT — 재실행 안전.
CREATE TABLE IF NOT EXISTS price_master_settings (
  key         TEXT PRIMARY KEY,
  num_value   NUMERIC,
  updated_by  BIGINT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO price_master_settings (key, num_value) VALUES ('sga_pct', NULL) ON CONFLICT (key) DO NOTHING;
