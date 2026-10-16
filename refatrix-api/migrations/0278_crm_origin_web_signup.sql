-- =====================================================================
-- Refatrix ERP · 0278_crm_origin_web_signup  (2026-10-16)
-- CRM 고객가입 — 광고 유입(GOOGLE · FACEBOOK)은 **들어오는 대로 받는다**
--
--   디렉터 지시:
--     "CRM에서 고객가입 정보가 ERP로 넘어올때, CUS_Origin항목에 GOOGLE로 기록이 되어 있거나
--      FACEBOOK으로 기록이 된 경우, 보내오는 것만 데이타를 받고, ERP에서 꼭 필요하다고 규정한
--      항목이 없어도 회원가입을 받아줘. 이 경우, 고객팀을 07_Pagina로 정의하고 할인률을 10%로
--      정해서 고객가입을 진행해줘"
--     → "RFC가 없을 수 있어. GOOGLE, FACEBOOK 유입고객은 자동으로 10%할인과 고객구분을
--        MECANICO로 저장하고 고객이 등록되도록 해줘"
--
--   여기서 만드는 것은 **두 가지뿐**이다 — 유입경로를 담을 칸과, 그 고객들이 들어갈 팀.
--   규칙(무엇을 면제하고 무엇을 박아 넣을지)은 코드(crmInboundRoutes.js)에 한 곳으로 둔다.
--   멱등: 전부 IF NOT EXISTS / ON CONFLICT. 재실행 안전.
-- =====================================================================

-- (1) 유입경로 ---------------------------------------------------------
--   ⚠ CRM 이 보낸 **원문을 그대로** 담는다(대문자로 바꾸거나 목록으로 가두지 않는다).
--     GOOGLE·FACEBOOK 말고 어떤 값이 오는지는 상대가 정하고, 우리는 나중에 그걸 보고
--     규칙을 늘린다. 값을 가두면 새 유입경로가 생기는 날 **아무 기록도 남지 않는다.**
ALTER TABLE customers ADD COLUMN IF NOT EXISTS crm_origin TEXT;

COMMENT ON COLUMN customers.crm_origin IS
  'CRM 이 보낸 유입경로 원문(CUS_Origin). GOOGLE·FACEBOOK 이면 가입 조건을 면제한다. 0278';

-- 어느 유입경로가 얼마나 들어오는지 세는 조회가 바로 나온다.
CREATE INDEX IF NOT EXISTS idx_customers_crm_origin
  ON customers (crm_origin) WHERE crm_origin IS NOT NULL;

-- (2) 광고 유입 고객이 들어갈 팀 ---------------------------------------
--   이름이 코드에 박히므로(crmInboundRoutes.WEB_TEAM_NAME) 여기서 **반드시** 만들어 둔다.
--   운영 DB 에 사람이 같은 이름으로 이미 만들어 뒀다면 ON CONFLICT 로 건너뛴다.
--   sort_order 7 — 이름의 「07_」 과 맞춘다.
INSERT INTO sales_teams (name, sort_order) VALUES ('07_Pagina', 7)
ON CONFLICT (name) DO NOTHING;

-- 사람이 지웠다가 다시 쓰는 경우 되살린다(팀 관리 화면과 같은 규칙).
UPDATE sales_teams SET deleted_at = NULL WHERE name = '07_Pagina' AND deleted_at IS NOT NULL;
