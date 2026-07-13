-- =====================================================================
-- Refatrix ERP · 0135_briefing_pending
-- 하루 브리핑 "미결 누적" 트래커 보조 상태 테이블 (Layer 1).
--   · 미결 항목 자체는 원천(인보이스·견적·포장·todo·지시…)에서 라이브로 재계산 →
--     완료되면 자동 소멸(별도 원장 불필요, 드리프트 없음).
--   · 이 테이블은 "디렉터가 취한 조치"만 저장: 스누즈(까지 숨김)·영구무시·자동생성 todo 링크.
--   · item_key = 안정적 항목 식별자 '{type}:{ref_id}'  예) 'ar:123', 'calevent:45'
-- =====================================================================
CREATE TABLE IF NOT EXISTS briefing_pending_state (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_key     TEXT NOT NULL UNIQUE,               -- '{type}:{ref_id}'
  snooze_until DATE,                                 -- 이 날짜까지 미결 목록에서 숨김
  dismissed_at TIMESTAMPTZ,                          -- 영구 무시(디렉터 판단)
  todo_id      BIGINT REFERENCES todos(id),          -- 자동 생성된 할 일(있으면) — 중복생성 방지
  acked_by     BIGINT REFERENCES users(id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bps_key  ON briefing_pending_state (item_key);
CREATE INDEX IF NOT EXISTS idx_bps_todo ON briefing_pending_state (todo_id);
