// =====================================================================
// 부족분 해소 엔진 (0156_shortage_resolutions)
//   원칙: 부족분 발생 이후 "같은 고객 + 같은 제품" 판매(인보이스 발행)가 일어나면
//         판매 수량만큼 오래된 부족분부터(FIFO) 해소한다.
//   · 원 부족 기록(shortage_qty)은 수정하지 않는다 — resolved_qty 만 누적.
//   · 해소 원장(stock_shortage_resolutions)에 건별 기록. 잔여 0 → status='resolved'.
//   · 같은 인보이스가 만든 부족 기록은 그 인보이스의 출고분으로 해소하지 않는다
//     (부족분 자체가 그 인보이스의 미출고 잔량이므로).
//   · 인보이스 삭제·수정 시 reverseInvoiceResolutions 로 되돌린다(원장 삭제 + 캐시 복원).
//   호출처: salesRoutes(매출 등록·삭제·수정승인), 소급 스캔(resolve-scan).
// =====================================================================

const r3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

/**
 * 판매 1라인을 open 부족분에 FIFO 배분해 해소한다.
 * @param {Function} q  트랜잭션 client.query 바인딩(c.query.bind(c)) 또는 query
 * @param {Object}   p  { productId, customerId, qty, invDate(YYYY-MM-DD), invoiceId, userId, source }
 * @returns {Promise<{allocated:number, entries:Array}>} allocated=이번에 해소된 총량
 */
export async function allocateShortagesOnSale(q, { productId, customerId, qty, invDate, invoiceId = null, userId = null, source = 'sale' }) {
  let left = r3(qty);
  if (!(left > 0) || !productId || !customerId) return { allocated: 0, entries: [] };
  // 대상: 같은 고객+제품, open, 발생일 ≤ 판매일, 이 인보이스가 만든 기록 제외. 오래된 것부터.
  const rows = (await q(
    `SELECT id, shortage_qty, resolved_qty FROM stock_shortages
      WHERE product_id=$1 AND customer_id=$2 AND status='open'
        AND occurred_at <= $3::date
        AND ($4::bigint IS NULL OR sales_invoice_id IS DISTINCT FROM $4::bigint)
      ORDER BY occurred_at, id
      FOR UPDATE`, [productId, customerId, invDate, invoiceId])).rows;
  const entries = [];
  for (const sh of rows) {
    if (left <= 0) break;
    const remaining = r3(Number(sh.shortage_qty) - Number(sh.resolved_qty));
    if (remaining <= 0) continue;
    const take = Math.min(remaining, left);
    left = r3(left - take);
    const res = (await q(
      `INSERT INTO stock_shortage_resolutions (shortage_id, qty, source, sales_invoice_id, resolved_by, note)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [sh.id, take, source, invoiceId, userId,
       invoiceId ? `판매 해소 (인보이스 #${invoiceId})` : '판매 해소'])).rows[0];
    const fully = r3(remaining - take) <= 0;
    await q(
      `UPDATE stock_shortages
          SET resolved_qty = resolved_qty + $1
            ${fully ? `, status='resolved', resolved_at=now(), resolved_by=$3` : ''}
        WHERE id=$2`,
      fully ? [take, sh.id, userId] : [take, sh.id]);
    entries.push({ resolution_id: Number(res.id), shortage_id: Number(sh.id), qty: take, fully });
  }
  return { allocated: r3(Number(qty) - left), entries };
}

/**
 * 인보이스가 만들었던 해소를 전부 되돌린다(삭제·수정 전 호출).
 * 원장 행을 지우고 resolved_qty 를 복원, 전량해소였던 기록은 open 으로 재개방.
 * (cancelled 기록은 건드리지 않음)
 */
export async function reverseInvoiceResolutions(q, invoiceId, userId = null) {
  if (!invoiceId) return { reversed: 0 };
  const rows = (await q(
    `DELETE FROM stock_shortage_resolutions WHERE sales_invoice_id=$1
      RETURNING shortage_id, qty`, [invoiceId])).rows;
  let reversed = 0;
  for (const r of rows) {
    reversed = r3(reversed + Number(r.qty));
    await q(
      `UPDATE stock_shortages
          SET resolved_qty = GREATEST(resolved_qty - $1, 0),
              status = CASE WHEN status='resolved' THEN 'open' ELSE status END,
              resolved_at = CASE WHEN status='resolved' THEN NULL ELSE resolved_at END,
              resolved_by = CASE WHEN status='resolved' THEN $3 ELSE resolved_by END
        WHERE id=$2 AND status <> 'cancelled'`, [r.qty, r.shortage_id, userId]);
  }
  return { reversed, rows: rows.length };
}

/**
 * 소급 스캔: 과거 판매 이력을 훑어 open 부족분을 해소한다. 몇 번을 돌려도 결과가 같다(멱등).
 *   (고객, 제품) 쌍마다:
 *     · 판매 용량 = posted 인보이스 라인 수량 − 그 인보이스가 이미 이 쌍에 대해 해소한 양
 *     · 인보이스를 날짜순으로 돌며 발생일 ≤ 판매일인 open 부족분에 FIFO 배분
 * @returns {Promise<{pairs:number, allocated:number, resolutions:number}>}
 */
export async function scanResolveShortages(q, { userId = null } = {}) {
  // open 부족분이 있는 (고객, 제품) 쌍
  const pairs = (await q(
    `SELECT customer_id, product_id, MIN(occurred_at)::date AS first_at
       FROM stock_shortages
      WHERE status='open' AND customer_id IS NOT NULL
        AND shortage_qty - resolved_qty > 0
      GROUP BY customer_id, product_id`)).rows;
  let allocated = 0; let resolutions = 0;
  for (const pr of pairs) {
    // 이 쌍의 판매 인보이스(발생 최초일 이후) + 이미 사용된 해소량
    const sales = (await q(
      `SELECT si.id AS invoice_id, si.inv_date::date AS inv_date,
              SUM(sil.qty)::numeric AS sold_qty,
              COALESCE((SELECT SUM(r.qty) FROM stock_shortage_resolutions r
                          JOIN stock_shortages s2 ON s2.id = r.shortage_id
                         WHERE r.sales_invoice_id = si.id
                           AND s2.product_id = $2 AND s2.customer_id = $1), 0)::numeric AS used_qty
         FROM sales_invoices si
         JOIN sales_invoice_lines sil ON sil.invoice_id = si.id AND sil.product_id = $2
        WHERE si.customer_id = $1 AND si.deleted_at IS NULL
          AND si.status NOT IN ('deleted')
          AND si.inv_date >= $3::date
        GROUP BY si.id, si.inv_date
        ORDER BY si.inv_date, si.id`, [pr.customer_id, pr.product_id, pr.first_at])).rows;
    for (const s of sales) {
      const capacity = r3(Number(s.sold_qty) - Number(s.used_qty));
      if (capacity <= 0) continue;
      const out = await allocateShortagesOnSale(q, {
        productId: Number(pr.product_id), customerId: Number(pr.customer_id),
        qty: capacity, invDate: s.inv_date, invoiceId: Number(s.invoice_id),
        userId, source: 'scan',
      });
      allocated = r3(allocated + out.allocated);
      resolutions += out.entries.length;
    }
  }
  return { pairs: pairs.length, allocated, resolutions };
}
