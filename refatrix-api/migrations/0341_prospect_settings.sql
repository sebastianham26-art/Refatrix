-- 🧭 고객개발 (디렉터 요청 2026-11-26) — 루트 소요시간·연료 추정 기준(디렉터·관리자가 목표 화면에서 입력)
--   visit_min    : 업체 한 곳 방문(상담) 시간(분)          기본 20
--   km_per_liter : 차량 연비(km/L)                        기본 10
--   speed_kmh    : 시내 평균 이동 속도(km/h)               기본 22
--   road_factor  : 직선거리 → 실제 도로 거리 보정 배수       기본 1.3
-- 멱등 — 재실행 안전.
CREATE TABLE IF NOT EXISTS prospect_settings (
  key         TEXT PRIMARY KEY,
  value       NUMERIC(10,2) NOT NULL,
  updated_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO prospect_settings (key, value) VALUES ('visit_min', 20), ('km_per_liter', 10), ('speed_kmh', 22), ('road_factor', 1.3)
ON CONFLICT (key) DO NOTHING;
