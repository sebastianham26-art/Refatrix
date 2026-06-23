import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { costDocTotalMxn, allocateByQty, applyClosedMonth, isClosedMonth, toMxn } from '../importCost.js';
import { round2, fieldVisible } from '../permissions.js';
import { computeRecost } from '../recost.js';
import { getRateForDate } from '../fx.js';
import { logEvent } from '../audit.js';

// 한 입고 건의 총수량 (분배 비율 기준)
async function batchTotalQty(c, batchId) {
  const r = await c.query(`SELECT COALESCE(SUM(qty),0) AS q FROM import_lines WHERE batch_id=$1`, [batchId]);
  return Number(r.rows[0].q);
}
async function closedPeriods(c) {
  return (await c.query(`SELECT period FROM period_closings`)).rows.map((r) => r.period);
}

// 승인 시 적용될 제품별 효과를 계산(읽기 전용). preview / approve 공용.
// NOTE: 매출(판매) 모듈 도입 전이므로 "이미 팔린 수량 = 0"으로 본다.
//   → 현재는 전액 재고가산(평균원가 상승), 정산차액/소급COGS = 0.
//   → 매출 원장이 쌓이면 동일 로직에서 분리·정정이 자동 적용된다.
async function computeDoc(c, docId) {
  const doc = (await c.query(`SELECT * FROM import_cost_docs WHERE id=$1 AND deleted_at IS NULL`, [docId])).rows[0];
  if (!doc) return { error: 'not_found' };
  const lines = (await c.query(`SELECT label, amount, currency, invoice_no FROM import_cost_lines WHERE doc_id=$1`, [docId])).rows;
  const allocs = (await c.query(`SELECT * FROM import_cost_allocations WHERE doc_id=$1`, [docId])).rows;
  const closed = await closedPeriods(c);
  const totalMxn = costDocTotalMxn(lines, doc.fx_rate, doc.base_currency);

  const effects = [];
  for (const a of allocs) {
    const batch = (await c.query(`SELECT id, batch_no, import_date FROM import_batches WHERE id=$1`, [a.batch_id])).rows[0];
    const bTotalQty = await batchTotalQty(c, a.batch_id);
    const allocMxn = Number(a.alloc_amount_mxn);
    const perUnit = bTotalQty > 0 ? round2(allocMxn / bTotalQty) : 0;
    const isClosed = isClosedMonth(batch.import_date, closed);

    const plines = (await c.query(
      `SELECT il.product_id, il.qty, p.code, p.name, p.stock_qty, p.avg_cost
         FROM import_lines il JOIN products p ON p.id=il.product_id
        WHERE il.batch_id=$1`, [a.batch_id])).rows;

    for (const pl of plines) {
      const lineQty = Number(pl.qty);
      const allocForProduct = round2(perUnit * lineQty);
      const curStock = Number(pl.stock_qty);
      const curAvg = Number(pl.avg_cost);
      // 판매 모듈 전: soldQtyOfBatch = 0 → 전액 재고가산
      const r = applyClosedMonth({ batchQty: lineQty, soldQtyOfBatch: 0, perUnit, curStockQty: curStock, curAvg });
      effects.push({
        batchId: batch.id, batchNo: batch.batch_no, importDate: batch.import_date, closedMonth: isClosed,
        productId: pl.product_id, code: pl.code, name: pl.name,
        lineQty, perUnit, allocForProduct,
        avgBefore: r.avgBefore, avgAfter: r.avgAfter,
        stockAddedMxn: r.stockAddedMxn, varianceExpenseMxn: 0, retroCogsMxn: 0,
      });
    }
  }
  return {
    docId, status: doc.status, fxRate: Number(doc.fx_rate), totalMxn,
    allocations: allocs.map((a) => ({ batchId: a.batch_id, ratio: Number(a.ratio), allocMxn: Number(a.alloc_amount_mxn) })),
    effects,
  };
}

export default async function importCostRoutes(app) {
  // 승인된 입고 건 목록(부대비용 분배 대상 선택용)
  app.get('/api/import-batches', { preHandler: [authGuard, requirePage('inventory')] }, async (req) => {
    const canApprove = req.ctx.perm.role === 'director';
    const seeCost = fieldVisible(req.ctx.perm, 'unit_cost');
    const status = (req.query.status || 'approved');
    const rows = (await query(
      `SELECT b.id, b.batch_no, b.import_date, b.status, b.note, b.created_by, b.currency, b.fx_rate,
              u.name AS created_by_name,
              COALESCE(SUM(il.qty),0) AS total_qty,
              COUNT(DISTINCT il.product_id) AS sku_count,
              COALESCE(SUM(il.qty * il.import_price),0) AS base_amount_cur,
              COALESCE((SELECT SUM(CASE WHEN o.currency='USD' THEN o.amount*b.fx_rate ELSE o.amount END)
                          FROM import_overheads o WHERE o.batch_id=b.id),0) AS overhead_mxn,
              STRING_AGG(DISTINCT p.code, ', ') AS product_codes
         FROM import_batches b
         LEFT JOIN import_lines il ON il.batch_id=b.id
         LEFT JOIN products p ON p.id=il.product_id
         LEFT JOIN users u ON u.id=b.created_by
        WHERE b.deleted_at IS NULL AND b.status=$1
        GROUP BY b.id, u.name ORDER BY b.import_date DESC, b.id DESC LIMIT 200`, [status])).rows;
    return { can_approve: canApprove, items: rows.map((r) => {
      const fx = Number(r.fx_rate) || 1;
      const baseMxn = Number(r.base_amount_cur) * (r.currency === 'USD' ? fx : 1);
      const stockValueMxn = Math.round((baseMxn + Number(r.overhead_mxn)) * 100) / 100;
      // 원가 구성요소(base_amount_cur·overhead_mxn 등)는 직원에게 전송하지 않음
      const out = {
        id: r.id, batch_no: r.batch_no, import_date: r.import_date, status: r.status, note: r.note,
        created_by: r.created_by, created_by_name: r.created_by_name, product_codes: r.product_codes,
        total_qty: Number(r.total_qty), sku_count: Number(r.sku_count),
        stock_value_mxn: seeCost ? stockValueMxn : null,
      };
      if (seeCost) { out.currency = r.currency; out.fx_rate = fx; }
      return out;
    }) };
  });

  // 승인 대기 입고 건수(포털 배지용)
  app.get('/api/import-batches/pending-count', { preHandler: [authGuard, requirePage('inventory')] }, async () => {
    const n = (await query(`SELECT COUNT(*)::int AS n FROM import_batches WHERE deleted_at IS NULL AND status='pending'`)).rows[0].n;
    return { pending: n };
  });

  // 배치별 라인(SKU·수량) + 삭제 안전성. 드릴다운/배치정리 공용.
  //   판매는 특정 배치에 묶이지 않음(가중평균 단일 재고풀) → "삭제해도 판매이력에 영향 없음"의 기준은
  //   '그 배치 수량을 빼도 재고가 음수가 안 됨'(safe = current_stock >= batch_qty). 음수면 그 배치 분이 판매로 소진된 것.
  app.get('/api/import-batches/:id/lines', { preHandler: [authGuard, requirePage('inventory')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_batch' });
    const rows = (await query(
      `SELECT il.product_id, p.code, p.name, il.qty AS batch_qty, p.stock_qty AS current_stock,
              COALESCE((SELECT SUM(sil.qty) FROM sales_invoice_lines sil
                          JOIN sales_invoices si ON si.id=sil.invoice_id
                         WHERE sil.product_id=il.product_id AND si.status='posted' AND si.deleted_at IS NULL),0) AS sold_qty
         FROM import_lines il JOIN products p ON p.id=il.product_id
        WHERE il.batch_id=$1
        ORDER BY p.code, p.name`, [id])).rows;
    const lines = rows.map((r) => ({
      product_id: Number(r.product_id), code: r.code, name: r.name,
      batch_qty: Number(r.batch_qty), current_stock: Number(r.current_stock), sold_qty: Number(r.sold_qty),
      safe: Number(r.current_stock) >= Number(r.batch_qty),
    }));
    return { lines, safe: lines.every((l) => l.safe) };
  });

  // 중복 배치 정리 분석(읽기 전용, 디렉터). 같은 SKU·수량 구성의 배치를 자동으로 묶어
  //   그룹·제품별로 유령(중복)수량 · 현재고 · 판매 · 음수없이 제거가능량 · 막힌유령(실입고 누락)을 계산.
  app.get('/api/import-recost/duplicate-analysis', { preHandler: [authGuard, requireDirector] }, async () => {
    // 1) 승인·미삭제 배치의 라인 전부 (+송장번호)
    const rows = (await query(
      `SELECT b.id AS batch_id, b.batch_no, b.import_date, il.product_id, il.qty, il.invoice_no, p.code, p.name
         FROM import_batches b
         JOIN import_lines il ON il.batch_id=b.id
         JOIN products p ON p.id=il.product_id
        WHERE b.deleted_at IS NULL AND b.status='approved'
        ORDER BY b.id, p.code`)).rows;
    // 2) 배치별 구성(서명) 만들기 (+송장번호 집합)
    const byBatch = new Map();
    for (const r of rows) {
      const bid = Number(r.batch_id);
      if (!byBatch.has(bid)) byBatch.set(bid, { batch_id: bid, batch_no: r.batch_no, import_date: r.import_date ? String(r.import_date).slice(0, 10) : '', lines: [], invoices: new Set() });
      byBatch.get(bid).lines.push({ product_id: Number(r.product_id), code: r.code, name: r.name, qty: Number(r.qty) });
      if (r.invoice_no) byBatch.get(bid).invoices.add(String(r.invoice_no));
    }
    const sig = (b) => b.lines.slice().sort((a, c) => a.product_id - c.product_id).map((l) => l.product_id + ':' + l.qty).join('|');
    // 3) 서명으로 그룹핑 → 2개 이상만 중복 그룹
    const groups = new Map();
    for (const b of byBatch.values()) { const s = sig(b); if (!groups.has(s)) groups.set(s, []); groups.get(s).push(b); }
    const dupGroups = [...groups.values()].filter((arr) => arr.length >= 2);
    if (!dupGroups.length) return { groups: [], product_count: 0 };
    // 4) 관련 제품의 현재고 + 총판매
    const pidSet = new Set();
    dupGroups.forEach((arr) => arr[0].lines.forEach((l) => pidSet.add(l.product_id)));
    const pids = [...pidSet];
    const stockRows = (await query(`SELECT id, stock_qty FROM products WHERE id = ANY($1)`, [pids])).rows;
    const stockBy = {}; stockRows.forEach((r) => { stockBy[Number(r.id)] = Number(r.stock_qty); });
    const soldRows = (await query(
      `SELECT sil.product_id, COALESCE(SUM(sil.qty),0) AS sold
         FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id=sil.invoice_id
        WHERE si.status='posted' AND si.deleted_at IS NULL AND sil.product_id = ANY($1)
        GROUP BY sil.product_id`, [pids])).rows;
    const soldBy = {}; soldRows.forEach((r) => { soldBy[Number(r.product_id)] = Number(r.sold); });
    // 5) 그룹별 정리
    const out = dupGroups.map((arr) => {
      const sorted = arr.slice().sort((a, c) => String(a.import_date).localeCompare(String(c.import_date)) || a.batch_id - c.batch_id);
      const keep = sorted[0]; const phantoms = sorted.slice(1); // 가장 오래된 배치 보존 제안
      const dupCount = arr.length;
      const batchMeta = (b) => ({ batch_id: b.batch_id, batch_no: b.batch_no, import_date: b.import_date, invoice_nos: [...b.invoices].sort() });
      // 송장/입고일 신호: 모든 배치가 같은 (입고일 + 송장집합)이면 진짜 중복 의심, 다르면 정상 재입고 의심
      const docKey = (b) => b.import_date + '#' + [...b.invoices].sort().join(',');
      const sameDoc = sorted.every((b) => docKey(b) === docKey(keep));
      const products = keep.lines.map((l) => {
        const perBatch = l.qty;
        const phantomQty = perBatch * (dupCount - 1);
        const cur = stockBy[l.product_id] != null ? stockBy[l.product_id] : 0;
        const sold = soldBy[l.product_id] || 0;
        const removableSafe = Math.max(0, Math.min(phantomQty, cur));
        const stuck = Math.max(0, phantomQty - cur);
        return { product_id: l.product_id, code: l.code, name: l.name, per_batch_qty: perBatch, dup_count: dupCount, phantom_qty: phantomQty, current_stock: cur, sold_qty: sold, removable_safe: removableSafe, stuck_phantom: stuck };
      });
      const stuckTotal = products.reduce((s, p) => s + p.stuck_phantom, 0);
      return {
        signature: sig(keep),
        dup_count: dupCount,
        keep_batch: batchMeta(keep),
        phantom_batches: phantoms.map(batchMeta),
        same_doc: sameDoc,          // true=같은 송장/일자(진짜 중복 의심) / false=다른 송장/일자(정상 재입고 의심)
        products,
        all_removable: stuckTotal === 0,
      };
    });
    return { groups: out, product_count: pids.length };
  });

  // =====================================================================
  // 수입 원가 정정(재가) — 디렉터 전용
  //   ① 단가 템플릿(모든 수입 라인) 엑셀 다운로드용 데이터
  //   ② 정정 단가 + 배치별 부대비용(1/n) 미리보기
  //   ③ 적용: 제품 평균원가·라인/재고이동 원가 갱신 + 팔린 분 소급 COGS(이번 달 정산차액)
  // =====================================================================
  // 배치별 적용환율(USD→MXN). 통화가 USD면 fx_rates의 그 일자 환율, MXN이면 1. (일자별 캐시)
  async function ratesForBatches(metaList) {
    const cache = {}; const out = {};
    for (const m of metaList) {
      const cur = (m.currency || 'USD').toUpperCase();
      if (cur !== 'USD') { out[m.batch_id] = { currency: cur, import_date: m.import_date, rate: 1 }; continue; }
      const d = m.import_date || null;
      if (cache[d] == null) cache[d] = await getRateForDate(d);
      out[m.batch_id] = { currency: 'USD', import_date: m.import_date, rate: Number(cache[d]) };
    }
    return out;
  }

  app.get('/api/import-recost/lines', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(
      `SELECT il.batch_id, b.batch_no, to_char(b.import_date,'YYYY-MM-DD') AS import_date, b.currency,
              il.product_id, p.code, p.name, il.qty, il.unit_cost_mxn
         FROM import_lines il
         JOIN import_batches b ON b.id=il.batch_id AND b.deleted_at IS NULL
         JOIN products p ON p.id=il.product_id
        ORDER BY b.import_date, b.id, p.code`)).rows;
    // 배치별 적용환율
    const metaList = [...new Map(rows.map((r) => [Number(r.batch_id), { batch_id: Number(r.batch_id), currency: r.currency, import_date: r.import_date }])).values()];
    const rates = await ratesForBatches(metaList);
    return { lines: rows.map((r) => {
      const bid = Number(r.batch_id); const rt = rates[bid] || { currency: 'USD', rate: 1 };
      return {
        batch_id: bid, batch_no: r.batch_no || ('#' + bid), import_date: r.import_date,
        currency: rt.currency, fx_rate: rt.rate, product_id: Number(r.product_id), code: r.code, name: r.name,
        qty: Number(r.qty), current_unit_cost: Number(r.unit_cost_mxn || 0),
      };
    }) };
  });

  // 정정 입력으로부터 계산 입력 데이터 준비(미리보기/적용 공용). 입력단가는 배치 통화 → MXN 환산.
  async function prepareRecost(c, body) {
    const upl = Array.isArray(body.lines) ? body.lines : [];
    const ovl = Array.isArray(body.overheads) ? body.overheads : [];
    // 업로드 단가(배치 통화 기준, 환산 전)
    const priceRaw = {};
    for (const l of upl) {
      const v = (l.unit_price != null && l.unit_price !== '') ? l.unit_price : l.unit_price_mxn; // 신/구 키 호환
      if (v == null || v === '') continue;
      priceRaw[Number(l.batch_id) + ':' + Number(l.product_id)] = Number(v);
    }
    // 부대비용(배치 통화 또는 명시 통화)
    const ovRaw = {};
    for (const o of ovl) {
      const amt = (o.amount != null && o.amount !== '') ? Number(o.amount) : Number(o.amount_mxn);
      if (!(amt > 0)) continue;
      ovRaw[Number(o.batch_id)] = { amount: amt, currency: o.currency ? String(o.currency).toUpperCase() : null };
    }
    // 영향 제품 = 업로드 라인 제품 ∪ 부대비용 배치의 제품
    const prodSet = new Set(upl.map((l) => Number(l.product_id)));
    const seedBatches = [...new Set([...upl.map((l) => Number(l.batch_id)), ...Object.keys(ovRaw).map(Number)])];
    if (seedBatches.length) {
      const rs = (await c.query(`SELECT DISTINCT product_id FROM import_lines WHERE batch_id = ANY($1)`, [seedBatches])).rows;
      rs.forEach((r) => prodSet.add(Number(r.product_id)));
    }
    const productIds = [...prodSet].filter(Boolean);
    if (!productIds.length) return { empty: true, productLines: {}, batchOverhead: {}, batchTotalQty: {}, productState: {}, soldQty: {}, rates: {} };
    // 영향 제품의 모든 수입 라인(모든 배치) + 배치 통화·일자
    const ilRows = (await c.query(
      `SELECT il.batch_id, il.product_id, il.qty, il.unit_cost_mxn,
              b.currency, to_char(b.import_date,'YYYY-MM-DD') AS import_date
         FROM import_lines il JOIN import_batches b ON b.id=il.batch_id AND b.deleted_at IS NULL
        WHERE il.product_id = ANY($1)`, [productIds])).rows;
    // 배치별 적용환율
    const metaMap = new Map();
    for (const r of ilRows) { const bid = Number(r.batch_id); if (!metaMap.has(bid)) metaMap.set(bid, { batch_id: bid, currency: r.currency, import_date: r.import_date }); }
    const rates = await ratesForBatches([...metaMap.values()]);
    const productLines = {}; const allBatches = new Set();
    for (const r of ilRows) {
      const pid = Number(r.product_id), bid = Number(r.batch_id);
      allBatches.add(bid);
      const k = bid + ':' + pid;
      const rt = (rates[bid] || { rate: 1 }).rate;
      // 업로드 단가(배치 통화) → MXN, 없으면 현재 MXN 원가 유지
      const priceMxn = (k in priceRaw) ? round2(priceRaw[k] * rt) : Number(r.unit_cost_mxn || 0);
      (productLines[pid] = productLines[pid] || []).push({ batch_id: bid, qty: Number(r.qty), unit_price_mxn: priceMxn });
    }
    // 부대비용 → MXN (통화 미지정 시 배치 통화 기준)
    const batchOverhead = {};
    for (const [bidStr, o] of Object.entries(ovRaw)) {
      const bid = Number(bidStr); const meta = rates[bid] || { currency: 'USD', rate: 1 };
      const cur = o.currency || meta.currency || 'USD';
      batchOverhead[bid] = round2(cur === 'USD' ? o.amount * meta.rate : o.amount);
    }
    const btqRows = (await c.query(`SELECT batch_id, COALESCE(SUM(qty),0) AS q FROM import_lines WHERE batch_id = ANY($1) GROUP BY batch_id`, [[...allBatches]])).rows;
    const batchTotalQty = {}; btqRows.forEach((r) => { batchTotalQty[Number(r.batch_id)] = Number(r.q); });
    const pRows = (await c.query(`SELECT id, code, name, stock_qty, avg_cost FROM products WHERE id = ANY($1)`, [productIds])).rows;
    const productState = {}; pRows.forEach((p) => { productState[p.id] = { stock_qty: Number(p.stock_qty), avg_cost: Number(p.avg_cost), code: p.code, name: p.name }; });
    const sRows = (await c.query(
      `SELECT sil.product_id, COALESCE(SUM(sil.qty),0) AS q
         FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id=sil.invoice_id
        WHERE sil.product_id = ANY($1) AND si.status='posted' AND si.deleted_at IS NULL
        GROUP BY sil.product_id`, [productIds])).rows;
    const soldQty = {}; sRows.forEach((r) => { soldQty[Number(r.product_id)] = Number(r.q); });
    return { productLines, batchOverhead, batchTotalQty, productState, soldQty, rates };
  }

  app.post('/api/import-recost/preview', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const data = await prepareRecost(/* read-only */ { query: (q, a) => query(q, a) }, req.body || {});
    if (data.empty) return { items: [], totalStockAddedMxn: 0, totalRetroCogsMxn: 0 };
    const res = computeRecost(data);
    const items = Object.values(res.perProduct).map((p) => ({
      product_id: p.product_id, code: p.code, name: p.name, total_qty: p.totalQty,
      sold_qty: p.soldQty, remaining_qty: p.remainingQty, avg_before: p.avgBefore, new_avg: p.newAvg,
      stock_added_mxn: p.stockAddedMxn, retro_cogs_mxn: p.retroCogsMxn,
    })).sort((a, b) => String(a.code || '').localeCompare(String(b.code || '')));
    const rates = Object.entries(data.rates || {}).filter(([, v]) => (v.currency || 'USD') === 'USD')
      .map(([bid, v]) => ({ batch_id: Number(bid), import_date: v.import_date, rate: v.rate }));
    return { items, totalStockAddedMxn: res.totalStockAddedMxn, totalRetroCogsMxn: res.totalRetroCogsMxn, rates };
  });

  app.post('/api/import-recost/apply', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const data = await prepareRecost(c, req.body || {});
      if (data.empty) return { ok: true, products: 0, adjustments: 0, totalRetroCogsMxn: 0, totalStockAddedMxn: 0 };
      const res = computeRecost(data);
      let nProd = 0, nAdj = 0;
      for (const pid of Object.keys(res.perProduct)) {
        const p = res.perProduct[pid];
        await c.query(`UPDATE products SET avg_cost=$1, updated_by=$2 WHERE id=$3`, [p.newAvg, userId, pid]);
        for (const le of p.lineEff) {
          await c.query(`UPDATE import_lines SET unit_cost_mxn=$1, avg_cost_after=$2, alloc_overhead=$3 WHERE batch_id=$4 AND product_id=$5`,
            [le.eff, p.newAvg, round2(le.perUnitOv * le.qty), le.batch_id, pid]);
          await c.query(`UPDATE stock_movements SET unit_cost_mxn=$1 WHERE batch_id=$2 AND product_id=$3 AND move_type='in'`,
            [le.eff, le.batch_id, pid]);
        }
        nProd++;
        // 팔린 분 → 이번 달 정산차액(소급 COGS). shift 기준이라 재적용 시 0(멱등).
        if (Math.abs(p.shift) > 0.005 && p.soldQty > 0) {
          const sls = (await c.query(
            `SELECT sil.invoice_id, sil.qty, sil.applied_unit_cost, si.inv_date
               FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id=sil.invoice_id
              WHERE sil.product_id=$1 AND si.status='posted' AND si.deleted_at IS NULL`, [pid])).rows;
          for (const s of sls) {
            const diff = round2(Number(s.qty) * p.shift);
            if (Math.abs(diff) < 0.005) continue;
            await c.query(
              `INSERT INTO cogs_adjustments (doc_id, sales_invoice_id, product_id, sale_date, qty, unit_cost_before, unit_cost_after, diff_mxn, kind, source)
               VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,'variance','import_recost')`,
              [s.invoice_id, pid, s.inv_date, Number(s.qty), p.avgBefore, p.newAvg, diff]);
            nAdj++;
          }
        }
      }
      return { ok: true, products: nProd, adjustments: nAdj, totalRetroCogsMxn: res.totalRetroCogsMxn, totalStockAddedMxn: res.totalStockAddedMxn };
    });
    await logEvent({ userId, deviceId: req.ctx.deviceId, action: 'update', target: 'import_recost', detail: { products: out.products, adjustments: out.adjustments, retro: out.totalRetroCogsMxn } });
    return out;
  });

  // 수입 배치 완전 삭제(디렉터) — 남은 재고이동 역산 + 배치 기록 soft-delete(deleted_at).
  //   재고화면 "배치 삭제"는 재고만 역산하고 기록은 남겨, 목록·정정 엑셀에 계속 나옴 → 이걸로 기록까지 제거.
  //   이동이 이미 지워진(재고만 삭제했던) 배치도 기록만 정리 가능.
  app.delete('/api/import-batches/:batchId', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const batchId = Number(req.params.batchId);
    if (!batchId) return reply.code(400).send({ error: 'bad_batch' });
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const b = (await c.query(`SELECT id, batch_no FROM import_batches WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [batchId])).rows[0];
      if (!b) return { error: 'not_found' };
      // 남은 재고이동 역산(있으면) 후 삭제
      const mv = (await c.query(`SELECT product_id, move_type, qty FROM stock_movements WHERE batch_id=$1 FOR UPDATE`, [batchId])).rows;
      for (const r of mv) {
        const p = (await c.query(`SELECT stock_qty FROM products WHERE id=$1 FOR UPDATE`, [r.product_id])).rows[0];
        if (!p) continue;
        const qty = Number(r.qty) || 0;
        const delta = r.move_type === 'in' ? Math.abs(qty) : (r.move_type === 'out' ? -Math.abs(qty) : qty);
        await c.query(`UPDATE products SET stock_qty=$1, updated_by=$2 WHERE id=$3`, [(Number(p.stock_qty) || 0) - delta, userId, r.product_id]);
      }
      if (mv.length) await c.query(`DELETE FROM stock_movements WHERE batch_id=$1`, [batchId]);
      // 배치 기록 soft-delete → 목록·정정 엑셀에서 제외(import_lines 는 비삭제 배치 조인이라 자동 숨김)
      await c.query(`UPDATE import_batches SET deleted_at=now() WHERE id=$1`, [batchId]);
      return { ok: true, batch_no: b.batch_no, movements_reversed: mv.length };
    });
    if (out.error) return reply.code(out.error === 'not_found' ? 404 : 400).send(out);
    await logEvent({ userId, deviceId: req.ctx.deviceId, action: 'delete', target: `import_batch:${batchId}`, detail: { batch_no: out.batch_no, movements_reversed: out.movements_reversed } });
    return out;
  });

  // 삭제된(soft-delete) 배치 목록 — 복원용(디렉터)
  app.get('/api/import-batches/deleted', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(
      `SELECT b.id, b.batch_no, b.import_date, b.deleted_at,
              COUNT(DISTINCT il.product_id)::int AS sku_count, COALESCE(SUM(il.qty),0) AS total_qty
         FROM import_batches b LEFT JOIN import_lines il ON il.batch_id=b.id
        WHERE b.deleted_at IS NOT NULL
        GROUP BY b.id, b.batch_no, b.import_date, b.deleted_at
        ORDER BY b.deleted_at DESC NULLS LAST, b.id DESC`)).rows;
    return { items: rows.map((r) => ({ id: Number(r.id), batch_no: r.batch_no, import_date: r.import_date ? String(r.import_date).slice(0, 10) : '', deleted_at: r.deleted_at, sku_count: Number(r.sku_count), total_qty: Number(r.total_qty) })) };
  });

  // 배치 복원(디렉터) — 안전삭제/전체삭제 되돌리기.
  //   import_lines에서 'in' 이동기록을 재생성하고, 영향 제품의 재고를 이동원장 합계로 재계산 → 삭제 전 값 복원.
  app.post('/api/import-batches/:batchId/restore', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const batchId = Number(req.params.batchId);
    if (!batchId) return reply.code(400).send({ error: 'bad_batch' });
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const b = (await c.query(`SELECT id, batch_no, import_date FROM import_batches WHERE id=$1 AND deleted_at IS NOT NULL FOR UPDATE`, [batchId])).rows[0];
      if (!b) return { error: 'not_deleted' };
      const lines = (await c.query(`SELECT product_id, qty, unit_cost_mxn FROM import_lines WHERE batch_id=$1`, [batchId])).rows;
      if (!lines.length) return { error: 'no_lines' };
      // 이미 이동이 남아있으면 중복 재생성 방지
      const have = Number((await c.query(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE batch_id=$1`, [batchId])).rows[0].n);
      if (!have) {
        const evNo = Number((await c.query(`SELECT COALESCE(MAX(event_no),0)+1 AS ev FROM stock_movements`)).rows[0].ev);
        for (const l of lines) {
          await c.query(
            `INSERT INTO stock_movements (product_id, move_type, qty, unit_cost_mxn, ref, batch_id, event_no, moved_at, created_by)
             VALUES ($1,'in',$2,$3,$4,$5,$6,$7,$8)`,
            [Number(l.product_id), Math.abs(Number(l.qty) || 0), l.unit_cost_mxn, `restore:${batchId}`, batchId, evNo, b.import_date || new Date(), userId]);
        }
      }
      await c.query(`UPDATE import_batches SET deleted_at=NULL WHERE id=$1`, [batchId]);
      // 영향 제품 재고 = 이동원장 합계로 재계산(in − out)
      const pids = [...new Set(lines.map((l) => Number(l.product_id)))];
      const products = [];
      for (const pid of pids) {
        const pr = (await c.query(`SELECT code, name, stock_qty FROM products WHERE id=$1 FOR UPDATE`, [pid])).rows[0];
        if (!pr) continue;
        const before = Number(pr.stock_qty) || 0;
        const sum = Number((await c.query(
          `SELECT COALESCE(SUM(CASE WHEN move_type='in' THEN qty WHEN move_type='out' THEN -qty ELSE qty END),0) AS s
             FROM stock_movements WHERE product_id=$1`, [pid])).rows[0].s);
        await c.query(`UPDATE products SET stock_qty=$1, updated_by=$2 WHERE id=$3`, [sum, userId, pid]);
        products.push({ product_id: pid, code: pr.code, name: pr.name, before, after: sum });
      }
      return { ok: true, batch_no: b.batch_no, restored_movements: have ? 0 : lines.length, products };
    });
    if (out.error) return reply.code(out.error === 'not_deleted' ? 404 : 400).send(out);
    await logEvent({ userId, deviceId: req.ctx.deviceId, action: 'update', target: `import_batch:${batchId}`, detail: { batch_no: out.batch_no, mode: 'restore', products: out.products.length } });
    return out;
  });

  // 수입 배치 안전 삭제(디렉터) — 재고를 0에서 멈추도록만 역산(음수 금지) + 배치 기록 soft-delete.
  //   가짜(중복) 배치 정리용. 이미 팔려나간 분(=현재고를 넘는 배치수량)은 빼지 않고 '잔여'로 보고.
  //   판매/COGS 기록은 건드리지 않음(출고는 배치에 안 묶여 있음).
  app.post('/api/import-batches/:batchId/safe-delete', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const batchId = Number(req.params.batchId);
    if (!batchId) return reply.code(400).send({ error: 'bad_batch' });
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const b = (await c.query(`SELECT id, batch_no FROM import_batches WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [batchId])).rows[0];
      if (!b) return { error: 'not_found' };
      const mv = (await c.query(
        `SELECT sm.product_id, sm.move_type, sm.qty, p.code, p.name
           FROM stock_movements sm JOIN products p ON p.id=sm.product_id
          WHERE sm.batch_id=$1 ORDER BY p.code FOR UPDATE OF sm`, [batchId])).rows;
      const lines = [];
      for (const r of mv) {
        if (r.move_type !== 'in') continue; // 입고만 안전 역산(수입 배치는 'in'만 가짐)
        const pr = (await c.query(`SELECT stock_qty FROM products WHERE id=$1 FOR UPDATE`, [r.product_id])).rows[0];
        if (!pr) continue;
        const Q = Math.abs(Number(r.qty) || 0);
        const S = Number(pr.stock_qty) || 0;
        const removed = Math.max(0, Math.min(Q, S)); // 0에서 멈춤(음수 금지)
        if (removed > 0) await c.query(`UPDATE products SET stock_qty=$1, updated_by=$2 WHERE id=$3`, [S - removed, userId, r.product_id]);
        lines.push({ product_id: Number(r.product_id), code: r.code, name: r.name, batch_qty: Q, removed, remaining: Q - removed });
      }
      if (mv.length) await c.query(`DELETE FROM stock_movements WHERE batch_id=$1`, [batchId]);
      await c.query(`UPDATE import_batches SET deleted_at=now() WHERE id=$1`, [batchId]);
      const removedTotal = lines.reduce((s, l) => s + l.removed, 0);
      const remainingTotal = lines.reduce((s, l) => s + l.remaining, 0);
      const stuckLines = lines.filter((l) => l.remaining > 0);
      return { ok: true, batch_no: b.batch_no, sku_count: lines.length, removed_total: removedTotal, remaining_total: remainingTotal, stuck_lines: stuckLines };
    });
    if (out.error) return reply.code(out.error === 'not_found' ? 404 : 400).send(out);
    await logEvent({ userId, deviceId: req.ctx.deviceId, action: 'delete', target: `import_batch:${batchId}`, detail: { batch_no: out.batch_no, mode: 'safe', removed: out.removed_total, remaining: out.remaining_total } });
    return out;
  });

  app.post('/api/import-costs', { preHandler: [authGuard, requirePage('inventory')] }, async (req, reply) => {
    const { doc_no, cost_date, fx_rate, lines = [], batch_ids = [], note } = req.body || {};
    if (!cost_date || !fx_rate || !lines.length || !batch_ids.length) {
      return reply.code(400).send({ error: 'cost_date_fx_lines_batches_required' });
    }
    const userId = req.ctx.perm.userId;
    const id = await withTx(async (c) => {
      const doc = (await c.query(
        `INSERT INTO import_cost_docs (doc_no, cost_date, fx_rate, status, created_by, note)
         VALUES ($1,$2,$3,'pending',$4,$5) RETURNING id`,
        [doc_no || null, cost_date, fx_rate, userId, note || null])).rows[0];
      for (const l of lines) {
        await c.query(
          `INSERT INTO import_cost_lines (doc_id, label, amount, currency, invoice_no)
           VALUES ($1,$2,$3,$4,$5)`, [doc.id, l.label || '부대비용', l.amount, l.currency || 'USD', l.invoice_no || null]);
      }
      // 분배: 선택된 입고 건들의 총수량 비율로 배분(스냅샷 저장)
      const total = costDocTotalMxn(lines, fx_rate);
      const batches = [];
      for (const bid of batch_ids) batches.push({ batchId: bid, qty: await batchTotalQty(c, bid) });
      const alloc = allocateByQty(total, batches);
      for (const a of alloc) {
        await c.query(
          `INSERT INTO import_cost_allocations (doc_id, batch_id, batch_qty, ratio, alloc_amount_mxn)
           VALUES ($1,$2,$3,$4,$5)`, [doc.id, a.batchId, a.qty, a.ratio, a.allocMxn]);
      }
      return doc.id;
    });
    await logEvent({ userId, deviceId: req.ctx.deviceId, action: 'create', target: `import_cost:${id}` });
    return { id, status: 'pending' };
  });

  // 미리보기(반영 없음) — 디렉터 검토 화면 데이터
  app.get('/api/import-costs/:id/preview', { preHandler: [authGuard, requirePage('inventory')] }, async (req, reply) => {
    const out = await computeDoc({ query: (t, p) => query(t, p) }, Number(req.params.id));
    if (out.error) return reply.code(404).send(out);
    return out;
  });

  // 승인 대기 목록(디렉터)
  app.get('/api/import-costs/pending', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(
      `SELECT d.id, d.doc_no, d.cost_date, d.fx_rate, d.created_at,
              COALESCE(SUM(toMxn.amt),0) AS total_mxn,
              (SELECT COUNT(*) FROM import_cost_allocations a WHERE a.doc_id=d.id) AS batch_count
         FROM import_cost_docs d
         LEFT JOIN LATERAL (
           SELECT CASE WHEN l.currency='MXN' THEN l.amount ELSE l.amount*d.fx_rate END AS amt
             FROM import_cost_lines l WHERE l.doc_id=d.id
         ) toMxn ON true
        WHERE d.status='pending' AND d.deleted_at IS NULL
        GROUP BY d.id ORDER BY d.created_at`)).rows;
    return { items: rows.map((r) => ({ ...r, total_mxn: round2(Number(r.total_mxn)), batch_count: Number(r.batch_count) })) };
  });

  // 디렉터 승인 → 평균원가 반영 + 스냅샷 기록 (트랜잭션)
  app.post('/api/import-costs/:id/approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const doc = (await c.query(`SELECT * FROM import_cost_docs WHERE id=$1`, [id])).rows[0];
      if (!doc || doc.status !== 'pending') return { error: 'not_pending' };

      const computed = await computeDoc(c, id);
      for (const e of computed.effects) {
        // 평균원가 갱신(재고가산분 반영). 판매 모듈 전이므로 전액 재고가산.
        await c.query(
          `UPDATE products SET avg_cost=$1, updated_by=$2 WHERE id=$3`,
          [e.avgAfter, userId, e.productId]);
        // 처리 결과 스냅샷
        await c.query(
          `INSERT INTO import_cost_adjustments
             (doc_id, batch_id, product_id, closed_month, batch_qty, per_unit_mxn,
              sold_qty, remaining_qty, stock_added_mxn, variance_expense_mxn, retro_cogs_mxn,
              avg_cost_before, avg_cost_after)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [id, e.batchId, e.productId, e.closedMonth, e.lineQty, e.perUnit,
           0, e.lineQty, e.stockAddedMxn, e.varianceExpenseMxn, e.retroCogsMxn,
           e.avgBefore, e.avgAfter]);
        // 재고이동 원장에 정산(adjust) 기록(수량 변화 없음, 원가 가산 근거)
        await c.query(
          `INSERT INTO stock_movements (product_id, move_type, qty, unit_cost_mxn, ref, cost_doc_id, created_by)
           VALUES ($1,'adjust',0,$2,$3,$4,$5)`,
          [e.productId, e.perUnit, `cost_doc:${id}`, id, userId]);
      }
      await c.query(
        `UPDATE import_cost_docs SET status='approved', approved_by=$1, approved_at=now() WHERE id=$2`,
        [userId, id]);
      return { ok: true, effects: computed.effects, totalMxn: computed.totalMxn };
    });
    if (out.error) return reply.code(409).send(out);
    await logEvent({ userId, deviceId: req.ctx.deviceId, action: 'update', target: `import_cost:${id}`, detail: { approved: true } });
    return out;
  });

  // 월 마감(디렉터) — 잠금
  app.post('/api/periods/:period/close', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const period = String(req.params.period); // 'YYYY-MM'
    if (!/^\d{4}-\d{2}$/.test(period)) return reply.code(400).send({ error: 'bad_period' });
    await query(
      `INSERT INTO period_closings (period, closed_by) VALUES ($1,$2)
       ON CONFLICT (period) DO NOTHING`, [period, req.ctx.perm.userId]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'period_close', target: period });
    return { ok: true, period };
  });
  app.get('/api/periods/closed', { preHandler: [authGuard, requirePage('inventory')] }, async () => {
    const rows = (await query(`SELECT period, closed_at FROM period_closings ORDER BY period`)).rows;
    return { items: rows };
  });
}
