-- =====================================================================
-- Refatrix ERP · 0139_briefing_share_socio
-- 디렉터가 켜고 끄는 옵션: "오늘의 브리핑 · 미결 누적"을 socio(파트너)에게도 열람 허용.
--   · 기본 FALSE(디렉터 전용 유지) — 켜야만 socio 가 볼 수 있다.
--   · 열람 전용. 스누즈/무시/자동todo/AI스캔 등 조치는 디렉터만(라우트에서 강제).
--   · company_settings 는 단일행(id=1) 전역 설정 테이블.
-- =====================================================================
ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS briefing_share_socio BOOLEAN NOT NULL DEFAULT FALSE;
