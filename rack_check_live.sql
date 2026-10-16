-- 읽기 전용 점검 (Railway 콘솔 psql) — 아무것도 바꾸지 않는다
-- ① 최근 실사 랙 업로드 결과: 저장 SKU 수 · 차단 SKU(over/error)
SELECT id, created_at, file_name, rows_in, skus, blocked,
       summary->'counts' AS counts, summary->'blocked' AS blocked_list
  FROM rack_stock_imports ORDER BY id DESC LIMIT 3;
-- ② 랙이 2개 이상 저장된 SKU 수 (0 또는 아주 적으면 업로드가 1번째 랙만 들어간 것)
SELECT COUNT(*) AS multi_rack_skus FROM (
  SELECT product_id FROM product_rack_stock WHERE qty > 0 GROUP BY product_id HAVING COUNT(*) >= 2) x;
-- ③ 랙별 재고에는 있는데 위치변경 랙 목록(마스터 ∪ 랙 유형)에는 없던 랙 = 스캔 시 「등록되지 않은 코드」가 나던 랙
SELECT s.rack, COUNT(DISTINCT s.product_id) AS skus, SUM(s.qty) AS qty
  FROM product_rack_stock s
 WHERE s.qty > 0
   AND NOT EXISTS (SELECT 1 FROM rack_kinds k WHERE UPPER(TRIM(k.rack)) = s.rack)
   AND NOT EXISTS (SELECT 1 FROM products p, regexp_split_to_table(COALESCE(p.rack_location,''), '[,\n\r]+') t
                    WHERE p.deleted_at IS NULL AND UPPER(TRIM(t)) = s.rack)
 GROUP BY s.rack ORDER BY s.rack;
-- ④ 랙 합 > 등록 재고(초과) SKU — 예전 위치변경이 도착 랙을 부풀린 흔적
SELECT p.code, p.stock_qty, SUM(s.qty) AS rack_sum
  FROM product_rack_stock s JOIN products p ON p.id = s.product_id
 GROUP BY p.id, p.code, p.stock_qty HAVING SUM(s.qty) > p.stock_qty ORDER BY p.code;
