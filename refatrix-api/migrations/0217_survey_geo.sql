-- 0217 · 고객 설문 분석 — 지역(주·도시) 분석 (2026-09-14)
--   설문지에 손으로 적은 지역을 멕시코 32개 주로 정리해 보관한다.
--   answers 에는 표준 주 이름이 들어가고(집계·세그먼트용), 여기에는 도시와 원문이 함께 남는다.
--   {"q2": {"estado": "Nuevo León", "ciudad": "Monterrey", "raw": "Mty, N.L."}}
ALTER TABLE survey_pages ADD COLUMN IF NOT EXISTS geo JSONB;
