-- =====================================================================
-- Refatrix ERP · 0269_rack_stock_edit_pick  (랙별 재고 · 실사 업로드 · 위치수정 · 피킹 기록)
--
--  디렉터 지시(2026-10-12):
--    ① 창고 실사로 받은 「SKU × 랙 × 수량」을 그대로 저장하고, 저장·조회 화면에 랙과 수량을 보여준다.
--    ② 창고담당자가 SKU 별로 랙 위치와 수량을 고칠 수 있게 한다. 단 재고에 등록된 수량을 벗어나면
--       안 되므로 「기존 위치 → 새 위치 + 수량」으로 옮기는 방식(합계 보존)으로만 바꾼다.
--    ③ 포장작업지시서에 랙 위치·수량을 모두 보여주고, 피킹할 때 실제로 어느 랙에서 집었는지 기록한다.
--
--  변경(기존 0245 테이블 확장만 — 새 테이블 1개):
--    · product_rack_moves.reason 에 'transfer'(창고 위치수정) · 'import'(실사 랙 업로드) 추가
--    · quote_pick_alloc 에 picked_at / picked_by — 창고가 「실제로 이 랙에서 집었다」고 기록한 위치
--      (기록이 없으면 종전처럼 지시서 출력 때 잡힌 계획 위치에서 차감)
--    · rack_stock_imports — 실사 랙 업로드 1회 = 1행(누가·언제·몇 SKU). 원장 ref = 'rack_import:<id>'
-- =====================================================================

-- ① 원장 사유 확장 --------------------------------------------------------
ALTER TABLE product_rack_moves DROP CONSTRAINT IF EXISTS prm_reason_chk;
ALTER TABLE product_rack_moves ADD CONSTRAINT prm_reason_chk
  CHECK (reason IN ('count','sale','sale_reverse','putaway','relocate','manual','transfer','import'));

-- ② 피킹 기록 -------------------------------------------------------------
ALTER TABLE quote_pick_alloc ADD COLUMN IF NOT EXISTS picked_at TIMESTAMPTZ;
ALTER TABLE quote_pick_alloc ADD COLUMN IF NOT EXISTS picked_by BIGINT REFERENCES users(id);

-- ③ 실사 랙 업로드 이력 ----------------------------------------------------
CREATE TABLE IF NOT EXISTS rack_stock_imports (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_name   TEXT,
  note        TEXT,
  rows_in     INTEGER NOT NULL DEFAULT 0,      -- 파일에서 읽은 줄 수
  skus        INTEGER NOT NULL DEFAULT 0,      -- 랙재고를 바꾼 SKU 수
  blocked     INTEGER NOT NULL DEFAULT 0,      -- 재고 초과로 막힌 SKU 수
  summary     JSONB,
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
