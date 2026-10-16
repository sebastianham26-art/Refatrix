-- =====================================================================
-- Refatrix ERP · 0282_wa_image_platform — REFATRIX Platform(본사)에서 올린 마케팅 이미지 (2026-10-16 디렉터 지시)
--   「플랫폼에 마케팅 이미지 뱅크 — 본사 직원이 올리면 ERP 로 연동 · 저장 → WhatsApp 광고에 활용」
--   · 플랫폼 로그인한 사람 모두 올릴 수 있다(세션은 ERP 서버가 플랫폼 RPC app_log 로 직접 확인).
--   · 올리면 ERP 이미지 뱅크(wa_images) 「본사(CTR)」 폴더에 바로 들어가 쓸 수 있다(승인 없음).
--   · 플랫폼 화면은 자기가 올린 것만 본다(광고 결과는 보이지 않음).
--   source        'erp'(기본) | 'platform'
--   pf_user       플랫폼 사용자 구분값(플랫폼 세션의 사용자 id/아이디) — 「내가 올린 것」 목록용
--   pf_user_name  플랫폼 사용자 이름(표시용)
--   memo          올린 사람이 남긴 설명(용도 · 차종 등)
--   멱등(IF NOT EXISTS) — 재실행 안전.
-- =====================================================================
ALTER TABLE wa_images ADD COLUMN IF NOT EXISTS source       TEXT NOT NULL DEFAULT 'erp';
ALTER TABLE wa_images ADD COLUMN IF NOT EXISTS pf_user      TEXT;
ALTER TABLE wa_images ADD COLUMN IF NOT EXISTS pf_user_name TEXT;
ALTER TABLE wa_images ADD COLUMN IF NOT EXISTS memo         TEXT;
CREATE INDEX IF NOT EXISTS idx_wa_images_pf_user ON wa_images (pf_user, created_at DESC) WHERE source = 'platform';
