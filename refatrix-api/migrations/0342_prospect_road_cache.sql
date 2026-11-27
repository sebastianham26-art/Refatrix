-- 0342: 루트 실제 도로 주행 거리 캐시 (OSRM 도로망 계산 결과)
--   같은 정류장 순서(좌표)는 다시 계산하지 않음. key = 좌표열 해시
CREATE TABLE IF NOT EXISTS prospect_road_cache (
  key         TEXT PRIMARY KEY,
  km          NUMERIC NOT NULL,
  osrm_min    NUMERIC,
  path        JSONB,
  provider    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
