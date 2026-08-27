-- =====================================================================
-- Refatrix ERP · 0187_inbound_warehouse_finish
-- 수입입고 "창고 종료"(잠금) — 2026-08-27
--
-- 왜: 마감(close)은 **입고 수량 반영**이지 창고 작업의 끝이 아니다(적치는 마감 후에도 계속).
--     적치까지 끝나면 그 선적에 대한 창고 프로세스를 닫아, 이후 스캔·수정으로 숫자가
--     조용히 흔들리는 것을 막아야 한다(2026-08-27 디렉터 지시).
--
-- 절차(2단계): 창고 담당자 [종료 신청] → 디렉터 PIN [승인] → wh_locked_at 기록.
--   · 신청 조건(서버가 강제): 전 팔렛 **적치 완료** + 전 팔렛 **입고 반영(received_at)**.
--   · 잠기면 창고 쪽 변경이 전부 막힌다 — 하차/하차취소·스캔·검수확정·적치·검수리셋·
--     라인재분할·마감·인보이스수정·선적삭제. (구매 재매칭·파일 첨부는 회계/서류 보강이라 제외.)
--   · 해제는 디렉터 PIN 으로만. 해제하면 신청도 함께 지워져 다시 신청부터 밟는다.
--
-- status 컬럼(CHECK)에 값을 추가하지 않는다 — 'closed'(입고 반영)와 창고 종료는 다른 축이고,
-- status 를 보는 기존 코드(목록 필터·마감 재호출·입고예정 뷰)를 건드리지 않기 위해서다.
-- =====================================================================

ALTER TABLE inbound_shipments
  ADD COLUMN IF NOT EXISTS wh_req_by    BIGINT REFERENCES users(id),   -- 종료 신청자(창고)
  ADD COLUMN IF NOT EXISTS wh_req_at    TIMESTAMPTZ,                   -- 종료 신청 시각
  ADD COLUMN IF NOT EXISTS wh_locked_by BIGINT REFERENCES users(id),   -- 승인(잠금)한 디렉터
  ADD COLUMN IF NOT EXISTS wh_locked_at TIMESTAMPTZ;                   -- NOT NULL = 창고 종료됨

-- 승인 대기 목록(디렉터 화면)
CREATE INDEX IF NOT EXISTS idx_inbound_ship_wh_req
  ON inbound_shipments (wh_req_at)
  WHERE wh_req_at IS NOT NULL AND wh_locked_at IS NULL;

-- 잠금 조회(모든 창고 변경 라우트가 진입 시 확인)
CREATE INDEX IF NOT EXISTS idx_inbound_ship_wh_locked
  ON inbound_shipments (wh_locked_at)
  WHERE wh_locked_at IS NOT NULL;
