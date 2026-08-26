-- 전시회 미팅 시간표 (영업 > 고객상담 > 🎪 전시회) — 디렉터 요청 2026-08-26
-- ① exhibitions         : 전시회 1건(RUJAC 등). 시작일 + 일수(1st/2nd/3rd day) + 시간대(08~18시).
--                         is_active = TRUE 인 전시회가 화면의 「🎪 RUJAC」 버튼에서 기본으로 열린다.
-- ② exhibition_meetings : 시간표 한 칸(day_no × slot_hour)에 붙는 미팅 1건.
--                         · 계획 미팅  : status='planned', is_walkin=FALSE  (사전에 고객·담당자·목표 설정)
--                         · 즉석 미팅  : is_walkin=TRUE                     (계획 없이 진행 → 그 시간 칸을 눌러 등록)
--                         · 정량목표   : target_quote(견적수주 목표) · target_order(수주확정 목표)  [통화 = exhibitions.currency]
--                         · 정성목표   : goal_note (타이핑), 달성판단은 qual_result/qual_eval (녹음 AI 요약 기반)
--                         · 미팅 기록  : consult_id 로 sales_consults 1건에 연결 → 기존 녹음·AI요약 파이프라인을 그대로 재사용
-- 기존 고객상담(sales_consults) 계열 테이블 구조는 한 줄도 바꾸지 않는다(무회귀).

CREATE TABLE IF NOT EXISTS exhibitions (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,                       -- 전시회 이름(예: RUJAC 2026)
  venue        TEXT,                                -- 장소(예: Expo Guadalajara)
  start_date   DATE NOT NULL,                       -- 1st day 날짜
  day_count    INT  NOT NULL DEFAULT 3  CHECK (day_count BETWEEN 1 AND 10),
  start_hour   INT  NOT NULL DEFAULT 8  CHECK (start_hour BETWEEN 0 AND 23),
  end_hour     INT  NOT NULL DEFAULT 18 CHECK (end_hour   BETWEEN 1 AND 24),
  currency     TEXT NOT NULL DEFAULT 'MXN',
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,       -- 화면에서 기본으로 열리는 전시회
  note         TEXT,
  created_by   BIGINT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ,
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_exhibitions_active ON exhibitions(is_active) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS exhibition_meetings (
  id             BIGSERIAL PRIMARY KEY,
  exhibition_id  BIGINT NOT NULL REFERENCES exhibitions(id) ON DELETE CASCADE,
  day_no         INT NOT NULL CHECK (day_no BETWEEN 1 AND 10),     -- 1 = 1st day
  slot_hour      INT NOT NULL CHECK (slot_hour BETWEEN 0 AND 23),  -- 8 = 08:00~09:00
  meet_date      DATE,                                             -- start_date + (day_no-1) 스냅샷
  owner_user_id  BIGINT REFERENCES users(id),                      -- 미팅 담당자(시간표 색상 기준)
  customer_id    BIGINT REFERENCES customers(id),                  -- 등록된 고객에서 선택한 경우
  company_name   TEXT NOT NULL,
  contact_name   TEXT,
  wa_phone       TEXT,
  email          TEXT,
  goal_note      TEXT,                                             -- 정성목표(타이핑)
  target_quote   NUMERIC(14,2) NOT NULL DEFAULT 0,                 -- 견적수주 목표금액
  target_order   NUMERIC(14,2) NOT NULL DEFAULT 0,                 -- 수주확정 목표금액
  actual_quote   NUMERIC(14,2),                                    -- 달성(견적)
  actual_order   NUMERIC(14,2),                                    -- 달성(수주)
  memo           TEXT,                                             -- 미팅 간단 내용
  status         TEXT NOT NULL DEFAULT 'planned'
                 CHECK (status IN ('planned','done','cancelled','noshow')),
  is_walkin      BOOLEAN NOT NULL DEFAULT FALSE,
  consult_id     BIGINT REFERENCES sales_consults(id),             -- 녹음·AI요약이 붙는 고객상담 1건
  qual_result    TEXT CHECK (qual_result IN ('achieved','partial','missed')),
  qual_eval      TEXT,                                             -- AI 판단 근거(한국어)
  qual_eval_json JSONB,                                            -- {result,reason,evidence:[],quote_amount,order_amount,next_step}
  qual_eval_at   TIMESTAMPTZ,
  created_by     BIGINT NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ,
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_expo_meet_board  ON exhibition_meetings(exhibition_id, day_no, slot_hour) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_expo_meet_owner  ON exhibition_meetings(owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_expo_meet_consult ON exhibition_meetings(consult_id) WHERE consult_id IS NOT NULL;
