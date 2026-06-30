import { query, withTx } from '../db.js';
import { authGuard, requirePage, requirePageEdit } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { bizMinutes } from '../businessHours.js';
import { maybeMarkPacked } from '../packedGate.js';

// =====================================================================
// Refatrix ERP · warehouseRoutes.js  (창고 모듈)
//   출고-1a: 포장지시 목록(포장 대기) + 드릴다운(포장할 품목).
//   · 권한: 'warehouse' 페이지(창고담당) + 디렉터 바이패스.
//   · 읽기 전용 — 재고·매출·단계에 아무 영향 없음(격리).
//   · 포장 대기 = 포장지시서 출력됨(packing_printed_at) + 미전환(invoice 없음).
//   · 드릴다운 = 즉시재고(in_stock) 라인만 (부족/개발 제외 — 견적 convert-preview와 동일 기준).
//     라인 = 즉시충당(min(reserved_qty, 현재고) >= qty)인 것만. 컬럼: CTR·SYD·EAN-13·수량·랙.
// =====================================================================
export default async function warehouseRoutes(app) {
  const num = (v) => (v == null ? null : Number(v));
  // 현재가 업무시간인가(월~금 07:30~17:00, UTC-6) — 클라가 실시간 틱을 켤지 판단용
  function inBusinessNow() {
    const mx = new Date(Date.now() - 6 * 3600000); // MX 벽시계를 UTC 필드로
    const dow = mx.getUTCDay(); if (dow < 1 || dow > 5) return false;
    const m = mx.getUTCHours() * 60 + mx.getUTCMinutes();
    return m >= 450 && m < 1020; // 07:30 ~ 17:00
  }

  // ---------- 포장 대기 목록 (오더목록처럼) ----------
  app.get('/api/warehouse/packing-queue', { preHandler: [authGuard, requirePage('warehouse')] }, async () => {
    const rows = (await query(
      `SELECT q.id, q.quote_no, q.customer_id, q.guest_name,
              c.name AS customer_name,
              q.packing_printed_at, q.packing_due_at,
              q.total_qty, q.sku_count, q.total_mxn
         FROM quotes q
         LEFT JOIN customers c ON c.id = q.customer_id
        WHERE q.packing_printed_at IS NOT NULL
          AND q.invoice_id IS NULL
          AND q.status NOT IN ('converted','cancelled')
          AND q.deleted_at IS NULL
        ORDER BY q.packing_printed_at ASC, q.id ASC`)).rows;

    const now = new Date();
    const items = rows.map((r) => ({
      quote_id: Number(r.id),
      quote_no: r.quote_no || null,
      customer: r.customer_name || r.guest_name || '—',
      is_guest: r.customer_id == null,
      printed_at: r.packing_printed_at,
      due_at: r.packing_due_at,
      overdue: r.packing_due_at ? (now.getTime() > new Date(r.packing_due_at).getTime()) : false,
      elapsed_biz_sec: r.packing_printed_at ? Math.floor(bizMinutes(r.packing_printed_at, now) * 60) : 0,
      total_qty: num(r.total_qty),
      sku_count: r.sku_count != null ? Number(r.sku_count) : null,
    }));
    return { count: items.length, in_business: inBusinessNow(), items };
  });

  // ---------- 드릴다운: 포장할 품목 (즉시재고 라인만) ----------
  app.get('/api/warehouse/packing-queue/:id', { preHandler: [authGuard, requirePage('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const q = (await query(
      `SELECT q.id, q.quote_no, q.customer_id, q.guest_name, c.name AS customer_name,
              q.packing_printed_at, q.packing_due_at, q.status, q.invoice_id
         FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id
        WHERE q.id=$1 AND q.deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });

    const lines = (await query(
      `SELECT l.line_no, l.ctr_code, l.syd_codes, l.qty, l.product_id, l.reserved_qty,
              p.ean, p.rack_location, p.scode, p.stock_qty
         FROM quote_lines l
         LEFT JOIN products p ON p.id = l.product_id
        WHERE l.quote_id = $1
        ORDER BY l.line_no, l.id`, [id])).rows;

    const items = [];
    let totalPieces = 0;
    for (const l of lines) {
      if (!l.product_id) continue;                       // 미등록(개발) 제외
      const qty = Number(l.qty) || 0;
      const physical = l.stock_qty != null ? Number(l.stock_qty) : 0;
      const fulfill = Math.max(0, Math.min(Number(l.reserved_qty) || 0, physical));
      if (fulfill < qty) continue;                        // 부족 라인 제외(즉시재고만)
      const syd = (l.syd_codes && String(l.syd_codes).trim()) || (l.scode && String(l.scode).trim()) || '';
      items.push({
        ctr_code: l.ctr_code || '',
        syd_code: syd,
        ean: l.ean || '',
        qty,
        rack_location: l.rack_location || '',
      });
      totalPieces += qty;
    }

    return {
      quote_id: Number(q.id),
      quote_no: q.quote_no || null,
      customer: q.customer_name || q.guest_name || '—',
      printed_at: q.packing_printed_at,
      due_at: q.packing_due_at,
      elapsed_biz_sec: q.packing_printed_at ? Math.floor(bizMinutes(q.packing_printed_at, new Date()) * 60) : 0,
      in_business: inBusinessNow(),
      sku_count: items.length,
      total_pieces: totalPieces,
      items,
    };
  });

  // ===================================================================
  // 출고-1b 패킹: 박스 분류 + EAN-13 스캔 (1스캔=1피스)
  //   · 권한: warehouse(쓰기는 edit) + 디렉터.
  //   · 포장 대상 = 즉시재고(in_stock) 라인만 (드릴다운과 동일 기준).
  //   · 스캔/박스 기록뿐 — 재고·매출전환 게이트는 1b-2에서.
  // ===================================================================

  // 포장 대상 라인(즉시재고만) — required 포함. 드릴다운과 동일 판정.
  async function packableLines(quoteId, exec = query) {
    const rows = (await exec(
      `SELECT l.line_no, l.ctr_code, l.syd_codes, l.qty, l.product_id, l.reserved_qty,
              p.ean, p.rack_location, p.scode, p.stock_qty
         FROM quote_lines l LEFT JOIN products p ON p.id=l.product_id
        WHERE l.quote_id=$1 ORDER BY l.line_no, l.id`, [quoteId])).rows;
    const out = [];
    for (const l of rows) {
      if (!l.product_id) continue;
      const qty = Number(l.qty) || 0;
      const physical = l.stock_qty != null ? Number(l.stock_qty) : 0;
      const fulfill = Math.max(0, Math.min(Number(l.reserved_qty) || 0, physical));
      if (fulfill < qty) continue;
      const syd = (l.syd_codes && String(l.syd_codes).trim()) || (l.scode && String(l.scode).trim()) || '';
      out.push({ product_id: Number(l.product_id), ctr_code: l.ctr_code || '', syd_code: syd,
                 ean: (l.ean || '').trim(), rack_location: l.rack_location || '', required: qty });
    }
    return out;
  }

  // EAN-13 매칭(리더기 앞자리 0 가감 폴백)
  async function findProductByEan(ean, exec = query) {
    const e = String(ean || '').trim();
    if (!e) return null;
    let r = (await exec(`SELECT id, code, ean FROM products WHERE TRIM(ean)=$1 AND deleted_at IS NULL LIMIT 1`, [e])).rows[0];
    if (r) return r;
    r = (await exec(`SELECT id, code, ean FROM products WHERE ltrim(TRIM(ean),'0')=ltrim($1,'0') AND deleted_at IS NULL LIMIT 1`, [e])).rows[0];
    return r || null;
  }

  // ---------- 패킹 상태(재개용 전체 스냅샷) ----------
  app.get('/api/warehouse/packing/:id', { preHandler: [authGuard, requirePage('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const q = (await query(
      `SELECT q.id, q.quote_no, q.customer_id, q.guest_name, c.name AS customer_name,
              q.packing_printed_at, q.packing_due_at, q.status, q.invoice_id
         FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id
        WHERE q.id=$1 AND q.deleted_at IS NULL`, [id])).rows[0];
    if (!q) return reply.code(404).send({ error: 'not_found' });

    const req2 = await packableLines(id);
    const scanned = {};
    (await query(`SELECT product_id, SUM(qty)::int AS q FROM packing_box_line WHERE quote_id=$1 GROUP BY product_id`, [id]))
      .rows.forEach((r) => { scanned[Number(r.product_id)] = Number(r.q) || 0; });

    let reqTotal = 0, scanTotal = 0;
    const items = req2.map((l) => {
      const sc = scanned[l.product_id] || 0;
      reqTotal += l.required; scanTotal += Math.min(sc, l.required);
      return { product_id: l.product_id, ctr_code: l.ctr_code, syd_code: l.syd_code, ean: l.ean,
               rack_location: l.rack_location, required: l.required, scanned: sc, remaining: Math.max(0, l.required - sc) };
    });

    // product_id → 경쟁사 코드(SYD) 매핑(포장목록 기준)
    const sydMap = {};
    req2.forEach((l) => { sydMap[l.product_id] = l.syd_code || ''; });

    const boxes = (await query(`SELECT id, box_no, sealed_at FROM packing_box WHERE quote_id=$1 ORDER BY box_no`, [id])).rows;
    const blines = (await query(
      `SELECT bl.box_id, bl.product_id, bl.qty, p.code AS ctr_code, p.ean
         FROM packing_box_line bl JOIN products p ON p.id=bl.product_id
        WHERE bl.quote_id=$1 AND bl.qty>0 ORDER BY bl.box_id, p.code`, [id])).rows;
    const photoCnt = {};
    (await query(`SELECT box_id, COUNT(*)::int AS n FROM packing_box_photo WHERE quote_id=$1 GROUP BY box_id`, [id]))
      .rows.forEach((r) => { photoCnt[Number(r.box_id)] = Number(r.n) || 0; });

    const boxOut = boxes.map((b) => ({
      box_id: Number(b.id), box_no: b.box_no, sealed: !!b.sealed_at,
      photo_count: photoCnt[Number(b.id)] || 0,
      lines: blines.filter((x) => Number(x.box_id) === Number(b.id))
                   .map((x) => ({ product_id: Number(x.product_id), ctr_code: x.ctr_code || '',
                                  syd_code: sydMap[Number(x.product_id)] || '', ean: x.ean || '', qty: Number(x.qty) })),
    }));
    // product_id → 담긴 박스번호(여러 개면 모두)
    const boxNoById = {}; boxes.forEach((b) => { boxNoById[Number(b.id)] = b.box_no; });
    const prodBoxNos = {};
    blines.forEach((x) => { const pid = Number(x.product_id); const bn = boxNoById[Number(x.box_id)];
      if (bn != null) { (prodBoxNos[pid] = prodBoxNos[pid] || []).push(bn); } });
    Object.keys(prodBoxNos).forEach((k) => { prodBoxNos[k] = Array.from(new Set(prodBoxNos[k])).sort((a, b) => a - b); });
    items.forEach((it) => { it.box_nos = prodBoxNos[it.product_id] || []; });
    const photosOk = boxOut.length > 0 && boxOut.every((b) => b.photo_count >= 1);

    return {
      quote_id: Number(q.id), quote_no: q.quote_no || null,
      customer: q.customer_name || q.guest_name || '—',
      printed_at: q.packing_printed_at,
      elapsed_biz_sec: q.packing_printed_at ? Math.floor(bizMinutes(q.packing_printed_at, new Date()) * 60) : 0,
      in_business: inBusinessNow(),
      required_total: reqTotal, scanned_total: scanTotal, remaining_total: Math.max(0, reqTotal - scanTotal),
      all_done: reqTotal > 0 && scanTotal >= reqTotal,
      photos_ok: photosOk,
      items, boxes: boxOut,
    };
  });

  // ---------- 새 박스(자동번호 Box N) ----------
  app.post('/api/warehouse/packing/:id/box', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const result = await withTx(async (c) => {
      const q = (await c.query(`SELECT id FROM quotes WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0];
      if (!q) return null;
      const next = (await c.query(`SELECT COALESCE(MAX(box_no),0)+1 AS n FROM packing_box WHERE quote_id=$1`, [id])).rows[0].n;
      const b = (await c.query(
        `INSERT INTO packing_box (quote_id, box_no, created_by) VALUES ($1,$2,$3) RETURNING id, box_no`,
        [id, next, req.ctx.perm.userId])).rows[0];
      return { box_id: Number(b.id), box_no: b.box_no };
    });
    if (!result) return reply.code(404).send({ error: 'not_found' });
    return result;
  });

  // ---------- 스캔(EAN-13, 1건=1피스) ----------
  app.post('/api/warehouse/packing/:id/scan', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const boxId = Number(req.body && req.body.box_id);
    const ean = String((req.body && req.body.ean) || '').trim();
    if (!ean) return reply.code(400).send({ error: 'no_ean' });

    const out = await withTx(async (c) => {
      const q = (await c.query(`SELECT id FROM quotes WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0];
      if (!q) return { http: 404, body: { error: 'not_found' } };

      const prod = await findProductByEan(ean, c.query.bind(c));
      const logScan = async (res, pid) => { await c.query(
        `INSERT INTO packing_scan (quote_id, box_id, product_id, ean, result, scanned_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, boxId || null, pid || null, ean, res, req.ctx.perm.userId]); };

      if (!prod) { await logScan('unknown', null); return { body: { result: 'unknown', ean } }; }

      const list = await packableLines(id, c.query.bind(c));
      const target = list.find((x) => x.product_id === Number(prod.id));
      if (!target) { await logScan('wrong', prod.id); return { body: { result: 'wrong', ean, ctr_code: prod.code || '' } }; }

      const sc = Number((await c.query(`SELECT COALESCE(SUM(qty),0)::int AS q FROM packing_box_line WHERE quote_id=$1 AND product_id=$2`, [id, prod.id])).rows[0].q) || 0;
      if (sc >= target.required) { await logScan('excess', prod.id); return { body: { result: 'excess', ean, ctr_code: target.ctr_code, required: target.required } }; }

      const box = (await c.query(`SELECT id, sealed_at FROM packing_box WHERE id=$1 AND quote_id=$2`, [boxId, id])).rows[0];
      if (!box) return { http: 400, body: { error: 'no_box', note: '먼저 박스를 만들어 주세요.' } };
      if (box.sealed_at) { await c.query(`UPDATE packing_box SET sealed_at=NULL WHERE id=$1`, [boxId]); } // 선택한 박스가 마감돼 있으면 자동 재오픈

      await c.query(
        `INSERT INTO packing_box_line (box_id, quote_id, product_id, qty) VALUES ($1,$2,$3,1)
           ON CONFLICT (box_id, product_id) DO UPDATE SET qty = packing_box_line.qty + 1, updated_at=now()`,
        [boxId, id, prod.id]);
      await logScan('ok', prod.id);

      const reqTotal = list.reduce((a, x) => a + x.required, 0);
      const scanTotal = Number((await c.query(`SELECT COALESCE(SUM(qty),0)::int AS q FROM packing_box_line WHERE quote_id=$1`, [id])).rows[0].q) || 0;
      const boxNo = (await c.query(`SELECT box_no FROM packing_box WHERE id=$1`, [boxId])).rows[0].box_no;
      return { body: { result: 'ok', ean, product_id: Number(prod.id), ctr_code: target.ctr_code, syd_code: target.syd_code, box_no: boxNo,
        scanned: sc + 1, required: target.required, remaining: Math.max(0, target.required - (sc + 1)),
        scanned_total: Math.min(scanTotal, reqTotal), required_total: reqTotal, all_done: scanTotal >= reqTotal } };
    });
    if (out.http) return reply.code(out.http).send(out.body);
    if (out.body && out.body.all_done) { try { await maybeMarkPacked(id); } catch (_) {} }
    return out.body;
  });

  // ---------- 언스캔(오스캔 정정: 박스에서 1개 빼기) ----------
  app.post('/api/warehouse/packing/:id/unscan', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const boxId = Number(req.body && req.body.box_id);
    const pid = Number(req.body && req.body.product_id);
    const out = await withTx(async (c) => {
      const q = (await c.query(`SELECT id FROM quotes WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0];
      if (!q) return { http: 404, body: { error: 'not_found' } };
      const ln = (await c.query(`SELECT id, qty FROM packing_box_line WHERE box_id=$1 AND product_id=$2 AND quote_id=$3`, [boxId, pid, id])).rows[0];
      if (!ln || Number(ln.qty) <= 0) return { http: 400, body: { error: 'nothing_to_undo' } };
      if (Number(ln.qty) <= 1) await c.query(`DELETE FROM packing_box_line WHERE id=$1`, [ln.id]);
      else await c.query(`UPDATE packing_box_line SET qty = qty - 1, updated_at = now() WHERE id=$1`, [ln.id]);
      await c.query(`INSERT INTO packing_scan (quote_id, box_id, product_id, ean, result, scanned_by) VALUES ($1,$2,$3,NULL,'undo',$4)`, [id, boxId, pid, req.ctx.perm.userId]);
      return { body: { ok: true } };
    });
    if (out.http) return reply.code(out.http).send(out.body);
    if (out.body && out.body.all_done) { try { await maybeMarkPacked(id); } catch (_) {} }
    return out.body;
  });

  // ---------- 박스 봉인/해제 ----------
  app.post('/api/warehouse/packing/:id/box/:boxId/seal', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id), boxId = Number(req.params.boxId);
    const seal = req.body && req.body.seal === false ? false : true;
    const b = (await query(`SELECT id FROM packing_box WHERE id=$1 AND quote_id=$2`, [boxId, id])).rows[0];
    if (!b) return reply.code(404).send({ error: 'not_found' });
    await query(`UPDATE packing_box SET sealed_at=$2 WHERE id=$1`, [boxId, seal ? new Date() : null]);
    return { ok: true, sealed: seal };
  });


  // ---------- 수동 추가(CTR 코드, 포장목록에 있는 제품만) ----------
  app.post('/api/warehouse/packing/:id/add', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const boxId = Number(req.body && req.body.box_id);
    const ctr = String((req.body && req.body.ctr_code) || '').trim();
    if (!ctr) return reply.code(400).send({ error: 'no_ctr' });

    const out = await withTx(async (c) => {
      const q = (await c.query(`SELECT id FROM quotes WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0];
      if (!q) return { http: 404, body: { error: 'not_found' } };

      const prod = (await c.query(`SELECT id, code, ean FROM products WHERE UPPER(TRIM(code))=UPPER($1) AND deleted_at IS NULL LIMIT 1`, [ctr.toUpperCase()])).rows[0];
      if (!prod) return { body: { result: 'wrong', ctr_code: ctr, note: '등록되지 않은 CTR 코드' } };

      const list = await packableLines(id, c.query.bind(c));
      const target = list.find((x) => x.product_id === Number(prod.id));
      if (!target) return { body: { result: 'wrong', ctr_code: prod.code || ctr, note: '이 주문(포장목록)에 없는 제품' } };

      const sc = Number((await c.query(`SELECT COALESCE(SUM(qty),0)::int AS q FROM packing_box_line WHERE quote_id=$1 AND product_id=$2`, [id, prod.id])).rows[0].q) || 0;
      if (sc >= target.required) return { body: { result: 'excess', ctr_code: target.ctr_code, required: target.required } };

      const box = (await c.query(`SELECT id, sealed_at FROM packing_box WHERE id=$1 AND quote_id=$2`, [boxId, id])).rows[0];
      if (!box) return { http: 400, body: { error: 'no_box' } };
      if (box.sealed_at) { await c.query(`UPDATE packing_box SET sealed_at=NULL WHERE id=$1`, [boxId]); } // 자동 재오픈

      await c.query(
        `INSERT INTO packing_box_line (box_id, quote_id, product_id, qty) VALUES ($1,$2,$3,1)
           ON CONFLICT (box_id, product_id) DO UPDATE SET qty = packing_box_line.qty + 1, updated_at = now()`,
        [boxId, id, prod.id]);
      await c.query(`INSERT INTO packing_scan (quote_id, box_id, product_id, ean, result, scanned_by) VALUES ($1,$2,$3,$4,'ok',$5)`,
        [id, boxId, prod.id, prod.ean || null, req.ctx.perm.userId]);

      const reqTotal = list.reduce((a, x) => a + x.required, 0);
      const scanTotal = Number((await c.query(`SELECT COALESCE(SUM(qty),0)::int AS q FROM packing_box_line WHERE quote_id=$1`, [id])).rows[0].q) || 0;
      const boxNo = (await c.query(`SELECT box_no FROM packing_box WHERE id=$1`, [boxId])).rows[0].box_no;
      return { body: { result: 'ok', product_id: Number(prod.id), ctr_code: target.ctr_code, syd_code: target.syd_code, ean: prod.ean || '', box_no: boxNo,
        scanned: sc + 1, required: target.required, remaining: Math.max(0, target.required - (sc + 1)),
        scanned_total: Math.min(scanTotal, reqTotal), required_total: reqTotal, all_done: scanTotal >= reqTotal } };
    });
    if (out.http) return reply.code(out.http).send(out.body);
    if (out.body && out.body.all_done) { try { await maybeMarkPacked(id); } catch (_) {} }
    return out.body;
  });

  // ---------- 박스 사진 업로드(여러 장 가능) ----------
  app.post('/api/warehouse/packing/:id/box/:boxId/photo', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id), boxId = Number(req.params.boxId);
    const img = String((req.body && req.body.image_data) || '');
    if (!img || img.length < 32 || !/^data:image\//i.test(img)) return reply.code(400).send({ error: 'bad_image' });
    const box = (await query(`SELECT id FROM packing_box WHERE id=$1 AND quote_id=$2`, [boxId, id])).rows[0];
    if (!box) return reply.code(404).send({ error: 'not_found' });
    const r = (await query(
      `INSERT INTO packing_box_photo (box_id, quote_id, image_data, uploaded_by) VALUES ($1,$2,$3,$4) RETURNING id`,
      [boxId, id, img, req.ctx.perm.userId])).rows[0];
    const n = Number((await query(`SELECT COUNT(*)::int AS n FROM packing_box_photo WHERE box_id=$1`, [boxId])).rows[0].n) || 0;
    try { await maybeMarkPacked(id); } catch (_) {}
    return { ok: true, photo_id: Number(r.id), count: n };
  });

  // ---------- 박스 사진 목록(이미지 데이터 포함) ----------
  app.get('/api/warehouse/packing/:id/photos', { preHandler: [authGuard, requirePage('warehouse')] }, async (req) => {
    const id = Number(req.params.id);
    const rows = (await query(
      `SELECT id, box_id, image_data, uploaded_at FROM packing_box_photo WHERE quote_id=$1 ORDER BY box_id, id`, [id])).rows;
    return { photos: rows.map((r) => ({ id: Number(r.id), box_id: Number(r.box_id), image_data: r.image_data, uploaded_at: r.uploaded_at })) };
  });

  // ---------- 박스 사진 삭제 ----------
  app.post('/api/warehouse/packing/:id/photo/:photoId/remove', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id), photoId = Number(req.params.photoId);
    const r = (await query(`DELETE FROM packing_box_photo WHERE id=$1 AND quote_id=$2 RETURNING box_id`, [photoId, id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });


  // ---------- 박스 삭제(담긴 내역·사진 함께 삭제, 스캔 이력은 보존) ----------
  app.post('/api/warehouse/packing/:id/box/:boxId/remove', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    const id = Number(req.params.id), boxId = Number(req.params.boxId);
    const r = (await query(`DELETE FROM packing_box WHERE id=$1 AND quote_id=$2 RETURNING id`, [boxId, id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    try { await maybeMarkPacked(id); } catch (_) {}
    return { ok: true };
  });


  // ---------- 영업지원 포장완료 알림 대상(스캔 0 + 모든 박스 사진≥1, ③ 종이문서 미업로드) ----------
  //   · 영업지원/디렉터 폴링용. 포장지시 출력됨 + 미전환 + packing_doc 없음 후보 중,
  //     즉시재고 라인 전부 스캔 완료 && 박스>0 && 모든 박스 사진≥1 인 견적만 반환.
  app.get('/api/warehouse/sales/packing-ready', { preHandler: [authGuard] }, async (req, reply) => {
    const role = req.ctx.perm.role;
    if (role !== 'sales_support' && role !== 'director') return reply.code(403).send({ error: 'forbidden' });
    const cands = (await query(
      `SELECT q.id, q.quote_no, q.total_mxn,
              COALESCE(c.name, q.guest_name, '\u2014') AS customer_name
         FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id
        WHERE q.deleted_at IS NULL
          AND q.packing_printed_at IS NOT NULL
          AND q.status NOT IN ('converted','cancelled','expired','delete_pending')
          AND NOT EXISTS (SELECT 1 FROM quote_packing_docs pd WHERE pd.quote_id=q.id)
        ORDER BY q.packing_printed_at`)).rows;
    const out = [];
    for (const q of cands) {
      const lines = await packableLines(q.id);
      if (!lines.length) continue;
      const scanned = {};
      (await query(`SELECT product_id, SUM(qty)::int AS s FROM packing_box_line WHERE quote_id=$1 GROUP BY product_id`, [q.id]))
        .rows.forEach((r) => { scanned[Number(r.product_id)] = Number(r.s) || 0; });
      const complete = lines.every((l) => (scanned[l.product_id] || 0) >= l.required);
      if (!complete) continue;
      const boxes = (await query(`SELECT id FROM packing_box WHERE quote_id=$1`, [q.id])).rows;
      if (!boxes.length) continue;
      const pc = {};
      (await query(`SELECT box_id, COUNT(*)::int AS n FROM packing_box_photo WHERE quote_id=$1 GROUP BY box_id`, [q.id]))
        .rows.forEach((r) => { pc[Number(r.box_id)] = Number(r.n) || 0; });
      const photosOk = boxes.every((b) => (pc[Number(b.id)] || 0) >= 1);
      if (!photosOk) continue;
      out.push({ quote_id: Number(q.id), quote_no: q.quote_no || ('#' + q.id), customer_name: q.customer_name,
                 sku_count: lines.length, total_qty: lines.reduce((a, l) => a + l.required, 0),
                 total_mxn: Number(q.total_mxn) || 0 });
    }
    return { count: out.length, items: out };
  });

}
