-- 0306 · 견적 줄에 「어느 키트에서 풀렸나」를 남긴다 — 디렉터 지시 2026-10-28
--   키트(K0001 …)를 견적·주문에 넣으면 구성 부품 줄로 풀린다(0293). 지금까지는 풀린 뒤 어느 줄이
--   어느 키트였는지가 저장되지 않아, 창고가 포장할 때 구성품을 키트 단위로 알아볼 수 없었다.
--   kit_no = 프로모션(키트) 번호. 포장지시(창고 화면) · 포장작업지시서(PDF) · Lista de empaque 가
--   이 값으로 키트를 묶어 보여준다. 재고·금액·예약에는 아무 영향 없다(표시용 라벨).
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS kit_no TEXT;
CREATE INDEX IF NOT EXISTS quote_lines_kit_idx ON quote_lines (quote_id) WHERE kit_no IS NOT NULL;

-- Q-2026-0339(Dante Fernandez · muestra GoCar)는 0306 전에 저장돼 키트 번호가 없다.
--   부품 구성으로 맞춘 키트를 한 번 채운다(아직 비어 있는 줄만 — 다시 저장했거나 사람이 고친 줄은 건드리지 않는다).
--   CQ0166L/R 은 같은 구성의 Sportage 키트가 K0014 · K0016 두 개라 최신 번호 K0016 으로 둔다.
UPDATE quote_lines SET kit_no = CASE
         WHEN ctr_code IN ('CE0536L','CE0536R','CR0490','CL0477') THEN 'K0009'
         WHEN ctr_code IN ('CQ0166L','CQ0166R') THEN 'K0016'
         WHEN ctr_code IN ('CQ0285L','CQ0285R') THEN 'K0012'
       END
 WHERE quote_id = (SELECT id FROM quotes WHERE quote_no = 'Q-2026-0339' AND deleted_at IS NULL LIMIT 1)
   AND kit_no IS NULL
   AND ctr_code IN ('CE0536L','CE0536R','CR0490','CL0477','CQ0166L','CQ0166R','CQ0285L','CQ0285R');
