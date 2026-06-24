-- =====================================================================
-- Refatrix ERP · 0076_wbr_board
-- WBR(Weekly Business Review) 보드: 일정 > WBR 화면의
--  ① 5개 조직(영업/영업지원/제품마케팅/창고/경영총괄)별 「이번주/다음주」 이슈 불릿
--  ② 회의 자유 메모
-- 를 단일 JSON 문서로 영속 저장한다(작성자가 직접 지울 때까지 유지).
-- 단일 행(id=1) 싱글톤. 프런트가 전체 상태를 PUT 으로 덮어쓴다.
-- KPI 카드/워터폴 데이터는 여기 저장하지 않음(영업 대시보드 API 실시간 조회).
-- =====================================================================

CREATE TABLE IF NOT EXISTS wbr_board (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wbr_board_singleton CHECK (id = 1)
);

INSERT INTO wbr_board (id, data) VALUES (1, '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;
