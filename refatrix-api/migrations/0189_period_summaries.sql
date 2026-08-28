-- 「오늘 요약」 기간 묶음(주간) 요약 보관 — 디렉터 요청 2026-08-28
-- · 일자별 요약(daily_summaries, 날짜당 1건)은 그대로 두고,
--   여러 날짜를 하나의 스토리로 묶은 요약을 별도로 누적 보관한다.
-- · 재료 = 이미 생성된 일자별 요약 본문 + 그날의 「나의 기록」 원문(2차 요약).
-- · 같은 날짜 조합을 다시 묶으면 새 행이 아니라 기존 행을 갱신한다(dates_key 유니크).

CREATE TABLE IF NOT EXISTS period_summaries (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT,                          -- 사용자 지정 제목(비면 기간 라벨로 대체)
  date_from   DATE NOT NULL,                 -- 선택 날짜 중 가장 이른 날
  date_to     DATE NOT NULL,                 -- 선택 날짜 중 가장 늦은 날
  day_count   INT  NOT NULL DEFAULT 0,       -- 실제 선택된 날짜 수(연속이 아닐 수 있음)
  dates_key   TEXT NOT NULL,                 -- 정렬·중복제거된 날짜 목록 'YYYY-MM-DD,…' (재생성 판정 키 겸 원본 목록)
  content_md  TEXT NOT NULL,                 -- AI 묶음 요약 본문(마크다운)
  stats       JSONB,                         -- 기간 합계 헤드라인(일정/할일/견적/매출/입출금/기록)
  model       TEXT,
  memo        TEXT,                          -- 날짜 요약과 동일한 자유 메모
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 같은 날짜 조합 = 1건(재생성 시 갱신)
CREATE UNIQUE INDEX IF NOT EXISTS period_summaries_key_uidx
  ON period_summaries (dates_key);

-- 보관함 목록(최근 기간 우선)
CREATE INDEX IF NOT EXISTS period_summaries_range_idx
  ON period_summaries (date_to DESC, date_from DESC);
