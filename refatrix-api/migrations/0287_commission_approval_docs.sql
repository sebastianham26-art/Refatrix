-- =====================================================================
-- Refatrix ERP · 0287_commission_approval_docs
--   재무 › 커미션 → 전자결재 연동 (디렉터 요청 2026-10-19)
--
--   흐름
--     ① 디렉터가 그 달을 확정(commission_batches) → 영업사원·월을 고르면 확정·미지급 인보이스 목록이 보인다.
--     ② 「커미션 지급승인 전자문서 생성」 → 전자결재 임시저장 문서가 자동으로 만들어진다
--        (지급 대상·기간·고객·인보이스·매출/수금·율·커미션 내역만 채움 — 결재선·나머지는 디렉터가 작성 후 상신).
--     ③ 결재 승인 → 현금 지급 → 영업사원이 「수령증(Recibo)」에 서명.
--     ④ 서명된 수령증 스캔을 올리면 한 번에: 커미션 지급 전표 등록(반제·FIFO) + 전자결재 집행완료(증빙 '수령증')
--        → 대표이사 사후승인 대기. 문서가 마감된다.
--
--   commission_approval_docs = 커미션(영업사원 × 반제 완료월) ↔ 전자결재 문서 연결.
--     · snapshot: 문서 생성 시점의 지급 대상 내역(JSON). 결재·수령증·지급 검증의 기준.
--       지급할 때 현재 지급 대상과 다르면(승인 후 반제·NC 등으로 바뀜) 지급을 막는다.
--     · 재기안(반려 → 새 버전)은 approval_documents.parent_id 로 따라간다 — 연결은 원문서에 그대로 둔다.
--     · commission_payment_id: 수령증 업로드로 등록된 지급 전표. 채워지면 이 연결은 마감.
--   approval_categories '영업 커미션' 추가 → 재무 계정과목 6030(지급수수료) (있을 때만 · 설정에서 바꿀 수 있음).
--   전 구문 IF NOT EXISTS / NOT EXISTS — 재실행 안전.
-- =====================================================================

CREATE TABLE IF NOT EXISTS commission_approval_docs (
  id                     BIGSERIAL PRIMARY KEY,
  document_id            BIGINT NOT NULL REFERENCES approval_documents(id),
  agent_id               BIGINT NOT NULL REFERENCES users(id),
  settle_ym              TEXT   NOT NULL CHECK (settle_ym ~ '^\d{4}-\d{2}$'),
  total                  NUMERIC(14,2) NOT NULL,
  snapshot               TEXT   NOT NULL,                     -- JSON (지급 대상 내역)
  created_by             BIGINT REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  commission_payment_id  BIGINT REFERENCES commission_payments(id),
  settled_document_id    BIGINT REFERENCES approval_documents(id),   -- 실제로 마감한 문서(재기안이면 새 버전)
  settled_at             TIMESTAMPTZ,
  settled_by             BIGINT REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_approval_docs_doc ON commission_approval_docs(document_id);
CREATE INDEX IF NOT EXISTS idx_commission_approval_docs_agent ON commission_approval_docs(agent_id, settle_ym);

-- 결재 카테고리 '영업 커미션'
INSERT INTO approval_categories (name, sort_order)
SELECT '영업 커미션', 95
 WHERE NOT EXISTS (SELECT 1 FROM approval_categories WHERE name = '영업 커미션');

UPDATE approval_categories ac SET fin_category_code = '6030'
 WHERE ac.name = '영업 커미션' AND ac.fin_category_code IS NULL
   AND EXISTS (SELECT 1 FROM categories c WHERE c.code = '6030');
