import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { computeQuoteLine, computeQuoteTotals, stockFlag, formatQuoteNo, round2 } from '../quotes.js';

function d10(d) { if (!d) return null; if (d instanceof Date) return d.toISOString().slice(0, 10); return String(d).slice(0, 10); }

export default async function quoteRoutes(app) {
  // ============ 회사 설정 / 로고 ============
  app.get('/api/company', { preHandler: [authGuard] }, async () => {
    const r = (await query(`SELECT emisor, domicilio, homepage, rfc, phone, email, logo_data,
                                   bank_name, bank_account, bank_clabe, bank_holder, whatsapp_qr
                              FROM company_settings WHERE id=1`)).rows[0];
    return r || {};
  });

  app.put('/api/company', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const b = req.body || {};
    await query(
      `UPDATE company_settings SET emisor=$1, domicilio=$2, homepage=$3, rfc=$4, phone=$5, email=$6,
              bank_name=$7, bank_account=$8, bank_clabe=$9, bank_holder=$10, updated_by=$11, updated_at=now() WHERE id=1`,
      [b.emisor || null, b.domicilio || null, b.homepage || null, b.rfc || null, b.phone || null, b.email || null,
       b.bank_name || null, b.bank_account || null, b.bank_clabe || null, b.bank_holder || null, req.ctx.perm.userId]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: 'company_settings' });
    return { ok: true };
  });

  // 이미지 업로드 공통: kind = 'logo' | 'whatsapp'
  async function saveImage(req, reply, col) {
    const data = String(req.body?.image || req.body?.logo_data || '');
    if (!data.startsWith('data:image/')) return reply.code(400).send({ error: 'invalid_image' });
    if (data.length > 1500000) return reply.code(413).send({ error: 'image_too_large', note: '약 1MB 이하 이미지를 사용하세요.' });
    await query(`UPDATE company_settings SET ${col}=$1, updated_by=$2, updated_at=now() WHERE id=1`, [data, req.ctx.perm.userId]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `company_${col}` });
    return { ok: true };
  }

  app.put('/api/company/logo', { preHandler: [authGuard, requireDirector] }, async (req, reply) => saveImage(req, reply, 'logo_data'));
  app.delete('/api/company/logo', { preHandler: [authGuard, requireDirector] }, async (req) => {
    await query(`UPDATE company_settings SET logo_data=NULL, updated_by=$1, updated_at=now() WHERE id=1`, [req.ctx.perm.userId]);
    return { ok: true };
  });
  app.put('/api/company/whatsapp', { preHandler: [authGuard, requireDirector] }, async (req, reply) => saveImage(req, reply, 'whatsapp_qr'));
  app.delete('/api/company/whatsapp', { preHandler: [authGuard, requireDirector] }, async (req) => {
    await query(`UPDATE company_settings SET whatsapp_qr=NULL, updated_by=$1, updated_at=now() WHERE id=1`, [req.ctx.perm.userId]);
    return { ok: true };
  });

  // ============ 코드 해석 (CTR 또는 SYD) ============
  // 입력 코드 하나를 받아 매칭 후보를 반환. CTR 정확매칭 우선, 없으면 SYD 역검색.
  // 반환: { matches: [{product_id, ctr_code, list_price, app, name, syd_codes[]}], source:'ctr'|'syd'|'none' }
  async function resolveCode(code) {
    const c = String(code || '').trim();
    if (!c) return { matches: [], source: 'none' };
    // 1) CTR 정확매칭
    const ctr = (await query(
      `SELECT id, code, name, app, list_price FROM products WHERE deleted_at IS NULL AND code=$1`, [c])).rows;
    let rows = ctr, source = 'ctr';
    if (!rows.length) {
      // 2) SYD 역검색
      rows = (await query(
        `SELECT p.id, p.code, p.name, p.app, p.list_price
           FROM product_syd_codes s JOIN products p ON p.id=s.product_id AND p.deleted_at IS NULL
          WHERE s.syd_code=$1`, [c])).rows;
      source = rows.length ? 'syd' : 'none';
    }
    if (!rows.length) return { matches: [], source: 'none' };
    const ids = rows.map((r) => r.id);
    const sydRows = (await query(`SELECT product_id, syd_code FROM product_syd_codes WHERE product_id = ANY($1)`, [ids])).rows;
    const sydByPid = {};
    for (const s of sydRows) (sydByPid[s.product_id] ||= []).push(s.syd_code);
    return {
      source,
      matches: rows.map((r) => ({
        product_id: r.id, ctr_code: r.code, name: r.name, app: r.app,
        list_price: Number(r.list_price) || 0, syd_codes: sydByPid[r.id] || [],
      })),
    };
  }

  // 단건 코드 조회 (화면에서 SYD 다중매칭 후보 표시용)
  app.get('/api/quotes/resolve-code', { preHandler: [authGuard, requirePage('sales')] }, async (req) => {
    return await resolveCode(req.query.code);
  });

  // 자동완성: CTR 코드 또는 SYD 코드 부분일치 검색 (영업 권한)
  app.get('/api/quotes/search-code', { preHandler: [authGuard, requirePage('sales')] }, async (req) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 1) return { items: [] };
    const like = `%${q}%`;
    // CTR(code/name) 일치 + SYD 일치를 합쳐 제품 id 수집
    const rows = (await query(
      `SELECT DISTINCT p.id, p.code, p.name, p.app, p.list_price
         FROM products p
         LEFT JOIN product_syd_codes s ON s.product_id = p.id
        WHERE p.deleted_at IS NULL
          AND (p.code ILIKE $1 OR p.name ILIKE $1 OR s.syd_code ILIKE $1)
        ORDER BY p.code
        LIMIT 12`, [like])).rows;
    if (!rows.length) return { items: [] };
    const ids = rows.map((r) => r.id);
    const sydRows = (await query(`SELECT product_id, syd_code FROM product_syd_codes WHERE product_id = ANY($1)`, [ids])).rows;
    const sydByPid = {};
    for (const s of sydRows) (sydByPid[s.product_id] ||= []).push(s.syd_code);
    return {
      items: rows.map((r) => ({
        product_id: r.id, ctr_code: r.code, name: r.name, app: r.app,
        list_price: Number(r.list_price) || 0, syd_codes: sydByPid[r.id] || [],
      })),
    };
  });

  // 견적 줄 계산 미리보기 (저장 없이): body { customer_id, lines:[{code, product_id?, qty}] }
  app.post('/api/quotes/preview', { preHandler: [authGuard, requirePage('sales')] }, async (req) => {
    const b = req.body || {};
    let discountRate = 0;
    if (b.customer_id) {
      const cust = (await query(`SELECT discount FROM customers WHERE id=$1 AND deleted_at IS NULL`, [Number(b.customer_id)])).rows[0];
      discountRate = cust ? Number(cust.discount) || 0 : 0;
    } else if (b.discount_rate != null && b.discount_rate !== '') {
      discountRate = Number(b.discount_rate) || 0;   // 불특정 고객: 수동 할인율
    }
    const ivaRate = 16;
    const out = [];
    for (const ln of (Array.isArray(b.lines) ? b.lines : [])) {
      const qty = Number(ln.qty) || 0;
      let prod = null;
      if (ln.product_id) {
        const r = (await query(`SELECT id, code, name, app, list_price, stock_qty FROM products WHERE id=$1 AND deleted_at IS NULL`, [Number(ln.product_id)])).rows[0];
        if (r) prod = r;
      } else {
        const res = await resolveCode(ln.code);
        if (res.matches.length === 1) {
          const m = res.matches[0];
          const r = (await query(`SELECT id, code, name, app, list_price, stock_qty FROM products WHERE id=$1`, [m.product_id])).rows[0];
          prod = r;
        } else if (res.matches.length > 1) {
          out.push({ input_code: ln.code, qty, ambiguous: true, candidates: res.matches });
          continue;
        }
      }
      if (!prod) { out.push({ input_code: ln.code, qty, stock_flag: 'not_found', matched: false }); continue; }
      const sydRows = (await query(`SELECT syd_code FROM product_syd_codes WHERE product_id=$1`, [prod.id])).rows.map((x) => x.syd_code);
      const calc = computeQuoteLine({ listPrice: prod.list_price, discountRate, qty, ivaRate });
      const avail = prod.stock_qty != null ? Number(prod.stock_qty) : null;
      out.push({
        input_code: ln.code || prod.code, matched: true, product_id: prod.id, ctr_code: prod.code,
        syd_codes: sydRows, product_name: prod.name, app_text: prod.app, qty,
        list_price: round2(prod.list_price), discount_rate: discountRate,
        final_price: calc.finalPrice, line_subtotal: calc.lineSubtotal, line_iva: calc.lineIva, line_total: calc.lineTotal,
        avail_stock: avail, stock_flag: stockFlag({ matched: true, qty, availStock: avail }),
      });
    }
    const totals = computeQuoteTotals(out.filter((l) => l.matched).map((l) => ({ lineSubtotal: l.line_subtotal, lineIva: l.line_iva, lineTotal: l.line_total, qty: l.qty })));
    return { discountRate, ivaRate, lines: out, totals };
  });

  // ============ 견적 저장/수정 ============
  async function nextQuoteNo(c, year) {
    const r = (await c.query(`SELECT COUNT(*)::int AS n FROM quotes WHERE quote_no LIKE $1`, [`Q-${year}-%`])).rows[0];
    return formatQuoteNo(year, (r.n || 0) + 1);
  }

  // 라인 입력 → 계산 후 저장용 행 생성
  async function buildLines(customerDiscount, ivaRate, inputLines) {
    const rows = [];
    let lineNo = 0;
    for (const ln of inputLines) {
      lineNo++;
      const qty = Number(ln.qty) || 0;
      let prod = null;
      if (ln.product_id) prod = (await query(`SELECT id, code, name, app, list_price, stock_qty FROM products WHERE id=$1 AND deleted_at IS NULL`, [Number(ln.product_id)])).rows[0] || null;
      else {
        const res = await resolveCode(ln.code);
        if (res.matches.length === 1) prod = (await query(`SELECT id, code, name, app, list_price, stock_qty FROM products WHERE id=$1`, [res.matches[0].product_id])).rows[0];
        // 다중매칭은 저장 단계에서 product_id가 와야 함(화면에서 선택). 여기선 미매칭 처리.
      }
      if (!prod) {
        rows.push({ line_no: lineNo, product_id: null, input_code: ln.code || null, ctr_code: null, syd_codes: null, product_name: null, app_text: null, qty, list_price: 0, discount_rate: customerDiscount, final_price: 0, line_subtotal: 0, line_iva: 0, line_total: 0, avail_stock: null, stock_flag: 'not_found' });
        continue;
      }
      const sydRows = (await query(`SELECT syd_code FROM product_syd_codes WHERE product_id=$1`, [prod.id])).rows.map((x) => x.syd_code);
      const calc = computeQuoteLine({ listPrice: prod.list_price, discountRate: customerDiscount, qty, ivaRate });
      const avail = prod.stock_qty != null ? Number(prod.stock_qty) : null;
      rows.push({
        line_no: lineNo, product_id: prod.id, input_code: ln.code || prod.code, ctr_code: prod.code,
        syd_codes: sydRows.join(' / '), product_name: prod.name, app_text: prod.app, qty,
        list_price: round2(prod.list_price), discount_rate: customerDiscount,
        final_price: calc.finalPrice, line_subtotal: calc.lineSubtotal, line_iva: calc.lineIva, line_total: calc.lineTotal,
        avail_stock: avail, stock_flag: stockFlag({ matched: true, qty, availStock: avail }),
      });
    }
    return rows;
  }

  app.post('/api/quotes', { preHandler: [authGuard, requirePage('sales')] }, async (req, reply) => {
    const b = req.body || {};
    const isGuest = !b.customer_id && (b.guest_name || b.guest === true || b.discount_rate != null);
    let customerId = null, guestName = null, discountRate = 0;
    if (isGuest) {
      guestName = String(b.guest_name || '').trim();
      if (!guestName) return reply.code(400).send({ error: 'guest_name_required' });
      if (b.discount_rate == null || b.discount_rate === '') return reply.code(400).send({ error: 'discount_required' });
      discountRate = Number(b.discount_rate) || 0;
    } else {
      customerId = Number(b.customer_id);
      if (!customerId) return reply.code(400).send({ error: 'customer_required' });
      const cust = (await query(`SELECT discount FROM customers WHERE id=$1 AND deleted_at IS NULL`, [customerId])).rows[0];
      if (!cust) return reply.code(404).send({ error: 'customer_not_found' });
      discountRate = Number(cust.discount) || 0;
    }
    const ivaRate = 16;
    const result = await withTx(async (c) => {
      const year = (b.quote_date ? String(b.quote_date).slice(0, 4) : String(new Date().getFullYear()));
      const quoteNo = await nextQuoteNo(c, year);
      const lines = await buildLines(discountRate, ivaRate, Array.isArray(b.lines) ? b.lines : []);
      const totals = computeQuoteTotals(lines.filter((l) => l.product_id).map((l) => ({ lineSubtotal: l.line_subtotal, lineIva: l.line_iva, lineTotal: l.line_total, qty: l.qty })));
      const q = (await c.query(
        `INSERT INTO quotes (quote_no, customer_id, guest_name, quote_date, discount_rate, iva_rate, memo, status, subtotal_mxn, iva_mxn, total_mxn, total_qty, sku_count, created_by)
         VALUES ($1,$2,$3,COALESCE($4,CURRENT_DATE),$5,$6,$7,'draft',$8,$9,$10,$11,$12,$13) RETURNING id, quote_no`,
        [quoteNo, customerId, guestName, b.quote_date || null, discountRate, ivaRate, b.memo || null, totals.subtotal, totals.iva, totals.total, totals.totalQty, totals.skuCount, req.ctx.perm.userId])).rows[0];
      for (const l of lines) {
        await c.query(
          `INSERT INTO quote_lines (quote_id, line_no, product_id, input_code, ctr_code, syd_codes, product_name, app_text, qty, list_price, discount_rate, final_price, line_subtotal, line_iva, line_total, avail_stock, stock_flag)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [q.id, l.line_no, l.product_id, l.input_code, l.ctr_code, l.syd_codes, l.product_name, l.app_text, l.qty, l.list_price, l.discount_rate, l.final_price, l.line_subtotal, l.line_iva, l.line_total, l.avail_stock, l.stock_flag]);
      }
      return q;
    });
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `quote:${result.id}` });
    return { id: result.id, quote_no: result.quote_no };
  });

  // 견적 수정(draft/confirmed만) — 라인 전체 교체
  app.put('/api/quotes/:id', { preHandler: [authGuard, requirePage('sales')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const q = (await query(`SELECT status, customer_id FROM quotes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    if (q.status === 'converted') return reply.code(409).send({ error: 'already_converted' });
    const customerId = Number(b.customer_id) || q.customer_id;
    const cust = (await query(`SELECT discount FROM customers WHERE id=$1`, [customerId])).rows[0];
    const discountRate = cust ? Number(cust.discount) || 0 : 0;
    const ivaRate = 16;
    await withTx(async (c) => {
      const lines = await buildLines(discountRate, ivaRate, Array.isArray(b.lines) ? b.lines : []);
      const totals = computeQuoteTotals(lines.filter((l) => l.product_id).map((l) => ({ lineSubtotal: l.line_subtotal, lineIva: l.line_iva, lineTotal: l.line_total, qty: l.qty })));
      await c.query(`UPDATE quotes SET customer_id=$1, discount_rate=$2, memo=$3, subtotal_mxn=$4, iva_mxn=$5, total_mxn=$6, total_qty=$7, sku_count=$8, updated_by=$9, updated_at=now() WHERE id=$10`,
        [customerId, discountRate, b.memo || null, totals.subtotal, totals.iva, totals.total, totals.totalQty, totals.skuCount, req.ctx.perm.userId, id]);
      await c.query(`DELETE FROM quote_lines WHERE quote_id=$1`, [id]);
      for (const l of lines) {
        await c.query(
          `INSERT INTO quote_lines (quote_id, line_no, product_id, input_code, ctr_code, syd_codes, product_name, app_text, qty, list_price, discount_rate, final_price, line_subtotal, line_iva, line_total, avail_stock, stock_flag)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [id, l.line_no, l.product_id, l.input_code, l.ctr_code, l.syd_codes, l.product_name, l.app_text, l.qty, l.list_price, l.discount_rate, l.final_price, l.line_subtotal, l.line_iva, l.line_total, l.avail_stock, l.stock_flag]);
      }
    });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `quote:${id}` });
    return { ok: true };
  });

  // 견적 상태 변경: confirmed / cancelled / draft
  app.post('/api/quotes/:id/status', { preHandler: [authGuard, requirePage('sales')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const st = String(req.body?.status || '');
    if (!['draft', 'confirmed', 'cancelled'].includes(st)) return reply.code(400).send({ error: 'bad_status' });
    const q = (await query(`SELECT status FROM quotes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    if (q.status === 'converted') return reply.code(409).send({ error: 'already_converted' });
    await query(`UPDATE quotes SET status=$1, updated_by=$2, updated_at=now() WHERE id=$3`, [st, req.ctx.perm.userId, id]);
    return { ok: true, status: st };
  });

  // ============ 목록 / 상세 ============
  app.get('/api/quotes', { preHandler: [authGuard, requirePage('sales')] }, async (req) => {
    const from = String(req.query.from || ''); const to = String(req.query.to || '');
    const status = String(req.query.status || '');
    const conds = [`q.deleted_at IS NULL`]; const args = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { args.push(from); conds.push(`q.quote_date >= $${args.length}`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { args.push(to); conds.push(`q.quote_date <= $${args.length}`); }
    if (['draft', 'confirmed', 'converted', 'cancelled'].includes(status)) { args.push(status); conds.push(`q.status=$${args.length}`); }
    if (req.query.open === '1') conds.push(`q.status IN ('draft','confirmed')`);          // 견적후 미결
    if (req.query.guest === '1') conds.push(`q.customer_id IS NULL AND q.status IN ('draft','confirmed')`); // 불특정·미등록
    const rows = (await query(
      `SELECT q.id, q.quote_no, q.quote_date, q.status, q.subtotal_mxn, q.iva_mxn, q.total_mxn, q.total_qty, q.sku_count,
              q.invoice_id, q.guest_name, q.customer_id,
              c.name AS customer_name,
              i.inv_date AS sale_date, i.sat_no AS sale_sat_no
         FROM quotes q
         LEFT JOIN customers c ON c.id=q.customer_id
         LEFT JOIN sales_invoices i ON i.id=q.invoice_id
        WHERE ${conds.join(' AND ')}
        ORDER BY q.quote_date DESC, q.id DESC`, args)).rows;
    return {
      items: rows.map((r) => ({
        id: r.id, quote_no: r.quote_no, quote_date: d10(r.quote_date), status: r.status,
        total_mxn: Number(r.total_mxn), total_qty: Number(r.total_qty), sku_count: r.sku_count,
        invoice_id: r.invoice_id, sale_date: r.sale_date ? d10(r.sale_date) : null, sale_sat_no: r.sale_sat_no || null,
        is_guest: r.customer_id == null,
        party_name: r.customer_id == null ? (r.guest_name || '불특정 고객') : r.customer_name,
        open: ['draft', 'confirmed'].includes(r.status),
      })),
    };
  });

  // 미결/불특정 카운트 (배지용)
  app.get('/api/quotes/open-count', { preHandler: [authGuard, requirePage('sales')] }, async () => {
    const r = (await query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('draft','confirmed'))::int AS open,
         COUNT(*) FILTER (WHERE status IN ('draft','confirmed') AND customer_id IS NULL)::int AS guest_pending
       FROM quotes WHERE deleted_at IS NULL`)).rows[0];
    return { open: r.open || 0, guest_pending: r.guest_pending || 0 };
  });

  app.get('/api/quotes/:id', { preHandler: [authGuard, requirePage('sales')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const q = (await query(
      `SELECT q.*, c.name AS customer_name, c.rfc AS customer_rfc, c.phone AS customer_phone
         FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id WHERE q.id=$1 AND q.deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    q.is_guest = q.customer_id == null;
    q.party_name = q.customer_id == null ? (q.guest_name || '불특정 고객') : q.customer_name;
    const lines = (await query(`SELECT * FROM quote_lines WHERE quote_id=$1 ORDER BY line_no, id`, [id])).rows;
    return {
      quote: {
        ...q, quote_date: d10(q.quote_date),
        subtotal_mxn: Number(q.subtotal_mxn), iva_mxn: Number(q.iva_mxn), total_mxn: Number(q.total_mxn), total_qty: Number(q.total_qty),
      },
      lines: lines.map((l) => ({
        ...l, qty: Number(l.qty), list_price: Number(l.list_price), discount_rate: Number(l.discount_rate),
        final_price: Number(l.final_price), line_subtotal: Number(l.line_subtotal), line_iva: Number(l.line_iva), line_total: Number(l.line_total),
        avail_stock: l.avail_stock != null ? Number(l.avail_stock) : null,
      })),
    };
  });

  app.delete('/api/quotes/:id', { preHandler: [authGuard, requirePage('sales')] }, async (req) => {
    await query(`UPDATE quotes SET deleted_at=now() WHERE id=$1`, [Number(req.params.id)]);
    return { ok: true };
  });

  // ============ 고객-SKU 구매 실적 (최근 3년, 수량 기준) ============
  // GET /api/quotes/customer-sku-history?customer_id=&product_id=
  // 반환: years[{year, qty, pct}], total3y, totalPct(전체 누적 비중)
  app.get('/api/quotes/customer-sku-history', { preHandler: [authGuard, requirePage('sales')] }, async (req) => {
    const customerId = Number(req.query.customer_id);
    const productId = Number(req.query.product_id);
    if (!customerId || !productId) return { years: [], total3y: 0, totalPct: null };
    const curYear = new Date().getFullYear();
    const y0 = curYear - 2; // 최근 3년: y0 .. curYear

    // 이 고객의 연도별 SKU 구매 수량(최근 3년)
    const skuByYear = (await query(
      `SELECT EXTRACT(YEAR FROM i.inv_date)::int AS yr, COALESCE(SUM(l.qty),0) AS q
         FROM sales_invoices i JOIN sales_invoice_lines l ON l.invoice_id=i.id
        WHERE i.customer_id=$1 AND l.product_id=$2 AND i.status='posted'
          AND EXTRACT(YEAR FROM i.inv_date) >= $3
        GROUP BY yr`, [customerId, productId, y0])).rows;
    const skuMap = {}; for (const r of skuByYear) skuMap[r.yr] = Number(r.q);

    // 이 고객의 연도별 전체 구매 수량(최근 3년) — 비중 분모
    const allByYear = (await query(
      `SELECT EXTRACT(YEAR FROM i.inv_date)::int AS yr, COALESCE(SUM(l.qty),0) AS q
         FROM sales_invoices i JOIN sales_invoice_lines l ON l.invoice_id=i.id
        WHERE i.customer_id=$1 AND i.status='posted'
          AND EXTRACT(YEAR FROM i.inv_date) >= $2
        GROUP BY yr`, [customerId, y0])).rows;
    const allMap = {}; for (const r of allByYear) allMap[r.yr] = Number(r.q);

    const years = [];
    let sku3y = 0, all3y = 0;
    for (let y = y0; y <= curYear; y++) {
      const q = skuMap[y] || 0; const tot = allMap[y] || 0;
      sku3y += q; all3y += tot;
      years.push({ year: y, qty: round2(q), pct: tot > 0 ? round2(q / tot * 100) : null });
    }
    return {
      years,
      total3y: round2(sku3y),
      totalAll3y: round2(all3y),
      totalPct: all3y > 0 ? round2(sku3y / all3y * 100) : null,
    };
  });
  // 견적 전환 미리보기: 3갈래 분류 (즉시매출 / 부족(발주) / 미등록(개발요청))
  app.get('/api/quotes/:id/convert-preview', { preHandler: [authGuard, requirePage('sales')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const q = (await query(`SELECT * FROM quotes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    const lines = (await query(`SELECT * FROM quote_lines WHERE quote_id=$1 ORDER BY line_no, id`, [id])).rows;
    const inStock = [], shortage = [], newDev = [];
    for (const l of lines) {
      const qty = Number(l.qty) || 0;
      if (!l.product_id) { newDev.push({ input_code: l.input_code, qty }); continue; }
      const p = (await query(`SELECT stock_qty FROM products WHERE id=$1`, [l.product_id])).rows[0];
      const avail = p && p.stock_qty != null ? Number(p.stock_qty) : 0;
      if (avail >= qty) inStock.push({ ctr_code: l.ctr_code, product_name: l.product_name, qty, avail });
      else {
        shortage.push({ ctr_code: l.ctr_code, product_name: l.product_name, qty, avail, fulfill: Math.max(avail, 0), short: qty - Math.max(avail, 0) });
      }
    }
    return {
      is_guest: q.customer_id == null,
      already: q.status === 'converted',
      counts: { in_stock: inStock.length, shortage: shortage.length, new_dev: newDev.length },
      in_stock: inStock, shortage, new_dev: newDev,
    };
  });

  // ============ 전체 SKU 가격표 (엑셀 다운로드용) ============
  app.get('/api/quotes/price-list', { preHandler: [authGuard, requirePage('sales')] }, async (req) => {
    let discountRate = null;
    if (req.query.customer_id) {
      const c = (await query(`SELECT discount FROM customers WHERE id=$1 AND deleted_at IS NULL`, [Number(req.query.customer_id)])).rows[0];
      if (c) discountRate = Number(c.discount) || 0;
    }
    const prods = (await query(
      `SELECT id, code, scode, app, list_price, stock_qty
         FROM products WHERE deleted_at IS NULL ORDER BY code`)).rows;
    const ids = prods.map((p) => p.id);
    const sydRows = ids.length ? (await query(`SELECT product_id, syd_code FROM product_syd_codes WHERE product_id = ANY($1)`, [ids])).rows : [];
    const sydByPid = {};
    for (const s of sydRows) (sydByPid[s.product_id] ||= []).push(s.syd_code);
    const items = prods.map((p) => ({
      ctr_code: p.code,
      syd_codes: p.scode || (sydByPid[p.id] || []).join(' / '),
      app: p.app || '',
      list_price: Number(p.list_price) || 0,
      stock_qty: p.stock_qty != null ? Number(p.stock_qty) : null,
    }));
    return { discountRate, count: items.length, items };
  });

  // 확정된 견적을 매출 인보이스로 전환. 매칭 안 된 줄(not_found)은 제외.
  app.post('/api/quotes/:id/convert', { preHandler: [authGuard, requirePage('sales')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const q = (await query(`SELECT * FROM quotes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    if (q.status === 'converted') return reply.code(409).send({ error: 'already_converted', invoice_id: q.invoice_id });
    // 불특정 고객 견적은 고객을 지정해야 전환 가능 (고객등록 유도)
    let customerId = q.customer_id;
    if (customerId == null) {
      customerId = Number(req.body?.customer_id) || null;
      if (!customerId) return reply.code(409).send({ error: 'guest_needs_customer', note: '불특정 고객 견적입니다. 고객을 먼저 등록·지정한 뒤 전환하세요.' });
      const cu = (await query(`SELECT id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [customerId])).rows[0];
      if (!cu) return reply.code(404).send({ error: 'customer_not_found' });
    }
    // 매칭된 줄(케이스 1·2) + 미매칭 줄(케이스 3) 분리
    const matched = (await query(`SELECT product_id, qty FROM quote_lines WHERE quote_id=$1 AND product_id IS NOT NULL`, [id])).rows;
    const unmatched = (await query(`SELECT input_code, qty FROM quote_lines WHERE quote_id=$1 AND product_id IS NULL`, [id])).rows;
    if (!matched.length && !unmatched.length) return reply.code(400).send({ error: 'no_valid_lines' });

    let invoiceId = null, sale = null;
    const invDate = req.body?.inv_date || d10(new Date());
    if (matched.length) {
      // allow_partial: 재고 있는 만큼 매출 + 부족분은 stock_shortages 자동 기록(케이스 2)
      const payload = {
        customer_id: customerId, inv_date: invDate, allow_partial: true,
        lines: matched.map((l) => ({ product_id: l.product_id, qty: Number(l.qty) })),
        memo: `견적 ${q.quote_no} 전환`,
      };
      const res = await app.inject({
        method: 'POST', url: '/api/sales',
        headers: { authorization: req.headers.authorization, 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
      if (res.statusCode !== 200) return reply.code(res.statusCode).send({ error: 'sale_failed', detail: res.json() });
      sale = res.json();
      invoiceId = sale.id || (sale.invoice && sale.invoice.id);
    }
    // 케이스 3: 미등록 코드 → 제품개발요청 생성
    const devIds = [];
    for (const u of unmatched) {
      const r = (await query(
        `INSERT INTO product_dev_requests (input_code, customer_id, requested_qty, requested_at, source_quote_id, status, created_by)
         VALUES ($1,$2,$3,$4,$5,'received',$6) RETURNING id`,
        [u.input_code || null, customerId, Number(u.qty) || null, invDate, id, req.ctx.perm.userId])).rows[0];
      devIds.push(r.id);
    }
    await query(`UPDATE quotes SET status='converted', invoice_id=$1, customer_id=$2, updated_by=$3, updated_at=now() WHERE id=$4`, [invoiceId || null, customerId, req.ctx.perm.userId, id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `quote:${id}`, detail: { converted_to_invoice: invoiceId, dev_requests: devIds.length } });
    return {
      ok: true, invoice_id: invoiceId,
      invoiced: sale ? (sale.invoiced !== false) : false,
      shortages: (sale && sale.shortages) || [],
      dev_requests: devIds.length,
      sale,
    };
  });
}
