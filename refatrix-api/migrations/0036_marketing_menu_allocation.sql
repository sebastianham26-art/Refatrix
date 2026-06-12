-- =====================================================================
-- Refatrix ERP · 0036_marketing_menu_allocation
-- 마케팅 메뉴판 배분: 전체 월 예산(탑) → 고객×월×활동 수량(자동 비용) →
--   마케팅 담당 제출 → 디렉터 승인. + 메모 게시판(전체·고객별).
-- 메뉴판은 activity_catalog(단가) 재사용.
-- =====================================================================

-- 전체 마케팅 월 예산(탑). 디렉터/마케팅이 입력.
CREATE TABLE IF NOT EXISTS marketing_budget_months (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ym          TEXT NOT NULL UNIQUE,                 -- 'YYYY-MM'
  amount      NUMERIC(15,2) NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT REFERENCES users(id)
);

-- 고객×월×활동 수량 배분(수량×단가 = 비용). 단가는 스냅샷 보관.
CREATE TABLE IF NOT EXISTS marketing_alloc (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id   BIGINT NOT NULL REFERENCES customers(id),
  ym            TEXT NOT NULL,                       -- 'YYYY-MM'
  catalog_id    BIGINT NOT NULL REFERENCES activity_catalog(id),
  qty           NUMERIC(15,3) NOT NULL DEFAULT 0,
  unit_budget   NUMERIC(15,2) NOT NULL DEFAULT 0,    -- 산출 시점 단가 스냅샷
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT REFERENCES users(id),
  UNIQUE (customer_id, ym, catalog_id)
);
CREATE INDEX IF NOT EXISTS idx_malloc_ym ON marketing_alloc (ym);
CREATE INDEX IF NOT EXISTS idx_malloc_cust ON marketing_alloc (customer_id);

-- 마케팅 배분 승인 상태(전체 1건: 마케팅 담당 제출 → 디렉터 승인)
CREATE TABLE IF NOT EXISTS marketing_plan_status (
  id           INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','submitted','approved','rejected')),
  note         TEXT,
  submitted_by BIGINT REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  decided_by   BIGINT REFERENCES users(id),
  decided_at   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO marketing_plan_status (id, status) VALUES (1, 'draft') ON CONFLICT (id) DO NOTHING;

-- 메모 게시판(전체 또는 고객별). 전원 작성, 역할 표시, 시간순 스레드.
CREATE TABLE IF NOT EXISTS marketing_notes (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id  BIGINT REFERENCES customers(id),     -- NULL = 전체 메모
  note         TEXT NOT NULL,
  author_id    BIGINT REFERENCES users(id),
  author_role  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mnote_cust ON marketing_notes (customer_id, created_at);

-- 메뉴판 중복 방지: 활성 항목 이름 유니크(중복 시드 정리 후)
DELETE FROM activity_catalog a
 USING activity_catalog b
 WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL
   AND a.name = b.name AND a.id > b.id
   AND NOT EXISTS (SELECT 1 FROM marketing_alloc m WHERE m.catalog_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM marketing_activities m WHERE m.catalog_id = a.id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_name ON activity_catalog (name) WHERE deleted_at IS NULL;
