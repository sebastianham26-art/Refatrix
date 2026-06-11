-- =====================================================================
-- Refatrix ERP · 0030_sales_teams
-- 영업팀 2개(01_Monterrey, 02_Merida). 고객은 팀에 고정(방식 A).
-- 같은 팀이면 팀의 고객·실적을 공유해서 봄. 상대팀은 기본 비공개.
-- 디렉터가 상대팀 열람 권한을 부여(user_team_access) — 향후 세분화 여지.
-- =====================================================================

CREATE TABLE IF NOT EXISTS sales_teams (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  sort_order  INT NOT NULL DEFAULT 0,
  deleted_at  TIMESTAMPTZ
);
INSERT INTO sales_teams (name, sort_order) VALUES
  ('01_Monterrey', 1), ('02_Merida', 2)
ON CONFLICT (name) DO NOTHING;

-- 사용자 소속 팀(영업). 디렉터 등 비영업은 NULL 가능.
ALTER TABLE users ADD COLUMN IF NOT EXISTS team_id BIGINT REFERENCES sales_teams(id);

-- 고객 귀속 팀(고정). 담당자(owner)와 별개로 팀에 고정.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS team_id BIGINT REFERENCES sales_teams(id);
CREATE INDEX IF NOT EXISTS idx_customers_team ON customers (team_id);

-- 상대팀 열람 권한(디렉터가 부여). 내 소속팀 외에 추가로 볼 수 있는 팀.
CREATE TABLE IF NOT EXISTS user_team_access (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  team_id     BIGINT NOT NULL REFERENCES sales_teams(id),
  can_edit    BOOLEAN NOT NULL DEFAULT false,   -- 향후: 열람만 vs 편집까지
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT REFERENCES users(id),
  UNIQUE (user_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_uta_user ON user_team_access (user_id);
