-- 🧭 고객개발 6차 (디렉터 요청 2026-11-25)
--   ① 목표 = 디렉터가 지표별 「총 합의 목표」를 넣고, 담당자별 「할당률(%)」로 나눈다. 할당률이 없으면 목표도 없다.
--      prospect_target_totals : 월·지표별 총 목표 / prospect_target_shares : 월·담당자별 할당률
--      담당자별 결과는 기존 prospect_targets 에 계산해 저장(현황판·진척 보드는 그대로 읽음)
--   ② 지역을 지도에서 드래그한 구역(다각형)으로도 정할 수 있다 — 담당자가 스스로 자기 지역을 만든다.
--      다른 담당이 이미 맡은 후보는 구역 안에 있어도 가져가지 않는다.
-- 멱등 — 재실행 안전.
CREATE TABLE IF NOT EXISTS prospect_target_totals (
  period       TEXT NOT NULL,                 -- YYYY-MM
  metric       TEXT NOT NULL,
  total_value  NUMERIC(14,2) NOT NULL CHECK (total_value >= 0),
  updated_by   BIGINT REFERENCES users(id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (period, metric)
);
CREATE TABLE IF NOT EXISTS prospect_target_shares (
  period      TEXT NOT NULL,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  share_pct   NUMERIC(5,2) NOT NULL CHECK (share_pct > 0 AND share_pct <= 100),
  updated_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (period, user_id)
);
ALTER TABLE prospect_territories ADD COLUMN IF NOT EXISTS polygon JSONB;   -- [[lat,lng],...] (지도에서 그린 구역)
