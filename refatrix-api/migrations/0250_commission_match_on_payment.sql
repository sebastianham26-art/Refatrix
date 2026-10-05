-- =====================================================================
-- 0250 · 커미션 기간 판정 기준 — 「발행일」 / 「수금일」 (2026-10-05 · 디렉터 결정)
--
--   기존(0143): 수금 기준 커미션도 "인보이스 발행일"이 속한 기간으로 판정했다.
--     → 기간 시작 전에 발행된 인보이스는, 기간 안에 수금해도 커미션 0.
--   디렉터 결정: "인보이스 발행기간은 중요하지 않고, 수금되는 기간이 중요하다."
--     · match_on='payment'(수금일) : 기간 안에 들어온 수금액(ex-IVA) × 율 이 적립된다.
--                                    발행일이 기간 전이어도 상관없다.
--                                    지급 확정은 그 인보이스가 미수 없이 완납된 달(반제 완료월).
--     · match_on='invoice'(발행일) : 종전 그대로 — 발행일이 기간에 속한 인보이스, 완납 시 전액 확정.
--   매출 기준(basis='revenue') 기간은 항상 발행일 판정(이 컬럼 무시).
--   발행일이 매출 기준 기간에 속한 인보이스는 매출 커미션만 받는다(수금 커미션과 중복 없음).
--
--   이관: 기존 기간은 모두 'invoice'(종전 동작 보존).
--         단, Oscar 의 수금 기준 기간은 'payment' 로 바꾼다(2026-10 부터 수금일 기준 4%).
--   이미 지급(반제)된 커미션은 지급 시점 금액으로 동결 — 이 변경으로 바뀌지 않는다.
-- =====================================================================

ALTER TABLE commission_agent_periods
  ADD COLUMN IF NOT EXISTS match_on TEXT NOT NULL DEFAULT 'invoice';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'comm_period_match_on_ok'
  ) THEN
    ALTER TABLE commission_agent_periods
      ADD CONSTRAINT comm_period_match_on_ok CHECK (match_on IN ('invoice','payment'));
  END IF;
END $$;

COMMENT ON COLUMN commission_agent_periods.match_on IS
  '기간 판정 기준: invoice=인보이스 발행일 / payment=수금일(수금 기준 기간에만 의미). 0250';

-- Oscar: 수금 기준 기간을 수금일 판정으로.
UPDATE commission_agent_periods cap
   SET match_on = 'payment', updated_at = now()
  FROM users u
 WHERE u.id = cap.user_id
   AND lower(u.name) = 'oscar'
   AND u.deleted_at IS NULL
   AND cap.basis = 'collection'
   AND cap.match_on = 'invoice';
