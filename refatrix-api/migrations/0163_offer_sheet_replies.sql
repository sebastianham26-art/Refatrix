-- =====================================================================
-- Refatrix ERP · 0163_offer_sheet_replies
-- Offer Sheet 고객 회신 기록 — 시트를 보낸 뒤 고객이 뭐라고 답했는지 원장으로 남긴다.
--   · 시트 1건당 여러 회신(팔로업 메모 포함) 가능 — 기록 유지, 최신 "실질 회신"이 그 시트의 답.
--   · reply_type: ordered=주문함 / partial=일부 주문 / considering=검토중 /
--                 declined=거절 / no_answer=무응답 / note=단순 메모(답으로 안 침)
--   · 요약(목록·카드)은 note 를 제외한 최신 회신을 "고객의 답"으로 사용.
-- =====================================================================

CREATE TABLE IF NOT EXISTS offer_sheet_replies (
  id              BIGSERIAL PRIMARY KEY,
  offer_sheet_id  BIGINT NOT NULL REFERENCES offer_sheets(id) ON DELETE CASCADE,
  reply_type      TEXT NOT NULL DEFAULT 'note'
                  CHECK (reply_type IN ('ordered','partial','considering','declined','no_answer','note')),
  note            TEXT,
  created_by      BIGINT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_osr_sheet ON offer_sheet_replies (offer_sheet_id, created_at);
