-- =====================================================================
-- Refatrix ERP · 0258_e_approval_finance_link
--   전자결재 ↔ 자금 연동 (디렉터 요청 2026-10-07)
--   ① 결재(승인완료)된 문서의 미집행 회차 → 미래자금계획(transactions status='plan', 지출)에 자동 반영.
--      반려·회수·재결재·삭제·회차 중단 시 예정은 자동으로 빠지고, 복구·재승인 시 다시 들어간다.
--   ② 거래등록에서 실제 자금집행(실적)을 등록할 때 전자결재 문서(회차)를 골라 증빙(영수증 대용)으로 연결.
--      연결하면 전자결재 회차가 집행완료로 처리되고, 전 회차가 끝나면 대표이사 사후승인으로 넘어간다.
--   · approval_payments.txn_id    : 이 회차와 연결된 거래(예정 행 → 실적 처리되면 같은 행이 실적)
--   · approval_payments.exec_source: 'approval'(전자결재 화면에서 집행/집행생략) | 'finance'(거래등록 실적으로 집행)
--   · approval_categories.fin_category_code: 결재 카테고리 → 재무 계정과목(예정·실적 거래의 과목)
--   · 이 마이그레이션은 지금 승인완료 상태인 문서의 미집행 회차를 예정으로 한 번 채운다(백필).
-- =====================================================================

ALTER TABLE approval_payments ADD COLUMN IF NOT EXISTS txn_id BIGINT REFERENCES transactions(id);
ALTER TABLE approval_payments ADD COLUMN IF NOT EXISTS exec_source TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_payments_txn ON approval_payments(txn_id) WHERE txn_id IS NOT NULL;

ALTER TABLE approval_categories ADD COLUMN IF NOT EXISTS fin_category_code TEXT REFERENCES categories(code);

-- 기존 집행완료 회차는 전자결재 화면에서 집행한 것
UPDATE approval_payments SET exec_source = 'approval' WHERE status = 'done' AND exec_source IS NULL;

-- 기본 카테고리 → 계정과목 (해당 과목이 있을 때만, 이미 지정된 건 그대로)
UPDATE approval_categories ac SET fin_category_code = m.code
  FROM (VALUES ('출장비','6090'),('소모품','6050'),('마케팅','6070'),('차량·연료','6090'),('수선·유지','6060'),
               ('비품','6120'),('외주용역','6100'),('임차료','6020'),('복리후생','6110'),('기타','6130')) AS m(name, code)
 WHERE ac.name = m.name AND ac.fin_category_code IS NULL AND EXISTS (SELECT 1 FROM categories c WHERE c.code = m.code);

-- 백필: 승인완료·미삭제 문서의 미집행(planned) 회차 → 지출 예정. plan_memo 로 회차를 표시해 되연결한다.
INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind,
                          approved, owner_id, memo, created_by, plan_amount, plan_date, plan_memo)
SELECT NULL,
       COALESCE(p.due_date, d.pay_due, CURRENT_DATE),
       'out', p.planned_amount, d.currency,
       CASE WHEN d.currency = 'USD' THEN d.fx_rate ELSE 1 END,
       COALESCE(p.planned_mxn, p.planned_amount),
       COALESCE(ac.fin_category_code, (SELECT code FROM categories WHERE code = '6130')),
       'plan', 'general', true, d.drafter_id,
       left('[전자결재] ' || COALESCE(d.doc_no, '') || ' ' || d.title
            || CASE WHEN (SELECT count(*) FROM approval_payments x WHERE x.document_id = d.id) > 1
                    THEN ' (' || p.seq || '/' || (SELECT count(*) FROM approval_payments x WHERE x.document_id = d.id) || ')' ELSE '' END
            || CASE WHEN COALESCE(d.vendor, '') <> '' THEN ' · ' || d.vendor ELSE '' END, 500),
       d.drafter_id, p.planned_amount, COALESCE(p.due_date, d.pay_due, CURRENT_DATE),
       'approval_payment:' || p.id
  FROM approval_payments p
  JOIN approval_documents d ON d.id = p.document_id
  LEFT JOIN approval_categories ac ON ac.id = d.category_id
 WHERE d.status = 'approved' AND d.deleted_at IS NULL AND p.status = 'planned' AND p.txn_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.plan_memo = 'approval_payment:' || p.id);

UPDATE approval_payments p SET txn_id = t.id
  FROM transactions t
 WHERE p.txn_id IS NULL AND t.plan_memo = 'approval_payment:' || p.id AND t.deleted_at IS NULL;
