-- 0211 · 웹 가입 신청 — 「먼저 잡는 사람」에서 「디렉터가 지정」으로
--
--   바뀐 규칙(디렉터 지시):
--     · 「내가 맡겠습니다」를 없앤다. **디렉터가 직원을 지정**한다.
--     · 지정받은 직원은 접속할 때마다 그 건이 팝업으로 뜬다.
--     · 그 팝업은 **디렉터 승인까지** 계속 뜬다 — 고객 등록만으로는 끝이 아니다.
--       (할인율·외상일을 정해 등록하고, 디렉터가 승인해야 고객이 홈페이지에서 가격을 본다)
--
--   그래서 상태가 하나 늘었다. 「등록됨(승인 대기)」과 「완결(승인됨)」은 다른 상태다 —
--   이 둘을 뭉개면 담당자는 등록만 하고 손을 떼고, 승인은 아무도 안 챙긴다.
--
--     new → assigned → registered → done
--                   ↘ dismissed (대상 아님)
--
--   멱등: 재실행해도 같은 결과.

-- (1) claimed_by/claimed_at → assigned_to/assigned_at (이름이 뜻과 맞아야 읽힌다)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='crm_web_leads' AND column_name='claimed_by') THEN
    ALTER TABLE crm_web_leads RENAME COLUMN claimed_by TO assigned_to;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='crm_web_leads' AND column_name='claimed_at') THEN
    ALTER TABLE crm_web_leads RENAME COLUMN claimed_at TO assigned_at;
  END IF;
END $$;

ALTER TABLE crm_web_leads ADD COLUMN IF NOT EXISTS assigned_by   BIGINT REFERENCES users(id);
ALTER TABLE crm_web_leads ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ;

-- (2) 상태값 확장. 기존 'claimed' 는 'assigned' 로, 'done'(=등록됨) 중 아직 승인 안 난 건은
--     'registered' 로 되돌린다 — 승인까지 챙겨야 하니까.
ALTER TABLE crm_web_leads DROP CONSTRAINT IF EXISTS crm_web_leads_status_check;
UPDATE crm_web_leads SET status='assigned' WHERE status='claimed';
UPDATE crm_web_leads l SET status='registered'
 WHERE l.status='done'
   AND EXISTS (SELECT 1 FROM customers c
                WHERE c.id=l.customer_id AND COALESCE(c.approval_status,'approved') <> 'approved');
ALTER TABLE crm_web_leads
  ADD CONSTRAINT crm_web_leads_status_check
  CHECK (status IN ('new','assigned','registered','done','dismissed'));

-- (3) 열려 있는 건(팝업 대상) 조회용
DROP INDEX IF EXISTS idx_crm_web_leads_open;
CREATE INDEX IF NOT EXISTS idx_crm_web_leads_open
  ON crm_web_leads (received_at DESC) WHERE status IN ('new','assigned','registered');
CREATE INDEX IF NOT EXISTS idx_crm_web_leads_assignee
  ON crm_web_leads (assigned_to) WHERE status IN ('assigned','registered');
