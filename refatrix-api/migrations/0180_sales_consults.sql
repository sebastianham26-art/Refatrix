-- 고객상담 (영업 > 고객상담) — 디렉터 요청 2026-08-19
-- ① sales_consults          : 상담 1건(업체명·담당자·WhatsApp·이메일·상담일·위치).
--                             private_by 가 채워지면 그 사용자에게만 보인다(디렉터 감추기).
-- ② sales_consult_recordings: 상담에 붙는 미팅 녹음 1건.
--                             업로드(queued) → 전사(transcribing, Whisper) → 요약(summarizing, Claude) → done.
--                             summary_json = {resumen, insights, action_items:[{content,due_date,category}],
--                                             bullets:[{category,text}], products, next_step, ko:{…}}
-- ③ sales_consult_pendings  : 상담별 펜딩·후속조치(요약 action_items 자동 등록 + 수기 추가).
-- ④ sales_consult_insights  : 기간(또는 선택 건) 인사이트 캐시 — 같은 선택은 재호출 없이 즉시 표시.
-- 기존 방문(sales_visits) 계열 테이블은 일절 건드리지 않는다(무회귀).

CREATE TABLE IF NOT EXISTS sales_consults (
  id            BIGSERIAL PRIMARY KEY,
  consult_date  DATE NOT NULL,                    -- 상담한 날짜(사용자가 달력에서 선택)
  company_name  TEXT NOT NULL,                    -- 업체명(자유 입력 또는 고객 선택 스냅샷)
  customer_id   BIGINT REFERENCES customers(id),  -- 기존 고객에서 고른 경우 연결(선택)
  contact_name  TEXT,                             -- 만난 사람 이름·직책
  wa_phone      TEXT,                             -- WhatsApp 연락 가능한 전화번호
  email         TEXT,
  geo_lat       DOUBLE PRECISION,                 -- 상담 장소(브라우저 위치정보)
  geo_lng       DOUBLE PRECISION,
  geo_accuracy  DOUBLE PRECISION,
  place_label   TEXT,                             -- 장소 메모(주소·지점명 등, 선택)
  note          TEXT,                             -- 상담 전 메모/목적
  private_by    BIGINT REFERENCES users(id),      -- 감추기: 이 사용자에게만 보임(NULL=전체 공개)
  private_at    TIMESTAMPTZ,
  created_by    BIGINT NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_consults_date ON sales_consults(consult_date);
CREATE INDEX IF NOT EXISTS ix_consults_user_date ON sales_consults(created_by, consult_date);
CREATE INDEX IF NOT EXISTS ix_consults_private ON sales_consults(private_by) WHERE private_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS sales_consult_recordings (
  id            BIGSERIAL PRIMARY KEY,
  consult_id    BIGINT NOT NULL REFERENCES sales_consults(id) ON DELETE CASCADE,
  mode          TEXT NOT NULL DEFAULT 'full' CHECK (mode IN ('full','memo')),
  mime          TEXT,
  duration_sec  INT,
  size_bytes    BIGINT,
  audio_b64     TEXT,                    -- data URL 의 base64 본문(처리 성공 후 NULL)
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','transcribing','summarizing','done','failed')),
  error         TEXT,
  attempts      INT NOT NULL DEFAULT 0,
  transcript    TEXT,
  summary_json  JSONB,
  created_by    BIGINT NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_consult_rec_consult ON sales_consult_recordings(consult_id);
CREATE INDEX IF NOT EXISTS ix_consult_rec_queue ON sales_consult_recordings(status)
  WHERE status IN ('queued','transcribing','summarizing');

CREATE TABLE IF NOT EXISTS sales_consult_pendings (
  id          BIGSERIAL PRIMARY KEY,
  consult_id  BIGINT NOT NULL REFERENCES sales_consults(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  category    TEXT,                      -- 카테고리(가격/제품/경쟁사/물류/결제/품질/관계/기타)
  source_rec_id BIGINT,                  -- AI 요약에서 자동 등록된 경우 그 녹음 id(재처리 시 중복 방지). 수기는 NULL
  due_date    DATE,
  done        BOOLEAN NOT NULL DEFAULT FALSE,
  done_at     TIMESTAMPTZ,
  done_by     BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_consult_pendings_consult ON sales_consult_pendings(consult_id);
CREATE INDEX IF NOT EXISTS ix_consult_pendings_open ON sales_consult_pendings(done) WHERE done = FALSE;

CREATE TABLE IF NOT EXISTS sales_consult_insights (
  id           BIGSERIAL PRIMARY KEY,
  scope_key    TEXT NOT NULL,            -- 선택한 상담 id 목록(정렬·조인)의 지문
  consult_ids  TEXT,                     -- 사람이 읽을 수 있게 남기는 원본 id 목록
  insight_json JSONB,                    -- {period_bullets:[{category,text}], themes:[…], risks:[…], next_actions:[…], ko:{…}}
  created_by   BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope_key)
);
