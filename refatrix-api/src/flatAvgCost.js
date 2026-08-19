import { round2 } from './permissions.js';

// 단순가중평균 평균원가.
//   = 현재 살아있는(삭제 X · 원가제외 X) "승인 반영된" 수입 배치들의 Σ(수입수량 × 입고단가MXN) ÷ Σ수입수량.
//   - 중간에 삭제/제외된 배치는 자동으로 빠진다(JOIN 조건).
//   - 대기(pending)·반려(rejected) 배치는 원가에 반영하지 않는다(2026-08-19):
//     같은 선적을 재작성하며 반려한 옛 배치가 평균원가·원가분석을 오염시키던 문제.
//     입고단가(unit_cost_mxn)가 아직 계산되지 않은 라인도 제외(분모 부풀림 방지).
//   - 판매 타이밍과 무관(이동평균 아님). 화면 "원가 계산 근거"의 computed_avg 와 동일한 식.
export const APPLIED_BATCH_COND = `b.deleted_at IS NULL
     AND b.exclude_from_cost IS NOT TRUE
     AND b.status NOT IN ('pending','rejected')
     AND il.unit_cost_mxn IS NOT NULL`;
export const FLAT_AVG_SQL = `
  SELECT il.product_id AS pid,
         SUM(il.qty)                      AS qty,
         SUM(il.qty * il.unit_cost_mxn)   AS amount
    FROM import_lines il
    JOIN import_batches b ON b.id = il.batch_id
   WHERE ${APPLIED_BATCH_COND}
     AND il.product_id = ANY($1)
   GROUP BY il.product_id`;

// client: pg client 또는 {query}. productIds: number[].
// 반환: { [productId]: avgCost(MXN, round2) }  — 살아있는 배치 수량이 0이면 키 없음(평균 미정).
export async function flatAvgCost(client, productIds) {
  const ids = (productIds || []).map(Number).filter((n) => Number.isFinite(n));
  if (!ids.length) return {};
  const rows = (await client.query(FLAT_AVG_SQL, [ids])).rows;
  const out = {};
  for (const r of rows) {
    const q = Number(r.qty);
    if (q > 0) out[Number(r.pid)] = round2(Number(r.amount) / q);
  }
  return out;
}
