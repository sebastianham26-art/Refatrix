-- Refatrix ERP · 0110_quotes_delete_pending_index
-- 목적: 포털 통합 알림 폴링의 '견적 삭제 대기' 조회를 seq-scan → index-scan 으로.
--   기존: SELECT ... FROM quotes WHERE status='delete_pending' AND deleted_at IS NULL
--         → quotes 전체 순차 스캔(테이블이 커질수록 매 폴링마다 비용 증가).
--   부분 인덱스(delete_pending 행만, 보통 0~극소수)라 저장·유지 비용 사실상 0.
--   del_requested_at DESC 로 정렬까지 인덱스가 제공 → ORDER BY 도 공짜.
-- 무해: 읽기 성능 개선만. 데이터·제약 변경 없음. 재실행 안전(IF NOT EXISTS).

CREATE INDEX IF NOT EXISTS idx_quotes_delete_pending
  ON quotes (del_requested_at DESC)
  WHERE status = 'delete_pending' AND deleted_at IS NULL;
