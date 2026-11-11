-- =====================================================================
-- 0325 · WhatsApp 미디어 저장본 (2026-11-11)
--   손님이 보낸 사진 · 음성 · 동영상 · PDF 와 우리가 보낸 사진 · PDF 를 ERP 대화창에서 본다.
--   Meta 는 미디어를 약 30일만 보관하므로 처음 받을 때 파일을 여기에 남긴다(media_id = wa_messages.payload).
-- =====================================================================
CREATE TABLE IF NOT EXISTS wa_media_cache (
  media_id    TEXT PRIMARY KEY,
  mime        TEXT NOT NULL DEFAULT 'application/octet-stream',
  size        INTEGER NOT NULL DEFAULT 0,
  filename    TEXT,
  bytes       BYTEA NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_media_cache_at ON wa_media_cache (fetched_at);
