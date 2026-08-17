-- =====================================================================
-- Refatrix ERP · 0175_inbound_scan_idempotency
-- 스캔 이중 기록 수정(2026-08-17): 전송 재시도의 at-least-once 문제
--   스캔이 서버에 저장됐는데 응답이 유실되면 클라이언트가 같은 스캔을 다시 보내
--   두 번 기록되던 것을, 스캔마다 클라이언트 고유 키를 붙여 정확히 1회만 기록한다.
--   취소(undo)도 같은 방식 — 재시도가 두 건을 지우지 않도록 void_key 로 멱등 처리.
-- =====================================================================

ALTER TABLE inbound_scans ADD COLUMN IF NOT EXISTS client_key TEXT;  -- 스캔 1건의 클라이언트 생성 키
ALTER TABLE inbound_scans ADD COLUMN IF NOT EXISTS void_key   TEXT;  -- 취소 1회의 클라이언트 생성 키

CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_scans_ckey ON inbound_scans (client_key) WHERE client_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_scans_vkey ON inbound_scans (void_key)   WHERE void_key   IS NOT NULL;
