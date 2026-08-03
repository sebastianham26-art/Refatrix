// =====================================================================
// Offer Sheet 자동 생성기
//   입고(재고 등재)된 SKU 에 대해 "기다리고 있던 수요"를 두 곳에서 찾아
//   고객별로 offer_sheets(+items)를 생성한다.
//   ① 부족 기록(stock_shortages, status=open, 고객 있음)
//      — 매출등록 부족·견적 전환확정(인보이스 발행) 미확보분·견적 만료 백로그.
//   ② 견적의 부족 라인(미삭제, 고객 있음, qty > reserved_qty) — "최초 견적 부족분".
//      - draft/confirmed(살아있는 견적): 아직 전환·만료 전이라 부족 기록이 없는 것.
//      - expired(만료 견적, 최근 90일): "견적 부족 → 입고 → 만료" 순서로 진행되면
//        만료 스위퍼가 (만료 시점 재고 기준) 부족 0으로 판단해 기록을 안 남긴다 —
//        그 사각지대를 여기서 커버. 단, 같은 (견적,SKU)로 부족 기록이 이미
//        존재(전환·만료 전이)하면 그 기록의 수명주기를 따르므로 제외(anti-join).
//   · 호출처: 수입입고 승인(importRoutes /approve) 직후 + 부족분 화면 수동 [스캔·생성]
//   · 단가: 현재 정가(products.list_price) × (1 − customers.discount%) — IVA는 제품 iva_rate.
//   · 제안수량 캡(디렉터 확정 2026-08-03): 제안수량 = min(부족수량, 현재고 스냅샷).
//       실제 없는 수량을 오퍼해 "또 재고가 부족하다"는 말이 나오지 않게 한다.
//       캡은 고객별·SKU별 누적 적용(같은 고객의 같은 SKU 부족 기록이 여러 건이면
//       합계가 현재고를 넘지 않음). 고객 간에는 배분하지 않는다 — 모든 고객에게
//       같은 재고를 오퍼하고 선착순 판매(오퍼시트 하단 면책문구로 안내).
//       캡으로 0이 된 기록도 시트에 담아(수량 0) 중복가드를 유지한다 —
//       시트 취소 후 재스캔하면 그 시점 재고로 다시 계산된다.
//   · 중복 가드(살아있는 시트 기준 — 취소하면 재생성 대상으로 복귀):
//       - 부족 기록: shortage_id 가 이미 담겨 있으면 제외.
//         + 그 부족 기록의 (source_quote_id, product_id) 조합이 견적 단계에서
//           이미 오퍼된 경우 제외 — 견적 오퍼 후 전환·만료돼도 이중 오퍼 없음.
//       - 견적 라인: quote_line_id 가 이미 담겨 있으면 제외.
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
  const pidCond = (col) => (pids ? `AND ${col} IN (${pids.map((_, i) => `$${i + 1}`).join(',')})` : '');
  const pidArgs = pids || [];

  // ① 부족 기록(전환확정·매출등록·만료) — 살아있는 시트에 없는 것만
  const shortRows = (await q(
    `SELECT sh.id AS shortage_id, sh.customer_id, sh.product_id,
            (sh.shortage_qty - sh.resolved_qty) AS demand_qty,
            sh.occurred_at::text AS occurred_at,
            NULL AS quote_id, NULL AS quote_line_id,
            p.list_price, p.iva_rate, p.stock_qty,
            c.discount AS cust_discount
       FROM stock_shortages sh
       JOIN products  p ON p.id = sh.product_id AND p.deleted_at IS NULL
       JOIN customers c ON c.id = sh.customer_id AND c.deleted_at IS NULL
       LEFT JOIN (SELECT DISTINCT oi.shortage_id
                    FROM offer_sheet_items oi
                    JOIN offer_sheets os ON os.id = oi.offer_sheet_id
                   WHERE os.status <> 'cancelled' AND os.deleted_at IS NULL
                     AND oi.shortage_id IS NOT NULL) used
              ON used.shortage_id = sh.id
       LEFT JOIN (SELECT DISTINCT oi2.quote_id, oi2.product_id
                    FROM offer_sheet_items oi2
                    JOIN offer_sheets os2 ON os2.id = oi2.offer_sheet_id
                   WHERE os2.status <> 'cancelled' AND os2.deleted_at IS NULL
                     AND oi2.quote_id IS NOT NULL) uq
              ON uq.quote_id = sh.source_quote_id AND uq.product_id = sh.product_id
      WHERE sh.status = 'open'
        AND sh.customer_id IS NOT NULL
        AND (sh.shortage_qty - sh.resolved_qty) > 0
        AND p.stock_qty > 0
        AND used.shortage_id IS NULL
        AND uq.quote_id IS NULL
        ${pidCond('sh.product_id')}
      ORDER BY sh.customer_id, sh.product_id, sh.occurred_at, sh.id`, pidArgs)).rows;

  // ② 견적의 부족 라인(최초 견적 부족분)
  //    부족 = 요청수량 − 예약확보분. draft/confirmed + 최근 90일 내 만료(expired) 견적.
  //    만료 견적은 "입고 후 만료"라 부족 기록이 안 남은 사각지대 커버용 —
  //    부족 기록으로 전이된 (견적,SKU)는 tsh anti-join 으로 제외(①의 수명주기를 따름).
  const quoteCutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const args2 = pids ? pids.slice() : [];
  args2.push(quoteCutoff);
  const cutRef = `$${args2.length}`;
  const quoteRows = (await q(
    `SELECT NULL AS shortage_id, qt.customer_id, ql.product_id,
            (ql.qty - COALESCE(ql.reserved_qty,0)) AS demand_qty,
            qt.quote_date::text AS occurred_at,
            qt.id AS quote_id, ql.id AS quote_line_id,
            p.list_price, p.iva_rate, p.stock_qty,
            c.discount AS cust_discount
       FROM quote_lines ql
       JOIN quotes qt ON qt.id = ql.quote_id
       JOIN products  p ON p.id = ql.product_id AND p.deleted_at IS NULL
       JOIN customers c ON c.id = qt.customer_id AND c.deleted_at IS NULL
       LEFT JOIN (SELECT DISTINCT oi.quote_line_id
                    FROM offer_sheet_items oi
                    JOIN offer_sheets os ON os.id = oi.offer_sheet_id
                   WHERE os.status <> 'cancelled' AND os.deleted_at IS NULL
                     AND oi.quote_line_id IS NOT NULL) ub
              ON ub.quote_line_id = ql.id
       LEFT JOIN (SELECT DISTINCT sh2.source_quote_id, sh2.product_id
                    FROM stock_shortages sh2
                   WHERE sh2.source_quote_id IS NOT NULL) tsh
              ON tsh.source_quote_id = qt.id AND tsh.product_id = ql.product_id
      WHERE qt.status IN ('draft','confirmed','expired')
        AND (qt.status <> 'expired' OR qt.quote_date >= ${cutRef})
        AND qt.deleted_at IS NULL
        AND qt.customer_id IS NOT NULL
        AND ql.product_id IS NOT NULL
        AND (ql.qty - COALESCE(ql.reserved_qty,0)) > 0
        AND p.stock_qty > 0
        AND ub.quote_line_id IS NULL
        AND tsh.source_quote_id IS NULL
        ${pidCond('ql.product_id')}
      ORDER BY qt.customer_id, ql.product_id, qt.quote_date, ql.id`, args2)).rows;

  const rows = shortRows.concat(quoteRows);
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
    // 제안수량 캡: SKU별 남은 오퍼 가능량(현재고 스냅샷)에서 차감하며 min(부족수량, 남은량).
    const remaining = new Map();
    const items = list.map((r) => {
      const pid = Number(r.product_id);
      if (!remaining.has(pid)) remaining.set(pid, Math.max(0, Number(r.stock_qty) || 0));
      const demand = Number(r.demand_qty) || 0;
      const qty = Math.min(demand, remaining.get(pid));
      remaining.set(pid, remaining.get(pid) - qty);
      const listPrice = r2(r.list_price);
      const disc = Number(r.cust_discount) || 0;
      const unit = r2(listPrice * (1 - disc / 100));
      const sub = r2(unit * qty);
      const li = r2(sub * ((Number(r.iva_rate) || 0) / 100));
      subtotal += sub; iva += li;
      return {
        shortage_id: r.shortage_id != null ? Number(r.shortage_id) : null,
        quote_id: r.quote_id != null ? Number(r.quote_id) : null,
        quote_line_id: r.quote_line_id != null ? Number(r.quote_line_id) : null,
        product_id: Number(r.product_id), qty,
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
        `INSERT INTO offer_sheet_items (offer_sheet_id, shortage_id, quote_id, quote_line_id, product_id, offer_qty,
                                        list_price, discount_rate, unit_price, line_subtotal, line_iva, line_total, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [sheetId, it.shortage_id, it.quote_id, it.quote_line_id, it.product_id, it.qty, it.list_price, it.discount_rate,
         it.unit_price, it.sub, it.iva, it.total, it.occurred_at]);
      itemCount += 1;
    }
    sheetCount += 1;
    customers.push({ customer_id: custId, offer_sheet_id: sheetId, items: items.length, total_mxn: r2(subtotal + iva) });
  }
  return { sheets: sheetCount, items: itemCount, customers };
}
