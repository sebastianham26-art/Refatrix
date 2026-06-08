-- =====================================================================
-- Refatrix ERP · 0001_common
-- 공통: 확장, updated_at 자동 갱신 트리거 함수
-- 순서대로(0001 → 0009) 한 번씩만 적용. 전진(forward-only) 마이그레이션.
-- =====================================================================

-- gen_random_uuid() 등을 쓸 경우 대비(선택). 없어도 무방.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 모든 테이블 공통: updated_at 자동 갱신
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 설계 공통 규칙(문서화용 주석)
--  · 기본키 id: BIGINT GENERATED ALWAYS AS IDENTITY (내부용)
--  · 업무코드(C-0001, SAT, 제품코드 등): 별도 컬럼 + UNIQUE
--  · 금액 NUMERIC(15,2), 수량 NUMERIC(15,3), 환율 NUMERIC(15,6)
--  · 외화: 원통화 + 환율 + MXN 환산값 함께 저장
--  · 소프트 삭제: deleted_at (NULL = 정상)
--  · 변경 추적: created_at/by, updated_at/by + audit_log
--  · 시각: TIMESTAMPTZ
