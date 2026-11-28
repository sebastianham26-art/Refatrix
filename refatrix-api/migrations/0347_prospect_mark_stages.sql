-- 🧭 고객개발 — 방문 결과 표시 단계(11-27): 관련 없음(no_relacionado) · 업체 없음(no_existe)
--   방문해 보니 관계없는 제품을 취급하거나 업체가 없을 때 담당이 표시. 표시한 위치·거리도 단계 이력에 남긴다.
-- 멱등 — 재실행 안전.
ALTER TABLE prospects DROP CONSTRAINT IF EXISTS prospects_stage_check;
ALTER TABLE prospects ADD CONSTRAINT prospects_stage_check
  CHECK (stage IN ('sin_asignar','asignado','contactado','perfilado','interesado','cotizado','registro','cliente_activo','descartado','no_relacionado','no_existe'));

ALTER TABLE prospect_stage_history ADD COLUMN IF NOT EXISTS lat NUMERIC(9,6);
ALTER TABLE prospect_stage_history ADD COLUMN IF NOT EXISTS lng NUMERIC(9,6);
ALTER TABLE prospect_stage_history ADD COLUMN IF NOT EXISTS dist_m INT;
