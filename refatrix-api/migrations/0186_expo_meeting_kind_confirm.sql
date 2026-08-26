-- 전시회 시간표 보강 — 약속 확정(컨펌) + 부스 직접 방문 (디렉터 요청 2026-08-26)
-- ① kind         : 'meeting' = 고객과 잡은 미팅 약속 / 'booth' = 약속 없이 고객 부스를 직접 찾아가는 영업 시간
--                  부스 방문은 시간표에서 담당자 색을 쓰지 않고 공통 회색으로 표시한다(담당자 이름만 표기).
-- ② is_confirmed : 고객이 그 약속을 확정했는지. 계획만 잡힌 상태와 확정된 상태를 한눈에 구분하기 위한 것.
--                  부스 방문에는 해당 없음(항상 FALSE).
-- 기존 데이터는 전부 'meeting' · 미확정으로 남는다(무회귀).

ALTER TABLE exhibition_meetings
  ADD COLUMN IF NOT EXISTS kind         TEXT NOT NULL DEFAULT 'meeting',
  ADD COLUMN IF NOT EXISTS is_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmed_by BIGINT REFERENCES users(id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exhibition_meetings_kind_chk') THEN
    ALTER TABLE exhibition_meetings
      ADD CONSTRAINT exhibition_meetings_kind_chk CHECK (kind IN ('meeting','booth'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_expo_meet_kind ON exhibition_meetings(exhibition_id, kind) WHERE deleted_at IS NULL;
