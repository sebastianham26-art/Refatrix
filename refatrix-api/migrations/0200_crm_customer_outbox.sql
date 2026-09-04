-- 0200_crm_customer_outbox.sql
-- ERP → CRM(웹 카달록) 고객 상거래정보 전송 대기함(아웃박스).
--
--   왜 아웃박스인가: 승인 트랜잭션 안에서 외부 HTTP 를 직접 때리면
--   CRM 이 느리거나 죽어 있을 때 **디렉터의 승인 버튼이 같이 멈춘다.**
--   승인은 ERP 안에서 끝내고, 전송은 이 테이블에 적재한 뒤 워커가 책임진다.
--   (적재 직후 한 번 즉시 시도하므로 정상 상황에서는 체감상 "누르는 즉시 전송"이다)
--
--   ⚠ 0199 는 미배포 zip(refatrix_custreg_alert_v2 · customer_registration_event_reads)이
--     선점하고 있어 이 마이그레이션은 0200 을 쓴다.

CREATE TABLE IF NOT EXISTS crm_customer_outbox (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  op              TEXT NOT NULL,                    -- 'upsert' | 'delete'
  origin          TEXT NOT NULL,                    -- 어느 승인 경로에서 생겼는지
  rfc             TEXT,                             -- 전송 시점의 RFC(대조용 스냅샷)
  payload         JSONB NOT NULL,                   -- 실제로 보낼 본문
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed | skipped
  attempts        INT  NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  http_status     INT,
  codigo_error    TEXT,
  last_error      TEXT,
  response        JSONB,
  acted_by        BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ
);

DO $$ BEGIN
  ALTER TABLE crm_customer_outbox ADD CONSTRAINT crm_outbox_op_ck   CHECK (op IN ('upsert','delete'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'crm_outbox_op_ck 이미 존재'; END $$;

DO $$ BEGIN
  ALTER TABLE crm_customer_outbox ADD CONSTRAINT crm_outbox_status_ck CHECK (status IN ('pending','sent','failed','skipped'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'crm_outbox_status_ck 이미 존재'; END $$;

-- 워커가 매번 도는 조회: "지금 보낼 것".
CREATE INDEX IF NOT EXISTS idx_crm_outbox_due
  ON crm_customer_outbox (next_attempt_at) WHERE status = 'pending';

-- 고객별 최근 전송 이력(고객 상세·현황 화면).
CREATE INDEX IF NOT EXISTS idx_crm_outbox_customer
  ON crm_customer_outbox (customer_id, created_at DESC);

-- 현황 화면 상단 요약.
CREATE INDEX IF NOT EXISTS idx_crm_outbox_status
  ON crm_customer_outbox (status, created_at DESC);
