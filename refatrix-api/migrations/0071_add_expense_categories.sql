-- 0071: 실제 지출 실적을 담기 위한 판관비/영업외 계정과목 11개 추가.
--   기존 계정(6010 급여 등)은 그대로 두고, 빈 코드 번호로 신규 추가만 한다.
--   ※ group_name(구분)은 하드코딩하지 않고 기존 6010(판관비)·7010(영업외비용)에서
--     '그대로 상속'받는다. 시드는 '판관비'지만 운영 DB 문자열이 다를 수 있어,
--     상속시켜야 신규 계정이 기존 계정과 화면 표시/필터에서 100% 동일하게 보인다.
--   ※ COGS/수입 물류비는 계정과목을 만들지 않는다 — '이체'로만 기록하고
--     재고 원가 반영은 수입등록 화면에서 직접 처리(정책 결정).
--   ON CONFLICT DO NOTHING 으로 재실행/중복에도 안전.

-- (1) 판관비 — 기존 6010과 동일 그룹으로 상속 -------------------------
INSERT INTO categories (code, name, group_name, sort_order)
SELECT v.code, v.name,
       COALESCE((SELECT group_name FROM categories WHERE code = '6010'), '판관비'),
       v.sort_order
FROM (VALUES
  ('6030', '지급수수료',     51),
  ('6040', '세금과공과',     52),
  ('6050', '소모품비',       53),
  ('6060', '수선비',         54),
  ('6080', '소프트웨어·IT',  61),
  ('6090', '여비교통비',     62),
  ('6100', '전문가보수',     63),
  ('6110', '복리후생비',     64),
  ('6120', '비품',           65),
  ('6130', '기타경비',       66)
) AS v(code, name, sort_order)
ON CONFLICT (code) DO NOTHING;

-- (2) 영업외비용 — 기존 7010과 동일 그룹으로 상속 --------------------
INSERT INTO categories (code, name, group_name, sort_order)
SELECT '7020', '외환차손',
       COALESCE((SELECT group_name FROM categories WHERE code = '7010'), '영업외비용'),
       71
ON CONFLICT (code) DO NOTHING;
