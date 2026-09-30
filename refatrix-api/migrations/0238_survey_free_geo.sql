-- 0238 · 고객 설문 분석 — 양식에 없는 지역을 손글씨에서 찾기 (2026-09-30)
--   설문지에 지역 문항이 없어도 고객이 여백·이름 칸 옆 등에 손으로 지역을 적은 경우가 있다.
--   「손으로 적은 지역」 문항(type geo, free=true)을 추가하면, 이미 읽은 설문지는
--   이 문항만 따로 AI 로 다시 찾는다(다른 답은 건드리지 않음). 그 진행 상태를 여기에 둔다.
--     geo_scan: NULL(대상 아님) | queued | processing | done | error
ALTER TABLE survey_pages ADD COLUMN IF NOT EXISTS geo_scan TEXT;
ALTER TABLE survey_pages ADD COLUMN IF NOT EXISTS geo_scan_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE survey_pages ADD COLUMN IF NOT EXISTS geo_scan_error TEXT;
CREATE INDEX IF NOT EXISTS survey_pages_geo_scan_idx ON survey_pages (geo_scan) WHERE geo_scan IN ('queued', 'processing');
