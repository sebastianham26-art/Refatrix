-- 0265 · 신규 견적 WhatsApp 알림 — 「헤더 이미지 + 상세 내용」 한 통 (2026-10-08 디렉터 지시)
--   「헤더 이미지가 위에 있고, 그 아래에 텍스트로 온 것 같은 상세 요약을 받고 싶다」
--   send_mode 'rich'(새 기본):
--     · 24시간 창이 열려 있으면 → 헤더 이미지 + 캡션(상세 · 당월 요약) 이미지 메시지 1통(무료)
--     · 창이 닫혀 있으면     → 상세 템플릿 cotizacion_detalle(헤더 이미지 + 여러 줄 본문 · 변수 16개)
--       아직 승인 전이면 nueva_cotizacion(헤더 이미지 + 한 줄)로 대신 보낸다
-- 재실행 안전: 기존 행은 처음 한 번만 'rich' 로 바꾼다(rich_applied 표시).
ALTER TABLE quote_wa_settings DROP CONSTRAINT IF EXISTS quote_wa_settings_send_mode_check;
ALTER TABLE quote_wa_settings ADD CONSTRAINT quote_wa_settings_send_mode_check
  CHECK (send_mode IN ('rich','template','text_when_open'));
ALTER TABLE quote_wa_settings ALTER COLUMN send_mode SET DEFAULT 'rich';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'quote_wa_settings' AND column_name = 'rich_applied') THEN
    ALTER TABLE quote_wa_settings ADD COLUMN rich_applied BOOLEAN NOT NULL DEFAULT true;
    UPDATE quote_wa_settings SET send_mode = 'rich' WHERE id = 1;
  END IF;
END $$;
INSERT INTO quote_wa_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
