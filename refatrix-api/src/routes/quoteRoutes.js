import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector, requirePageAny, requirePageEditAny } from '../middleware/authGuard.js';
import { teamArr, canViewTeam } from '../teams.js';
import { logEvent } from '../audit.js';
import { computeQuoteLine, computeQuoteTotals, stockFlag, round2 } from '../quotes.js';
// 조립기는 공용 모듈에 있다 — CRM 수신 창구(crmQuoteRoutes)가 **같은 것**을 쓴다.
import { resolveCode, assignReservations, nextQuoteNo, buildLines,
         screenIssue, inactiveSinceMap,
         normalizePoNo, poColumnReady, poSelectFrag, quoteSearchClause } from '../quoteBuild.js';
import { autoStage } from '../stageAuto.js';
import { findOrCreateCustomerByName } from '../customerAuto.js';
import { packingDeadline } from '../workingHours.js';
import { reserveExpiresAt } from '../quoteExpiry.js';
import { recordQuoteDevDemand, quoteDevLines, esDevNote } from '../quoteDevDemand.js';   // 2026-09-21 · 미등록 코드는 저장 즉시 개발요청 대장에   // 2026-09-21 · 근무시간 밖 접수 → 다음 근무일 07:30 기산
import { maybeMarkPacked } from '../packedGate.js';
import { kickOrderStatus } from '../orderStatusSync.js';   // 0227 · 단계 전진 → CRM 오더상태
import { customerSoldItems, SOLD_DEFAULT_LIMIT } from '../customerSold.js';
import { normalizeClaimKey, RFC_ERROR_NOTE } from '../customerClaim.js';
import { internalHeaders } from '../internalCall.js';   // 0224c · /api/sales 내부 호출 표식

function d10(d) { if (!d) return null; if (d instanceof Date) return d.toISOString().slice(0, 10); return String(d).slice(0, 10); }

// 0185 — 디렉터 승인 대기 고객은 견적·가격표에 쓸 수 없다.
//   마이그레이션 전 DB(컬럼 없음)에서는 항상 false → 기존 동작 그대로.
async function isPendingCustomer(customerId) {
  try {
    const r = (await query(
      `SELECT COALESCE(approval_status,'approved') AS s FROM customers WHERE id=$1`, [customerId])).rows[0];
    return !!r && r.s === 'pending';
  } catch (_) { return false; }
}

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
      `SELECT DISTINCT p.id, p.code, p.name, p.app, p.list_price, p.is_active
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
        is_active: r.is_active !== false,   // 0179 — 자동완성에 「비활성」 배지 표시용
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
        const r = (await query(
          `SELECT p.id, p.code, p.name, p.app, p.list_price, p.stock_qty, p.is_active,
                  COALESCE(inc.incoming_qty,0) AS incoming_qty, inc.incoming_eta::text AS incoming_eta,
                  COALESCE(bo.backorder_qty,0) AS backorder_qty
             FROM products p
             LEFT JOIN v_incoming_stock inc ON inc.product_id=p.id
             LEFT JOIN v_backorder bo ON bo.product_id=p.id
            WHERE p.id=$1 AND p.deleted_at IS NULL`, [Number(ln.product_id)])).rows[0];
        if (r) prod = r;
      } else {
        const res = await resolveCode(ln.code);
        if (res.matches.length === 1) {
          const m = res.matches[0];
          const r = (await query(
            `SELECT p.id, p.code, p.name, p.app, p.list_price, p.stock_qty, p.is_active,
                    COALESCE(inc.incoming_qty,0) AS incoming_qty, inc.incoming_eta::text AS incoming_eta,
                    COALESCE(bo.backorder_qty,0) AS backorder_qty
               FROM products p
               LEFT JOIN v_incoming_stock inc ON inc.product_id=p.id
               LEFT JOIN v_backorder bo ON bo.product_id=p.id
              WHERE p.id=$1`, [m.product_id])).rows[0];
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
        incoming_qty: Number(prod.incoming_qty) || 0,
        incoming_eta: prod.incoming_eta || null,
        backorder_qty: Number(prod.backorder_qty) || 0,
        // 0179 — 비활성(판매중단) SKU: 미리보기에는 보이되 저장 시 차단된다.
        is_active: prod.is_active !== false,
      });
    }
    const totals = computeQuoteTotals(out.filter((l) => l.matched).map((l) => ({ lineSubtotal: l.line_subtotal, lineIva: l.line_iva, lineTotal: l.line_total, qty: l.qty })));
    return { discountRate, ivaRate, lines: out, totals };
  });


  // 만료 처리: 24h 지난 미결견적을 'expired'로 무효화 + 부족/개발 demand 백로그 적재.
  //  · 정확히 1회: status 플립을 RETURNING 으로 선점한 트랜잭션만 백로그를 쓴다(스위퍼 중복 무해).
  //  · 가용재고 정합성은 쿼리시 reserve_expires_at>now() 필터로 이미 보장됨(여긴 회색화+백로그만).
  async function finalizeExpiredQuotes() {
    const due = (await query(
      `SELECT id FROM quotes
        WHERE status IN ('draft','confirmed') AND reserve_expires_at IS NOT NULL
          AND reserve_expires_at <= now() AND deleted_at IS NULL
          AND packing_printed_at IS NULL
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
          // 미매칭 라인: 제품개발요청 — 2026-09-21 부터는 저장 시점에 이미 적혀 있다.
          //   여기서는 **안전망**으로 한 번 더 부른다(배포 전 견적·예외 경로). 같은 견적·같은 코드는 중복되지 않는다.
          //   (status 를 방금 expired 로 바꿨으므로 취소 판정에 걸리지 않는다)
          await recordQuoteDevDemand(c, id, { userId: won.created_by || null });
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



  // 0224b · 판매중단 줄 안내는 **스페인어**로 돌려준다 — 이 응답을 읽는 사람은 영업사원이다.
  //   막는 말이 아니다: 견적은 그대로 진행되고, 그 줄이 어디에 기록으로 남는지를 알려 준다.
  const esInactiveNote = (rows) =>
    `Productos descontinuados (inactivos) en esta cotización: ${rows.length} `
    + `(${rows.map((x) => x.code).filter(Boolean).join(', ')}). La cotización sigue su curso normal; `
    + `estas líneas quedan registradas como demanda del producto en Productos y Marketing > `
    + `Búsqueda de productos (ficha del SKU · «Solicitudes tras descontinuar»), para evaluar reactivar su venta.`;

  // 0224b · **판매중단 줄은 흐름을 세우지 않는다.**
  //   처음엔 포장·매출 전환까지 409 로 막았다가 되돌렸다(디렉터 지시, 2026-09-18):
  //   즉시 출고 가능한 20개 SKU 가 단종 1줄 때문에 통째로 멈추는 것이 훨씬 비싸다.
  //   남는 것은 **표시와 기록**이다 — 줄의 issue='inactive', 목록의 건수 배지, 그리고
  //   제품 화면의 수요 집계. 확정(POST /:id/status)만 0220 규칙대로 잠긴다.

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
      // 0185 — 「★ 미등록 고객(직접 입력)」으로는 더 이상 고객이 만들어지지 않는다.
      //   이름이 이미 등록된 고객이면 그 고객에 붙이고, 없으면 등록 화면으로 돌려보낸다.
      //   (RFC 선점 검사·디렉터 승인을 우회하는 유일한 구멍이었다)
      const fc = await findOrCreateCustomerByName({ name: gname });
      if (!fc) return reply.code(500).send({ error: 'customer_autocreate_failed' });
      if (fc.error === 'customer_not_registered') {
        return reply.code(409).send({ error: 'customer_not_registered',
          note: `"${gname}" 은(는) 등록된 고객이 아닙니다. 고객 등록 화면에서 먼저 등록하고 디렉터 승인을 받으세요(RFC 는 선택 — 다만 RFC 를 넣어야 그 고객이 선점됩니다).` });
      }
      if (fc.approval_status === 'pending') {
        return reply.code(409).send({ error: 'customer_not_approved',
          note: `"${gname}" 은(는) 디렉터 승인 대기 중입니다. 승인 후 견적을 작성할 수 있습니다.` });
      }
      customerId = fc.id;
      guestName = null;                 // 더 이상 불특정 아님 — 고객에 연결
      autoCustomer = { id: fc.id, name: gname, created: false };
      const cd = (await query(`SELECT discount FROM customers WHERE id=$1`, [customerId])).rows[0];
      if (cd) discountRate = Number(cd.discount) || 0;   // 등록 할인율 사용(일관성)
    } else {
      customerId = Number(b.customer_id);
      if (!customerId) return reply.code(400).send({ error: 'customer_required' });
      const cust = (await query(`SELECT discount FROM customers WHERE id=$1 AND deleted_at IS NULL`, [customerId])).rows[0];
      if (!cust) return reply.code(404).send({ error: 'customer_not_found' });
      if (await isPendingCustomer(customerId)) {
        return reply.code(409).send({ error: 'customer_not_approved',
          note: '디렉터 승인 대기 중인 고객입니다. 승인 후 견적을 작성할 수 있습니다.' });
      }
      discountRate = Number(cust.discount) || 0;
    }
    const ivaRate = 16;
    // 0224 — 비활성(판매중단) SKU 가 섞여 있어도 **거절하지 않고 접수한다.**
    //
    //   0179 는 여기서 409 로 막았다. 그런데 거절은 **아무 기록도 남기지 않는다** —
    //   고객이 단종된 부품을 계속 찾고 있다는 사실이 ERP 어디에도 안 남아서,
    //   판매재개 여부를 감으로 판단해야 했다. 「다음 단계로 못 가더라도 요청이
    //   들어왔다는 기록은 있어야 한다」는 것이 디렉터 지시(2026-09-18)다.
    //
    //   그래서 줄에 issue='inactive' 를 박아 **확정(POST /:id/status)만 잠근다.**
    //   포털 수신 창구(0220)가 이미 쓰는 규칙과 같다 — 두 경로가 갈리면 안 된다.
    // 0225 · 고객 PO번호 — 마이그레이션 전이면 조용히 건너뛴다(견적 저장 자체는 막지 않는다).
    const poNo = normalizePoNo(b.customer_po_no);
    const poReady = await poColumnReady();
    const result = await withTx(async (c) => {
      const year = (b.quote_date ? String(b.quote_date).slice(0, 4) : String(new Date().getFullYear()));
      const quoteNo = await nextQuoteNo(c, year);
      const lines = await buildLines(discountRate, ivaRate, Array.isArray(b.lines) ? b.lines : []);
      const totals = computeQuoteTotals(lines.filter((l) => l.product_id).map((l) => ({ lineSubtotal: l.line_subtotal, lineIva: l.line_iva, lineTotal: l.line_total, qty: l.qty })));
      const q = (await c.query(
        `INSERT INTO quotes (quote_no, customer_id, guest_name, quote_date, discount_rate, iva_rate, memo, status, subtotal_mxn, iva_mxn, total_mxn, total_qty, sku_count, created_by, reserve_expires_at${poReady ? ', customer_po_no' : ''})
         VALUES ($1,$2,$3,COALESCE($4,CURRENT_DATE),$5,$6,$7,'draft',$8,$9,$10,$11,$12,$13, $${poReady ? 15 : 14}::timestamptz${poReady ? ', $14' : ''}) RETURNING id, quote_no`,
        poReady
          ? [quoteNo, customerId, guestName, b.quote_date || null, discountRate, ivaRate, b.memo || null, totals.subtotal, totals.iva, totals.total, totals.totalQty, totals.skuCount, req.ctx.perm.userId, poNo, reserveExpiresAt(new Date())]
          : [quoteNo, customerId, guestName, b.quote_date || null, discountRate, ivaRate, b.memo || null, totals.subtotal, totals.iva, totals.total, totals.totalQty, totals.skuCount, req.ctx.perm.userId, reserveExpiresAt(new Date())])).rows[0];
      for (const l of lines) {
        await c.query(
          `INSERT INTO quote_lines (quote_id, line_no, product_id, input_code, ctr_code, syd_codes, product_name, app_text, qty, list_price, discount_rate, final_price, line_subtotal, line_iva, line_total, avail_stock, stock_flag, issue)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [q.id, l.line_no, l.product_id, l.input_code, l.ctr_code, l.syd_codes, l.product_name, l.app_text, l.qty, l.list_price, l.discount_rate, l.final_price, l.line_subtotal, l.line_iva, l.line_total, l.avail_stock, l.stock_flag, screenIssue(l.issue)]);
      }
      await assignReservations(c, q.id);   // 선착순 재고 예약(블럭)
      // 2026-09-21 · 카탈로그에 없는 코드는 **지금** 개발요청 대장에 적는다(전환·만료를 기다리지 않는다).
      await recordQuoteDevDemand(c, q.id, { userId: req.ctx.perm.userId });
      const devLines = await quoteDevLines(c, q.id);
      return { ...q, lines, devLines };
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
    // 0224 — 판매중단 SKU 가 들어간 줄을 화면에 돌려준다.
    //   저장은 됐지만 **확정은 못 한다**는 것을 사람이 바로 알아야 하므로, 목록으로 준다.
    const inactiveLines = (result.lines || []).filter((l) => l.issue === 'inactive')
      .map((l) => ({ line_no: l.line_no, code: l.ctr_code || l.input_code, name: l.product_name }));
    return { id: result.id, quote_no: result.quote_no, customer_id: customerId || null, auto_customer: autoCustomer,
      customer_po_no: poReady ? poNo : null,
      // 마이그레이션 전에 PO 를 보냈다면 **말해 준다.** 조용히 버리면 영업사원은 넣은 줄 안다.
      po_pending_migration: (!poReady && !!poNo) || undefined,
      inactive_lines: inactiveLines,
      inactive_note: inactiveLines.length ? esInactiveNote(inactiveLines) : null,
      dev_lines: result.devLines || [],
      dev_note: (result.devLines || []).length ? esDevNote(result.devLines) : null };
  });

  // 견적 수정(draft/confirmed만) — 라인 전체 교체
  app.put('/api/quotes/:id', { preHandler: [authGuard, requirePageEditAny(['quote','sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const q = (await query(`SELECT status, customer_id, created_at FROM quotes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    if (q.status === 'converted') return reply.code(409).send({ error: 'already_converted' });
    const customerId = Number(b.customer_id) || q.customer_id;
    const cust = (await query(`SELECT discount FROM customers WHERE id=$1`, [customerId])).rows[0];
    const discountRate = cust ? Number(cust.discount) || 0 : 0;
    const ivaRate = 16;
    // 0179/0224 — 이미 이 견적에 들어 있던 SKU 는 비활성이어도 **그대로** 둔다.
    //   비활성 전에 확정된 오더를 계속 정리할 수 있어야 하므로, 그 줄에는 issue 를 달지
    //   않는다(달면 확정이 잠겨 예전 오더의 인보이스 발행이 막힌다 — 0179 가 견적→매출
    //   전환을 일부러 막지 않은 것과 같은 이유다).
    //   **새로 추가하는** 비활성 SKU 만 issue='inactive' 로 표시해 확정을 잠근다.
    //   (0224 전에는 여기서 409 로 거절했다 — 요청 기록이 사라지는 것이 문제였다)
    const existingIds = new Set((await query(
      `SELECT DISTINCT product_id FROM quote_lines WHERE quote_id=$1 AND product_id IS NOT NULL`, [id]))
      .rows.map((r) => Number(r.product_id)));
    const poReady = await poColumnReady();
    const flagged = await withTx(async (c) => {
      const hit = [];
      const lines = await buildLines(discountRate, ivaRate, Array.isArray(b.lines) ? b.lines : []);
      // 중단 시각과 견적 생성 시각을 비교한다. 「원래 있던 줄」이라도 견적 자체가
      // 중단 **이후**에 만들어졌다면(포털 수신 견적 등) 표시를 유지해야 한다 —
      // 안 그러면 수정 한 번으로 0원짜리 줄의 확정 잠금이 풀린다.
      const sinceMap = await inactiveSinceMap(lines.map((l) => l.product_id));
      const qCreated = q.created_at ? new Date(q.created_at) : null;
      const flagInactive = (pid) => {
        const since = sinceMap.get(Number(pid));
        if (!existingIds.has(Number(pid))) return true;             // 새로 추가된 비활성 SKU
        if (since && qCreated && qCreated >= new Date(since)) return true;  // 중단 후 만들어진 견적
        return false;                                              // 중단 전부터 있던 줄 — 그대로 둔다
      };
      const totals = computeQuoteTotals(lines.filter((l) => l.product_id).map((l) => ({ lineSubtotal: l.line_subtotal, lineIva: l.line_iva, lineTotal: l.line_total, qty: l.qty })));
      // 0225 · PO번호는 **보내 왔을 때만** 건드린다. 화면이 키를 안 보내면 기존 값을 지키는 것이
      //   맞다 — SKU·수량만 고치는 편집이 PO 를 지워 버리면 그 사실을 아무도 눈치채지 못한다.
      const touchPo = poReady && Object.prototype.hasOwnProperty.call(b, 'customer_po_no');
      await c.query(
        `UPDATE quotes SET customer_id=$1, discount_rate=$2, memo=$3, subtotal_mxn=$4, iva_mxn=$5, total_mxn=$6, total_qty=$7, sku_count=$8, updated_by=$9, updated_at=now()${touchPo ? ', customer_po_no=$11' : ''} WHERE id=$10`,
        touchPo
          ? [customerId, discountRate, b.memo || null, totals.subtotal, totals.iva, totals.total, totals.totalQty, totals.skuCount, req.ctx.perm.userId, id, normalizePoNo(b.customer_po_no)]
          : [customerId, discountRate, b.memo || null, totals.subtotal, totals.iva, totals.total, totals.totalQty, totals.skuCount, req.ctx.perm.userId, id]);
      await c.query(`DELETE FROM quote_lines WHERE quote_id=$1`, [id]);
      for (const l of lines) {
        const iss = (l.issue === 'inactive' && l.product_id && flagInactive(l.product_id)) ? 'inactive' : null;
        if (iss) hit.push({ line_no: l.line_no, code: l.ctr_code || l.input_code, name: l.product_name });
        await c.query(
          `INSERT INTO quote_lines (quote_id, line_no, product_id, input_code, ctr_code, syd_codes, product_name, app_text, qty, list_price, discount_rate, final_price, line_subtotal, line_iva, line_total, avail_stock, stock_flag, issue)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [id, l.line_no, l.product_id, l.input_code, l.ctr_code, l.syd_codes, l.product_name, l.app_text, l.qty, l.list_price, l.discount_rate, l.final_price, l.line_subtotal, l.line_iva, l.line_total, l.avail_stock, l.stock_flag, iss]);
      }
      await assignReservations(c, id);   // 라인 교체 후 예약 재배분(만료시각은 생성 기준 유지)
      // 2026-09-21 · 수정으로 새로 들어온 미등록 코드도 바로 적는다(같은 견적·같은 코드는 한 줄).
      await recordQuoteDevDemand(c, id, { userId: req.ctx.perm.userId });
      hit.devLines = await quoteDevLines(c, id);
      return hit;
    });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `quote:${id}` });
    const devLines = flagged.devLines || [];
    return { ok: true, inactive_lines: [...flagged],
      inactive_note: flagged.length ? esInactiveNote(flagged) : null,
      dev_lines: devLines, dev_note: devLines.length ? esDevNote(devLines) : null };
  });

  // 견적 상태 변경: confirmed / cancelled / draft
  app.post('/api/quotes/:id/status', { preHandler: [authGuard, requirePageEditAny(['quote','sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    const st = String(req.body?.status || '');
    if (!['draft', 'confirmed', 'cancelled'].includes(st)) return reply.code(400).send({ error: 'bad_status' });
    const q = (await query(`SELECT status FROM quotes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    if (q.status === 'converted') return reply.code(409).send({ error: 'already_converted' });
    // 0220/0224b · **확정을 막는 것은 「해석 못 한 줄」뿐이다.**
    //   못 찾은 코드(not_found)·다중매칭(multi_match) 은 단가 0 으로 들어가고 합계에서도
    //   빠진다 — 그대로 확정하면 0원짜리 줄이 붙은 견적이 고객에게 나간다. 그건 계속 막는다.
    //   **판매중단(inactive) 줄은 막지 않는다**(디렉터 지시, 2026-09-18): 단가가 정상으로
    //   들어가 있고, 그 한 줄 때문에 나머지 품목의 흐름이 멈추면 손해가 훨씬 크다.
    //   그 줄은 기록으로 남아 제품 화면의 수요 집계에 잡힌다.
    if (st === 'confirmed') {
      let bad = [];
      try {
        bad = (await query(
          `SELECT line_no, input_code, issue FROM quote_lines
            WHERE quote_id=$1 AND issue IS NOT NULL AND issue <> 'inactive' ORDER BY line_no`, [id])).rows;
      } catch (_) { bad = []; }   // 0220 전 DB — 그 칼럼이 없다
      if (bad.length) {
        return reply.code(409).send({ error: 'quote_has_issues',
          note: `Hay ${bad.length} línea(s) que el ERP no pudo identificar (código no encontrado o ambiguo) `
            + `y entrarían con importe 0. Corrija o elimine esas líneas antes de confirmar.`,
          items: bad.map((r) => ({ line_no: Number(r.line_no), code: r.input_code, issue: r.issue })) });
      }
    }
    await query(`UPDATE quotes SET status=$1, updated_by=$2, updated_at=now() WHERE id=$3`, [st, req.ctx.perm.userId, id]);
    return { ok: true, status: st };
  });

  // ============ 고객 PO번호(O.C.) 단독 수정 — 0225 ============
  //
  //   **왜 별도 엔드포인트인가.** PUT /api/quotes/:id 는 라인을 통째로 갈아 끼우고
  //   `converted`(매출 전환된) 견적은 아예 거절한다. 그런데 현장의 순서는 반대다 —
  //   고객이 PO 를 **확정·전환 뒤에** 발행하는 일이 흔하고, 그때는 이미 창고가 패킹리스트를
  //   찍기 직전이다. 그 상황에서 「전환됐으니 못 고칩니다」 는 답이 될 수 없다.
  //
  //   그래서 이 길은 **PO 칸 하나만** 건드린다. 금액·라인·재고 예약은 손대지 않으므로
  //   전환된 견적에도 열어 둔다. 바꾼 사실은 감사로그에 남는다(이전값 포함).
  app.post('/api/quotes/:id/customer-po', { preHandler: [authGuard, requirePageEditAny(['quote', 'sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!(await poColumnReady())) {
      return reply.code(503).send({ error: 'migration_required', migration: '0225',
        note: '고객 PO번호 칼럼이 아직 없습니다. Railway 콘솔에서 `npm run migrate` 를 실행하세요.' });
    }
    const q = (await query(`SELECT id, quote_no, customer_po_no FROM quotes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    const po = normalizePoNo(req.body?.customer_po_no);
    await query(`UPDATE quotes SET customer_po_no=$1, updated_by=$2, updated_at=now() WHERE id=$3`,
      [po, req.ctx.perm.userId, id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `quote:${id}`,
      detail: { customer_po_no: { from: q.customer_po_no || null, to: po } } });
    return { ok: true, customer_po_no: po };
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
      // 0185 — 가격표(pricelist)도 고객 자동생성 경로였다. 동일하게 차단.
      const fc = await findOrCreateCustomerByName({ name: gname });
      if (!fc) return reply.code(500).send({ error: 'customer_autocreate_failed' });
      if (fc.error === 'customer_not_registered') {
        return reply.code(409).send({ error: 'customer_not_registered',
          note: `"${gname}" 은(는) 등록된 고객이 아닙니다. 고객 등록 화면에서 먼저 등록하세요.` });
      }
      if (fc.approval_status === 'pending') {
        return reply.code(409).send({ error: 'customer_not_approved', note: '디렉터 승인 대기 중인 고객입니다.' });
      }
      customerId = fc.id;
      { const cd = (await query(`SELECT discount FROM customers WHERE id=$1`, [customerId])).rows[0]; if (cd) discountRate = Number(cd.discount) || 0; }
    } else {
      customerId = Number(b.customer_id);
      if (!customerId) return reply.code(400).send({ error: 'customer_required' });
      const cust = (await query(`SELECT discount FROM customers WHERE id=$1 AND deleted_at IS NULL`, [customerId])).rows[0];
      if (!cust) return reply.code(404).send({ error: 'customer_not_found' });
      if (await isPendingCustomer(customerId)) {
        return reply.code(409).send({ error: 'customer_not_approved', note: '디렉터 승인 대기 중인 고객입니다.' });
      }
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
    // 0225 · 한 칸 검색 — 견적번호 · 고객명 · 고객 PO번호.
    //   고객이 전화로 대는 번호가 우리 번호인지 자기 PO 인지 모르는 채로 받으므로 칸을 나누지 않는다.
    const poReady = await poColumnReady();
    const kwClause = quoteSearchClause(req.query.q, args, { poReady });
    if (kwClause) conds.push(kwClause);
    // 팀 가시성: 디렉터/영업지원=전체. 그 외=자기 팀 고객 견적 + 본인이 만든 불특정 견적만.
    const ta = teamArr(req.ctx.perm);
    if (ta) {
      args.push(ta); const ti = args.length;
      args.push(req.ctx.perm.userId); const ui = args.length;
      conds.push(`(c.team_id = ANY($${ti}) OR (q.customer_id IS NULL AND q.created_by = $${ui}))`);
    }
    const rows = (await query(
      `SELECT q.id, q.quote_no, q.quote_date, q.status, q.subtotal_mxn, q.iva_mxn, q.total_mxn, q.total_qty, q.sku_count,
              q.invoice_id, q.guest_name, q.customer_id, q.created_by, q.reserve_expires_at, q.packing_printed_at, q.created_at,
              ${poSelectFrag(poReady)} AS customer_po_no,
              c.name AS customer_name, c.team_id,
              uc.name AS creator_name,
              (EXISTS(SELECT 1 FROM field_surveys fs WHERE fs.quote_id=q.id AND fs.deleted_at IS NULL)) AS from_field_survey,
              i.inv_date AS sale_date, i.sat_no AS sale_sat_no, i.total_mxn AS sale_total,
              (SELECT COUNT(*) FROM stock_shortages sh WHERE sh.sales_invoice_id=i.id AND sh.status='open')::int AS shortage_cnt,
              cls.ok_cnt, cls.short_cnt, cls.dev_cnt, cls.ok_qty, cls.short_qty, cls.dev_qty,
              cls.ok_sub, cls.short_sub, cls.ok_amt, cls.short_amt, cls.inact_cnt
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
             COALESCE(SUM( GREATEST(ql.qty - COALESCE(ql.reserved_qty,0), 0)::numeric / NULLIF(ql.qty,0) * ql.line_total ) FILTER (WHERE ql.product_id IS NOT NULL),0) AS short_amt,
             -- 0224 · 판매중단(비활성) 줄 수 — 목록에서 「왜 안 넘어가는지」가 바로 보여야 한다.
             COUNT(*) FILTER (WHERE ql.issue = 'inactive')::int AS inact_cnt
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
        customer_po_no: r.customer_po_no || null,          // 0225 · 고객이 관리하는 오더번호
        party_name: r.customer_id == null ? (r.guest_name || '불특정 고객') : r.customer_name,
        creator_name: r.creator_name || null,
        from_field_survey: !!r.from_field_survey,
        open: ['draft', 'confirmed'].includes(r.status),
        reserve_expires_at: r.reserve_expires_at || null,
        created_at: r.created_at || null,                   // 2026-09-21 · 접수 시각(견적일 아래 표시)
        packing_printed_at: r.packing_printed_at || null,   // 설정 시 시간과 무관 유효(만료 없음)
        inactive_cnt: Number(r.inact_cnt || 0),             // 0224 · 판매중단 줄(다음 단계 차단 사유)
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
      `SELECT q.*, c.name AS customer_name, c.rfc AS customer_rfc, c.phone AS customer_phone,
              uo.name AS customer_owner_name
         FROM quotes q
         LEFT JOIN customers c ON c.id=q.customer_id
         LEFT JOIN users uo ON uo.id=c.owner_id AND uo.deleted_at IS NULL
        WHERE q.id=$1 AND q.deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    q.is_guest = q.customer_id == null;
    q.party_name = q.customer_id == null ? (q.guest_name || '불특정 고객') : q.customer_name;
    const lines = (await query(
      `SELECT ql.*, p.stock_qty AS cur_stock_raw,
              COALESCE(inc.incoming_qty,0) AS incoming_qty_raw, inc.incoming_eta::text AS incoming_eta_raw,
              COALESCE(bo.backorder_qty,0) AS backorder_qty_raw,
              COALESCE((SELECT SUM(ql2.reserved_qty)
                          FROM quote_lines ql2 JOIN quotes q2 ON q2.id = ql2.quote_id
                         WHERE ql2.product_id = ql.product_id
                           AND q2.id <> ql.quote_id
                           AND q2.status IN ('draft','confirmed')
                           AND (q2.reserve_expires_at > now() OR q2.packing_printed_at IS NOT NULL)
                           AND q2.deleted_at IS NULL), 0) AS reserved_other_raw
         FROM quote_lines ql
         LEFT JOIN products p ON p.id = ql.product_id
         LEFT JOIN v_incoming_stock inc ON inc.product_id = ql.product_id
         LEFT JOIN v_backorder bo ON bo.product_id = ql.product_id
        WHERE ql.quote_id=$1 ORDER BY ql.line_no, ql.id`, [id])).rows;
    const cls = { ok: 0, short: 0, dev: 0, ok_qty: 0, short_qty: 0, dev_qty: 0, ok_sub: 0, short_sub: 0, ok_amt: 0, short_amt: 0 };
    const outLines = lines.map((l) => {
      const qtyN = Number(l.qty) || 0;
      const cur = l.product_id != null ? (l.cur_stock_raw != null ? Number(l.cur_stock_raw) : 0) : null;
      const resvN = Number(l.reserved_qty) || 0;
      // 라이브 가용재고 = 현재 실물재고 − (이 견적을 제외한) 타 미결·미만료 견적 예약분.
      //   현장재고조사/견적화면과 동일 정의. 고객 제시용 Existencia 는 이 값을 사용.
      const reservedOther = Number(l.reserved_other_raw) || 0;
      const liveAvail = (cur != null) ? Math.max(0, cur - reservedOther) : null;
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
        cur_stock: cur, live_avail: liveAvail, live_flag: live,
        // 운송중(입고예정): 아직 마감 안 된 선적의 SKU별 예상 수량 + 가장 이른 ETA (v_incoming_stock)
        incoming_qty: Number(l.incoming_qty_raw) || 0,
        incoming_eta: l.incoming_eta_raw || null,
        // 발주 미입고 잔량(v_backorder) — 운송중(incoming)을 포함한 전체. 프런트에서 운송중을 빼 순수 발주잔량을 구분 표시.
        backorder_qty: Number(l.backorder_qty_raw) || 0,
      };
    });
    // 현장재고조사 전환 여부 + (디렉터에게만) 현장 위치 좌표
    const fsRow = (await query(
      `SELECT id, geo_lat, geo_lng, survey_date FROM field_surveys
        WHERE quote_id = $1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`, [id])).rows[0];
    const isDir = req.ctx.perm.role === 'director';
    const fieldSurvey = fsRow ? {
      id: Number(fsRow.id), from: true, survey_date: fsRow.survey_date,
      has_geo: fsRow.geo_lat != null && fsRow.geo_lng != null,
      geo_lat: (isDir && fsRow.geo_lat != null) ? Number(fsRow.geo_lat) : null,
      geo_lng: (isDir && fsRow.geo_lng != null) ? Number(fsRow.geo_lng) : null,
    } : null;
    return {
      quote: {
        ...q, quote_date: d10(q.quote_date),
        subtotal_mxn: Number(q.subtotal_mxn), iva_mxn: Number(q.iva_mxn), total_mxn: Number(q.total_mxn), total_qty: Number(q.total_qty),
        field_survey: fieldSurvey,
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
  // GET /api/quotes/customer-purchased?customer_id=&all=&q=
  //   견적 사이드패널 「이 고객 누적 구매 품목」.
  //   그동안 판매한 품목을 누적수량 ▼ 로 내려준다 → 이번 견적에 빠진 단골 품목을 화면이 잡아낸다.
  //   기본 상위 30 / all=1 전체 / q= 코드·품명 검색. 기간 = 전체 누적.
  app.get('/api/quotes/customer-purchased', { preHandler: [authGuard, requirePageAny(['quote', 'sales'])] }, async (req, reply) => {
    const cid = Number(req.query.customer_id);
    if (!cid) return { enabled: false, items: [], total: 0, shown: 0, all: false, limit: SOLD_DEFAULT_LIMIT };
    const c = (await query(`SELECT team_id FROM customers WHERE id = $1 AND deleted_at IS NULL`, [cid])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canViewTeam(req.ctx.perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const d = await customerSoldItems(cid, {
      all: String(req.query.all || '') === '1',
      q: req.query.q,
      limit: SOLD_DEFAULT_LIMIT,
    });
    return { enabled: true, limit: SOLD_DEFAULT_LIMIT, ...d };
  });

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
      // rack_location = 제품마스터의 창고 랙 위치(0070). 포장작업지시서 'Ubicación rack' 열의 원천.
      //   미지정(NULL/공백)이면 '' 로 내려 프런트가 SIN UBICACIÓN 으로 표시한다.
      const p = (await query(`SELECT stock_qty, rack_location FROM products WHERE id=$1`, [l.product_id])).rows[0];
      const physical = p && p.stock_qty != null ? Number(p.stock_qty) : 0;
      const rack = (p && p.rack_location != null ? String(p.rack_location) : '').trim();
      const fulfill = Math.max(0, Math.min(Number(l.reserved_qty) || 0, physical));   // 예약 확보분(현재고로 캡)
      const short = qty - fulfill;
      if (short <= 0) inStock.push({ ctr_code: l.ctr_code, product_name: l.product_name, qty, avail: fulfill, rack_location: rack });
      else {
        shortage.push({ ctr_code: l.ctr_code, product_name: l.product_name, qty, avail: fulfill, fulfill, short, rack_location: rack });
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
    // top=N(예: 500): VIO 순위 기반 상위 N개. ctr_vio_rank 매칭 SKU(재고 무관 — 품절 포함), 순위 오름차순(1위=최다등록).
    //   동순위(같은 대표차종)는 재고 많은 순 → 코드 순. top 미지정이면 종전대로 전체 SKU(코드순).
    // all=1: 전체 SKU(재고·VIO매칭 무관)를 LEFT JOIN으로 VIO 정보 붙여 반환 — Top500과 동일 양식의 "전체 견적"용.
    //   VIO 미매칭 SKU는 vio_* = null (프런트 정렬에서 맨 뒤 그룹).
    const topN = Math.min(Math.max(Number(req.query.top) || 0, 0), 1000);
    const wantAll = String(req.query.all || '') === '1';
    let prods;
    if (wantAll) {
      prods = (await query(
        `SELECT p.id, p.code, p.name, p.scode, p.app, p.list_price, p.stock_qty, p.material,
                COALESCE(bo.backorder_qty,0) AS backorder_qty,
                v.vio_units, v.vio_model, v.vio_year
           FROM products p
           LEFT JOIN v_backorder bo ON bo.product_id = p.id
           LEFT JOIN ctr_vio_rank v ON UPPER(TRIM(p.code)) = UPPER(v.ctr_code)
          WHERE p.deleted_at IS NULL
          ORDER BY v.vio_units DESC NULLS LAST, p.stock_qty DESC, p.code`)).rows;
    } else if (topN > 0) {
      prods = (await query(
        `SELECT p.id, p.code, p.name, p.scode, p.app, p.list_price, p.stock_qty, p.material,
                COALESCE(bo.backorder_qty,0) AS backorder_qty,
                v.vio_units, v.vio_model, v.vio_year
           FROM products p
           LEFT JOIN v_backorder bo ON bo.product_id = p.id
           JOIN ctr_vio_rank v ON UPPER(TRIM(p.code)) = UPPER(v.ctr_code)
          WHERE p.deleted_at IS NULL
          ORDER BY v.vio_units DESC NULLS LAST, p.stock_qty DESC, p.code
          LIMIT $1`, [topN])).rows;
    } else {
      prods = (await query(
        `SELECT p.id, p.code, p.name, p.scode, p.app, p.list_price, p.stock_qty, p.material,
                COALESCE(bo.backorder_qty,0) AS backorder_qty,
                NULL::bigint AS vio_units, NULL::text AS vio_model, NULL::text AS vio_year
           FROM products p
           LEFT JOIN v_backorder bo ON bo.product_id = p.id
          WHERE p.deleted_at IS NULL ORDER BY p.code`)).rows;
    }
    const ids = prods.map((p) => p.id);
    const sydRows = ids.length ? (await query(`SELECT product_id, syd_code FROM product_syd_codes WHERE product_id = ANY($1)`, [ids])).rows : [];
    const sydByPid = {};
    for (const s of sydRows) (sydByPid[s.product_id] ||= []).push(s.syd_code);
    const items = prods.map((p) => ({
      ctr_code: p.code,
      name: p.name || '',
      syd_codes: p.scode || (sydByPid[p.id] || []).join(' / '),
      app: p.app || '',
      list_price: Number(p.list_price) || 0,
      stock_qty: p.stock_qty != null ? Number(p.stock_qty) : null,
      backorder_qty: Number(p.backorder_qty) || 0,
      material: p.material || null,
      vio_units: p.vio_units != null ? Number(p.vio_units) : null,
      vio_model: p.vio_model || null,
      vio_year: p.vio_year || null,
    }));
    return { discountRate, top: topN || null, all: wantAll || undefined, count: items.length, items };
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
    try { await maybeMarkPacked(id); } catch (_) {}   // 종이문서까지 올라오면 3조건 검사 → packed_at 확정
    // 포장작업지시서 스캔본 업로드 시점에도 단계 수주(50) 백스톱(전진만)
    if (q.customer_id) { try { await autoStage({ customerId: q.customer_id, targetSort: 50, userId: req.ctx.perm.userId, note: `자동: 포장작업지시서 (${q.quote_no || id}) · 수주 단계` }); } catch (_) {} }
    return { ok: true };
  });

  // 포장작업지시서 "출력(인쇄)" 시점에 단계 수주(50) 자동 전진(전진만). 프런트 printPickList에서 호출.
  app.post('/api/quotes/:id/packing-printed', { preHandler: [authGuard, requirePageEditAny(['quote', 'sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    const q = (await query(`SELECT id, customer_id, quote_no, packing_printed_at, packing_due_at FROM quotes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    // 0224b — **포장은 막지 않는다**(디렉터 지시, 2026-09-18).
    //   한 견적에 즉시 출고 가능한 SKU 가 20개인데 단종 1줄 때문에 지시서가 안 나가면
    //   그 20개가 통째로 멈춘다. 단종 줄은 재고가 없어 어차피 피킹 목록에 안 들어가므로,
    //   여기서 세울 이유가 없다. 요청 기록(issue='inactive')은 그대로 남는다.
    // 포장 시각/기한은 "최초 출력"에만 고정(재출력해도 기한이 밀리지 않음 — 전진 전용 원칙).
    let printedAt = q.packing_printed_at;
    let dueAt = q.packing_due_at;
    if (!printedAt) {
      const now = new Date();
      const due = packingDeadline(now); // 업무시간(07:30~17:00, UTC-6) 6시간
      const r = (await query(
        `UPDATE quotes SET packing_printed_at = now(), packing_due_at = $2
           WHERE id=$1 AND packing_printed_at IS NULL
         RETURNING packing_printed_at, packing_due_at`, [id, due])).rows[0];
      if (r) {
        printedAt = r.packing_printed_at; dueAt = r.packing_due_at;
        kickOrderStatus(id, { origin: 'packing_printed', actorUserId: req.ctx.perm.userId, app });   // 0227 · Surtiendo
      }
      else { // 경합(동시 두 번 출력) → 이미 박힌 값 재조회
        const rr = (await query(`SELECT packing_printed_at, packing_due_at FROM quotes WHERE id=$1`, [id])).rows[0] || {};
        printedAt = rr.packing_printed_at; dueAt = rr.packing_due_at;
      }
    }
    if (q.customer_id) { try { await autoStage({ customerId: q.customer_id, targetSort: 50, userId: req.ctx.perm.userId, note: `자동: 포장작업지시서 출력 (${q.quote_no || id}) · 수주 단계` }); } catch (_) {} }
    // 출력 클릭을 영구 기록(불변) — 매 클릭마다. 최초 1건이 실제 첫 출력 시각.
    try { await logEvent({ userId: req.ctx.perm.userId, action: 'print', target: 'packing_print', detail: { quote_id: id, quote_no: q.quote_no || null, customer_id: q.customer_id || null, printed_at: printedAt } }); } catch (_) {}
    return { ok: true, held: true, packing_printed_at: printedAt, packing_due_at: dueAt };
  });

  // 확정된 견적을 매출 인보이스로 전환. 매칭 안 된 줄(not_found)은 제외.
  app.post('/api/quotes/:id/convert', { preHandler: [authGuard, requirePageEditAny(['quote','sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    const q = (await query(`SELECT * FROM quotes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    if (q.status === 'converted') return reply.code(409).send({ error: 'already_converted', invoice_id: q.invoice_id });
    if (!q.packing_printed_at && (q.status === 'expired' || (q.reserve_expires_at && new Date(q.reserve_expires_at) <= new Date())))
      return reply.code(409).send({ error: 'quote_expired', note: '예약 24시간이 지나 무효화된 견적입니다. 전환할 수 없습니다. 견적을 복제해 새로 진행하세요.' });
    // 0224b — **매출 전환도 막지 않는다**(포장과 같은 이유).
    //   전환은 재고가 있는 줄만 인보이스로 만들고 나머지는 부족분으로 기록한다.
    //   단종 줄을 이유로 전환 전체를 세우면 팔 수 있는 물건까지 멈춘다.
    //   (0179 도 견적→매출 전환은 일부러 열어 두었다)
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
    // 0193 · 매출 전환도 **RFC 가 있어야** 한다. 견적까지는 RFC 없이 열어 뒀지만
    //   청구 단계에서는 팩투라에 RFC 가 필요하고, 선점 없는 고객에 매출이 꽂히면
    //   커미션 귀속이 무주공산이 된다. (POST /api/sales 의 관문과 같은 규칙 — 두 경로 모두 막는다.)
    {
      const cr = (await query(`SELECT name, rfc FROM customers WHERE id=$1`, [customerId])).rows[0];
      if (cr && !normalizeClaimKey(cr.rfc)) {
        return reply.code(409).send({ error: 'customer_rfc_required',
          note: RFC_ERROR_NOTE.sales_rfc_required, customer_name: cr.name });
      }
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
        // 0224c · 판매중단 SKU 가 섞여 있어도 이 견적의 줄이면 매출확정된다(salesRoutes 참조).
        source_quote_id: id,
      };
      const res = await app.inject({
        method: 'POST', url: '/api/sales',
        headers: { authorization: req.headers.authorization, 'content-type': 'application/json', ...internalHeaders() },
        payload: JSON.stringify(payload),
      });
      if (res.statusCode !== 200) return reply.code(res.statusCode).send({ error: 'sale_failed', detail: res.json() });
      sale = res.json();
      invoiceId = sale.id || (sale.invoice && sale.invoice.id);
    }

    // 미확보 부족분 백로그 + 미등록 개발요청 + 견적 종료(converted) — 한 트랜잭션
    const devIds = [];
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
      // 미등록 코드 → 개발요청(2026-09-21 부터는 저장 시점에 이미 적혀 있다 — 여기는 안전망).
      //   불특정 견적을 전환하며 고객을 지정했다면 그 고객을 요청에 붙인다.
      const dev = await recordQuoteDevDemand(c, id, { customerId, userId: req.ctx.perm.userId });
      for (const d of dev.created) devIds.push(d.id);
      if (!q.customer_id && customerId) {
        await c.query(
          `UPDATE product_dev_requests SET customer_id=$1, updated_at=now()
            WHERE source_quote_id=$2 AND customer_id IS NULL AND deleted_at IS NULL`, [customerId, id]);
      }
      await c.query(`UPDATE quotes SET status='converted', invoice_id=$1, customer_id=$2, updated_by=$3, updated_at=now() WHERE id=$4`,
        [invoiceId || null, customerId, req.ctx.perm.userId, id]);
    });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `quote:${id}`, detail: { converted_to_invoice: invoiceId, shortages: shortRows.length, dev_requests: devIds.length } });
    kickOrderStatus(id, { origin: 'converted', actorUserId: req.ctx.perm.userId, app });   // 0227 · 전환 → Preparando despacho / OC Enviada
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

  // ============ 재고 재검증 (수동 재예약) ============
  // 왜 필요한가: `reserved_qty` 는 견적 저장 시점의 스냅샷이다. 이후 다른 견적이 삭제·만료·전환되어
  // 재고가 풀려도 이 견적은 편집(재저장)·복제 전까지 계속 '재고부족'으로 남는다.
  // (같은 고객의 옛 견적이 재고를 선점하고 있던 사례 — 2026-08-26 디렉터 보고)
  // 이 엔드포인트는 **누르는 시점의 가용재고**로 예약을 다시 배분해 즉시/부족 분류를 갱신한다.
  //  · 저장(PUT)·복제와 **동일한 `assignReservations`** 를 쓰므로 선착순·동시성(FOR UPDATE) 보장이 같다.
  //  · **만료시각(`reserve_expires_at`)은 건드리지 않는다** — 생성 기준 고정(무한 잠금 방지) 원칙 유지.
  //  · 가격·수량·라인은 손대지 않는다(재고 배분만). 스냅샷 `stock_flag` 도 보존(오더퍼널 추이 연속성).
  app.post('/api/quotes/:id/revalidate-stock', { preHandler: [authGuard, requirePageEditAny(['quote', 'sales'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    const q = (await query(
      `SELECT id, quote_no, status, reserve_expires_at, packing_printed_at
         FROM quotes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });
    if (q.status !== 'draft' && q.status !== 'confirmed')
      return reply.code(409).send({ error: 'not_open', note: '작성중·확정 상태의 견적만 재고를 재검증할 수 있습니다.' });
    if (q.packing_printed_at)
      return reply.code(409).send({ error: 'packing_locked', note: '포장작업지시서가 출력되어 재고가 확정된 견적입니다. 재검증 대상이 아닙니다.' });
    if (q.reserve_expires_at && new Date(q.reserve_expires_at) <= new Date())
      return reply.code(409).send({ error: 'quote_expired', note: '예약 24시간이 지나 만료된 견적입니다. 「복제해서 새로 진행」을 사용하세요.' });

    const LINE_SQL = `SELECT ql.id, ql.ctr_code, ql.product_name, ql.qty, ql.reserved_qty,
                             COALESCE(p.stock_qty,0) AS cur_stock
                        FROM quote_lines ql LEFT JOIN products p ON p.id=ql.product_id
                       WHERE ql.quote_id=$1 AND ql.product_id IS NOT NULL
                       ORDER BY ql.line_no, ql.id`;
    const before = (await query(LINE_SQL, [id])).rows;
    await withTx(async (c) => { await assignReservations(c, id); });
    const after = (await query(LINE_SQL, [id])).rows;

    const wasBy = new Map(before.map((l) => [Number(l.id), Number(l.reserved_qty) || 0]));
    const flagOf = (resv, qty) => (resv >= qty ? 'ok' : 'low_stock');
    const changes = [];
    let okLines = 0; let shortLines = 0;
    for (const l of after) {
      const qty = Number(l.qty) || 0;
      const now = Number(l.reserved_qty) || 0;
      const was = wasBy.has(Number(l.id)) ? wasBy.get(Number(l.id)) : 0;
      if (now >= qty) okLines++; else shortLines++;
      if (now === was) continue;
      changes.push({
        line_id: Number(l.id), ctr_code: l.ctr_code, product_name: l.product_name,
        qty, before: was, after: now,
        before_flag: flagOf(was, qty), after_flag: flagOf(now, qty),
        cur_stock: Number(l.cur_stock) || 0,
      });
    }
    const upgraded = changes.filter((x) => x.before_flag !== 'ok' && x.after_flag === 'ok').length;
    const downgraded = changes.filter((x) => x.before_flag === 'ok' && x.after_flag !== 'ok').length;
    if (changes.length) await query(`UPDATE quotes SET updated_at=now() WHERE id=$1`, [id]);
    await logEvent({
      userId: req.ctx.perm.userId, action: 'update', target: `quote:${id}`,
      detail: { revalidate_stock: true, changed: changes.length, upgraded, downgraded },
    });
    return {
      ok: true, quote_no: q.quote_no,
      changed: changes.length, upgraded, downgraded,
      ok_lines: okLines, short_lines: shortLines, changes,
    };
  });

  // 견적 복제 → 새 draft(현재고 기준 재평가 + 새 24h 예약). 만료 견적 회생용.
  //  · 부족분 정보는 복제 시점 현재고/타 예약으로 재산정(과거 스냅샷 복사 아님).
  app.post('/api/quotes/:id/clone', { preHandler: [authGuard, requirePageEditAny(['quote','sales'])] }, async (req, reply) => {
    const srcId = Number(req.params.id);
    // 0225 · 복제는 「같은 오더를 다시 진행」하는 것이므로 고객 PO 도 따라간다.
    //   만료된 견적을 살리는 경로인데 PO 만 사라지면 창고가 다시 대조를 못 한다.
    const poReady = await poColumnReady();
    const src = (await query(
      `SELECT id, customer_id, quote_no, memo, ${poSelectFrag(poReady)} AS customer_po_no
         FROM quotes q WHERE id=$1 AND deleted_at IS NULL`, [srcId])).rows[0];   // 0224c · 별칭 q 누락 → 복제 500 (poSelectFrag 는 q.customer_po_no)
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
    // 0224 — 복제는 "새 견적"이다. 비활성 SKU 가 섞여 있어도 막지 않고 접수하되,
    //   그 줄을 표시해 확정을 잠근다(새 견적 저장과 같은 규칙).
    const result = await withTx(async (c) => {
      const year = String(new Date().getFullYear());
      const quoteNo = await nextQuoteNo(c, year);
      const lines = await buildLines(discountRate, ivaRate, inputLines);
      const totals = computeQuoteTotals(lines.filter((l) => l.product_id).map((l) => ({ lineSubtotal: l.line_subtotal, lineIva: l.line_iva, lineTotal: l.line_total, qty: l.qty })));
      const q = (await c.query(
        `INSERT INTO quotes (quote_no, customer_id, quote_date, discount_rate, iva_rate, memo, status, subtotal_mxn, iva_mxn, total_mxn, total_qty, sku_count, created_by, reserve_expires_at${poReady ? ', customer_po_no' : ''})
         VALUES ($1,$2,CURRENT_DATE,$3,16,$4,'draft',$5,$6,$7,$8,$9,$10, $${poReady ? 12 : 11}::timestamptz${poReady ? ', $11' : ''}) RETURNING id, quote_no`,
        (() => {
          const a = [quoteNo, customerId, discountRate, src.memo ? `${src.memo} (복제 ${src.quote_no})` : `복제 ${src.quote_no}`,
            totals.subtotal, totals.iva, totals.total, totals.totalQty, totals.skuCount, req.ctx.perm.userId];
          if (poReady) a.push(src.customer_po_no || null);
          a.push(reserveExpiresAt(new Date()));   // 2026-09-21 · 근무시간 기산
          return a;
        })())).rows[0];
      for (const l of lines) {
        await c.query(
          `INSERT INTO quote_lines (quote_id, line_no, product_id, input_code, ctr_code, syd_codes, product_name, app_text, qty, list_price, discount_rate, final_price, line_subtotal, line_iva, line_total, avail_stock, stock_flag, issue)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [q.id, l.line_no, l.product_id, l.input_code, l.ctr_code, l.syd_codes, l.product_name, l.app_text, l.qty, l.list_price, l.discount_rate, l.final_price, l.line_subtotal, l.line_iva, l.line_total, l.avail_stock, l.stock_flag, screenIssue(l.issue)]);
      }
      await assignReservations(c, q.id);
      await recordQuoteDevDemand(c, q.id, { userId: req.ctx.perm.userId });   // 2026-09-21
      const devLines = await quoteDevLines(c, q.id);
      return { ...q, lines, devLines };
    });
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `quote:${result.id}`, detail: { cloned_from: srcId } });
    const cloneInactive = (result.lines || []).filter((l) => l.issue === 'inactive')
      .map((l) => ({ line_no: l.line_no, code: l.ctr_code || l.input_code, name: l.product_name }));
    return { id: result.id, quote_no: result.quote_no, customer_id: customerId,
      inactive_lines: cloneInactive,
      inactive_note: cloneInactive.length ? esInactiveNote(cloneInactive) : null,
      dev_lines: result.devLines || [],
      dev_note: (result.devLines || []).length ? esDevNote(result.devLines) : null };
  });
}
