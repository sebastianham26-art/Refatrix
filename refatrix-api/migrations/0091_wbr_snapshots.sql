-- WBR(주간 비즈니스 리뷰) 주간 스냅샷(동결 보관) — 회의 시점의 화면 전체를 통째로 얼려 저장.
-- 라이브 작업 보드(wbr_board, id=1 싱글톤)는 그대로 두고, 이 테이블에 "그 시점의 복사본"을 여러 행으로 쌓는다.
-- data JSONB 에는 카드(salesperf summary)·당월 누적 견적·워터폴·이슈 보드·메모·선택 월/팀 컨텍스트가 모두 동결되어 들어간다.
-- 사진은 사본을 만들지 않는다(용량 절감). data.board.photos 에는 wbr_issue_photos 의 사진 id 만 참조한다.
--   → 과거 스냅샷이 깨지지 않도록, 어떤 스냅샷이라도 참조 중인 사진은 하드삭제하지 않는다(photo_ids 로 빠르게 판별).

CREATE TABLE IF NOT EXISTS wbr_snapshots (
  id           BIGSERIAL PRIMARY KEY,
  label        TEXT NOT NULL,                       -- 표시 라벨(기본: ISO 주차+날짜, 저장 시 수정 가능). 예 '2026-W26 (06/26)'
  period_label TEXT,                                -- 조회 월·팀 컨텍스트 문자열(예 '조회월 6월 · 팀 Total')
  data         JSONB NOT NULL,                      -- 동결된 화면 전체 페이로드
  photo_ids    BIGINT[] NOT NULL DEFAULT '{}',      -- 이 스냅샷이 참조하는 사진 id (하드삭제 보호용 비정규화 컬럼)
  created_by   BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 최신순 목록 조회용
CREATE INDEX IF NOT EXISTS idx_wbr_snapshots_created ON wbr_snapshots (created_at DESC);
-- 사진 참조 여부(= ANY(photo_ids)) 빠른 판별용
CREATE INDEX IF NOT EXISTS idx_wbr_snapshots_photo_ids ON wbr_snapshots USING GIN (photo_ids);
