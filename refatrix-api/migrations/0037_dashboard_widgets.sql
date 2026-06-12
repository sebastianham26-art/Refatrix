-- =====================================================================
-- Refatrix ERP · 0037_dashboard_widgets
-- 위젯 단위 대시보드: 디렉터가 유저별로 위젯 구성·순서·필드토글을 정의.
-- 유저는 조정을 "요청"하고 디렉터가 승인.
--   · dashboard_widgets : 유저별 위젯 배치(+settings JSON: 필드 토글)
--   · dashboard_requests: 유저의 구성 변경 요청(디렉터 승인 대상)
-- =====================================================================

CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  widget_key  TEXT NOT NULL,                        -- 레지스트리 키(예: 'W01_sales_perf')
  sort_order  INT NOT NULL DEFAULT 0,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,   -- 필드 토글 등: {"amount":true,"ar":false}
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT REFERENCES users(id),
  UNIQUE (user_id, widget_key)
);
CREATE INDEX IF NOT EXISTS idx_dashw_user ON dashboard_widgets (user_id);

CREATE TABLE IF NOT EXISTS dashboard_requests (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  note        TEXT NOT NULL,                        -- 유저가 원하는 변경 설명
  payload     JSONB,                                -- (선택) 원하는 구성안
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','approved','rejected')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by  BIGINT REFERENCES users(id),
  decided_at  TIMESTAMPTZ,
  decide_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_dashreq_status ON dashboard_requests (status);
