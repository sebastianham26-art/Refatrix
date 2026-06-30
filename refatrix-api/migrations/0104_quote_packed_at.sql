-- 0104_quote_packed_at.sql
-- Refatrix ERP · 포장완료(packed) 3조건 게이트
--   packed_at = (① 즉시재고 라인 전부 스캔 완료 + ② 모든 박스 사진≥1 + ③ 종이 포장지시서 업로드)
--   가 처음 모두 충족된 시각. 기존엔 quote_packing_docs.uploaded_at(종이문서)만으로 packed 판정했음.
-- 백필(선택 A): 기존 종이문서가 있는 견적은 packed_at=uploaded_at 으로 채워 과거 지표를 보존한다.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS packed_at TIMESTAMPTZ;

UPDATE quotes q
   SET packed_at = pd.uploaded_at
  FROM quote_packing_docs pd
 WHERE pd.quote_id = q.id
   AND q.packed_at IS NULL;
