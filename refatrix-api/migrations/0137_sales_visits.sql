-- 영업활동 방문·동선 (build 20260715v-visitlog)
-- 체크인 1건 = GPS 위치 + 방문처 + 활동기록. 고객 방문이면 customer_id + customer_meetings 연결(meeting_id).
--               신규 방문처는 place_name만 기록 → 이후 고객 등록 시 link-customer로 소급 연결.

CREATE TABLE IF NOT EXISTS sales_visits (
  id BIGSERIAL PRIMARY KEY,
  visit_date DATE NOT NULL,                       -- 멕시코시티 기준 날짜(서버 mxTodayStr)
  visited_at TIMESTAMPTZ NOT NULL DEFAULT now(),  -- 체크인 시각
  customer_id BIGINT REFERENCES customers(id),    -- NULL = 미등록 방문처
  place_name TEXT NOT NULL,                       -- 방문처 이름(고객이면 고객명 스냅샷)
  geo_lat DOUBLE PRECISION NOT NULL,
  geo_lng DOUBLE PRECISION NOT NULL,
  geo_accuracy DOUBLE PRECISION,
  met_person TEXT,                                -- 만난 사람(이름·직책)
  talk_note TEXT,                                 -- 무슨 이야기를 했나
  insight_note TEXT,                              -- 새로배운 내용/파악한 내용(인사이트)
  meeting_id BIGINT,                              -- customer_meetings.id (고객 방문 시 자동 생성분)
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_sales_visits_user_date ON sales_visits(created_by, visit_date);
CREATE INDEX IF NOT EXISTS ix_sales_visits_customer ON sales_visits(customer_id);
CREATE INDEX IF NOT EXISTS ix_sales_visits_place ON sales_visits(place_name) WHERE customer_id IS NULL;

CREATE TABLE IF NOT EXISTS sales_visit_pendings (
  id BIGSERIAL PRIMARY KEY,
  visit_id BIGINT NOT NULL REFERENCES sales_visits(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  due_date DATE,
  done BOOLEAN NOT NULL DEFAULT FALSE,
  done_at TIMESTAMPTZ,
  done_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_visit_pendings_visit ON sales_visit_pendings(visit_id);
CREATE INDEX IF NOT EXISTS ix_visit_pendings_open ON sales_visit_pendings(done) WHERE done = FALSE;

CREATE TABLE IF NOT EXISTS sales_visit_photos (
  id BIGSERIAL PRIMARY KEY,
  visit_id BIGINT NOT NULL REFERENCES sales_visits(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'other',             -- card(명함) / store(가게) / other(기타)
  file_name TEXT,
  mime TEXT,
  size_bytes INT,
  data_url TEXT NOT NULL,                          -- data:image/... base64 (클라이언트 압축본, ≤8MB)
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_visit_photos_visit ON sales_visit_photos(visit_id);
