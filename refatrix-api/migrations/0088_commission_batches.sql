-- =====================================================================
-- 커미션 월 지급 배치 (반제 완료월 단위)
--   절차: 집계중 → 디렉터 확정 → 재무 인사전달(시점 기록) → 지급완료(증빙)
--   - settle_ym = 반제(완납) 완료월. 그 달 1~말일 클로징 인보이스를 묶음.
--   - 지급예정일 = 익월 15일.
--   - 제외/조정 없음(시스템 계산값 그대로 확정). 확정취소 없음.
--   - 증빙/지급완료는 영업사원별(기존 commission_payments). 인사전달은 배치 1회 기록.
-- =====================================================================
CREATE TABLE IF NOT EXISTS commission_batches (
  settle_ym    TEXT PRIMARY KEY,                          -- '2026-06'
  status       TEXT NOT NULL DEFAULT 'confirmed',         -- confirmed | handed
  pay_date     DATE,                                      -- 익월 15일(확정 시 자동)
  total_amount NUMERIC(15,2) NOT NULL DEFAULT 0,          -- 확정 시점 그 달 확정 커미션 합계(스냅샷)
  agent_count  INT NOT NULL DEFAULT 0,                    -- 대상 영업사원 수
  confirmed_by BIGINT REFERENCES users(id),
  confirmed_at TIMESTAMPTZ,
  handed_by    BIGINT REFERENCES users(id),               -- 재무
  handed_at    TIMESTAMPTZ,                               -- 인사에 넘긴 시점
  handed_note  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
