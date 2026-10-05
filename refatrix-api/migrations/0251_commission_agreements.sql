-- =====================================================================
-- 0251 · 커미션 조건 합의 기록 (2026-10-05 · 디렉터 결정)
--   커미션 대상자가 자기 조건 문서를 읽고 **본인 PIN** 을 넣으면 그것이 합의의 증명이다.
--   한 줄 = 한 번의 합의. 합의 시점의 조건(terms)과 문서 원문(doc)을 그대로 스냅샷으로 남긴다.
--   조건이 바뀌면 version_hash 가 달라져 「재합의 필요」로 표시된다(지급은 막지 않음).
--   기록은 수정·삭제할 수 없다(트리거로 차단) — 증빙이기 때문.
-- =====================================================================

CREATE TABLE IF NOT EXISTS commission_agreements (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  version_hash  TEXT   NOT NULL,                 -- 조건 스냅샷 해시(앞 12자리)
  agent_type    TEXT   NOT NULL DEFAULT 'empleado' CHECK (agent_type IN ('comisionista','empleado')),
  terms         JSONB  NOT NULL,                 -- 합의 시점 조건(기간·율·예외율·성과급)
  doc           JSONB  NOT NULL,                 -- 합의 시점 문서 원문(스페인어 섹션)
  summary       TEXT,                            -- 한 줄 요약(현황판용)
  agreed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip            TEXT,
  user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS idx_comm_agree_user ON commission_agreements (user_id, agreed_at DESC);

-- 수정·삭제 금지 (증빙)
CREATE OR REPLACE FUNCTION commission_agreements_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'commission_agreements 는 수정·삭제할 수 없습니다 (합의 증빙)';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_comm_agree_immutable ON commission_agreements;
CREATE TRIGGER trg_comm_agree_immutable
  BEFORE UPDATE OR DELETE ON commission_agreements
  FOR EACH ROW EXECUTE FUNCTION commission_agreements_immutable();
