-- =====================================================================
-- Refatrix ERP · 0183_offer_sheet_disable
-- Offer Sheet 비활성화(오퍼 중단) — 영업지원>부족분>Offer Sheet 목록에서
-- "이 오퍼는 더 이상 내보내지 않는다"를 지정한다.
--
--   · 부족 기록(stock_shortages)은 그대로 둔다 — 발주 근거이므로 절대 안 건드림.
--   · 비활성 시트에 담긴 부족분·견적 부족라인은 다음 스캔·입고 승인에서
--     "이미 처리됨"으로 취급되어 오퍼시트가 다시 생성되지 않는다.
--     (취소 cancelled 는 반대로 재생성 대상으로 복귀시킨다 — 그래서 별도 플래그)
--   · status(ready/sent/cancelled)는 그대로 보존한다. 비활성은 상태가 아니라
--     별도 스위치라서 [활성화]를 누르면 원래 상태로 그대로 돌아온다.
--   · 취소된 시트도 비활성화할 수 있다 — "취소했는데 스캔할 때마다 또 생긴다"를
--     막는 것이 이 기능의 주 용도.
-- =====================================================================

ALTER TABLE offer_sheets ADD COLUMN IF NOT EXISTS disabled_at   TIMESTAMPTZ;              -- NULL = 활성
ALTER TABLE offer_sheets ADD COLUMN IF NOT EXISTS disabled_by   BIGINT REFERENCES users(id);
ALTER TABLE offer_sheets ADD COLUMN IF NOT EXISTS disabled_note TEXT;                     -- 중단 사유(선택)

-- 생성기 중복가드·목록 필터가 자주 훑는 조건
CREATE INDEX IF NOT EXISTS idx_offer_sheets_disabled ON offer_sheets (disabled_at);
