-- 📱 원클릭 빠른 미팅 녹음 (영업 > 고객상담 + 영업활동 방문 기록) — 디렉터 요청 2026-11-20
-- 휴대폰 하단 🎙 버튼 한 번으로 위치·녹음이 바로 시작된다. 업체명·대상자·연락처·직함은 비워 둬도 되고
-- 나중에 입력한다. 업체명 컬럼은 NOT NULL 이라 비워 둔 상담은 '(업체 미입력)' 자리표시자 + info_pending=TRUE.
--   sales_consults
--   · contact_title : 미팅 대상자의 직함(구매 담당 · 사장 등)
--   · info_pending  : 업체 정보를 아직 입력하지 않은 빠른 녹음 → 종합표에 「⚠ 정보 입력 필요」.
--                     업체명을 넣거나 기존 고객을 고르면 서버가 자동으로 FALSE 로 바꾼다.
--   · quick_rec     : 🎙 원클릭으로 만든 상담 — 영업활동 「방문·동선」에도 방문 기록으로 남긴다.
--   · visit_id      : 그렇게 만든 방문(sales_visits) — 업체·대상자·위치·AI 요약·펜딩을 계속 맞춰 준다.
--   sales_visit_recordings.consult_rec_id   : 고객상담 녹음 요약을 방문 쪽에 옮겨 적은 행(재처리 때 덮어쓰기)
--   sales_visit_pendings.consult_pending_id : 고객상담 펜딩과 짝 — 어느 쪽에서 완료해도 양쪽이 함께 바뀐다
-- 기존 행은 그대로. 멱등 — 재실행 안전.
ALTER TABLE sales_consults ADD COLUMN IF NOT EXISTS contact_title TEXT;
ALTER TABLE sales_consults ADD COLUMN IF NOT EXISTS info_pending BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sales_consults ADD COLUMN IF NOT EXISTS quick_rec BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sales_consults ADD COLUMN IF NOT EXISTS visit_id BIGINT REFERENCES sales_visits(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_consults_info_pending ON sales_consults(created_by) WHERE info_pending AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_consults_visit ON sales_consults(visit_id) WHERE visit_id IS NOT NULL;

ALTER TABLE sales_visit_recordings ADD COLUMN IF NOT EXISTS consult_rec_id BIGINT REFERENCES sales_consult_recordings(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS ux_visit_rec_consult_rec ON sales_visit_recordings(consult_rec_id) WHERE consult_rec_id IS NOT NULL;

ALTER TABLE sales_visit_pendings ADD COLUMN IF NOT EXISTS consult_pending_id BIGINT REFERENCES sales_consult_pendings(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS ux_visit_pend_consult_pend ON sales_visit_pendings(consult_pending_id) WHERE consult_pending_id IS NOT NULL;
