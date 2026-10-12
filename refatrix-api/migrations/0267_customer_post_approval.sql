-- =====================================================================
-- Refatrix ERP · 0267_customer_post_approval
--   디렉터 지시 (2026-10-09):
--     "현재 erp에 여러 조건으로 고객등록을 하고 디렉터 승인을 받아야 고객으로 등록이 되고
--      CRM으로 전송이 되고 있어. 이걸 단순화해야겠어."
--     → "디렉터 사후승인으로 하자. 디렉터가 승인안한걸 모아서 나중에 승인하는 걸로 해줘"
--
--   무엇이 바뀌나: 등록이 **승인을 기다리지 않는다.** 신규 고객은 등록되는 순간
--   `approval_status='approved'` 로 활성화되고 CRM 으로도 바로 나간다. 디렉터의 승인은
--   게이트가 아니라 **사후 확인**이 되고, 승인하지 않은 건은 한 화면에 모여 기다린다.
--
--   ★ 설계에서 가장 중요한 결정 — `approval_status` 의 의미를 **건드리지 않는다.**
--     이 값은 지금 저장소 20여 곳에서 읽힌다: 견적 생성 차단 4곳(quoteRoutes),
--     CRM 수신 견적 차단(crmQuoteRoutes), CRM 상태값 변환(crmEstatus → pendiente),
--     독점·조건 트리거(0235·0247), 리드 팝업(crmLeadRoutes), 목록 배지 7곳.
--     여기에 「pending 인데 사실은 쓸 수 있는 고객」이라는 새 뜻을 끼워 넣으면
--     그 20여 곳을 전부 고쳐야 하고, 한 곳만 놓쳐도 고객이 조용히 막힌다.
--     그래서 승인 여부를 **별도의 축**으로 분리한다:
--
--         approval_status  = 이 고객을 쓸 수 있는가        (기존 의미 그대로)
--         ratified_at      = 디렉터가 사후 확인했는가       (NULL = 대기)
--
--     하위 코드는 한 줄도 고치지 않아도 되고, 사후승인 목록은 `ratified_at IS NULL`
--     하나만 보면 된다 — 규칙이 한 곳에 있다.
--
--   멱등: 전부 IF NOT EXISTS / 조건부. 재실행 안전.
-- =====================================================================

-- (1) 사후승인 축 ------------------------------------------------------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ratified_at   TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ratified_by   BIGINT REFERENCES users(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ratified_note TEXT;

COMMENT ON COLUMN customers.ratified_at IS
  '디렉터 사후승인 시각. NULL = 사후승인 대기(고객은 이미 활성이다 — 0267)';
COMMENT ON COLUMN customers.ratified_by IS '사후승인한 디렉터 (0267)';
COMMENT ON COLUMN customers.ratified_note IS '사후승인 시 디렉터 메모 (0267)';

-- 대기 목록이 읽는 유일한 조건 — 부분 인덱스로 받친다.
CREATE INDEX IF NOT EXISTS idx_customers_unratified
  ON customers (created_at DESC)
  WHERE deleted_at IS NULL AND ratified_at IS NULL;

-- (2) 이미 있던 고객을 어느 쪽에 둘 것인가 -----------------------------
--   ① 지금까지 정상 운영된 고객(approved) — 디렉터가 **이미 한 번 승인한** 건이다.
--      사후승인 대기로 되돌리면 디렉터 화면이 수백 건으로 터진다. 그래서
--      `approved_at`(또는 등록일)을 사후승인 시각으로 그대로 승계한다.
UPDATE customers
   SET ratified_at = COALESCE(approved_at, submitted_at, created_at, now()),
       ratified_by = approved_by
 WHERE ratified_at IS NULL
   AND COALESCE(approval_status, 'approved') = 'approved';

--   ② 반려된 고객(rejected) — 사후승인 축에서는 다룰 일이 없다. 대기 목록에
--      남지 않도록 닫아 둔다(반려 자체는 approval_status 가 계속 들고 있다).
UPDATE customers
   SET ratified_at = COALESCE(approved_at, submitted_at, created_at, now())
 WHERE ratified_at IS NULL
   AND COALESCE(approval_status, 'approved') = 'rejected';

--   ③ ★ 지금 승인을 기다리는 고객(pending) — 이들만 새 제도로 넘어온다.
--      새 제도에서 등록은 곧 활성이므로 `approved` 로 올리고, 사후승인은
--      **아직 받지 않은 것으로 둔다**(ratified_at = NULL) — 디렉터의 판단을
--      마이그레이션이 대신하지 않는다. 그래서 이 고객들은 전환 직후
--      「사후승인 대기」 화면에 그대로 모여 있다.
--
--      ⚠ CRM 전송은 여기서 하지 않는다. 마이그레이션이 대량 전송을 일으키면
--        상대 시스템에 무슨 일이 벌어지는지 아무도 통제하지 못한다.
--        이 고객들은 디렉터가 사후승인하는 순간 전송된다(라우트가 그렇게 한다).
INSERT INTO customer_registration_events (customer_id, action, reason, snapshot, acted_by)
SELECT id, 'post_approval_migrated',
       '0267 사후승인 제도 전환 — 승인 대기 상태에서 활성으로 올림(사후승인은 미완)',
       jsonb_build_object('prev_approval_status', approval_status,
                          'discount', discount,
                          'crm_pushed', false),
       NULL
  FROM customers
 WHERE deleted_at IS NULL
   AND COALESCE(approval_status, 'approved') = 'pending';

UPDATE customers
   SET approval_status = 'approved',
       ratified_at = NULL,
       ratified_by = NULL
 WHERE deleted_at IS NULL
   AND COALESCE(approval_status, 'approved') = 'pending';

-- (3) 이력 action 에 새 값이 들어가므로 제약이 있으면 넓힌다 -------------
--   0185 의 customer_registration_events.action 에 CHECK 가 걸려 있을 수 있다.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'customer_registration_events_action_check') THEN
    ALTER TABLE customer_registration_events
      DROP CONSTRAINT customer_registration_events_action_check;
  END IF;
END $$;
