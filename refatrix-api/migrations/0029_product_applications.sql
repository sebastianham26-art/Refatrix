-- =====================================================================
-- Refatrix ERP · 0029_product_applications
-- 적용차종(Aplicacion) 분해 저장. 원문 한 항목 = "메이커 모델 연식"
--   (예: "NISSAN Frontier 4X2 1998-2004"), ' // '로 여러 차종.
-- 역검색(차종→부품): maker/model/연식으로 조회.
-- 원문(app_text)도 보관해 파싱이 애매해도 텍스트 검색 가능.
-- =====================================================================

CREATE TABLE IF NOT EXISTS product_applications (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id  BIGINT NOT NULL REFERENCES products(id),
  app_text    TEXT NOT NULL,            -- 원문 한 항목
  maker       TEXT,                     -- 메이커(예: NISSAN, "DODGE, CHRYSLER")
  model       TEXT,                     -- 모델(예: Frontier 4X2)
  year_from   INT,                      -- 시작 연식
  year_to     INT                       -- 종료 연식
);
CREATE INDEX IF NOT EXISTS idx_papp_product ON product_applications (product_id);
CREATE INDEX IF NOT EXISTS idx_papp_maker   ON product_applications (maker);
CREATE INDEX IF NOT EXISTS idx_papp_model   ON product_applications (model);
CREATE INDEX IF NOT EXISTS idx_papp_year    ON product_applications (year_from, year_to);
