-- 🧭 고객개발 3차 — 근거 기반 단계 · 개발 점수(0~100) · 점수 이력 (디렉터 요청 2026-11-25)
--   ① 단계 세분화: 첫 방문(contactado) 다음에 「정보 확보(perfilado)」 추가
--      sin_asignar → asignado → contactado → perfilado → interesado → cotizado → registro → cliente_activo (+ descartado)
--   ② prospects.score / info_pct / score_parts : 기록(방문·양식·견적·고객 연결·인보이스)으로 서버가 계산
--      prospects.suggested_stage / suggestion_reason : AI·기록이 제안했지만 사람이 확인해야 하는 단계
--   ③ prospect_score_log : 점수·단계가 바뀔 때마다 한 줄(그래프·영업사원별 획득 점수)
--   ④ quotes.prospect_id : ERP 견적서와 후보 연결 — 견적 점수는 ERP 에 견적서가 저장돼 있어야만 오른다(디렉터 결정)
--      연결 고객의 견적은 자동, 게스트 견적은 담당·상호로 자동 연결하거나 담당이 직접 연결
--   ⑤ 목표 지표 추가: perfilados(정보 확보 업체 수) · puntos(획득 점수)
-- 멱등 — 재실행 안전.
ALTER TABLE prospects DROP CONSTRAINT IF EXISTS prospects_stage_check;
ALTER TABLE prospects ADD CONSTRAINT prospects_stage_check
  CHECK (stage IN ('sin_asignar','asignado','contactado','perfilado','interesado','cotizado','registro','cliente_activo','descartado'));

ALTER TABLE prospects ADD COLUMN IF NOT EXISTS score INT NOT NULL DEFAULT 0;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS info_pct INT NOT NULL DEFAULT 0;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS score_parts JSONB;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS score_at TIMESTAMPTZ;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS suggested_stage TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS suggestion_reason TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS suggested_at TIMESTAMPTZ;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS suggestion_dismissed TEXT;      -- 「단계:녹음id」 — 담당이 무시한 AI 제안은 같은 녹음으로 다시 띄우지 않는다
CREATE INDEX IF NOT EXISTS ix_prospects_score ON prospects(score DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS prospect_score_log (
  id             BIGSERIAL PRIMARY KEY,
  prospect_id    BIGINT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  owner_user_id  BIGINT REFERENCES users(id),           -- 그 시점 담당(획득 점수 귀속)
  score          INT NOT NULL,
  prev_score     INT NOT NULL DEFAULT 0,
  info_pct       INT NOT NULL DEFAULT 0,
  stage          TEXT,
  reason         TEXT,
  user_id        BIGINT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_pscore_log ON prospect_score_log(prospect_id, created_at);
CREATE INDEX IF NOT EXISTS ix_pscore_log_time ON prospect_score_log(created_at, owner_user_id);

-- ERP 견적서 ↔ 후보 연결: 게스트 견적(고객 미등록)도 후보 점수에 반영하기 위해
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS prospect_id BIGINT REFERENCES prospects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_quotes_prospect ON quotes(prospect_id) WHERE prospect_id IS NOT NULL;

ALTER TABLE prospect_targets DROP CONSTRAINT IF EXISTS prospect_targets_metric_check;
ALTER TABLE prospect_targets ADD CONSTRAINT prospect_targets_metric_check
  CHECK (metric IN ('visitas','contactados','perfilados','cotizaciones','nuevos_clientes','venta_nuevos','puntos'));
