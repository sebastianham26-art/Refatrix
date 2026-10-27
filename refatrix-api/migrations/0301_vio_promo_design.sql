-- 0301 · VIO 프로모션 디자인 저장 — 다시 열어도 전에 작업하던 그대로(템플릿·문구·차량 사진·위치·가린 곳·배경)
--   design  : 화면 설정 JSON(템플릿 · 문구 · 크기/위치 · 직접 가린 곳 · 차량 사진 출처 등)
--   veh_key : 차량 사진(내가 올린 사진 · 누끼 딴 사진)을 R2 에 저장한 경로 vio-promos/K0001/veh-….png
--   bg_key  : 템플릿 B 배경 사진 경로
ALTER TABLE vio_promos ADD COLUMN IF NOT EXISTS design JSONB;
ALTER TABLE vio_promos ADD COLUMN IF NOT EXISTS veh_key TEXT;
ALTER TABLE vio_promos ADD COLUMN IF NOT EXISTS bg_key TEXT;
