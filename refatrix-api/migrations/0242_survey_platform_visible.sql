-- 0242 · 고객 설문 분석 — REFATRIX Platform(refatrix-platform.netlify.app) 공개 (2026-09-30)
--   플랫폼에 로그인한 사용자(CTR 개발자·디렉터)가 플랫폼 메뉴 「고객 설문」에서 볼 설문을 디렉터가 고른다.
--   플랫폼 로그인 토큰은 ERP 서버가 플랫폼(Supabase) 에 직접 확인한다 — 별도 아이디·비밀번호 없음.
ALTER TABLE surveys ADD COLUMN IF NOT EXISTS platform_visible BOOLEAN NOT NULL DEFAULT false;
