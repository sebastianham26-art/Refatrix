import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector, requirePageAny, requirePageEditAny } from '../middleware/authGuard.js';
import { teamArr } from '../teams.js';
import { logEvent } from '../audit.js';
import { computeQuoteLine, computeQuoteTotals, stockFlag, formatQuoteNo, round2 } from '../quotes.js';
import { notifyProductMarketing } from './devRequestRoutes.js';
import { autoStage } from '../stageAuto.js';
import { findOrCreateCustomerByName } from '../customerAuto.js';

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
  app.get('/api/quotes/resolve-code', { preHandler: [authGuard, requirePageAny(['quote','sales'])] }, async (req) => {
    return await resolveCode(req.query.code);
  });

  // 자동완성: CTR 코드 또는 SYD 코드 부분일치 검색 (영업 권한)
  app.get('/api/quotes/search-code', { preHandler: [authGuard, requirePageAny(['quote','sales'])] }, async (req) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 1) return { items: [] };
    const like = `%${q}%`;
    // 소재 필터: material=aluminio 이면 알루미늄 제품만 검색 결과에 노출(견적 화면 「알루미늄만」 체크).
    const materialFilter = String(req.query.material || '').trim().toLowerCase();
    const params = [like];
    let matSql = '';
    if (materialFilter) {
      params.push(materialFilter === 'aluminio' || materialFilter.includes('alumin') ? 'aluminio' : materialFilter);
      matSql = ` AND p.material = $${params.length}`;
    }
    // CTR(code/name) 일치 + SYD 일치를 합쳐 제품 id 수집
    const rows = (await query(
      `SELECT DISTINCT p.id, p.code, p.name, p.app, p.list_price
         FROM products p
         LEFT JOIN product_syd_codes s ON s.product_id = p.id
        WHERE p.deleted_at IS NULL
          AND (p.code ILIKE $1 OR p.name ILIKE $1 OR s.syd_code ILIKE $1)${matSql}
        ORDER BY p.code
        LIMIT 12`, params)).rows;
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
  app.post('/api/quotes/preview', { preHandler: [authGuard, requirePageEditAny(['quote','sales'])] }, async (req) => {
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

  // ============ 재고 예약(블럭) · 만료(무효화) 공통 ============
  // 가용재고 = 현재고 − 타 미결·미만료 견적의 reserved_qty 합. 물리 stock_qty는 예약으로 안 건드림.
  // 한 견적의 매칭 라인들을 제품별로 묶어 생성순(line_no)으로 선착순 greedy 배분한다.
  //  · 같은 트랜잭션(c) 안에서 product 행을 FOR UPDATE 로 잠가, 동시 저장이 같은 재고를 중복 예약하지 못하게 직렬화.
  //  · '타 견적' 합은 이미 커밋된 reserved_qty 만 보이므로(잠금 대기 후 읽음) 선착순이 보장된다.
  async function assignReservations(c, quoteId) {
    const lines = (await c.query(
      `SELECT id, product_id, qty FROM quote_lines
        WHERE quote_id=$1 AND product_id IS NOT NULL ORDER BY product_id, line_no, id`, [quoteId])).rows;
    const byProd = {};
    for (const l of lines) { (byProd[Number(l.product_id)] ||= []).push(l); }
    for (const pid of Object.keys(byProd)) {
      const p = (await c.query(`SELECT stock_qty FROM products WHERE id=$1 FOR UPDATE`, [Number(pid)])).rows[0];
      const physical = p && p.stock_qty != null ? Number(p.stock_qty) : 0;
      const other = (await c.query(
        `SELECT COALESCE(SUM(ql.reserved_qty),0) AS s
           FROM quote_lines ql JOIN quotes q ON q.id=ql.quote_id
          WHERE ql.product_id=$1 AND q.id<>$2 AND q.status IN ('draft','confirmed')
            AND q.reserve_expires_at > now() AND q.deleted_at IS NULL`, [Number(pid), quoteId])).rows[0];
      let remaining = Math.max(0, physical - (Number(other.s) || 0));
      for (const l of byProd[pid]) {
        const want = Number(l.qty) || 0;
        const give = Math.max(0, Math.min(want, remaining));
        remaining -= give;
        await c.query(`UPDATE quote_lines SET reserved_qty=$1 WHERE id=$2`, [give, l.id]);
      }
    }
  }

  // 만료 처리: 24h 지난 미결견적을 'expired'로 무효화 + 부족/개발 demand 백로그 적재.
  //  · 정확히 1회: status 플립을 RETURNING 으로 선점한 트랜잭션만 백로그를 쓴다(스위퍼 중복 무해).
  //  · 가용재고 정합성은 쿼리시 reserve_expires_at>now() 필터로 이미 보장됨(여긴 회색화+백로그만).
  async function finalizeExpiredQuotes() {
    const due = (await query(
      `SELECT id FROM quotes
        WHERE status IN ('draft','confirmed') AND reserve_expires_at IS NOT NULL
          AND reserve_expires_at <= now() AND deleted_at IS NULL
        ORDER BY id LIMIT 200`)).rows;
    for (const row of due) {
      const id = row.id;
      try {
        await withTx(async (c) => {
          const won = (await c.query(
            `UPDATE quotes SET status='expired', updated_at=now()
              WHERE id=$1 AND status IN ('draft','confirmed') RETURNING id, quote_no, customer_id`, [id])).rows[0];
          if (!won) return;                       // 다른 틱이 이미 처리 — 백로그 중복 방지
          const today = d10(new Date());
          // 매칭 라인: 현재고로 못 채우는 부족분만 stock_shortages 에 적재(즉시분은 재고 복귀 → 미적재)
          const mlines = (await c.query(
            `SELECT ql.product_id, ql.qty, ql.final_price, p.stock_qty
               FROM quote_lines ql JOIN products p ON p.id=ql.product_id
              WHERE ql.quote_id=$1 AND ql.product_id IS NOT NULL`, [id])).rows;
          for (const l of mlines) {
            const qty = Number(l.qty) || 0;
            const physical = l.stock_qty != null ? Number(l.stock_qty) : 0;
            const short = Math.max(0, qty - Math.max(physical, 0));
            if (short <= 0) continue;
            const shAmount = round2(Number(l.final_price || 0) * short * 1.16);
            await c.query(
              `INSERT INTO stock_shortages
                 (product_id, customer_id, sales_invoice_id, requested_qty, fulfilled_qty, shortage_qty,
                  shortage_amount_mxn, occurred_at, source_quote_id, note, created_by)
               VALUES ($1,$2,NULL,$3,0,$4,$5,$6,$7,$8,$9)`,
              [l.product_id, won.customer_id, qty, short, shAmount, today, id,
               `견적 ${won.quote_no} 만료(미확정) — 부족 수요신호`, won.created_by || null]);
          }
          // 미매칭 라인: 제품개발요청 적재(전환 로직과 동일 — source_quote_id+input_code 중복가드 + 담당 알림)
          const ulines = (await c.query(
            `SELECT input_code, qty FROM quote_lines WHERE quote_id=$1 AND product_id IS NULL`, [id])).rows;
          const custName = won.customer_id
            ? ((await c.query(`SELECT name FROM customers WHERE id=$1`, [won.customer_id])).rows[0]?.name || '')
            : '';
          for (const u of ulines) {
            const dup = (await c.query(
              `SELECT 1 FROM product_dev_requests
                WHERE source_quote_id=$1 AND input_code IS NOT DISTINCT FROM $2 AND deleted_at IS NULL`,
              [id, u.input_code || null])).rows[0];
            if (dup) continue;
            await c.query(
              `INSERT INTO product_dev_requests
                 (input_code, customer_id, requested_qty, requested_at, source_quote_id, status, created_by)
               VALUES ($1,$2,$3,$4,$5,'received',$6)`,
              [u.input_code || null, won.customer_id, Number(u.qty) || null, today, id, won.created_by || null]);
            await notifyProductMarketing(c, {
              title: `개발검토 요청: ${u.input_code || ''}`,
              detail: `${custName ? custName + ' 고객 ' : ''}견적 ${won.quote_no}(만료)에서 미등록 코드 ${u.input_code || '-'} 개발 검토가 필요합니다.`,
              createdBy: won.created_by || null,
            });
          }
          await logEvent({ userId: won.created_by || null, action: 'update', target: `quote:${id}`, detail: { expired: true } });
        });
      } catch (_) { /* best-effort; 다음 틱에서 재시도 */ }
    }
  }
  // 서버 기동 시 1회 + 60초 주기 스위퍼(외부 크론 불필요). 테스트(미기동)에선 등록 안 됨.
  if (!globalThis.__refatrixExpirySweeper) {
    globalThis.__refatrixExpirySweeper = setInterval(() => { finalizeExpiredQuotes().catch(() => {}); }, 60000);
    if (globalThis.__refatrixExpirySweeper.unref) globalThis.__refatrixExpirySweeper.unref();
    finalizeExpiredQuotes().catch(() => {});
  }

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

  app.post('/api/quotes', { preHandler: [authGuard, requirePageEditAny(['quote','sales'])] }, async (req, reply) => {
    const b = req.body || {};
    const isGuest = !b.customer_id && (b.guest_name || b.guest === true || b.discount_rate != null);
    let customerId = null, guestName = null, discountRate = 0;
    let autoCustomer = null;   // 자동 등록된(또는 재사용된) 고객
    if (isGuest) {
      const gname = String(b.guest_name || '').trim();
      if (!gname) return reply.code(400).send({ error: 'guest_name_required' });
      if (b.discount_rate == null || b.discount_rate === '') return reply.code(400).send({ error: 'discount_required' });
      discountRate = Number(b.discount_rate) || 0;
      // 불특정 고객명+할인율 → 고객 자동등록(같은 이름 재사용) 후 견적을 그 고객에 연결
      const fc = await findOrCreateCustomerByName({ name: gname, discount: discountRate, teamId: req.ctx.perm.teamId, userId: req.ctx.perm.userId });
      if (!fc) return reply.code(500).send({ error: 'customer_autocreate_failed' });
      customerId = fc.id;
      guestName = null;                 // 더 이상 불특정 아님 — 고객에 연결
      autoCustomer = { id: fc.id, name: gname, created: fc.created };
      if (!fc.created) {                // 기존 고객 재사용 시 등록 할인율 사용(일관성)
        const cd = (await query(`SELECT discount FROM customers WHERE id=$1`, [customerId])).rows[0];
        if (cd) discountRate = Number(cd.discount) || 0;
      }
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
        `INSERT INTO quotes (quote_no, customer_id, guest_name, quote_date, discount_rate, iva_rate, memo, status, subtotal_mxn, iva_mxn, total_mxn, total_qty, sku_count, created_by, reserve_expires_at)
         VALUES ($1,$2,$3,COALESCE($4,CURRENT_DATE),$5,$6,$7,'draft',$8,$9,$10,$11,$12,$13, now() + interval '24 hours') RETURNING id, quote_no`,
        [quoteNo, customerId, guestName, b.quote_date || null, discountRate, ivaRate, b.memo || null, totals.subtotal, totals.iva, totals.total, totals.totalQty, totals.skuCount, req.ctx.perm.userId])).rows[0];
      for (const l of lines) {
        await c.query(
          `INSERT INTO quote_lines (quote_id, line_no, product_id, input_code, ctr_code, syd_codes, product_name, app_text, qty, list_price, discount_rate, final_price, line_subtotal, line_iva, line_total, avail_stock, stock_flag)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [q.id, l.line_no, l.product_id, l.input_code, l.ctr_code, l.syd_codes, l.product_name, l.app_text, l.qty, l.list_price, l.discount_rate, l.final_price, l.line_subtotal, l.line_iva, l.line_total, l.avail_stock, l.stock_flag]);
      }
      await assignReservations(c, q.id);   // 선착순 재고 예약(블럭)
      return q;
    });
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `quote:${result.id}` });
    if (customerId) {
      // 단계 자동 전진(전진만): 이름입력으로 신규 자동등록된 미등록 고객 → 접촉(20),
      //  기존 등록 고객(선택 또는 동명 재사용) 견적 작성 → 견적(30).
      const isNewGuest = !!(autoCustomer && autoCustomer.created);
      const targetSort = isNewGuest ? 20 : 30;
      const note = isNewGuest
        ? `자동: 미등록 고객 이름입력 견적서 (${result.quote_no}) · 접촉 단계`
        : `자동: 견적서 작성 (${result.quote_no}) · 견적 단계`;
      try { await autoStage({ customerId, targetSort, onDate: b.quote_date || null, userId: req.ctx.perm.userId, note }); } catch (_) { /* best-effort */ }
    }
    return { id: result.id, quote_no: result.quote_no, customer_id: customerId || null, auto_customer: autoCustomer };
  });

  // 견적 수정(draft/confirmed만) — 라인 전체 교체
  app.put('/api/quotes/:id', { preHandler: [authGuard, requirePageEditAny(['quote','sales'])] }, async (req, reply) => {
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
      await assignReservations(c, id);   // 라인 교체 후 예약 재배분(만료시각은 생성 기준 유지)
    });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `quote:${id}` });
    return { ok: true };
  });

  // 견적 상태 변경: confirmed / cancelled / draft
  app.post('/api/quotes/:id/status', { preHandler: [authGuard, requirePageEditAny(['quote','sales'])] }, async (req, reply) => {
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
  // 전체 가격표 다운로드 → 견적 목록에 '가용재고 및 견적'(pricelist)로 기록.
  //  집계(SKU/총수량/금액)는 0으로 저장하고 목록에서 빈칸 표시. 같은 고객·당일 기록은 재사용.
  app.post('/api/quotes/pricelist', { preHandler: [authGuard, requirePageEditAny(['quote','sales'])] }, async (req, reply) => {
    const b = req.body || {};
    let customerId = null, discountRate = 0;
    const isGuest = !b.customer_id && (b.guest_name || b.discount_rate != null);
    if (isGuest) {
      const gname = String(b.guest_name || '').trim();
      if (!gname) return reply.code(400).send({ error: 'guest_name_required' });
      discountRate = Number(b.discount_rate) || 0;
      const fc = await findOrCreateCustomerByName({ name: gname, discount: discountRate, teamId: req.ctx.perm.teamId, userId: req.ctx.perm.userId });
      if (!fc) return reply.code(500).send({ error: 'customer_autocreate_failed' });
      customerId = fc.id;
      if (!fc.created) { const cd = (await query(`SELECT discount FROM customers WHERE id=$1`, [customerId])).rows[0]; if (cd) discountRate = Number(cd.discount) || 0; }
    } else {
      customerId = Number(b.customer_id);
      if (!customerId) return reply.code(400).send({ error: 'customer_required' });
      const cust = (await query(`SELECT discount FROM customers WHERE id=$1 AND deleted_at IS NULL`, [customerId])).rows[0];
      if (!cust) return reply.code(404).send({ error: 'customer_not_found' });
      discountRate = Number(cust.discount) || 0;
    }
    // 전체 가격표 제공 → 파이프라인 단계 접촉(20)으로 자동 전진(전진만) + 이력/미팅 로그
    try { await autoStage({ customerId, targetSort: 20, onDate: null, userId: req.ctx.perm.userId, note: '자동: 전체 가격표 제공 → 접촉' }); } catch (_) { /* best-effort */ }
    // 같은 고객·당일 pricelist 기록이 이미 있으면 재사용(중복 방지)
    const dup = (await query(
      `SELECT id, quote_no FROM quotes WHERE customer_id=$1 AND status='pricelist' AND quote_date=CURRENT_DATE AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`, [customerId])).rows[0];
    if (dup) return { id: dup.id, quote_no: dup.quote_no, customer_id: customerId, reused: true };
    const result = await withTx(async (c) => {
      const year = String(new Date().getFullYear());
      const quoteNo = await nextQuoteNo(c, year);
      return (await c.query(
        `INSERT INTO quotes (quote_no, customer_id, quote_date, discount_rate, iva_rate, status, subtotal_mxn, iva_mxn, total_mxn, total_qty, sku_count, created_by)
         VALUES ($1,$2,CURRENT_DATE,$3,16,'pricelist',0,0,0,0,0,$4) RETURNING id, quote_no`,
        [quoteNo, customerId, discountRate, req.ctx.perm.userId])).rows[0];
    });
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `quote_pricelist:${result.id}` });
    return { id: result.id, quote_no: result.quote_no, customer_id: customerId };
  });

  app.get('/api/quotes', { preHandler: [authGuard, requirePageAny(['quote','sales'])] }, async (req) => {
    const from = String(req.query.from || ''); const to = String(req.query.to || '');
    const status = String(req.query.status || '');
    const conds = [`q.deleted_at IS NULL`]; const args = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { args.push(from); conds.push(`q.quote_date >= $${args.length}`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { args.push(to); conds.push(`q.quote_date <= $${args.length}`); }
    if (['draft', 'confirmed', 'converted', 'cancelled', 'pricelist', 'expired'].includes(status)) { args.push(status); conds.push(`q.status=$${args.length}`); }
    if (req.query.open === '1') conds.push(`q.status IN ('draft','confirmed')`);          // 견적후 미결
    if (req.query.guest === '1') conds.push(`q.customer_id IS NULL AND q.status IN ('draft','confirmed')`); // 불특정·미등록
    // 팀 가시성: 디렉터/영업지원=전체. 그 외=자기 팀 고객 견적 + 본인이 만든 불특정 견적만.
    const ta = teamArr(req.ctx.perm);
    if (ta) {
      args.push(ta); const ti = args.length;
      args.push(req.ctx.perm.userId); const ui = args.length;
      conds.push(`(c.team_id = ANY($${ti}) OR (q.customer_id IS NULL AND q.created_by = $${ui}))`);
    }
    const rows = (await query(
      `SELECT q.id, q.quote_no, q.quote_date, q.status, q.subtotal_mxn, q.iva_mxn, q.total_mxn, q.total_qty, q.sku_count,
              q.invoice_id, q.guest_name, q.customer_id, q.created_by, q.reserve_expires_at,
              c.name AS customer_name, c.team_id,
              uc.name AS creator_name,
              i.inv_date AS sale_date, i.sat_no AS sale_sat_no, i.total_mxn AS sale_total,
              (SELECT COUNT(*) FROM stock_shortages sh WHERE sh.sales_invoice_id=i.id AND sh.status='open')::int AS shortage_cnt,
              cls.ok_cnt, cls.short_cnt, cls.dev_cnt, cls.ok_qty, cls.short_qty, cls.dev_qty,
              cls.ok_sub, cls.short_sub, cls.ok_amt, cls.short_amt
         FROM quotes q
         LEFT JOIN customers c ON c.id=q.customer_id
         LEFT JOIN users uc ON uc.id=q.created_by
         LEFT JOIN sales_invoices i ON i.id=q.invoice_id
         LEFT JOIN LATERAL (
           SELECT
             COUNT(*) FILTER (WHERE ql.product_id IS NOT NULL AND ql.reserved_qty >= ql.qty)::int AS ok_cnt,
             COUNT(*) FILTER (WHERE ql.product_id IS NOT NULL AND ql.reserved_qty <  ql.qty)::int AS short_cnt,
             COUNT(*) FILTER (WHERE ql.product_id IS NULL)::int                                   AS dev_cnt,
             COALESCE(SUM(ql.qty) FILTER (WHERE ql.product_id IS NOT NULL AND ql.reserved_qty >= ql.qty),0) AS ok_qty,
             COALESCE(SUM(ql.qty) FILTER (WHERE ql.product_id IS NOT NULL AND ql.reserved_qty <  ql.qty),0) AS short_qty,
             COALESCE(SUM(ql.qty) FILTER (WHERE ql.product_id IS NULL),0)                          AS dev_qty,
             -- 실제 매출가능 금액(부분충당): 확보분 비율만큼 즉시, 모자란 비율만큼 부족. IVA제외=line_subtotal, IVA포함=line_total
             COALESCE(SUM( LEAST(COALESCE(ql.reserved_qty,0), ql.qty)::numeric / NULLIF(ql.qty,0) * ql.line_subtotal ) FILTER (WHERE ql.product_id IS NOT NULL),0) AS ok_sub,
             COALESCE(SUM( GREATEST(ql.qty - COALESCE(ql.reserved_qty,0), 0)::numeric / NULLIF(ql.qty,0) * ql.line_subtotal ) FILTER (WHERE ql.product_id IS NOT NULL),0) AS short_sub,
             COALESCE(SUM( LEAST(COALESCE(ql.reserved_qty,0), ql.qty)::numeric / NULLIF(ql.qty,0) * ql.line_total ) FILTER (WHERE ql.product_id IS NOT NULL),0) AS ok_amt,
             COALESCE(SUM( GREATEST(ql.qty - COALESCE(ql.reserved_qty,0), 0)::numeric / NULLIF(ql.qty,0) * ql.line_total ) FILTER (WHERE ql.product_id IS NOT NULL),0) AS short_amt
           FROM quote_lines ql
           WHERE ql.quote_id = q.id
         ) cls ON TRUE
        WHERE ${conds.join(' AND ')}
        ORDER BY q.quote_date DESC, q.id DESC`, args)).rows;
    return {
      items: rows.map((r) => ({
        id: r.id, quote_no: r.quote_no, quote_date: d10(r.quote_date), status: r.status,
        total_mxn: Number(r.total_mxn), subtotal_mxn: Number(r.subtotal_mxn || 0),
        total_qty: Number(r.total_qty), sku_count: r.sku_count,
        team_id: r.team_id != null ? Number(r.team_id) : null,
        invoice_id: r.invoice_id, sale_date: r.sale_date ? d10(r.sale_date) : null, sale_sat_no: r.sale_sat_no || null,
        sale_total: (r.status === 'converted') ? Number(r.sale_total || 0) : null,
        shortage_cnt: Number(r.shortage_cnt || 0),
        is_guest: r.customer_id == null,
        party_name: r.customer_id == null ? (r.guest_name || '불특정 고객') : r.customer_name,
        creator_name: r.creator_name || null,
        open: ['draft', 'confirmed'].includes(r.status),
        reserve_expires_at: r.reserve_expires_at || null,
        // 수주현황(현재고 기준 라인 3분류): 즉시매출가능 / 재고부족 / 개발필요
        cls: {
          ok: Number(r.ok_cnt || 0), short: Number(r.short_cnt || 0), dev: Number(r.dev_cnt || 0),
          ok_qty: Number(r.ok_qty || 0), short_qty: Number(r.short_qty || 0), dev_qty: Number(r.dev_qty || 0),
          ok_sub: Number(r.ok_sub || 0), short_sub: Number(r.short_sub || 0),
          ok_amt: Number(r.ok_amt || 0), short_amt: Number(r.short_amt || 0),
        },
      })),
    };
  });

  // 미결/불특정 카운트 (배지용)
  app.get('/api/quotes/open-count', { preHandler: [authGuard, requirePageAny(['quote','sales'])] }, async (req) => {
    const conds = [`q.deleted_at IS NULL`]; const args = [];
    const ta = teamArr(req.ctx.perm);
    if (ta) {
      args.push(ta); const ti = args.length;
      args.push(req.ctx.perm.userId); const ui = args.length;
      conds.push(`(c.team_id = ANY($${ti}) OR (q.customer_id IS NULL AND q.created_by = $${ui}))`);
    }
    const r = (await query(
      `SELECT
         COUNT(*) FILTER (WHERE q.status IN ('draft','confirmed'))::int AS open,
         COUNT(*) FILTER (WHERE q.status IN ('draft','confirmed') AND q.customer_id IS NULL)::int AS guest_pending,
         COUNT(*) FILTER (WHERE q.status='delete_pending')::int AS delete_pending
       FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id
       WHERE ${conds.join(' AND ')}`, args)).rows[0];
    return { open: r.open || 0, guest_pending: r.guest_pending || 0, delete_pending: r.delete_pending || 0 };
  });

  app.get('/api/quotes/:id', { preHandler: [authGuard, requirePageAny(['quote','sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    const q = (await query(
      `SELECT q.*, c.name AS customer_name, c.rfc AS customer_rfc, c.phone AS customer_phone
         FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id WHERE q.id=$1 AND q.deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    q.is_guest = q.customer_id == null;
    q.party_name = q.customer_id == null ? (q.guest_name || '불특정 고객') : q.customer_name;
    const lines = (await query(
      `SELECT ql.*, p.stock_qty AS cur_stock_raw
         FROM quote_lines ql LEFT JOIN products p ON p.id = ql.product_id
        WHERE ql.quote_id=$1 ORDER BY ql.line_no, ql.id`, [id])).rows;
    const cls = { ok: 0, short: 0, dev: 0, ok_qty: 0, short_qty: 0, dev_qty: 0, ok_sub: 0, short_sub: 0, ok_amt: 0, short_amt: 0 };
    const outLines = lines.map((l) => {
      const qtyN = Number(l.qty) || 0;
      const cur = l.product_id != null ? (l.cur_stock_raw != null ? Number(l.cur_stock_raw) : 0) : null;
      const resvN = Number(l.reserved_qty) || 0;
      // live_flag: 예약(블럭) 확보 기준 3분류 — reserved_qty>=요청이면 즉시(확보), 미만이면 부족
      let live = 'not_found';
      if (l.product_id != null) live = (resvN >= qtyN) ? 'ok' : 'low_stock';
      if (live === 'ok') { cls.ok++; cls.ok_qty += qtyN; }
      else if (live === 'low_stock') { cls.short++; cls.short_qty += qtyN; }
      else { cls.dev++; cls.dev_qty += qtyN; }
      // 실제 매출가능 금액(부분충당): 확보분 비율만큼 즉시, 나머지는 부족
      if (l.product_id != null && qtyN > 0) {
        const subN = Number(l.line_subtotal) || 0;
        const totN = Number(l.line_total) || 0;
        const filled = Math.min(Math.max(resvN, 0), qtyN);
        cls.ok_sub += subN * filled / qtyN; cls.short_sub += subN * (qtyN - filled) / qtyN;
        cls.ok_amt += totN * filled / qtyN; cls.short_amt += totN * (qtyN - filled) / qtyN;
      }
      return {
        ...l, qty: qtyN, list_price: Number(l.list_price), discount_rate: Number(l.discount_rate),
        final_price: Number(l.final_price), line_subtotal: Number(l.line_subtotal), line_iva: Number(l.line_iva), line_total: Number(l.line_total),
        avail_stock: l.avail_stock != null ? Number(l.avail_stock) : null,
        reserved_qty: Number(l.reserved_qty) || 0,
        cur_stock: cur, live_flag: live,
      };
    });
    return {
      quote: {
        ...q, quote_date: d10(q.quote_date),
        subtotal_mxn: Number(q.subtotal_mxn), iva_mxn: Number(q.iva_mxn), total_mxn: Number(q.total_mxn), total_qty: Number(q.total_qty),
        cls,
      },
      lines: outLines,
    };
  });

  // 삭제 요청 (영업) — 즉시 삭제하지 않고 디렉터 승인 대기. 승인 전까지 집계 제외.
  app.post('/api/quotes/:id/delete-request', { preHandler: [authGuard, requirePageEditAny(['quote','sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return reply.code(400).send({ error: 'reason_required', note: '삭제 사유를 입력하세요.' });
    const q = (await query(`SELECT status FROM quotes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    if (q.status === 'converted') return reply.code(409).send({ error: 'already_converted', note: '매출 전환된 견적은 삭제 요청할 수 없습니다.' });
    if (q.status === 'delete_pending') {
      // 이미 삭제 대기 — 오류 대신 사유만 최신화하고 정상 처리(멱등)
      await query(`UPDATE quotes SET del_reason=$1, del_requested_by=$2, del_requested_at=now(), updated_at=now() WHERE id=$3`,
        [reason, req.ctx.perm.userId, id]);
      return { ok: true, already_pending: true, note: '이미 삭제 요청이 접수되어 디렉터 승인 대기 중입니다.' };
    }
    await query(
      `UPDATE quotes SET del_prev_status=status, status='delete_pending', del_reason=$1, del_requested_by=$2, del_requested_at=now(), updated_by=$2, updated_at=now() WHERE id=$3`,
      [reason, req.ctx.perm.userId, id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete_request', target: `quote:${id}`, detail: { reason } });
    return { ok: true };
  });

  // 삭제 승인 (디렉터) → soft-delete
  app.post('/api/quotes/:id/delete-approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const q = (await query(`SELECT status FROM quotes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    if (q.status !== 'delete_pending') return reply.code(409).send({ error: 'not_pending' });
    await query(`UPDATE quotes SET deleted_at=now(), updated_by=$1, updated_at=now() WHERE id=$2`, [req.ctx.perm.userId, id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete_approve', target: `quote:${id}` });
    return { ok: true };
  });

  // 삭제 반려 (디렉터) → 직전 상태로 복귀
  app.post('/api/quotes/:id/delete-reject', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const q = (await query(`SELECT status, del_prev_status FROM quotes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    if (q.status !== 'delete_pending') return reply.code(409).send({ error: 'not_pending' });
    const back = ['draft', 'confirmed'].includes(q.del_prev_status) ? q.del_prev_status : 'draft';
    await query(
      `UPDATE quotes SET status=$1, del_reason=NULL, del_requested_by=NULL, del_requested_at=NULL, del_prev_status=NULL, updated_by=$2, updated_at=now() WHERE id=$3`,
      [back, req.ctx.perm.userId, id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete_reject', target: `quote:${id}` });
    return { ok: true, status: back };
  });

  // 삭제 승인 대기 목록 (디렉터 배지/검토용)
  app.get('/api/quotes/delete-pending', { preHandler: [authGuard, requirePageAny(['quote','sales'])] }, async () => {
    const rows = (await query(
      `SELECT q.id, q.quote_no, q.quote_date, q.total_mxn, q.total_qty, q.sku_count, q.del_reason, q.del_requested_at,
              c.name AS customer_name, q.customer_id, q.guest_name, u.name AS requested_by_name
         FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id LEFT JOIN users u ON u.id=q.del_requested_by
        WHERE q.status='delete_pending' AND q.deleted_at IS NULL
        ORDER BY q.del_requested_at DESC`)).rows;
    return {
      items: rows.map((r) => ({
        id: r.id, quote_no: r.quote_no, quote_date: d10(r.quote_date),
        total_mxn: Number(r.total_mxn), total_qty: Number(r.total_qty), sku_count: r.sku_count,
        del_reason: r.del_reason, del_requested_at: r.del_requested_at ? d10(r.del_requested_at) : null,
        party_name: r.customer_id == null ? (r.guest_name || '불특정 고객') : r.customer_name,
        requested_by_name: r.requested_by_name,
      })),
    };
  });

  // ============ 고객-SKU 구매 실적 (최근 3년, 수량 기준) ============
  // GET /api/quotes/customer-sku-history?customer_id=&product_id=
  // 반환: years[{year, qty, pct}], total3y, totalPct(전체 누적 비중)
  app.get('/api/quotes/customer-sku-history', { preHandler: [authGuard, requirePageAny(['quote','sales'])] }, async (req) => {
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
  app.get('/api/quotes/:id/convert-preview', { preHandler: [authGuard, requirePageAny(['quote','sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    const q = (await query(`SELECT * FROM quotes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    const lines = (await query(`SELECT * FROM quote_lines WHERE quote_id=$1 ORDER BY line_no, id`, [id])).rows;
    const inStock = [], shortage = [], newDev = [];
    for (const l of lines) {
      const qty = Number(l.qty) || 0;
      if (!l.product_id) { newDev.push({ input_code: l.input_code, qty }); continue; }
      const p = (await query(`SELECT stock_qty FROM products WHERE id=$1`, [l.product_id])).rows[0];
      const physical = p && p.stock_qty != null ? Number(p.stock_qty) : 0;
      const fulfill = Math.max(0, Math.min(Number(l.reserved_qty) || 0, physical));   // 예약 확보분(현재고로 캡)
      const short = qty - fulfill;
      if (short <= 0) inStock.push({ ctr_code: l.ctr_code, product_name: l.product_name, qty, avail: fulfill });
      else {
        shortage.push({ ctr_code: l.ctr_code, product_name: l.product_name, qty, avail: fulfill, fulfill, short });
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
  app.get('/api/quotes/price-list', { preHandler: [authGuard, requirePageAny(['quote','sales'])] }, async (req) => {
    let discountRate = null;
    if (req.query.customer_id) {
      const c = (await query(`SELECT discount FROM customers WHERE id=$1 AND deleted_at IS NULL`, [Number(req.query.customer_id)])).rows[0];
      if (c) discountRate = Number(c.discount) || 0;
    }
    // top=N(예: 500): VIO 순위 기반 상위 N개. 재고>0 + ctr_vio_rank 매칭 SKU만, 순위 오름차순(1위=최다등록).
    //   동순위(같은 대표차종)는 재고 많은 순 → 코드 순. top 미지정이면 종전대로 전체 SKU(코드순).
    const topN = Math.min(Math.max(Number(req.query.top) || 0, 0), 1000);
    let prods;
    if (topN > 0) {
      prods = (await query(
        `SELECT p.id, p.code, p.scode, p.app, p.list_price, p.stock_qty, p.material,
                v.vio_units, v.vio_model, v.vio_year
           FROM products p
           JOIN ctr_vio_rank v ON UPPER(TRIM(p.code)) = UPPER(v.ctr_code)
          WHERE p.deleted_at IS NULL AND p.stock_qty > 0
          ORDER BY v.vio_units DESC NULLS LAST, p.stock_qty DESC, p.code
          LIMIT $1`, [topN])).rows;
    } else {
      prods = (await query(
        `SELECT id, code, scode, app, list_price, stock_qty, material,
                NULL::bigint AS vio_units, NULL::text AS vio_model, NULL::text AS vio_year
           FROM products WHERE deleted_at IS NULL ORDER BY code`)).rows;
    }
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
      material: p.material || null,
      vio_units: p.vio_units != null ? Number(p.vio_units) : null,
      vio_model: p.vio_model || null,
      vio_year: p.vio_year || null,
    }));
    return { discountRate, top: topN || null, count: items.length, items };
  });

  // ============ 포장작업지시서(서명 스캔본) — 업로드 / 메타 / 보기 ============
  // 메타 조회: 업로드 여부 + 파일명/시각 (데이터 미포함; 모달 진입 시 게이트 판단용)
  app.get('/api/quotes/:id/packing-doc', { preHandler: [authGuard, requirePageAny(['quote', 'sales'])] }, async (req) => {
    const id = Number(req.params.id);
    const r = (await query(
      `SELECT d.file_name, d.mime_type, d.uploaded_at, u.name AS uploaded_by_name
         FROM quote_packing_docs d LEFT JOIN users u ON u.id=d.uploaded_by
        WHERE d.quote_id=$1`, [id])).rows[0];
    if (!r) return { has: false };
    return { has: true, file_name: r.file_name, mime_type: r.mime_type, uploaded_at: r.uploaded_at, uploaded_by_name: r.uploaded_by_name || null };
  });

  // 파일 데이터 조회 (보기 버튼)
  app.get('/api/quotes/:id/packing-doc/file', { preHandler: [authGuard, requirePageAny(['quote', 'sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    const r = (await query(`SELECT file_name, mime_type, file_data FROM quote_packing_docs WHERE quote_id=$1`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'no_packing_doc' });
    return { file_name: r.file_name, mime_type: r.mime_type, file_data: r.file_data };
  });

  // 업로드(교체) — 이미지/PDF, 약 5MB 이하 base64 data URL
  app.post('/api/quotes/:id/packing-doc', { preHandler: [authGuard, requirePageEditAny(['quote', 'sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    const q = (await query(`SELECT id, customer_id, quote_no FROM quotes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    const data = String(req.body?.data || '');
    const name = (req.body?.file_name || '').toString().slice(0, 200) || null;
    const mime = (req.body?.mime_type || '').toString().slice(0, 100) || null;
    if (!/^data:(image\/|application\/pdf)/.test(data)) return reply.code(400).send({ error: 'invalid_file', note: '이미지(JPG/PNG) 또는 PDF만 업로드할 수 있습니다.' });
    if (data.length > 7000000) return reply.code(413).send({ error: 'file_too_large', note: '약 5MB 이하 파일을 사용하세요.' });
    await query(
      `INSERT INTO quote_packing_docs (quote_id, file_name, mime_type, file_data, uploaded_by, uploaded_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (quote_id) DO UPDATE SET file_name=EXCLUDED.file_name, mime_type=EXCLUDED.mime_type,
         file_data=EXCLUDED.file_data, uploaded_by=EXCLUDED.uploaded_by, uploaded_at=now()`,
      [id, name, mime, data, req.ctx.perm.userId]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `quote:${id}`, detail: { packing_doc_uploaded: name || true } });
    // 포장작업지시서 스캔본 업로드 시점에도 단계 수주(50) 백스톱(전진만)
    if (q.customer_id) { try { await autoStage({ customerId: q.customer_id, targetSort: 50, userId: req.ctx.perm.userId, note: `자동: 포장작업지시서 (${q.quote_no || id}) · 수주 단계` }); } catch (_) {} }
    return { ok: true };
  });

  // 포장작업지시서 "출력(인쇄)" 시점에 단계 수주(50) 자동 전진(전진만). 프런트 printPickList에서 호출.
  app.post('/api/quotes/:id/packing-printed', { preHandler: [authGuard, requirePageEditAny(['quote', 'sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    const q = (await query(`SELECT id, customer_id, quote_no FROM quotes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    if (q.customer_id) { try { await autoStage({ customerId: q.customer_id, targetSort: 50, userId: req.ctx.perm.userId, note: `자동: 포장작업지시서 출력 (${q.quote_no || id}) · 수주 단계` }); } catch (_) {} }
    return { ok: true };
  });

  // 확정된 견적을 매출 인보이스로 전환. 매칭 안 된 줄(not_found)은 제외.
  app.post('/api/quotes/:id/convert', { preHandler: [authGuard, requirePageEditAny(['quote','sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    const q = (await query(`SELECT * FROM quotes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    if (q.status === 'converted') return reply.code(409).send({ error: 'already_converted', invoice_id: q.invoice_id });
    if (q.status === 'expired' || (q.reserve_expires_at && new Date(q.reserve_expires_at) <= new Date()))
      return reply.code(409).send({ error: 'quote_expired', note: '예약 24시간이 지나 무효화된 견적입니다. 전환할 수 없습니다. 견적을 복제해 새로 진행하세요.' });
    // 포장 게이트: 전량 가용(피킹 대상) 라인이 있으면 서명 스캔본 업로드가 선행돼야 전환 가능
    const pickable = (await query(
      `SELECT 1 FROM quote_lines ql JOIN products p ON p.id=ql.product_id
        WHERE ql.quote_id=$1 AND ql.product_id IS NOT NULL
          AND LEAST(ql.reserved_qty, COALESCE(p.stock_qty,0)) > 0 LIMIT 1`, [id])).rows[0];
    if (pickable) {
      const pd = (await query(`SELECT 1 FROM quote_packing_docs WHERE quote_id=$1`, [id])).rows[0];
      if (!pd) return reply.code(409).send({ error: 'packing_doc_required', note: '포장작업지시서 서명 스캔본을 먼저 업로드해야 매출로 전환할 수 있습니다.' });
    }
    // 불특정 고객 견적은 고객을 지정해야 전환 가능 (고객등록 유도)
    let customerId = q.customer_id;
    if (customerId == null) {
      customerId = Number(req.body?.customer_id) || null;
      if (!customerId) return reply.code(409).send({ error: 'guest_needs_customer', note: '불특정 고객 견적입니다. 고객을 먼저 등록·지정한 뒤 전환하세요.' });
      const cu = (await query(`SELECT id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [customerId])).rows[0];
      if (!cu) return reply.code(404).send({ error: 'customer_not_found' });
    }
    // 매칭된 줄: 예약 확보분(현재고로 캡)만 매출 확정. 미확보분은 부족 백로그.
    const mrows = (await query(
      `SELECT ql.product_id, ql.qty, ql.reserved_qty, ql.final_price, p.stock_qty
         FROM quote_lines ql JOIN products p ON p.id=ql.product_id
        WHERE ql.quote_id=$1`, [id])).rows;
    const unmatched = (await query(`SELECT input_code, qty FROM quote_lines WHERE quote_id=$1 AND product_id IS NULL`, [id])).rows;
    if (!mrows.length && !unmatched.length) return reply.code(400).send({ error: 'no_valid_lines' });

    const shipLines = [];   // /api/sales 로 보낼 확보분(현재고가 보장 → sales 내부 부족 없음)
    const shortRows = [];   // 미확보 → 부족 백로그
    for (const l of mrows) {
      const qty = Number(l.qty) || 0;
      const physical = l.stock_qty != null ? Number(l.stock_qty) : 0;
      const fulfill = Math.max(0, Math.min(Number(l.reserved_qty) || 0, physical));
      const short = round2(qty - fulfill);
      if (fulfill > 0) shipLines.push({ product_id: l.product_id, qty: fulfill });
      if (short > 0) shortRows.push({
        product_id: l.product_id, requested: qty, fulfilled: fulfill, shortage: short,
        amount_mxn: round2(Number(l.final_price || 0) * short * 1.16),
      });
    }

    let invoiceId = null, sale = null;
    const invDate = req.body?.inv_date || d10(new Date());
    if (shipLines.length) {
      // allow_partial: 안전망(현재고가 확보분을 보장하므로 통상 sales 내부 부족은 0)
      const payload = {
        customer_id: customerId, inv_date: invDate, allow_partial: true,
        lines: shipLines,
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

    // 미확보 부족분 백로그 + 미등록 개발요청 + 견적 종료(converted) — 한 트랜잭션
    const devIds = [];
    const custName = (await query(`SELECT name FROM customers WHERE id=$1`, [customerId])).rows[0]?.name || '';
    await withTx(async (c) => {
      for (const s of shortRows) {
        await c.query(
          `INSERT INTO stock_shortages
             (product_id, customer_id, sales_invoice_id, requested_qty, fulfilled_qty, shortage_qty,
              shortage_amount_mxn, occurred_at, source_quote_id, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [s.product_id, customerId, invoiceId || null, s.requested, s.fulfilled, s.shortage,
           s.amount_mxn || 0, invDate, id, `견적 ${q.quote_no} 전환 — 미확보 부족분`, req.ctx.perm.userId]);
      }
      for (const u of unmatched) {
        // 재전환 시 동일 견적·코드의 개발요청 중복 생성 방지
        const dup = (await c.query(
          `SELECT 1 FROM product_dev_requests WHERE source_quote_id=$1 AND input_code IS NOT DISTINCT FROM $2 AND deleted_at IS NULL`,
          [id, u.input_code || null])).rows[0];
        if (dup) continue;
        const r = (await c.query(
          `INSERT INTO product_dev_requests (input_code, customer_id, requested_qty, requested_at, source_quote_id, status, created_by)
           VALUES ($1,$2,$3,$4,$5,'received',$6) RETURNING id`,
          [u.input_code || null, customerId, Number(u.qty) || null, invDate, id, req.ctx.perm.userId])).rows[0];
        devIds.push(r.id);
        await notifyProductMarketing(c, {
          title: `개발검토 요청: ${u.input_code || ''}`,
          detail: `${custName ? custName + ' 고객 ' : ''}견적 ${q.quote_no}에서 미등록 코드 ${u.input_code || '-'} 개발 검토가 필요합니다.`,
          createdBy: req.ctx.perm.userId,
        });
      }
      await c.query(`UPDATE quotes SET status='converted', invoice_id=$1, customer_id=$2, updated_by=$3, updated_at=now() WHERE id=$4`,
        [invoiceId || null, customerId, req.ctx.perm.userId, id]);
    });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `quote:${id}`, detail: { converted_to_invoice: invoiceId, shortages: shortRows.length, dev_requests: devIds.length } });
    // 전환 실행 → 단계 거래중(60) 자동 전진(전진만). (매출 확정 경로가 이미 올리지만 무인보이스 전환도 커버)
    if (customerId) { try { await autoStage({ customerId, targetSort: 60, onDate: invDate, userId: req.ctx.perm.userId, note: `자동: 견적 전환 실행 (${q.quote_no}) · 거래중 단계` }); } catch (_) {} }
    return {
      ok: true, converted: true, invoice_id: invoiceId,
      invoiced: !!invoiceId,
      shortages: shortRows,
      shortage_amount: shortRows.reduce((s, x) => s + (Number(x.amount_mxn) || 0), 0),
      dev_requests: devIds.length,
      sale,
    };
  });

  // 견적 복제 → 새 draft(현재고 기준 재평가 + 새 24h 예약). 만료 견적 회생용.
  //  · 부족분 정보는 복제 시점 현재고/타 예약으로 재산정(과거 스냅샷 복사 아님).
  app.post('/api/quotes/:id/clone', { preHandler: [authGuard, requirePageEditAny(['quote','sales'])] }, async (req, reply) => {
    const srcId = Number(req.params.id);
    const src = (await query(`SELECT id, customer_id, quote_no, memo FROM quotes WHERE id=$1 AND deleted_at IS NULL`, [srcId])).rows[0];
    if (!src) return reply.code(404).send({ error: 'not_found' });
    const customerId = src.customer_id;
    if (!customerId) return reply.code(409).send({ error: 'customer_required', note: '고객이 지정된 견적만 복제할 수 있습니다.' });
    const cust = (await query(`SELECT discount FROM customers WHERE id=$1 AND deleted_at IS NULL`, [customerId])).rows[0];
    if (!cust) return reply.code(404).send({ error: 'customer_not_found' });
    const discountRate = Number(cust.discount) || 0;
    const ivaRate = 16;
    const srcLines = (await query(`SELECT product_id, input_code, qty FROM quote_lines WHERE quote_id=$1 ORDER BY line_no, id`, [srcId])).rows;
    if (!srcLines.length) return reply.code(400).send({ error: 'no_lines', note: '복제할 품목이 없습니다.' });
    const inputLines = srcLines.map((l) => (l.product_id
      ? { product_id: l.product_id, qty: Number(l.qty) }
      : { code: l.input_code, qty: Number(l.qty) }));
    const result = await withTx(async (c) => {
      const year = String(new Date().getFullYear());
      const quoteNo = await nextQuoteNo(c, year);
      const lines = await buildLines(discountRate, ivaRate, inputLines);
      const totals = computeQuoteTotals(lines.filter((l) => l.product_id).map((l) => ({ lineSubtotal: l.line_subtotal, lineIva: l.line_iva, lineTotal: l.line_total, qty: l.qty })));
      const q = (await c.query(
        `INSERT INTO quotes (quote_no, customer_id, quote_date, discount_rate, iva_rate, memo, status, subtotal_mxn, iva_mxn, total_mxn, total_qty, sku_count, created_by, reserve_expires_at)
         VALUES ($1,$2,CURRENT_DATE,$3,16,$4,'draft',$5,$6,$7,$8,$9,$10, now() + interval '24 hours') RETURNING id, quote_no`,
        [quoteNo, customerId, discountRate, src.memo ? `${src.memo} (복제 ${src.quote_no})` : `복제 ${src.quote_no}`,
         totals.subtotal, totals.iva, totals.total, totals.totalQty, totals.skuCount, req.ctx.perm.userId])).rows[0];
      for (const l of lines) {
        await c.query(
          `INSERT INTO quote_lines (quote_id, line_no, product_id, input_code, ctr_code, syd_codes, product_name, app_text, qty, list_price, discount_rate, final_price, line_subtotal, line_iva, line_total, avail_stock, stock_flag)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [q.id, l.line_no, l.product_id, l.input_code, l.ctr_code, l.syd_codes, l.product_name, l.app_text, l.qty, l.list_price, l.discount_rate, l.final_price, l.line_subtotal, l.line_iva, l.line_total, l.avail_stock, l.stock_flag]);
      }
      await assignReservations(c, q.id);
      return q;
    });
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `quote:${result.id}`, detail: { cloned_from: srcId } });
    return { id: result.id, quote_no: result.quote_no, customer_id: customerId };
  });
}
