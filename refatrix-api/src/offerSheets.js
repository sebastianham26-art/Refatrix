// =====================================================================
// Offer Sheet 자동 생성기
//   부족 기록(stock_shortages, status=open, 고객 있음) 중 지금 재고가 있는
//   SKU를 찾아 고객별로 offer_sheets(+items)를 생성한다.
//   · 호출처: ① 수입입고 승인(importRoutes /approve) 직후  ② 부족분 화면 수동 [스캔·생성]
//   · 단가: 현재 정가(products.list_price) × (1 − customers.discount%) — IVA는 제품 iva_rate.
//   · 중복 가드: 이미 살아있는(취소 아님) 시트에 담긴 부족 기록은 제외.
//     → 같은 부족분으로 오퍼가 두 번 만들어지지 않는다. 시트를 취소하면 재생성 대상으로 복귀.
//   · advisory lock 으로 동시 생성 직렬화(승인 연타·수동 버튼 동시 클릭 대비).
// =====================================================================

const OFFER_LOCK_KEY = 815202601; // pg_advisory_xact_lock 용 임의 고정 키

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @param {Function} q            query 함수 (db.query 또는 트랜잭션 client.query 바인딩)
 * @param {Object}   opts
 * @param {number[]} [opts.productIds]     이 SKU들만 스캔(입고 승인 훅). 없으면 전체 스캔(수동).
 * @param {number}   [opts.importBatchId]  생성 시트에 남길 입고 배치 참조
 * @param {number}   [opts.userId]         created_by (수동 생성 시)
 * @param {string}   [opts.origin]         'auto' | 'manual'
 * @returns {Promise<{sheets:number, items:number, customers:Array}>}
 */
export async function generateOfferSheets(q, { productIds = null, importBatchId = null, userId = null, origin = 'auto' } = {}) {
  await q(`SELECT pg_advisory_xact_lock($1)`, [OFFER_LOCK_KEY]);

  const pids = Array.isArray(productIds) && productIds.length ? productIds.map(Number) : null;
  // SKU 필터는 조건부로 조립(pg-mem 호환 — ANY(NULL) 미사용). 수동 스캔이면 전체.
  const pidCond = pids ? `AND sh.product_id IN (${pids.map((_, i) => `$${i + 1}`).join(',')})` : '';
  const rows = (await q(
    `SELECT sh.id AS shortage_id, sh.customer_id, sh.product_id, sh.shortage_qty, sh.occurred_at::text AS occurred_at,
            p.list_price, p.iva_rate,
            c.discount AS cust_discount
       FROM stock_shortages sh
       JOIN products  p ON p.id = sh.product_id AND p.deleted_at IS NULL
       JOIN customers c ON c.id = sh.customer_id AND c.deleted_at IS NULL
       LEFT JOIN (SELECT DISTINCT oi.shortage_id
                    FROM offer_sheet_items oi
                    JOIN offer_sheets os ON os.id = oi.offer_sheet_id
                   WHERE os.status <> 'cancelled' AND os.deleted_at IS NULL) used
              ON used.shortage_id = sh.id
      WHERE sh.status = 'open'
        AND sh.customer_id IS NOT NULL
        AND sh.shortage_qty > 0
        AND p.stock_qty > 0
        AND used.shortage_id IS NULL
        ${pidCond}
      ORDER BY sh.customer_id, sh.product_id, sh.occurred_at, sh.id`, pids || [])).rows;

  if (!rows.length) return { sheets: 0, items: 0, customers: [] };

  // 고객별 그룹
  const byCust = new Map();
  for (const r of rows) {
    const k = Number(r.customer_id);
    if (!byCust.has(k)) byCust.set(k, []);
    byCust.get(k).push(r);
  }

  let sheetCount = 0; let itemCount = 0; const customers = [];
  for (const [custId, list] of byCust) {
    let subtotal = 0; let iva = 0;
    const items = list.map((r) => {
      const qty = Number(r.shortage_qty) || 0;
      const listPrice = r2(r.list_price);
      const disc = Number(r.cust_discount) || 0;
      const unit = r2(listPrice * (1 - disc / 100));
      const sub = r2(unit * qty);
      const li = r2(sub * ((Number(r.iva_rate) || 0) / 100));
      subtotal += sub; iva += li;
      return {
        shortage_id: Number(r.shortage_id), product_id: Number(r.product_id), qty,
        list_price: listPrice, discount_rate: disc, unit_price: unit,
        sub, iva: li, total: r2(sub + li), occurred_at: r.occurred_at,
      };
    });
    subtotal = r2(subtotal); iva = r2(iva);

    const sheet = (await q(
      `INSERT INTO offer_sheets (customer_id, import_batch_id, status, origin, subtotal_mxn, iva_mxn, total_mxn, created_by)
       VALUES ($1,$2,'ready',$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [custId, importBatchId, origin === 'manual' ? 'manual' : 'auto', subtotal, iva, r2(subtotal + iva), userId])).rows[0];
    const sheetId = Number(sheet.id);
    await q(`UPDATE offer_sheets SET offer_no = 'OS-' || to_char(created_at,'YYYYMMDD') || '-' || id::text WHERE id=$1`, [sheetId]);

    for (const it of items) {
      await q(
        `INSERT INTO offer_sheet_items (offer_sheet_id, shortage_id, product_id, offer_qty,
                                        list_price, discount_rate, unit_price, line_subtotal, line_iva, line_total, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [sheetId, it.shortage_id, it.product_id, it.qty, it.list_price, it.discount_rate,
         it.unit_price, it.sub, it.iva, it.total, it.occurred_at]);
      itemCount += 1;
    }
    sheetCount += 1;
    customers.push({ customer_id: custId, offer_sheet_id: sheetId, items: items.length, total_mxn: r2(subtotal + iva) });
  }
  return { sheets: sheetCount, items: itemCount, customers };
}
