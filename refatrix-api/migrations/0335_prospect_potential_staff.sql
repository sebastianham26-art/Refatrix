-- 🧭 고객개발 보완 (디렉터 요청 2026-11-25)
--   ① 잠재성: Alta de clientes 「Potencial」 확정값을 후보 행에도 저장 → 목록 정렬·필터·현황판 합계
--      (값의 원본은 prospect_crm_values · 확정 저장 때 서버가 다시 계산해 채운다)
--   ② 담당자 명단: 고객개발 담당 선택지에서 뺄 사용자(디렉터가 지정). 다른 화면 권한과는 무관.
-- 멱등 — 재실행 안전.
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS pot_venta_total NUMERIC(15,2);
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS pot_venta_susp  NUMERIC(15,2);
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS pot_compra_total NUMERIC(15,2);
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS pot_compra_susp NUMERIC(15,2);   -- 월 서스펜션 구매액 = CTR 잠재 매출
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS pot_tier TEXT CHECK (pot_tier IS NULL OR pot_tier IN ('A','B','C'));
CREATE INDEX IF NOT EXISTS ix_prospects_pot ON prospects(pot_tier, pot_compra_susp DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS prospect_excluded_users (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  excluded_by BIGINT REFERENCES users(id),
  excluded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
