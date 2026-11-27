-- 0343: 주(州) 코드가 빠진 DENUE 후보 채우기 (2026-11-26 유카탄 파일: NL 양식으로 다듬어 cve_ent 열 없음)
--   ① entidad 이름 → ② 우편번호(cp) 앞 두 자리(SEPOMEX) 순서로 cve_ent 를 정하고, entidad 는 표준 이름으로
WITH st(cve, nom, lo, hi) AS (VALUES
  ('01','Aguascalientes',20,20),('02','Baja California',21,22),('03','Baja California Sur',23,23),('04','Campeche',24,24),
  ('05','Coahuila de Zaragoza',25,27),('06','Colima',28,28),('07','Chiapas',29,30),('08','Chihuahua',31,33),('09','Ciudad de México',1,16),
  ('10','Durango',34,35),('11','Guanajuato',36,38),('12','Guerrero',39,41),('13','Hidalgo',42,43),('14','Jalisco',44,49),('15','México',50,57),
  ('16','Michoacán de Ocampo',58,61),('17','Morelos',62,62),('18','Nayarit',63,63),('19','Nuevo León',64,67),('20','Oaxaca',68,71),
  ('21','Puebla',72,75),('22','Querétaro',76,76),('23','Quintana Roo',77,77),('24','San Luis Potosí',78,79),('25','Sinaloa',80,82),
  ('26','Sonora',83,85),('27','Tabasco',86,86),('28','Tamaulipas',87,89),('29','Tlaxcala',90,90),('30','Veracruz de Ignacio de la Llave',91,96),
  ('31','Yucatán',97,97),('32','Zacatecas',98,99)),
fix AS (
  SELECT p.id,
         COALESCE(
           (SELECT st.cve FROM st WHERE lower(translate(st.nom,'áéíóúÁÉÍÓÚ','aeiouAEIOU')) = lower(translate(trim(p.entidad),'áéíóúÁÉÍÓÚ','aeiouAEIOU')) LIMIT 1),
           (SELECT st.cve FROM st WHERE length(regexp_replace(COALESCE(p.cp,''),'\D','','g')) BETWEEN 4 AND 5
               AND left(lpad(regexp_replace(p.cp,'\D','','g'),5,'0'),2)::int BETWEEN st.lo AND st.hi LIMIT 1)) AS cve
    FROM prospects p WHERE p.cve_ent IS NULL OR p.cve_ent = ''
      -- 주 이름 없이 코드만 있는데 우편번호와 맞지 않는 행(예: Salinas Victoria CP 65510 인데 13) → 우편번호 기준으로 바로잡음
      OR ((p.entidad IS NULL OR p.entidad = '') AND p.cp ~ '^\d{5}$'
          AND NOT EXISTS (SELECT 1 FROM st WHERE st.cve = p.cve_ent AND left(p.cp,2)::int BETWEEN st.lo AND st.hi)))
UPDATE prospects p SET cve_ent = fix.cve, updated_at = now()
  FROM fix WHERE fix.id = p.id AND fix.cve IS NOT NULL;

-- 주 이름은 표준 표기로 통일(비었거나 YUCATAN 처럼 다르게 쓴 것)
UPDATE prospects SET entidad = CASE cve_ent
  WHEN '01' THEN 'Aguascalientes' WHEN '02' THEN 'Baja California' WHEN '03' THEN 'Baja California Sur' WHEN '04' THEN 'Campeche'
  WHEN '05' THEN 'Coahuila de Zaragoza' WHEN '06' THEN 'Colima' WHEN '07' THEN 'Chiapas' WHEN '08' THEN 'Chihuahua' WHEN '09' THEN 'Ciudad de México'
  WHEN '10' THEN 'Durango' WHEN '11' THEN 'Guanajuato' WHEN '12' THEN 'Guerrero' WHEN '13' THEN 'Hidalgo' WHEN '14' THEN 'Jalisco' WHEN '15' THEN 'México'
  WHEN '16' THEN 'Michoacán de Ocampo' WHEN '17' THEN 'Morelos' WHEN '18' THEN 'Nayarit' WHEN '19' THEN 'Nuevo León' WHEN '20' THEN 'Oaxaca'
  WHEN '21' THEN 'Puebla' WHEN '22' THEN 'Querétaro' WHEN '23' THEN 'Quintana Roo' WHEN '24' THEN 'San Luis Potosí' WHEN '25' THEN 'Sinaloa'
  WHEN '26' THEN 'Sonora' WHEN '27' THEN 'Tabasco' WHEN '28' THEN 'Tamaulipas' WHEN '29' THEN 'Tlaxcala' WHEN '30' THEN 'Veracruz de Ignacio de la Llave'
  WHEN '31' THEN 'Yucatán' WHEN '32' THEN 'Zacatecas' END
 WHERE cve_ent ~ '^(0[1-9]|[12][0-9]|3[0-2])$';

-- 업로드 파일 기록의 주 목록도 다시 계산
UPDATE prospect_import_batches b SET cve_ents = COALESCE((SELECT ARRAY(SELECT DISTINCT p.cve_ent FROM prospects p WHERE p.import_batch_id=b.id AND p.cve_ent IS NOT NULL ORDER BY 1)), '{}')
 WHERE EXISTS (SELECT 1 FROM prospects p WHERE p.import_batch_id=b.id);
