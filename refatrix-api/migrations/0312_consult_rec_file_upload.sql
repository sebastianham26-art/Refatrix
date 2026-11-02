-- =====================================================================
-- 0312 · 고객상담 녹음 — 휴대폰 녹음 파일 업로드 (2026-11-02)
--   source       : 'rec'  = 화면에서 직접 녹음(기존)
--                  'file' = 휴대폰 녹음앱 등에서 만든 파일을 올림(신규)
--   file_name    : 올린 파일 이름(화면 표시용)
--   converted_at : 서버가 ffmpeg 로 전사용 오디오(ogg/opus 20분 구간)로 바꾼 시각.
--                  NULL 이면 아직 원본 그대로 — 처리 큐가 전사 전에 변환한다.
--   기존 행은 전부 'rec' 이며 동작이 바뀌지 않는다.
-- =====================================================================
ALTER TABLE sales_consult_recordings ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'rec';
ALTER TABLE sales_consult_recordings ADD COLUMN IF NOT EXISTS file_name TEXT;
ALTER TABLE sales_consult_recordings ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;
