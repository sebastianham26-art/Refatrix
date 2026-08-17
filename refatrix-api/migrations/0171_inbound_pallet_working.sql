-- =====================================================================
-- Refatrix ERP · 0171_inbound_pallet_working
-- 수입입고 팔렛 「점유 표시」 — 다수 작업자가 서로 다른 디바이스로 동시에 일할 때
--   지금 누가 어느 팔렛을 잡고 있는지 화면에 보여주기 위한 소프트 락(강제 락 아님).
--   · 검수/적치 화면에서 팔렛을 열면 working_by/step/at 을 기록하고,
--     25초 자동 갱신마다 working_at 을 갱신(하트비트)한다.
--   · 조회 측은 최근 120초 이내 하트비트만 "작업 중"으로 본다(탭을 닫으면 자동 해제).
--   · 작업을 막지는 않는다 — 같은 팔렛을 굳이 잡으면 증분 저장으로 합산된다.
-- =====================================================================

ALTER TABLE inbound_pallets
  ADD COLUMN IF NOT EXISTS working_by   BIGINT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS working_step TEXT,
  ADD COLUMN IF NOT EXISTS working_at   TIMESTAMPTZ;

-- 점유 표시는 항상 "최근 것"만 조회하므로 시각 인덱스만 둔다.
CREATE INDEX IF NOT EXISTS idx_inbound_pal_working ON inbound_pallets (working_at);
