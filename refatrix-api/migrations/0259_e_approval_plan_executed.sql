-- =====================================================================
-- Refatrix ERP · 0259_e_approval_plan_executed
--   전자결재 ↔ 자금 연동 보완 (디렉터 2026-10-07 「거래등록에 test 문서가 없어」)
--   0258 은 「미집행(planned)」 회차만 미래자금계획에 넣었다. 그래서 전자결재 화면에서 이미 「집행」했거나
--   「집행 생략」(승인 즉시 자동 집행)한 문서는 예정이 없어 거래등록 · 예정 내역에서 보이지 않았다.
--   이제 결재가 끝난 문서는 **거래등록 실적이 연결될 때까지** 예정으로 남는다(실제 지급일 · 실적 금액).
--   이 마이그레이션은 그런 회차를 한 번 채운다(재실행 안전).
-- =====================================================================

-- ① 전자결재 집행 때 숨겨졌던 예정 행 → 되살림(실적 금액·지급일로)
UPDATE transactions t
   SET deleted_at = NULL,
       txn_date = COALESCE(p.exec_date, p.due_date, t.txn_date), plan_date = COALESCE(p.exec_date, p.due_date, t.txn_date),
       amount = COALESCE(p.actual_amount, p.planned_amount), plan_amount = COALESCE(p.actual_amount, p.planned_amount),
       amount_mxn = COALESCE(p.actual_mxn, p.planned_mxn, p.planned_amount)
  FROM approval_payments p
  JOIN approval_documents d ON d.id = p.document_id
 WHERE t.id = p.txn_id AND t.status = 'plan' AND t.deleted_at IS NOT NULL
   AND d.status = 'approved' AND d.deleted_at IS NULL
   AND p.status = 'done' AND COALESCE(p.exec_source, 'approval') <> 'finance';

-- ② 예정 행이 아예 없는 회차 → 새로 만듦
INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind,
                          approved, owner_id, memo, created_by, plan_amount, plan_date, plan_memo)
SELECT NULL,
       COALESCE(p.exec_date, p.due_date, d.pay_due, CURRENT_DATE),
       'out', COALESCE(p.actual_amount, p.planned_amount), d.currency,
       CASE WHEN d.currency = 'USD' AND COALESCE(p.actual_amount, 0) > 0 THEN round(p.actual_mxn / p.actual_amount, 6)
            WHEN d.currency = 'USD' THEN d.fx_rate ELSE 1 END,
       COALESCE(p.actual_mxn, p.planned_mxn, p.planned_amount),
       COALESCE(ac.fin_category_code, (SELECT code FROM categories WHERE code = '6130')),
       'plan', 'general', true, d.drafter_id,
       left('[전자결재] ' || COALESCE(d.doc_no, '') || ' ' || d.title
            || CASE WHEN (SELECT count(*) FROM approval_payments x WHERE x.document_id = d.id) > 1
                    THEN ' (' || p.seq || '/' || (SELECT count(*) FROM approval_payments x WHERE x.document_id = d.id) || ')' ELSE '' END
            || CASE WHEN COALESCE(d.vendor, '') <> '' THEN ' · ' || d.vendor ELSE '' END, 500),
       d.drafter_id, COALESCE(p.actual_amount, p.planned_amount), COALESCE(p.exec_date, p.due_date, d.pay_due, CURRENT_DATE),
       'approval_payment:' || p.id
  FROM approval_payments p
  JOIN approval_documents d ON d.id = p.document_id
  LEFT JOIN approval_categories ac ON ac.id = d.category_id
 WHERE d.status = 'approved' AND d.deleted_at IS NULL
   AND p.status = 'done' AND COALESCE(p.exec_source, 'approval') <> 'finance'
   AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = p.txn_id AND (t.deleted_at IS NULL OR t.status = 'plan'))
   AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.plan_memo = 'approval_payment:' || p.id AND t.deleted_at IS NULL);

UPDATE approval_payments p SET txn_id = t.id
  FROM transactions t
 WHERE t.plan_memo = 'approval_payment:' || p.id AND t.deleted_at IS NULL AND t.status = 'plan'
   AND NOT EXISTS (SELECT 1 FROM transactions x WHERE x.id = p.txn_id AND x.deleted_at IS NULL);
