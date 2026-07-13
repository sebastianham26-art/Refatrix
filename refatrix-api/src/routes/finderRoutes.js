// build fdr-0714a — 경쟁사 제품검색(제품찾기) 백엔드
//   · /api/finder/search   : CTR·SYD·교차참조(BAW/GROB/VASLO/KYB/MOOG/YOKOMITSU…) 아무 코드로 제품 검색
//   · /api/finder/compare  : 코드+수량 목록 → CTR 매칭 일괄 비교(견적 비교용)
//   · 가격: CTR=products.list_price · SYD=products.list_price_syd · 경쟁사=product_xref_codes.list_price
//     (sale_price 권한자에게만 포함 — viofinder와 동일 기준)
//   · VIO: ctr_vio_rank(모델·연식·대수) + product_applications(모델·연식) 보조
import { query, withTx } from '../db.js';
import { authGuard, requirePage } from '../middleware/authGuard.js';
import { fieldVisible } from '../permissions.js';
import { computeQuoteLine, computeQuoteTotals, stockFlag } from '../quotes.js';
import { logEvent } from '../audit.js';

const norm = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const escLike = (s) => s.replace(/([%_\\])/g, '\\$1');

export default async function finderRoutes(app) {
  // pids → 화면 번들(코드·브랜드별 코드/가격·VIO·적용차종)
  async function bundle(pids, canPrice, exec = query) {
    if (!pids.length) return [];
    const prows = (await exec(
      `SELECT id, code, name, app, list_price, list_price_syd
         FROM products WHERE id = ANY($1) AND deleted_at IS NULL`, [pids])).rows;
    if (!prows.length) return [];
    const ids = prows.map((r) => Number(r.id));
    const syd = (await exec(
      `SELECT product_id, syd_code FROM product_syd_codes WHERE product_id = ANY($1) ORDER BY syd_code`, [ids])).rows;
    const xref = (await exec(
      `SELECT product_id, xref_code, brand, list_price
         FROM product_xref_codes WHERE product_id = ANY($1) ORDER BY brand, xref_code`, [ids])).rows;
    const vio = (await exec(
      `SELECT p.id AS product_id, v.vio_model, v.vio_year, v.vio_units
         FROM ctr_vio_rank v JOIN products p ON p.code = v.ctr_code WHERE p.id = ANY($1)`, [ids])).rows;
    const apps = (await exec(
      `SELECT product_id, model, year_from, year_to
         FROM product_applications
        WHERE product_id = ANY($1) AND model IS NOT NULL AND model <> ''
        ORDER BY year_to DESC NULLS LAST`, [ids])).rows;
    // 가용재고(견적화면과 동일식: 현재고 − 타 미결·미만료 견적 예약, 음수면 0) + 백오더(v_backorder)
    const stock = (await exec(
      `SELECT p.id AS product_id, p.stock_qty,
              COALESCE(bo.backorder_qty, 0) AS backorder_qty,
              COALESCE((SELECT SUM(ql.reserved_qty)
                          FROM quote_lines ql JOIN quotes q ON q.id = ql.quote_id
                         WHERE ql.product_id = p.id
                           AND q.status IN ('draft','confirmed')
                           AND (q.reserve_expires_at > now() OR q.packing_printed_at IS NOT NULL)
                           AND q.deleted_at IS NULL), 0) AS reserved
         FROM products p LEFT JOIN v_backorder bo ON bo.product_id = p.id
        WHERE p.id = ANY($1)`, [ids])).rows;

    const by = new Map(prows.map((p) => [Number(p.id), {
      id: Number(p.id), ctr: p.code, name: p.name, app: p.app || '',
      ctr_price: canPrice && p.list_price != null ? Number(p.list_price) : null,
      syd_price: canPrice && p.list_price_syd != null ? Number(p.list_price_syd) : null,
      syd_codes: [], brands: {}, brand_prices: {}, vio: [], avail: null, backorder: 0
    }]));
    for (const st of stock) {
      const b = by.get(Number(st.product_id)); if (!b) continue;
      const phys = st.stock_qty != null ? Number(st.stock_qty) : 0;
      b.avail = Math.max(0, phys - (Number(st.reserved) || 0));
      b.backorder = Number(st.backorder_qty) || 0;
    }
    for (const s of syd) { const b = by.get(Number(s.product_id)); if (b && b.syd_codes.length < 4) b.syd_codes.push(s.syd_code); }
    for (const x of xref) {
      const b = by.get(Number(x.product_id)); if (!b) continue;
      const brand = (x.brand || 'ETC').toUpperCase();
      const root = brand.replace(/[0-9]+$/, '');                 // SYD1→SYD, GROB2→GROB
      if (root === 'SYD') {                                       // 교차참조의 SYD 추가분 → SYD 코드 목록에 합류
        if (b.syd_codes.length < 4 && !b.syd_codes.some((c) => norm(c) === norm(x.xref_code))) b.syd_codes.push(x.xref_code);
      } else {
        (b.brands[root] = b.brands[root] || []);
        if (b.brands[root].length < 4 && !b.brands[root].some((c) => norm(c) === norm(x.xref_code))) b.brands[root].push(x.xref_code);
      }
      if (canPrice && x.list_price != null && b.brand_prices[root] == null) b.brand_prices[root] = Number(x.list_price);
    }
    for (const v of vio) {
      const b = by.get(Number(v.product_id)); if (!b) continue;
      b.vio.push({ model: v.vio_model || '', years: v.vio_year || '', units: v.vio_units != null ? Number(v.vio_units) : null });
    }
    for (const a of apps) {
      const b = by.get(Number(a.product_id)); if (!b || b.vio.length >= 3) continue;
      const years = a.year_from && a.year_to ? `${a.year_from}-${a.year_to}` : (a.year_from ? String(a.year_from) : '');
      if (b.vio.some((x) => x.model === a.model)) continue;
      b.vio.push({ model: a.model, years, units: null });
    }
    if (!canPrice) for (const b of by.values()) { b.brand_prices = {}; }
    return [...by.values()];
  }

  // ── 코드 검색 (부분일치, 정규화) ──
  app.get('/api/finder/search', { preHandler: [authGuard, requirePage('products')] }, async (req) => {
    const { perm } = req.ctx;
    const canPrice = fieldVisible(perm, 'sale_price');
    const nq = norm(req.query.q || '');
    const out = { q: String(req.query.q || ''), items: [], price_included: canPrice };
    if (nq.length < 2) return out;
    const like = '%' + escLike(nq) + '%';
    const pids = (await query(
      `SELECT DISTINCT pid FROM (
         SELECT p.id AS pid FROM products p
          WHERE p.deleted_at IS NULL
            AND regexp_replace(upper(p.code), '[^A-Z0-9]', '', 'g') LIKE $1
         UNION ALL
         SELECT s.product_id FROM product_syd_codes s
          WHERE regexp_replace(upper(s.syd_code), '[^A-Z0-9]', '', 'g') LIKE $1
         UNION ALL
         SELECT x.product_id FROM product_xref_codes x WHERE x.norm_code LIKE $1
       ) t LIMIT 30`, [like])).rows.map((r) => Number(r.pid));
    out.items = await bundle(pids, canPrice);
    out.items.sort((a, b) => a.ctr.localeCompare(b.ctr));
    return out;
  });

  // ── 코드+수량 일괄 비교 (엑셀 업로드) ──
  //  body { items: [ { code, qty } ] } 최대 1000건 · 수량: 쉼표 제거, 빈칸/0 이하 → 1
  app.post('/api/finder/compare', { preHandler: [authGuard, requirePage('products')] }, async (req, reply) => {
    const { perm } = req.ctx;
    const canPrice = fieldVisible(perm, 'sale_price');
    const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 1000) : [];
    if (!items.length) return reply.code(400).send({ error: 'no_items' });
    const clean = items.map((it) => {
      const code = String((it && it.code) || '').trim();
      let qty = 1;
      if (it && it.qty != null && it.qty !== '') {
        const n = Number(String(it.qty).replace(/[,\s]/g, ''));
        if (Number.isFinite(n) && n > 0) qty = n;
      }
      return { code, qty, norm: norm(code) };
    }).filter((it) => it.norm);
    if (!clean.length) return reply.code(400).send({ error: 'no_items' });

    const norms = [...new Set(clean.map((c) => c.norm))];
    const map = new Map();
    const rows = (await query(
      `SELECT norm, pid, pri FROM (
         SELECT regexp_replace(upper(p.code), '[^A-Z0-9]', '', 'g') AS norm, p.id AS pid, 1 AS pri
           FROM products p WHERE p.deleted_at IS NULL
            AND regexp_replace(upper(p.code), '[^A-Z0-9]', '', 'g') = ANY($1)
         UNION ALL
         SELECT regexp_replace(upper(s.syd_code), '[^A-Z0-9]', '', 'g'), s.product_id, 2
           FROM product_syd_codes s JOIN products p ON p.id = s.product_id AND p.deleted_at IS NULL
          WHERE regexp_replace(upper(s.syd_code), '[^A-Z0-9]', '', 'g') = ANY($1)
         UNION ALL
         SELECT x.norm_code, x.product_id, 3
           FROM product_xref_codes x JOIN products p ON p.id = x.product_id AND p.deleted_at IS NULL
          WHERE x.norm_code = ANY($1)
       ) t ORDER BY pri`, [norms])).rows;
    for (const r of rows) if (!map.has(r.norm)) map.set(r.norm, Number(r.pid));

    const pids = [...new Set([...map.values()])];
    const products = await bundle(pids, canPrice);
    const lines = clean.map((c) => ({ code: c.code, qty: c.qty, product_id: map.get(c.norm) || null }));
    return { lines, products, price_included: canPrice, matched: lines.filter((l) => l.product_id).length, unmatched: lines.filter((l) => !l.product_id).length };
  });

  // ═══════════ 제품찾기 전용 견적 (공용 견적리스트와 완전 분리) ═══════════
  //  · 저장·조회는 이 화면 전용 테이블(finder_quotes) — 영업>견적·매출추적에 나타나지 않음
  //  · 재고 예약 없음 · 금액 계산은 공용 견적과 동일 함수 재사용(수치 일치)

  // 고객 목록(간이: id·명·기본할인) — 제품찾기 권한으로 접근 (공용 /api/customers는 customers 권한 필요)
  app.get('/api/finder/customers', { preHandler: [authGuard, requirePage('products')] }, async () => {
    const rows = (await query(
      `SELECT id, name, discount FROM customers WHERE deleted_at IS NULL ORDER BY name`)).rows;
    return { items: rows.map((r) => ({ id: Number(r.id), name: r.name, discount: Number(r.discount) || 0 })) };
  });

  // 계산 공통: items[{product_id, input_code?, qty}] → 계산된 lines + totals
  async function computeFinder(items, discountRate, exec = query) {
    const ivaRate = 16;
    const ids = [...new Set(items.map((it) => Number(it.product_id)).filter(Boolean))];
    const prods = ids.length ? (await exec(
      `SELECT id, code, name, app, list_price FROM products WHERE id = ANY($1) AND deleted_at IS NULL`, [ids])).rows : [];
    const pmap = new Map(prods.map((p) => [Number(p.id), p]));
    const syd = ids.length ? (await exec(
      `SELECT product_id, syd_code FROM product_syd_codes WHERE product_id = ANY($1) ORDER BY syd_code`, [ids])).rows : [];
    const smap = new Map();
    for (const s of syd) { const k = Number(s.product_id); if (!smap.has(k)) smap.set(k, []); if (smap.get(k).length < 4) smap.get(k).push(s.syd_code); }
    const stock = ids.length ? (await exec(
      `SELECT p.id AS product_id, p.stock_qty,
              COALESCE((SELECT SUM(ql.reserved_qty)
                          FROM quote_lines ql JOIN quotes q ON q.id = ql.quote_id
                         WHERE ql.product_id = p.id
                           AND q.status IN ('draft','confirmed')
                           AND (q.reserve_expires_at > now() OR q.packing_printed_at IS NOT NULL)
                           AND q.deleted_at IS NULL), 0) AS reserved
         FROM products p WHERE p.id = ANY($1)`, [ids])).rows : [];
    const amap = new Map(stock.map((r) => [Number(r.product_id),
      Math.max(0, (r.stock_qty != null ? Number(r.stock_qty) : 0) - (Number(r.reserved) || 0))]));
    const lines = []; let lineNo = 0;
    for (const it of items) {
      const p = pmap.get(Number(it.product_id)); if (!p) continue;   // 우리 제품(매칭)만
      lineNo++;
      const qty = Number(String(it.qty == null ? 1 : it.qty).replace(/[,\s]/g, ''));
      const q = (Number.isFinite(qty) && qty > 0) ? qty : 1;
      const avail = amap.has(Number(p.id)) ? amap.get(Number(p.id)) : null;
      const calc = computeQuoteLine({ listPrice: p.list_price, discountRate, qty: q, ivaRate });
      lines.push({ line_no: lineNo, product_id: Number(p.id),
        input_code: it.input_code || null, ctr_code: p.code,
        syd_codes: (smap.get(Number(p.id)) || []).join(' / '),
        product_name: p.name, app_text: p.app || '',
        qty: q, list_price: Number(p.list_price) || 0, discount_rate: discountRate,
        final_price: calc.finalPrice, line_subtotal: calc.lineSubtotal,
        line_iva: calc.lineIva, line_total: calc.lineTotal,
        avail_stock: avail, stock_flag: stockFlag({ matched: true, qty: q, availStock: avail }) });
    }
    const totals = computeQuoteTotals(lines.map((l) => ({ lineSubtotal: l.line_subtotal, lineIva: l.line_iva, lineTotal: l.line_total, qty: l.qty })));
    return { lines, totals, discountRate, ivaRate };
  }

  function finderQuoteParty(b) {
    const discountRate = (b.discount_rate != null && b.discount_rate !== '') ? (Number(b.discount_rate) || 0) : 0;
    const customerId = b.customer_id ? Number(b.customer_id) : null;
    const name = String(b.customer_name || '').trim();
    return { customerId, name, discountRate };
  }

  // 미리계산(엑셀 다운로드용, 저장 안 함)
  app.post('/api/finder/quotes/preview', { preHandler: [authGuard, requirePage('products')] }, async (req, reply) => {
    if (!fieldVisible(req.ctx.perm, 'sale_price')) return reply.code(403).send({ error: 'price_forbidden' });
    const b = req.body || {};
    const { discountRate } = finderQuoteParty(b);
    const items = Array.isArray(b.items) ? b.items.slice(0, 1000) : [];
    if (!items.length) return reply.code(400).send({ error: 'no_items' });
    return computeFinder(items, discountRate);
  });

  // 저장 — 제품찾기 화면 전용 목록에만 (공용 견적리스트 미기록, 재고 예약 없음)
  app.post('/api/finder/quotes', { preHandler: [authGuard, requirePage('products')] }, async (req, reply) => {
    if (!fieldVisible(req.ctx.perm, 'sale_price')) return reply.code(403).send({ error: 'price_forbidden' });
    const b = req.body || {};
    const { customerId, name, discountRate } = finderQuoteParty(b);
    if (!name) return reply.code(400).send({ error: 'customer_name_required' });
    const items = Array.isArray(b.items) ? b.items.slice(0, 1000) : [];
    if (!items.length) return reply.code(400).send({ error: 'no_items' });
    const out = await withTx(async (c) => {
      const exec = c.query.bind(c);
      if (customerId) {
        const cu = (await exec(`SELECT id FROM customers WHERE id = $1 AND deleted_at IS NULL`, [customerId])).rows[0];
        if (!cu) return { error: 'customer_not_found' };
      }
      const calc = await computeFinder(items, discountRate, exec);
      if (!calc.lines.length) return { error: 'no_matched_items' };
      const fq = (await exec(
        `INSERT INTO finder_quotes (customer_id, customer_name, discount_rate, iva_rate, subtotal_mxn, iva_mxn, total_mxn, total_qty, sku_count, memo, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, created_at`,
        [customerId, name, discountRate, calc.ivaRate, calc.totals.subtotal, calc.totals.iva, calc.totals.total,
         calc.totals.totalQty, calc.totals.skuCount, b.memo || null, req.ctx.perm.userId])).rows[0];
      for (const l of calc.lines) {
        await exec(
          `INSERT INTO finder_quote_lines (fq_id, line_no, product_id, input_code, ctr_code, syd_codes, product_name, app_text, qty, list_price, discount_rate, final_price, line_subtotal, line_iva, line_total, avail_stock, stock_flag)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [fq.id, l.line_no, l.product_id, l.input_code, l.ctr_code, l.syd_codes, l.product_name, l.app_text,
           l.qty, l.list_price, l.discount_rate, l.final_price, l.line_subtotal, l.line_iva, l.line_total, l.avail_stock, l.stock_flag]);
      }
      return { id: Number(fq.id), created_at: fq.created_at, ...calc };
    });
    if (out.error) return reply.code(out.error === 'customer_not_found' ? 404 : 400).send(out);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `finder_quote:${out.id}`,
      detail: { customer: name, discount: discountRate, sku: out.totals.skuCount, total: out.totals.total } });
    return out;
  });

  // 저장 목록 (최근 100)
  app.get('/api/finder/quotes', { preHandler: [authGuard, requirePage('products')] }, async (req) => {
    const canPrice = fieldVisible(req.ctx.perm, 'sale_price');
    const rows = (await query(
      `SELECT f.id, f.customer_name, f.discount_rate, f.total_mxn, f.total_qty, f.sku_count, f.created_at, u.name AS by_name
         FROM finder_quotes f LEFT JOIN users u ON u.id = f.created_by
        WHERE f.deleted_at IS NULL ORDER BY f.id DESC LIMIT 100`)).rows;
    return { items: rows.map((r) => ({ id: Number(r.id), customer: r.customer_name,
      discount: Number(r.discount_rate) || 0, total: canPrice ? Number(r.total_mxn) : null,
      qty: Number(r.total_qty) || 0, sku: Number(r.sku_count) || 0, at: r.created_at, by: r.by_name || '' })),
      price_included: canPrice };
  });

  // 상세 (엑셀 재다운로드용)
  app.get('/api/finder/quotes/:id', { preHandler: [authGuard, requirePage('products')] }, async (req, reply) => {
    if (!fieldVisible(req.ctx.perm, 'sale_price')) return reply.code(403).send({ error: 'price_forbidden' });
    const id = Number(req.params.id);
    const h = (await query(
      `SELECT id, customer_name, discount_rate, iva_rate, subtotal_mxn, iva_mxn, total_mxn, total_qty, sku_count, created_at
         FROM finder_quotes WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!h) return reply.code(404).send({ error: 'not_found' });
    const lines = (await query(
      `SELECT line_no, product_id, input_code, ctr_code, syd_codes, product_name, app_text, qty, list_price, discount_rate, final_price, line_subtotal, line_iva, line_total, avail_stock, stock_flag
         FROM finder_quote_lines WHERE fq_id = $1 ORDER BY line_no`, [id])).rows;
    return { id: Number(h.id), customer: h.customer_name, created_at: h.created_at,
      discountRate: Number(h.discount_rate) || 0,
      lines: lines.map((l) => ({ ...l, product_id: Number(l.product_id), qty: Number(l.qty),
        list_price: Number(l.list_price), discount_rate: Number(l.discount_rate), final_price: Number(l.final_price),
        line_subtotal: Number(l.line_subtotal), line_iva: Number(l.line_iva), line_total: Number(l.line_total),
        avail_stock: l.avail_stock == null ? null : Number(l.avail_stock),
        syd_codes: l.syd_codes ? String(l.syd_codes).split(' / ') : [] })),
      totals: { subtotal: Number(h.subtotal_mxn), iva: Number(h.iva_mxn), total: Number(h.total_mxn),
                totalQty: Number(h.total_qty), skuCount: Number(h.sku_count) } };
  });

  // 삭제 (소프트)
  app.delete('/api/finder/quotes/:id', { preHandler: [authGuard, requirePage('products')] }, async (req) => {
    const r = await query(`UPDATE finder_quotes SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [Number(req.params.id)]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `finder_quote:${req.params.id}`, detail: null });
    return { deleted: r.rowCount };
  });
}
