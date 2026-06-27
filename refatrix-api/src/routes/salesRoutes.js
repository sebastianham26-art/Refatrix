import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector, requirePageAny, requirePageEdit } from '../middleware/authGuard.js';
import { computeLine, computeInvoiceTotals, dueDate, isCreditException, computeDeleteReversal, computeEditNetEffect, ymd } from '../sales.js';
import { isClosedMonth } from '../importCost.js';
import { round2, allowPastMonthSalesEdit } from '../permissions.js';
import { logEvent } from '../audit.js';
import { autoStage } from '../stageAuto.js';

export default async function salesRoutes(app) {
  // 고객 CRUD는 customerRoutes로 일원화됨(팀 가시성 적용).

  // ---- 매출 인보이스 등록 (즉시 반영, 승인 불필요) ----
  // body: { sat_no?, customer_id, inv_date, credit_days?(예외 시), lines:[{product_id, qty, discount_rate?}], memo? }
  app.post('/api/sales', { preHandler: [authGuard, requirePageEdit('sales')] }, async (req, reply) => {
    const { sat_no, customer_id, inv_date, credit_days, lines = [], memo, credit_memo } = req.body || {};
    if (!customer_id || !inv_date || !lines.length) {
      return reply.code(400).send({ error: 'customer_date_lines_required' });
    }
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const cust = (await c.query(`SELECT id, discount, credit_days FROM customers WHERE id=$1 AND deleted_at IS NULL`, [customer_id])).rows[0];
      if (!cust) return { error: 'customer_not_found' };

      const custDiscount = Number(cust.discount) || 0;
      const baseCreditDays = Number(cust.credit_days) || 0;
      const appliedDays = (credit_days == null || credit_days === '') ? baseCreditDays : Number(credit_days);
      const exception = isCreditException(appliedDays, baseCreditDays);

      // 라인 계산 + 재고 확인 (부족 시 있는 만큼만 출고, 부족분은 기록)
      const r3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
      const allowPartial = req.body?.allow_partial === true;
      const computed = [];   // 실제 출고(인보이싱)될 라인
      const shortages = [];  // 부족분 기록 대상
      for (const l of lines) {
        const p = (await c.query(`SELECT id, code, name, list_price, stock_qty, avg_cost FROM products WHERE id=$1 AND deleted_at IS NULL`, [l.product_id])).rows[0];
        if (!p) return { error: `product_not_found:${l.product_id}` };
        const reqQty = Number(l.qty);
        const avail = Math.max(Number(p.stock_qty), 0);
        const fulfill = Math.min(reqQty, avail);
        const short = r3(reqQty - fulfill);
        if (short > 0) {
          // 매출 불가 금액(IVA 포함): 부족 수량 × 단가(할인반영) × 1.16
          const discRateS = (l.discount_rate == null || l.discount_rate === '') ? custDiscount : Number(l.discount_rate);
          const shLine = computeLine({ qty: short, listPrice: p.list_price, discountRate: discRateS });
          const shAmount = round2(Number(shLine.lineAmountMxn) * 1.16);
          shortages.push({ product_id: p.id, code: p.code, name: p.name, requested: reqQty, available: avail, shortage: short, amount_mxn: shAmount });
        }
        if (fulfill > 0) {
          const discRate = (l.discount_rate == null || l.discount_rate === '') ? custDiscount : Number(l.discount_rate);
          const line = computeLine({ qty: fulfill, listPrice: p.list_price, discountRate: discRate, cost: p.avg_cost });
          computed.push({ ...line, product_id: p.id, code: p.code });
        }
      }

      // 부족이 있는데 영업 확인(allow_partial)을 안 받았으면 막고 부족내역 반환
      if (shortages.length && !allowPartial) return { error: 'stock_short', shortages };

      const due = dueDate(inv_date, appliedDays);

      // 출고분이 하나도 없으면: 인보이스 없이 부족분만 기록
      if (!computed.length) {
        for (const s of shortages) {
          await c.query(
            `INSERT INTO stock_shortages (product_id, customer_id, sales_invoice_id, requested_qty, fulfilled_qty, shortage_qty, shortage_amount_mxn, occurred_at, created_by)
             VALUES ($1,$2,NULL,$3,0,$4,$5,$6,$7)`,
            [s.product_id, customer_id, s.requested, s.shortage, s.amount_mxn || 0, inv_date, userId]);
        }
        return { id: null, invoiced: false, shortages, due };
      }

      const totals = computeInvoiceTotals(computed, 16);

      // SAT 번호 미입력 시 임시번호 자동 부여 (TMP-NNNN)
      let satNo = (sat_no && String(sat_no).trim()) ? String(sat_no).trim() : null;
      if (!satNo) {
        const last = (await c.query(`SELECT sat_no FROM sales_invoices WHERE sat_no LIKE 'TMP-%' ORDER BY sat_no DESC LIMIT 1`)).rows[0];
        const n = last ? (parseInt(String(last.sat_no).slice(4), 10) || 0) + 1 : 1;
        satNo = 'TMP-' + String(n).padStart(4, '0');
      }

      // 헤더
      const inv = (await c.query(
        `INSERT INTO sales_invoices
           (sat_no, customer_id, inv_date, credit_days, due_date, credit_exception, credit_memo, credit_approved,
            iva_rate, subtotal_mxn, iva_mxn, total_mxn, status, owner_id, memo, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,16,$9,$10,$11,'posted',$12,$13,$14) RETURNING id`,
        [satNo, customer_id, inv_date, appliedDays, due, exception, exception ? (credit_memo || null) : null,
         exception ? false : true, totals.subtotalMxn, totals.ivaMxn, totals.totalMxn, userId, memo || null, userId])).rows[0];

      // 라인 + 재고 차감 + 원장(out)
      for (const ln of computed) {
        const lineRow = (await c.query(
          `INSERT INTO sales_invoice_lines
             (invoice_id, product_id, qty, list_price, discount_rate, unit_price, line_amount_mxn, applied_unit_cost, cogs_mxn)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [inv.id, ln.product_id, ln.qty, ln.listPrice, ln.discountRate, ln.unitPrice, ln.lineAmountMxn, ln.appliedUnitCost, ln.cogsMxn])).rows[0];
        await c.query(`UPDATE products SET stock_qty = stock_qty - $1, updated_by=$2 WHERE id=$3`, [ln.qty, userId, ln.product_id]);
        await c.query(
          `INSERT INTO stock_movements (product_id, move_type, qty, unit_cost_mxn, ref, sales_invoice_id, sales_invoice_line_id, moved_at, created_by)
           VALUES ($1,'out',$2,$3,$4,$5,$6,$7,$8)`,
          [ln.product_id, ln.qty, ln.appliedUnitCost, `sales:${inv.id}`, inv.id, lineRow.id, inv_date, userId]);
      }

      // 부족분 기록 (인보이스 연결)
      for (const s of shortages) {
        await c.query(
          `INSERT INTO stock_shortages (product_id, customer_id, sales_invoice_id, requested_qty, fulfilled_qty, shortage_qty, shortage_amount_mxn, occurred_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [s.product_id, customer_id, inv.id, s.requested, r3(s.requested - s.shortage), s.shortage, s.amount_mxn || 0, inv_date, userId]);
      }

      // 입금 예정(AR) — transactions plan, 인보이스당 한 건, 총액(IVA 포함)
      const txn = (await c.query(
        `INSERT INTO transactions (txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, sales_invoice_id, memo, created_by)
         VALUES ($1,'in',$2,'MXN',1,$2,'4010','plan','invoice',true,$3,$4,$5,$6) RETURNING id`,
        [due, totals.totalMxn, userId, inv.id, `매출 입금예정 (인보이스 #${inv.id})`, userId])).rows[0];
      await c.query(`UPDATE sales_invoices SET txn_id=$1 WHERE id=$2`, [txn.id, inv.id]);

      return { id: inv.id, invoiced: true, sat_no: satNo, totals, due, exception, shortages };
    });

    if (out.error === 'stock_short') return reply.code(409).send({ error: 'stock_short', shortages: out.shortages });
    if (out.error) return reply.code(out.error.startsWith('insufficient') ? 409 : 400).send({ error: out.error });
    await logEvent({ userId, deviceId: req.ctx.deviceId, action: 'create', target: `sales_invoice:${out.id || 'none'}`, detail: { exception: out.exception, shortages: out.shortages?.length || 0 } });
    if (out.invoiced && out.id) {
      // 매출 확정 → 단계 거래중(60) 자동 전진(전진만) + 미팅기록에 매출내역 표기(전진 없어도 기록)
      try {
        const label = (out.sat_no && !String(out.sat_no).startsWith('TMP-')) ? out.sat_no : `#${out.id}(임시)`;
        const amt = Number(out.totals?.totalMxn || 0);
        await autoStage({ customerId: customer_id, targetSort: 60, onDate: inv_date, userId, note: `자동: 매출 확정 (${label}) · MX$${amt.toLocaleString('en-US')} · 거래중`, alwaysLog: true });
      } catch (_) { /* best-effort */ }
    }
    return out;
  });

  // ---- 매출 목록 ----
  // ---- 엑셀 업로드 미리보기: CTR 코드 조회(정상/미등록) + 고객 할인 ----
  // body: { customer_id, codes:[...] }
  app.post('/api/sales/lookup', { preHandler: [authGuard, requirePage('sales')] }, async (req) => {
    const codes = Array.isArray(req.body?.codes) ? req.body.codes.map((x) => String(x).trim()).filter(Boolean) : [];
    const customerId = req.body?.customer_id;
    const cust = customerId ? (await query(`SELECT discount, credit_days FROM customers WHERE id=$1 AND deleted_at IS NULL`, [customerId])).rows[0] : null;
    const found = {};
    if (codes.length) {
      const rows = (await query(
        `SELECT id, code, name, list_price, stock_qty, avg_cost FROM products WHERE deleted_at IS NULL AND code = ANY($1)`, [codes])).rows;
      for (const r of rows) found[r.code] = { id: r.id, code: r.code, name: r.name, list_price: Number(r.list_price), stock_qty: Number(r.stock_qty) };
    }
    const missing = [...new Set(codes)].filter((c) => !found[c]);
    return { found, missing, customer_discount: cust ? Number(cust.discount) || 0 : 0, customer_credit_days: cust ? Number(cust.credit_days) || 0 : 0 };
  });

  // ---- SAT 번호 수정(임시번호 → 실제번호) ----
  app.post('/api/sales/:id/sat-no', { preHandler: [authGuard, requirePageEdit('sales')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const sat = (req.body?.sat_no && String(req.body.sat_no).trim()) || null;
    if (!sat) return reply.code(400).send({ error: 'sat_no_required' });
    try {
      const r = await query(`UPDATE sales_invoices
           SET sat_no=$1, updated_by=$2,
               sat_entered_at = COALESCE(sat_entered_at, CASE WHEN $1 NOT LIKE 'TMP-%' THEN now() END)
         WHERE id=$3 AND deleted_at IS NULL RETURNING id`, [sat, req.ctx.perm.userId, id]);
      if (!r.rows[0]) return reply.code(404).send({ error: 'not_found' });
      await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `sales_invoice:${id}`, detail: { sat_no: sat } });
      return { ok: true, sat_no: sat };
    } catch (e) {
      if (String(e.message).includes('unique') || e.code === '23505') return reply.code(409).send({ error: 'sat_no_duplicate' });
      throw e;
    }
  });

  // ============================================================
  // 매출확정(인보이스) 첨부파일 — SAT 번호 옆 인보이스 관련 파일 업로드.
  //   저장: sales_invoice_files (file_data = data URL base64). 인보이스 1건당 여러 파일.
  //   목록/집계 쿼리는 이 테이블을 건드리지 않음(성능 보호).
  //   허용 형식: PDF·이미지·XML(CFDI)·Excel·Word·CSV·ZIP 등.
  // ============================================================
  const INVOICE_FILE_MAX = 8 * 1024 * 1024; // 파일당 8MB(raw) — 12MB bodyLimit 내
  function validateInvoiceFileDataUrl(dataUrl, maxBytes = INVOICE_FILE_MAX) {
    if (typeof dataUrl !== 'string' || !dataUrl) return { ok: false, error: 'empty' };
    const m = dataUrl.match(/^data:([^;,]*);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!m) return { ok: false, error: 'bad_format' };
    const mime = (m[1] || 'application/octet-stream').toLowerCase();
    const allowed =
      mime.startsWith('image/') ||
      mime === 'application/pdf' ||
      mime === 'application/xml' || mime === 'text/xml' ||
      mime === 'text/plain' || mime === 'text/csv' ||
      mime === 'application/zip' || mime === 'application/x-zip-compressed' ||
      mime === 'application/vnd.ms-excel' ||
      mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mime === 'application/msword' ||
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mime === 'application/octet-stream' || mime === '';
    if (!allowed) return { ok: false, error: 'bad_mime' };
    const b64 = m[2].replace(/\s+/g, '');
    if (!b64) return { ok: false, error: 'empty_data' };
    const bytes = Math.floor((b64.length * 3) / 4);
    if (bytes > maxBytes) return { ok: false, error: 'too_large' };
    return { ok: true, mime, bytes };
  }

  // 첨부 목록(메타만 — file_data 제외)
  app.get('/api/sales/:id/files', { preHandler: [authGuard, requirePage('sales')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const r = await query(
      `SELECT f.id, f.file_name, f.mime_type, f.file_size, f.uploaded_at,
              u.name AS uploaded_by_name
         FROM sales_invoice_files f
         LEFT JOIN users u ON u.id = f.uploaded_by
        WHERE f.invoice_id = $1
        ORDER BY f.uploaded_at DESC, f.id DESC`, [id]);
    return {
      items: r.rows.map(x => ({
        id: Number(x.id),
        file_name: x.file_name,
        mime_type: x.mime_type,
        file_size: x.file_size == null ? null : Number(x.file_size),
        uploaded_at: x.uploaded_at,
        uploaded_by_name: x.uploaded_by_name || null,
      })),
    };
  });

  // 첨부 업로드(추가) — body: { file_name, mime_type, data(data URL base64) }
  // 매출 화면 열람 권한이 있으면 누구나 첨부 가능(모두 공개).
  app.post('/api/sales/:id/files', { preHandler: [authGuard, requirePage('sales')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const { file_name, mime_type, data } = req.body || {};
    const v = validateInvoiceFileDataUrl(data);
    if (!v.ok) return reply.code(400).send({ error: 'invalid_file', note: v.error });
    const inv = (await query(`SELECT id FROM sales_invoices WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!inv) return reply.code(404).send({ error: 'not_found' });
    const name = (file_name && String(file_name).slice(0, 200)) || '첨부파일';
    const mime = (mime_type && String(mime_type).slice(0, 100)) || v.mime;
    const r = await query(
      `INSERT INTO sales_invoice_files (invoice_id, file_name, mime_type, file_data, file_size, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, uploaded_at`,
      [id, name, mime, data, v.bytes, req.ctx.perm.userId]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `sales_invoice_file:${r.rows[0].id}`, detail: { invoice_id: id, file_name: name, bytes: v.bytes } });
    return { ok: true, id: Number(r.rows[0].id), uploaded_at: r.rows[0].uploaded_at };
  });

  // 단일 첨부 다운로드(데이터 포함) — 인증 fetch로 받아 blob 표시
  app.get('/api/sales/files/:fileId', { preHandler: [authGuard, requirePage('sales')] }, async (req, reply) => {
    const fid = Number(req.params.fileId);
    if (!fid) return reply.code(400).send({ error: 'bad_id' });
    const r = await query(
      `SELECT id, invoice_id, file_name, mime_type, file_data FROM sales_invoice_files WHERE id=$1`, [fid]);
    if (!r.rows[0]) return reply.code(404).send({ error: 'not_found' });
    return r.rows[0];
  });

  // 첨부 삭제 — 매출 화면 열람 권한이 있으면 누구나 삭제 가능(모두 공개).
  app.delete('/api/sales/files/:fileId', { preHandler: [authGuard, requirePage('sales')] }, async (req, reply) => {
    const fid = Number(req.params.fileId);
    if (!fid) return reply.code(400).send({ error: 'bad_id' });
    const r = await query(`DELETE FROM sales_invoice_files WHERE id=$1 RETURNING invoice_id`, [fid]);
    if (!r.rows[0]) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `sales_invoice_file:${fid}`, detail: { invoice_id: Number(r.rows[0].invoice_id) } });
    return { ok: true };
  });

  // ---- 디렉터: 인보이스 일자(inv_date) 변경 → 만기일(due_date) 자동 재계산 + 담당(영업담당) 동기화 ----
  // body: { inv_date: 'YYYY-MM-DD' }. due_date = inv_date + credit_days. owner_id는 고객의 영업담당으로 자동 반영.
  app.post('/api/sales/:id/inv-date', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const invDate = String(req.body?.inv_date || '').slice(0, 10);
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(invDate)) return reply.code(400).send({ error: 'invalid_inv_date' });
    const inv = (await query(
      `SELECT s.id, s.status, s.credit_days, s.customer_id, c.owner_id AS cust_owner_id
         FROM sales_invoices s JOIN customers c ON c.id=s.customer_id
        WHERE s.id=$1 AND s.deleted_at IS NULL`, [id])).rows[0];
    if (!inv) return reply.code(404).send({ error: 'not_found' });
    if (inv.status !== 'posted') return reply.code(409).send({ error: 'not_posted', note: '게시된 인보이스만 일자를 수정할 수 있습니다.' });
    const days = Number(inv.credit_days) || 0;
    const due = dueDate(invDate, days);
    // 담당은 고객의 영업담당으로 자동 반영(있을 때만)
    await query(
      `UPDATE sales_invoices SET inv_date=$1, due_date=$2,
              owner_id=COALESCE($3, owner_id), updated_by=$4
        WHERE id=$5 AND deleted_at IS NULL`,
      [invDate, due, inv.cust_owner_id || null, req.ctx.perm.userId, id]);
    const owner = inv.cust_owner_id
      ? (await query(`SELECT name FROM users WHERE id=$1`, [inv.cust_owner_id])).rows[0]?.name || null
      : null;
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `sales_invoice:${id}`, detail: { inv_date: invDate, due_date: due } });
    return { ok: true, inv_date: invDate, due_date: due, credit_days: days, owner_name: owner };
  });


  // body: { total_mxn (IVA 포함 총액), iva_mxn } → subtotal = total - iva, 라인 단가를 비례로 역산
  app.post('/api/sales/:id/adjust-total', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const userId = req.ctx.perm.userId;
    const targetTotal = round2(Number(req.body?.total_mxn));
    const targetIva = round2(Number(req.body?.iva_mxn));
    if (!Number.isFinite(targetTotal) || !Number.isFinite(targetIva) || targetTotal < 0 || targetIva < 0)
      return reply.code(400).send({ error: 'invalid_amounts' });
    if (targetIva > targetTotal) return reply.code(400).send({ error: 'iva_gt_total', note: 'IVA가 총액보다 클 수 없습니다.' });
    const targetSubtotal = round2(targetTotal - targetIva);

    const out = await withTx(async (c) => {
      const inv = (await c.query(
        `SELECT *, to_char(inv_date,'YYYY-MM') AS inv_ym, to_char(now(),'YYYY-MM') AS now_ym
           FROM sales_invoices WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
      if (!inv) return { error: 'not_found', code: 404 };
      // 당월 매출만 수정 가능 (마이그레이션 기간엔 ALLOW_PAST_MONTH_SALES_EDIT=1 로 과거 달도 허용)
      if (!allowPastMonthSalesEdit() && inv.inv_ym !== inv.now_ym) return { error: 'not_current_month', code: 409, note: '당월에 발행된 매출만 수정할 수 있습니다.' };
      const lines = (await c.query(`SELECT id, qty, line_amount_mxn FROM sales_invoice_lines WHERE invoice_id=$1 ORDER BY id`, [id])).rows;
      if (!lines.length) return { error: 'no_lines', code: 409 };
      const oldSub = round2(lines.reduce((s, l) => s + Number(l.line_amount_mxn), 0));
      if (!(oldSub > 0)) return { error: 'cannot_scale', code: 409, note: '기존 매출액이 0이라 비례 조정할 수 없습니다.' };
      const scale = targetSubtotal / oldSub;
      // 라인 금액을 비례 계산하고, 반올림 잔차는 가장 큰 라인에 흡수해 합계를 정확히 맞춤
      const newAmts = lines.map((l) => round2(Number(l.line_amount_mxn) * scale));
      const sumNew = round2(newAmts.reduce((s, v) => s + v, 0));
      const residual = round2(targetSubtotal - sumNew);
      if (residual !== 0) {
        let bi = 0; for (let i = 1; i < newAmts.length; i++) if (newAmts[i] > newAmts[bi]) bi = i;
        newAmts[bi] = round2(newAmts[bi] + residual);
      }
      for (let i = 0; i < lines.length; i++) {
        const qty = Number(lines[i].qty) || 0;
        const amt = newAmts[i];
        const unit = qty > 0 ? round2(amt / qty) : 0;
        await c.query(`UPDATE sales_invoice_lines SET unit_price=$1, line_amount_mxn=$2 WHERE id=$3`, [unit, amt, lines[i].id]);
      }
      await c.query(`UPDATE sales_invoices SET subtotal_mxn=$1, iva_mxn=$2, total_mxn=$3, updated_by=$4 WHERE id=$5`,
        [targetSubtotal, targetIva, targetTotal, userId, id]);
      // 연결된 입금예정(AR) 금액도 새 총액으로 동기화
      if (inv.txn_id) await c.query(`UPDATE transactions SET amount=$1, amount_mxn=$1, updated_by=$2 WHERE id=$3`, [targetTotal, userId, inv.txn_id]);
      return {
        ok: true,
        before: { subtotal: Number(inv.subtotal_mxn), iva: Number(inv.iva_mxn), total: Number(inv.total_mxn) },
        after: { subtotal: targetSubtotal, iva: targetIva, total: targetTotal },
        lines: lines.length,
      };
    });
    if (out.error) return reply.code(out.code || 409).send(out);
    await logEvent({ userId, action: 'update', target: `sales_invoice:${id}`, detail: { adjustTotal: out.after, before: out.before } });
    return out;
  });

  // ---- 미등록 SKU 보류(pending) 저장 ----
  // body: { customer_id, intended_sat_no?, sales_invoice_id?, rows:[{code, qty}] }
  app.post('/api/sales/sku-pending', { preHandler: [authGuard, requirePage('sales')] }, async (req) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const userId = req.ctx.perm.userId;
    let n = 0;
    for (const r of rows) {
      if (!r.code || !(Number(r.qty) > 0)) continue;
      await query(
        `INSERT INTO sales_sku_pending (code, qty, customer_id, intended_sat_no, sales_invoice_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [String(r.code).trim(), Number(r.qty), req.body.customer_id || null, req.body.intended_sat_no || null, req.body.sales_invoice_id || null, userId]);
      n++;
    }
    return { ok: true, saved: n };
  });

  // ---- 미등록 SKU 보류 목록 ----
  app.get('/api/sales/sku-pending', { preHandler: [authGuard, requirePage('sales')] }, async (req) => {
    const status = req.query.status || 'open';
    const rows = (await query(
      `SELECT sp.id, sp.code, sp.qty, sp.intended_sat_no, sp.occurred_at, sp.status,
              c.code AS customer_code, c.name AS customer_name,
              EXISTS(SELECT 1 FROM products p WHERE p.code=sp.code AND p.deleted_at IS NULL) AS now_registered
         FROM sales_sku_pending sp LEFT JOIN customers c ON c.id=sp.customer_id
        WHERE ($1='all' OR sp.status=$1) ORDER BY sp.occurred_at DESC, sp.id DESC LIMIT 200`, [status])).rows;
    return { items: rows };
  });

  app.get('/api/sales', { preHandler: [authGuard, requirePage('sales')] }, async (req) => {
    const rows = (await query(
      `SELECT s.id, s.sat_no, s.inv_date, s.due_date, s.credit_days, s.credit_exception, s.credit_approved,
              s.subtotal_mxn, s.iva_mxn, s.total_mxn, s.status, c.code AS customer_code, c.name AS customer_name,
              (SELECT COUNT(*) FROM sales_change_requests cr WHERE cr.invoice_id=s.id AND cr.req_type='edit' AND cr.status='approved') AS edit_count,
              (SELECT COUNT(*) FROM stock_shortages sh WHERE sh.sales_invoice_id=s.id AND sh.status='open') AS shortage_count,
              (SELECT COUNT(*) FROM sales_sku_pending sp WHERE sp.sales_invoice_id=s.id AND sp.status='open') AS pending_count
         FROM sales_invoices s JOIN customers c ON c.id=s.customer_id
        WHERE s.deleted_at IS NULL ORDER BY s.inv_date DESC, s.id DESC LIMIT 100`)).rows;
    return { items: rows.map((r) => ({ ...r, edit_count: Number(r.edit_count), shortage_count: Number(r.shortage_count), pending_count: Number(r.pending_count) })) };
  });

  // ---- 인보이스별 부족·보류 내역(세부 펼침용) ----
  app.get('/api/sales/:id/issues', { preHandler: [authGuard, requirePage('sales')] }, async (req) => {
    const id = Number(req.params.id);
    const shortages = (await query(
      `SELECT sh.id, p.code, p.name, sh.requested_qty, sh.fulfilled_qty, sh.shortage_qty, sh.occurred_at, sh.status
         FROM stock_shortages sh JOIN products p ON p.id=sh.product_id
        WHERE sh.sales_invoice_id=$1 ORDER BY sh.id`, [id])).rows;
    const pending = (await query(
      `SELECT sp.id, sp.code, sp.qty, sp.occurred_at, sp.status,
              EXISTS(SELECT 1 FROM products p WHERE p.code=sp.code AND p.deleted_at IS NULL) AS now_registered
         FROM sales_sku_pending sp WHERE sp.sales_invoice_id=$1 ORDER BY sp.id`, [id])).rows;
    return { shortages, pending };
  });


  // ---- 매출 상세(라인 포함) ----
  app.get('/api/sales/:id', { preHandler: [authGuard, requirePage('sales')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const head = (await query(
      `SELECT s.*, c.code AS customer_code, c.name AS customer_name, c.credit_days AS customer_credit_days
         FROM sales_invoices s JOIN customers c ON c.id=s.customer_id WHERE s.id=$1`, [id])).rows[0];
    if (!head) return reply.code(404).send({ error: 'not_found' });
    const lines = (await query(
      `SELECT l.*, p.code, p.name, p.app,
              (SELECT string_agg(syd_code, ' / ' ORDER BY syd_code) FROM product_syd_codes WHERE product_id=p.id) AS syd_codes
         FROM sales_invoice_lines l JOIN products p ON p.id=l.product_id WHERE l.invoice_id=$1 ORDER BY l.id`, [id])).rows;
    return { invoice: head, lines };
  });

  // ---- 예외 외상일 승인 대기 목록(디렉터) ----
  app.get('/api/sales/credit-exceptions/pending', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(
      `SELECT s.id, s.sat_no, s.inv_date, s.credit_days, s.due_date, s.credit_memo, s.total_mxn,
              c.code AS customer_code, c.name AS customer_name, c.credit_days AS base_credit_days
         FROM sales_invoices s JOIN customers c ON c.id=s.customer_id
        WHERE s.credit_exception=true AND s.credit_approved=false AND s.deleted_at IS NULL
        ORDER BY s.inv_date DESC`)).rows;
    return { items: rows };
  });

  // ---- 예외 외상일 승인/반려(디렉터) ----
  app.post('/api/sales/:id/credit-approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const { approve = true, reset_to_base = false } = req.body || {};
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const s = (await c.query(`SELECT s.*, cu.credit_days AS base_days FROM sales_invoices s JOIN customers cu ON cu.id=s.customer_id WHERE s.id=$1`, [id])).rows[0];
      if (!s) return { error: 'not_found' };
      if (!s.credit_exception) return { error: 'not_exception' };
      if (approve) {
        await c.query(`UPDATE sales_invoices SET credit_approved=true, credit_approved_by=$1, credit_approved_at=now() WHERE id=$2`, [userId, id]);
        return { ok: true, approved: true };
      }
      // 반려: 기준 외상일로 되돌림(요청 시) + 입금예정일 재계산
      const baseDays = Number(s.base_days) || 0;
      const newDue = dueDate(s.inv_date, baseDays);
      await c.query(
        `UPDATE sales_invoices SET credit_days=$1, due_date=$2, credit_exception=false, credit_approved=true, credit_approved_by=$3, credit_approved_at=now() WHERE id=$4`,
        [baseDays, newDue, userId, id]);
      if (s.txn_id) await c.query(`UPDATE transactions SET txn_date=$1 WHERE id=$2`, [newDue, s.txn_id]);
      return { ok: true, approved: false, resetTo: baseDays, newDue };
    });
    if (out.error) return reply.code(409).send(out);
    await logEvent({ userId, action: 'update', target: `sales_invoice:${id}`, detail: { creditApprove: out.approved } });
    return out;
  });

  // ---- 외상일(여신) 변경: 매출확정 단계에서 인보이스별 외상일을 마스터와 다르게 ----
  // 직원(매출 편집권한): 요청만 저장 — 활성 credit_days/due_date 는 그대로(승인 전엔 마스터값 유지).
  // 디렉터: 즉시 적용(요청 단계 없이 바로 반영하고 만기일·입금예정일 재계산).
  // body: { credit_days, memo? }
  app.post('/api/sales/:id/credit-days-request', { preHandler: [authGuard, requirePageEdit('sales')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const raw = Number(req.body?.credit_days);
    if (!Number.isFinite(raw) || raw < 0) return reply.code(400).send({ error: 'bad_days' });
    const days = Math.round(raw);
    const memo = (req.body?.memo == null ? '' : String(req.body.memo)).trim().slice(0, 300) || null;
    const userId = req.ctx.perm.userId;
    const isDir = req.ctx.perm.role === 'director';
    const out = await withTx(async (c) => {
      const s = (await c.query(`SELECT id, inv_date, status, credit_days, txn_id FROM sales_invoices WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
      if (!s) return { error: 'not_found' };
      if (s.status !== 'posted') return { error: 'not_posted' };
      if (isDir) {
        const newDue = dueDate(s.inv_date, days);
        await c.query(
          `UPDATE sales_invoices SET credit_days=$1, due_date=$2,
             credit_days_req=NULL, credit_req_by=NULL, credit_req_at=NULL, credit_req_memo=NULL, updated_by=$3
           WHERE id=$4`, [days, newDue, userId, id]);
        if (s.txn_id) await c.query(`UPDATE transactions SET txn_date=$1 WHERE id=$2`, [newDue, s.txn_id]);
        return { ok: true, applied: true, credit_days: days, due_date: newDue };
      }
      await c.query(
        `UPDATE sales_invoices SET credit_days_req=$1, credit_req_by=$2, credit_req_at=now(), credit_req_memo=$3 WHERE id=$4`,
        [days, userId, memo, id]);
      return { ok: true, applied: false, requested: days };
    });
    if (out.error) return reply.code(out.error === 'not_found' ? 404 : 409).send(out);
    await logEvent({ userId, action: 'update', target: `sales_invoice:${id}`, detail: { creditDaysReq: days, applied: out.applied } });
    return out;
  });

  // ---- 외상일 변경 요청 승인/반려(디렉터) ----  body: { approve: true|false }
  app.post('/api/sales/:id/credit-days-approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const approve = req.body?.approve !== false;
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const s = (await c.query(`SELECT id, inv_date, status, credit_days, credit_days_req, txn_id FROM sales_invoices WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
      if (!s) return { error: 'not_found' };
      if (s.credit_days_req == null) return { error: 'no_request' };
      if (!approve) {
        await c.query(`UPDATE sales_invoices SET credit_days_req=NULL, credit_req_by=NULL, credit_req_at=NULL, credit_req_memo=NULL, updated_by=$1 WHERE id=$2`, [userId, id]);
        return { ok: true, approved: false };
      }
      const days = Number(s.credit_days_req) || 0;
      const newDue = dueDate(s.inv_date, days);
      await c.query(
        `UPDATE sales_invoices SET credit_days=$1, due_date=$2,
           credit_days_req=NULL, credit_req_by=NULL, credit_req_at=NULL, credit_req_memo=NULL, updated_by=$3
         WHERE id=$4`, [days, newDue, userId, id]);
      if (s.txn_id) await c.query(`UPDATE transactions SET txn_date=$1 WHERE id=$2`, [newDue, s.txn_id]);
      return { ok: true, approved: true, credit_days: days, due_date: newDue };
    });
    if (out.error) return reply.code(out.error === 'not_found' ? 404 : 409).send(out);
    await logEvent({ userId, action: 'update', target: `sales_invoice:${id}`, detail: { creditDaysApprove: out.approved } });
    return out;
  });

  // ---- 외상일 변경 요청 승인 대기 목록(디렉터) ----
  app.get('/api/sales/credit-days/pending', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(
      `SELECT s.id, s.sat_no, to_char(s.inv_date,'YYYY-MM-DD') AS inv_date, to_char(s.due_date,'YYYY-MM-DD') AS due_date,
              s.credit_days, s.credit_days_req, s.credit_req_memo, to_char(s.credit_req_at,'YYYY-MM-DD HH24:MI') AS req_at,
              c.code AS customer_code, c.name AS customer_name, c.credit_days AS base_credit_days,
              u.name AS req_by_name, s.total_mxn
         FROM sales_invoices s JOIN customers c ON c.id=s.customer_id
              LEFT JOIN users u ON u.id=s.credit_req_by
        WHERE s.credit_days_req IS NOT NULL AND s.deleted_at IS NULL
        ORDER BY s.credit_req_at DESC NULLS LAST, s.id DESC`)).rows;
    return { items: rows.map((r) => ({ ...r,
      credit_days: Number(r.credit_days) || 0, credit_days_req: Number(r.credit_days_req) || 0,
      base_credit_days: Number(r.base_credit_days) || 0, total_mxn: Number(r.total_mxn) || 0 })) };
  });

  // ---- 부족 기록: 제품별 합계(주문용) ----
  app.get('/api/shortages/summary', { preHandler: [authGuard, requirePageAny(['shortage','sales'])] }, async () => {
    const rows = (await query(
      `SELECT sh.product_id, p.code, p.name, p.stock_qty,
              SUM(sh.shortage_qty) AS open_shortage,
              COUNT(*) AS records,
              MAX(sh.occurred_at) AS last_occurred
         FROM stock_shortages sh JOIN products p ON p.id=sh.product_id
        WHERE sh.status='open'
        GROUP BY sh.product_id, p.code, p.name, p.stock_qty
        ORDER BY open_shortage DESC`)).rows;
    return { items: rows.map((r) => ({ ...r, open_shortage: Number(r.open_shortage), stock_qty: Number(r.stock_qty), records: Number(r.records) })) };
  });

  // ---- 부족 기록: 원장(영업용, 누가·언제·얼마) ----
  app.get('/api/shortages', { preHandler: [authGuard, requirePageAny(['shortage','sales'])] }, async (req) => {
    const status = req.query.status || 'open';
    const rows = (await query(
      `SELECT sh.id, sh.occurred_at, sh.requested_qty, sh.fulfilled_qty, sh.shortage_qty, sh.status,
              p.code, p.name, c.code AS customer_code, c.name AS customer_name, sh.sales_invoice_id
         FROM stock_shortages sh
         JOIN products p ON p.id=sh.product_id
         LEFT JOIN customers c ON c.id=sh.customer_id
        WHERE ($1='all' OR sh.status=$1)
        ORDER BY sh.occurred_at DESC, sh.id DESC LIMIT 200`, [status])).rows;
    return { items: rows };
  });

  // ---- 부족 기록 해소/취소(디렉터) ----
  app.post('/api/shortages/:id/resolve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const status = (req.body?.status === 'cancelled') ? 'cancelled' : 'resolved';
    const r = await query(
      `UPDATE stock_shortages SET status=$1, resolved_at=now(), resolved_by=$2 WHERE id=$3 AND status='open' RETURNING id`,
      [status, req.ctx.perm.userId, id]);
    if (!r.rows[0]) return reply.code(409).send({ error: 'not_open' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `shortage:${id}`, detail: { status } });
    return { ok: true, status };
  });

  // ===== 매출 수정·삭제 승인 워크플로 (원본 격리, 디렉터 승인 시 반영) =====

  // 헬퍼: 원본 인보이스 + 라인 로드, 마감월 판정
  async function loadInvoiceForChange(c, id) {
    const inv = (await c.query(`SELECT * FROM sales_invoices WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!inv) return null;
    const lines = (await c.query(`SELECT * FROM sales_invoice_lines WHERE invoice_id=$1`, [id])).rows;
    const closed = (await c.query(`SELECT period FROM period_closings`)).rows.map((r) => r.period);
    inv._closedMonth = isClosedMonth(ymd(inv.inv_date), closed);
    inv._lines = lines.map((l) => ({ productId: l.product_id, qty: Number(l.qty), appliedUnitCost: Number(l.applied_unit_cost), lineAmountMxn: Number(l.line_amount_mxn) }));
    return inv;
  }

  // 수정 요청 (영업/디렉터) — 원본 유지, edit_pending
  // body: { reason, lines:[{product_id, qty, discount_rate?}], credit_days?, sat_no?, inv_date? }
  app.post('/api/sales/:id/edit-request', { preHandler: [authGuard, requirePageEdit('sales')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const { reason, lines, credit_days, sat_no, inv_date } = req.body || {};
    if (!Array.isArray(lines) || !lines.length) return reply.code(400).send({ error: 'lines_required' });
    const inv = (await query(`SELECT id, status FROM sales_invoices WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!inv) return reply.code(404).send({ error: 'not_found' });
    if (inv.status !== 'posted') return reply.code(409).send({ error: 'not_posted' });
    const payload = { lines, credit_days: credit_days ?? null, sat_no: sat_no ?? null, inv_date: inv_date ?? null };
    const r = await query(
      `INSERT INTO sales_change_requests (invoice_id, req_type, payload, reason, requested_by)
       VALUES ($1,'edit',$2,$3,$4) RETURNING id`, [id, JSON.stringify(payload), reason || null, req.ctx.perm.userId]);
    await query(`UPDATE sales_invoices SET status='edit_pending' WHERE id=$1`, [id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `sales_change_request:${r.rows[0].id}`, detail: { type: 'edit', invoice: id } });
    return { id: r.rows[0].id, type: 'edit', status: 'pending' };
  });

  // 삭제 요청 (영업/디렉터) — 원본 유지, delete_pending
  app.post('/api/sales/:id/delete-request', { preHandler: [authGuard, requirePageEdit('sales')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const { reason } = req.body || {};
    const inv = (await query(`SELECT id, status FROM sales_invoices WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!inv) return reply.code(404).send({ error: 'not_found' });
    if (inv.status !== 'posted') return reply.code(409).send({ error: 'not_posted' });
    const r = await query(
      `INSERT INTO sales_change_requests (invoice_id, req_type, payload, reason, requested_by)
       VALUES ($1,'delete',NULL,$2,$3) RETURNING id`, [id, reason || null, req.ctx.perm.userId]);
    await query(`UPDATE sales_invoices SET status='delete_pending' WHERE id=$1`, [id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `sales_change_request:${r.rows[0].id}`, detail: { type: 'delete', invoice: id } });
    return { id: r.rows[0].id, type: 'delete', status: 'pending' };
  });

  // 매출(인보이스) 직접 삭제 (디렉터 전용) — 재고복원 + AR취소 + 견적 미전환 되돌림 + 소프트삭제
  // 가드: 수금(반제) 있음 / 커미션 지급됨 / 게시(posted) 아님 → 거부
  app.delete('/api/sales/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const inv = await loadInvoiceForChange(c, id);
      if (!inv) return { error: 'not_found', code: 404 };
      if (inv.status !== 'posted') return { error: 'not_posted', code: 409 };

      // 가드 ① 수금(반제)이 잡혀 있으면 삭제 불가
      const paid = Number((await c.query(
        `SELECT COALESCE(SUM(amount),0) AS s FROM sales_payment_allocations WHERE invoice_id=$1`, [id])).rows[0].s) || 0;
      if (paid > 0) return { error: 'has_payments', code: 409, paid };
      // 가드 ② 커미션이 이미 지급된 매출이면 삭제 불가
      const commPaid = (await c.query(
        `SELECT 1 FROM commission_payouts WHERE invoice_id=$1 AND paid=true`, [id])).rows[0];
      if (commPaid) return { error: 'commission_paid', code: 409 };

      // 재고 복원: 라인 수량만큼 +복원하고, 원가 스냅샷으로 'in' 보정 이동 기록(이력 보존)
      for (const l of inv._lines) {
        await c.query(`UPDATE products SET stock_qty = stock_qty + $1, updated_by=$2 WHERE id=$3`, [l.qty, userId, l.productId]);
        await c.query(
          `INSERT INTO stock_movements (product_id, move_type, qty, unit_cost_mxn, ref, sales_invoice_id, created_by)
           VALUES ($1,'in',$2,$3,$4,$5,$6)`,
          [l.productId, l.qty, l.appliedUnitCost, `sales_reverse:${inv.id}`, inv.id, userId]);
      }
      // 입금예정(AR) 취소
      if (inv.txn_id) await c.query(`UPDATE transactions SET deleted_at=now(), updated_by=$1 WHERE id=$2`, [userId, inv.txn_id]);
      // 이 인보이스에 연결된 부족분 기록 / 미지급 커미션 정리
      await c.query(`DELETE FROM stock_shortages WHERE sales_invoice_id=$1`, [id]);
      await c.query(`DELETE FROM commission_payouts WHERE invoice_id=$1 AND paid=false`, [id]);
      // 연결된 견적 → 미전환(확정)으로 되돌림 (재전환 가능)
      await c.query(`UPDATE quotes SET status='confirmed', invoice_id=NULL, updated_by=$1, updated_at=now() WHERE invoice_id=$2 AND status='converted'`, [userId, inv.id]);
      // 인보이스 소프트 삭제
      await c.query(`UPDATE sales_invoices SET status='deleted', deleted_at=now(), updated_by=$1 WHERE id=$2`, [userId, inv.id]);
      // 정산차액 기록(마감월 등 회계 보정)
      const rev = computeDeleteReversal({ origLines: inv._lines, closedMonth: inv._closedMonth });
      if (rev.varianceMxn) {
        await c.query(
          `INSERT INTO cogs_adjustments (doc_id, sales_invoice_id, product_id, sale_date, qty, diff_mxn, kind, source)
           VALUES (NULL,$1,$2,$3,$4,$5,$6,$7)`,
          [inv.id, inv._lines[0]?.productId || null, ymd(inv.inv_date), null, round2(rev.varianceMxn), 'variance', 'sales_delete']);
      }
      return { ok: true, id, restored: inv._lines.length };
    });
    if (out.error) return reply.code(out.code || 400).send({ error: out.error, paid: out.paid });
    await logEvent({ userId, deviceId: req.ctx.deviceId, action: 'delete', target: `sales_invoice:${id}`, detail: { restored: out.restored } });
    return out;
  });

  // 변경요청 대기 목록 (디렉터)
  app.get('/api/sales/change-requests/pending', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(
      `SELECT cr.id, cr.invoice_id, cr.req_type, cr.payload, cr.reason, cr.requested_at,
              s.sat_no, s.inv_date, s.total_mxn, s.credit_days,
              c.code AS customer_code, c.name AS customer_name
         FROM sales_change_requests cr
         JOIN sales_invoices s ON s.id=cr.invoice_id
         JOIN customers c ON c.id=s.customer_id
        WHERE cr.status='pending' ORDER BY cr.requested_at`)).rows;
    return { items: rows };
  });

  // 변경요청 상세 미리보기 (디렉터) — 전/후 비교 + 예상 정산차액 (DB 변경 없음)
  app.get('/api/sales/change-requests/:reqId/detail', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const reqId = Number(req.params.reqId);
    const cr = (await query(`SELECT * FROM sales_change_requests WHERE id=$1`, [reqId])).rows[0];
    if (!cr) return reply.code(404).send({ error: 'not_found' });
    const inv = (await query(`SELECT * FROM sales_invoices WHERE id=$1`, [cr.invoice_id])).rows[0];
    if (!inv) return reply.code(404).send({ error: 'invoice_not_found' });
    const cust = (await query(`SELECT discount, credit_days, code, name FROM customers WHERE id=$1`, [inv.customer_id])).rows[0];
    const origRows = (await query(
      `SELECT l.product_id, l.qty, l.list_price, l.discount_rate, l.unit_price, l.line_amount_mxn, l.applied_unit_cost, l.cogs_mxn, p.code, p.name
         FROM sales_invoice_lines l JOIN products p ON p.id=l.product_id WHERE l.invoice_id=$1 ORDER BY l.id`, [cr.invoice_id])).rows;
    const closedList = (await query(`SELECT period FROM period_closings`)).rows.map((r) => r.period);
    const closedMonth = isClosedMonth(ymd(inv.inv_date), closedList);

    const origLinesCalc = origRows.map((l) => ({ productId: l.product_id, qty: Number(l.qty), appliedUnitCost: Number(l.applied_unit_cost), lineAmountMxn: Number(l.line_amount_mxn) }));

    const base = {
      reqId, type: cr.req_type, reason: cr.reason, closedMonth,
      invoice: { id: inv.id, sat_no: inv.sat_no, inv_date: ymd(inv.inv_date), credit_days: inv.credit_days, due_date: inv.due_date ? ymd(inv.due_date) : null, subtotal_mxn: Number(inv.subtotal_mxn), iva_mxn: Number(inv.iva_mxn), total_mxn: Number(inv.total_mxn) },
      customer: { code: cust.code, name: cust.name, base_credit_days: Number(cust.credit_days) || 0 },
      origLines: origRows.map((l) => ({ product_id: l.product_id, code: l.code, name: l.name, qty: Number(l.qty), discount_rate: Number(l.discount_rate), unit_price: Number(l.unit_price), line_amount_mxn: Number(l.line_amount_mxn) })),
    };

    if (cr.req_type === 'delete') {
      const rev = computeDeleteReversal({ origLines: origLinesCalc, closedMonth });
      return { ...base, mode: rev.mode, varianceMxn: rev.varianceMxn,
        effect: { stockRestore: rev.stockRestore, cogsReversal: rev.cogsReversal, salesReversal: rev.salesReversal } };
    }

    // edit: 변경 후 라인 계산(현재 평균원가 스냅샷)
    const payload = typeof cr.payload === 'string' ? JSON.parse(cr.payload) : cr.payload;
    const custDiscount = Number(cust.discount) || 0;
    const baseDays = Number(cust.credit_days) || 0;
    const newLines = [];
    const linesForTotals = [];
    for (const l of payload.lines) {
      const p = (await query(`SELECT id, code, name, list_price, stock_qty, avg_cost FROM products WHERE id=$1`, [l.product_id])).rows[0];
      if (!p) continue;
      const discRate = (l.discount_rate == null || l.discount_rate === '') ? custDiscount : Number(l.discount_rate);
      const line = computeLine({ qty: l.qty, listPrice: p.list_price, discountRate: discRate, cost: p.avg_cost });
      linesForTotals.push(line);
      newLines.push({ product_id: p.id, code: p.code, name: p.name, qty: line.qty, discount_rate: line.discountRate, unit_price: line.unitPrice, line_amount_mxn: line.lineAmountMxn, applied_unit_cost: line.appliedUnitCost, cogs_mxn: line.cogsMxn, stock_qty: Number(p.stock_qty) });
    }
    const newTotals = computeInvoiceTotals(linesForTotals, Number(inv.iva_rate) || 16);
    const newLinesCalc = newLines.map((l) => ({ productId: l.product_id, qty: l.qty, appliedUnitCost: l.applied_unit_cost, lineAmountMxn: l.line_amount_mxn }));
    const net = computeEditNetEffect({ origLines: origLinesCalc, newLines: newLinesCalc, closedMonth });
    const appliedDays = (payload.credit_days == null || payload.credit_days === '') ? baseDays : Number(payload.credit_days);
    const due = dueDate(payload.inv_date || inv.inv_date, appliedDays);

    // 재고 가능 여부 사전 점검(되돌림분 포함)
    const restore = {}; for (const l of origLinesCalc) restore[l.productId] = (restore[l.productId] || 0) + l.qty;
    const shortages = [];
    for (const l of newLines) {
      const avail = l.stock_qty + (restore[l.product_id] || 0);
      if (l.qty > avail) shortages.push({ code: l.code, requested: l.qty, available: avail, shortage: round2(l.qty - avail) });
    }

    return { ...base, mode: net.mode, varianceMxn: net.varianceMxn,
      newLines: newLines.map((l) => ({ product_id: l.product_id, code: l.code, name: l.name, qty: l.qty, discount_rate: l.discount_rate, unit_price: l.unit_price, line_amount_mxn: l.line_amount_mxn })),
      newTotals: { subtotal_mxn: newTotals.subtotalMxn, iva_mxn: newTotals.ivaMxn, total_mxn: newTotals.totalMxn },
      newCreditDays: appliedDays, newDueDate: due,
      stockOk: shortages.length === 0, shortages };
  });

  // 변경요청 반려 (디렉터) — 원본 상태 복귀
  app.post('/api/sales/change-requests/:reqId/reject', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const reqId = Number(req.params.reqId);
    const out = await withTx(async (c) => {
      const cr = (await c.query(`SELECT * FROM sales_change_requests WHERE id=$1`, [reqId])).rows[0];
      if (!cr || cr.status !== 'pending') return { error: 'not_pending' };
      await c.query(`UPDATE sales_change_requests SET status='rejected', decided_by=$1, decided_at=now() WHERE id=$2`, [req.ctx.perm.userId, reqId]);
      await c.query(`UPDATE sales_invoices SET status='posted' WHERE id=$1`, [cr.invoice_id]);
      return { ok: true };
    });
    if (out.error) return reply.code(409).send(out);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `sales_change_request:${reqId}`, detail: { rejected: true } });
    return out;
  });

  // 변경요청 승인 (디렉터) — 트랜잭션으로 되돌림+재적용, 마감월 규칙
  app.post('/api/sales/change-requests/:reqId/approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const reqId = Number(req.params.reqId);
    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const cr = (await c.query(`SELECT * FROM sales_change_requests WHERE id=$1`, [reqId])).rows[0];
      if (!cr || cr.status !== 'pending') return { error: 'not_pending' };
      const inv = await loadInvoiceForChange(c, cr.invoice_id);
      if (!inv) return { error: 'invoice_not_found' };
      const closed = inv._closedMonth;

      // 원본 효과 되돌림: 재고 복원(원가 스냅샷으로 'in' 이동), AR 취소
      async function reverseOriginalStock() {
        for (const l of inv._lines) {
          await c.query(`UPDATE products SET stock_qty = stock_qty + $1, updated_by=$2 WHERE id=$3`, [l.qty, userId, l.productId]);
          await c.query(
            `INSERT INTO stock_movements (product_id, move_type, qty, unit_cost_mxn, ref, sales_invoice_id, created_by)
             VALUES ($1,'in',$2,$3,$4,$5,$6)`,
            [l.productId, l.qty, l.appliedUnitCost, `sales_reverse:${inv.id}`, inv.id, userId]);
        }
      }
      // 정산차액/소급 정정 기록(기록만, 거래전기는 후속)
      async function recordVariance(varianceMxn, kind, source) {
        if (!varianceMxn) return;
        await c.query(
          `INSERT INTO cogs_adjustments (doc_id, sales_invoice_id, product_id, sale_date, qty, diff_mxn, kind, source)
           VALUES (NULL,$1,$2,$3,$4,$5,$6,$7)`,
          [inv.id, inv._lines[0]?.productId || null, ymd(inv.inv_date), null, round2(varianceMxn), kind, source]);
      }

      if (cr.req_type === 'delete') {
        const rev = computeDeleteReversal({ origLines: inv._lines, closedMonth: closed });
        await reverseOriginalStock();
        // AR(입금예정) 취소
        if (inv.txn_id) await c.query(`UPDATE transactions SET deleted_at=now(), updated_by=$1 WHERE id=$2`, [userId, inv.txn_id]);
        // 원장 out 무효화 표시는 reverse 'in'으로 상쇄됨. 인보이스 소프트 삭제.
        await c.query(`UPDATE sales_invoices SET status='deleted', deleted_at=now(), updated_by=$1 WHERE id=$2`, [userId, inv.id]);
        await recordVariance(rev.varianceMxn, 'variance', 'sales_delete');
        await c.query(`UPDATE sales_change_requests SET status='approved', decided_by=$1, decided_at=now() WHERE id=$2`, [userId, reqId]);
        return { ok: true, type: 'delete', mode: rev.mode, variance: rev.varianceMxn };
      }

      // 수정: 원본 되돌림 + 새 내용 재적용
      const payload = typeof cr.payload === 'string' ? JSON.parse(cr.payload) : cr.payload;
      const cust = (await c.query(`SELECT discount, credit_days FROM customers WHERE id=$1`, [inv.customer_id])).rows[0];
      const custDiscount = Number(cust.discount) || 0;
      const baseDays = Number(cust.credit_days) || 0;

      // 새 라인 계산(현재 평균원가 스냅샷)
      const newComputed = [];
      for (const l of payload.lines) {
        const p = (await c.query(`SELECT id, code, list_price, stock_qty, avg_cost FROM products WHERE id=$1 AND deleted_at IS NULL`, [l.product_id])).rows[0];
        if (!p) return { error: `product_not_found:${l.product_id}` };
        const discRate = (l.discount_rate == null || l.discount_rate === '') ? custDiscount : Number(l.discount_rate);
        const line = computeLine({ qty: l.qty, listPrice: p.list_price, discountRate: discRate, cost: p.avg_cost });
        newComputed.push({ ...line, product_id: p.id, code: p.code, _stock: Number(p.stock_qty) });
      }
      const newLinesForCalc = newComputed.map((l) => ({ productId: l.product_id, qty: l.qty, appliedUnitCost: l.appliedUnitCost, lineAmountMxn: l.lineAmountMxn }));
      const net = computeEditNetEffect({ origLines: inv._lines, newLines: newLinesForCalc, closedMonth: closed });

      // 재고 가능 여부 점검: 되돌림(+orig) 후 새로 차감(-new). 순변화가 음수이고 재고 부족이면 막음.
      // 원본 복원분을 먼저 더한 가용재고로 판단.
      const restore = {};
      for (const l of inv._lines) restore[l.productId] = (restore[l.productId] || 0) + l.qty;
      const shortages = [];
      for (const l of newComputed) {
        const avail = l._stock + (restore[l.product_id] || 0);
        if (l.qty > avail) shortages.push({ code: l.code, requested: l.qty, available: avail, shortage: round2(l.qty - avail) });
      }
      if (shortages.length) return { error: 'stock_short', shortages };

      // 1) 원본 되돌림(재고 복원)
      await reverseOriginalStock();
      // 2) 기존 라인 제거 전, 그 라인을 참조하는 재고이동(out)의 line 참조를 끊는다(원장 행은 이력으로 보존).
      await c.query(`UPDATE stock_movements SET sales_invoice_line_id=NULL WHERE sales_invoice_id=$1 AND sales_invoice_line_id IS NOT NULL`, [inv.id]);
      await c.query(`DELETE FROM sales_invoice_lines WHERE invoice_id=$1`, [inv.id]);
      // 3) 새 라인 적용(재고 차감 + 원장 out)
      const totals = computeInvoiceTotals(newComputed, Number(inv.iva_rate) || 16);
      for (const ln of newComputed) {
        const lineRow = (await c.query(
          `INSERT INTO sales_invoice_lines (invoice_id, product_id, qty, list_price, discount_rate, unit_price, line_amount_mxn, applied_unit_cost, cogs_mxn)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [inv.id, ln.product_id, ln.qty, ln.listPrice, ln.discountRate, ln.unitPrice, ln.lineAmountMxn, ln.appliedUnitCost, ln.cogsMxn])).rows[0];
        await c.query(`UPDATE products SET stock_qty = stock_qty - $1, updated_by=$2 WHERE id=$3`, [ln.qty, userId, ln.product_id]);
        await c.query(
          `INSERT INTO stock_movements (product_id, move_type, qty, unit_cost_mxn, ref, sales_invoice_id, sales_invoice_line_id, moved_at, created_by)
           VALUES ($1,'out',$2,$3,$4,$5,$6,$7,$8)`,
          [ln.product_id, ln.qty, ln.appliedUnitCost, `sales:${inv.id}`, inv.id, lineRow.id, inv.inv_date, userId]);
      }
      // 4) 외상일/예외(디렉터 수정승인에 흡수: 예외라도 승인된 것으로 확정)
      const appliedDays = (payload.credit_days == null || payload.credit_days === '') ? baseDays : Number(payload.credit_days);
      const exception = isCreditException(appliedDays, baseDays);
      const due = dueDate(payload.inv_date || inv.inv_date, appliedDays);
      await c.query(
        `UPDATE sales_invoices SET sat_no=COALESCE($1,sat_no), inv_date=COALESCE($2,inv_date),
           credit_days=$3, due_date=$4, credit_exception=$5, credit_approved=true,
           subtotal_mxn=$6, iva_mxn=$7, total_mxn=$8, status='posted', updated_by=$9 WHERE id=$10`,
        [payload.sat_no, payload.inv_date, appliedDays, due, exception, totals.subtotalMxn, totals.ivaMxn, totals.totalMxn, userId, inv.id]);
      // 5) AR 갱신
      if (inv.txn_id) await c.query(`UPDATE transactions SET txn_date=$1, amount=$2, amount_mxn=$2, updated_by=$3 WHERE id=$4`, [due, totals.totalMxn, userId, inv.txn_id]);
      // 6) 정산차액 기록(마감월)
      await recordVariance(net.varianceMxn, 'variance', 'sales_edit');
      await c.query(`UPDATE sales_change_requests SET status='approved', decided_by=$1, decided_at=now() WHERE id=$2`, [userId, reqId]);
      return { ok: true, type: 'edit', mode: net.mode, totals, due, exception, variance: net.varianceMxn };
    });
    if (out.error === 'stock_short') return reply.code(409).send(out);
    if (out.error) return reply.code(409).send(out);
    await logEvent({ userId, action: 'update', target: `sales_change_request:${reqId}`, detail: { approved: true, type: out.type } });
    return out;
  });
}
