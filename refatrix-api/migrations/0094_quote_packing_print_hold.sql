-- 0094_quote_packing_print_hold.sql
-- 포장작업지시서 출력 시 견적을 "유효 고정"하기 위한 컬럼.
--   packing_printed_at 이 설정되면 그 견적은 24시간 만료에서 영구 제외된다:
--     · 만료 스위퍼(finalizeExpiredQuotes) 대상에서 빠지고
--     · 재고 예약(reserved_qty) 합산에 계속 포함되어 확보 재고를 유지하며
--     · 시간과 무관하게 매출 전환이 허용된다.
-- 하위호환: 기존 견적은 NULL(=종전과 동일하게 24h 만료 적용).

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS packing_printed_at TIMESTAMPTZ;

COMMENT ON COLUMN quotes.packing_printed_at IS
  '포장작업지시서 최초 출력 시각. 설정되면 견적은 시간과 무관하게 유효(24h 만료 제외·예약 유지·전환 허용).';

-- 부분 인덱스: 유효 고정된 견적만 색인(스위퍼 제외·예약 합산 조건에 사용).
CREATE INDEX IF NOT EXISTS idx_quotes_packing_printed
  ON quotes (packing_printed_at) WHERE packing_printed_at IS NOT NULL;
