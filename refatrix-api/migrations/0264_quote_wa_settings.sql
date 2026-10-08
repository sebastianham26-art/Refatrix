-- 0264 · 신규 견적 WhatsApp 알림 — 발송 형식 · 템플릿 헤더 이미지 (2026-10-08 디렉터 지시)
--   「템플릿 디자인이 안 오고 텍스트로 온다」 →
--   · send_mode     : template(기본) = 항상 승인 템플릿(디자인)으로 · text_when_open = 24시간 창이 열려 있으면 상세 텍스트
--   · follow_detail : template 모드에서 창이 열려 있으면 템플릿 뒤에 상세(수주현황 · 당월 요약)를 이어서 보냄(무료)
--   · header_image  : 템플릿 헤더가 「이미지」면 보낼 때마다 이미지를 함께 넣어야 한다(Meta 규칙) — 그 이미지
--                     media_id 는 Meta 업로드 id(30일 유효, 25일마다 다시 올림)
-- 한 행(id=1)만 쓴다. 재실행 안전.
CREATE TABLE IF NOT EXISTS quote_wa_settings (
  id            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  send_mode     TEXT NOT NULL DEFAULT 'template' CHECK (send_mode IN ('template','text_when_open')),
  follow_detail BOOLEAN NOT NULL DEFAULT true,
  header_image  BYTEA,
  header_mime   TEXT,
  header_name   TEXT,
  media_id      TEXT,
  media_at      TIMESTAMPTZ,
  updated_by    BIGINT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO quote_wa_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
