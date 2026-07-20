import { query, withTx } from '../db.js';
import { authGuard, requirePage } from '../middleware/authGuard.js';
import { verifyPin } from '../auth.js';
import { logEvent } from '../audit.js';

// build 20260718a-inbound
// 수입 입고(Recepción): 패킹리스트 업로드 → 팔렛/검수/적치 → 마감(구매 received_qty 연동)
//   재고/평균원가는 건드리지 않음(기존 수입원가 승인에서 반영). 창고는 수량·위치만.

const num = (v) => (v == null ? 0 : Number(v));
const int = (v) => Math.round(num(v));

// 패킹리스트 원본 rows([{order_no, pl_no, code, cartons, qty, desc}])를
// 팔렛(ORDER NO+PL NO) → SKU별로 집계. code→product 매칭은 호출부에서 주입.
function aggregate(rows) {
  const pallets = new Map(); // key: order_no|pl_no
  for (const r of rows || []) {
    const order_no = String(r.order_no || '').trim();
    const code = String(r.code || '').trim();
    if (!order_no || !code) continue;
    const pl_no = int(r.pl_no);
    const cartons = int(r.cartons);
    const qty = num(r.qty);
    if (cartons <= 0 || qty <= 0) continue;
    const pk = order_no + '|' + pl_no;
    if (!pallets.has(pk)) pallets.set(pk, { order_no, pl_no, items: new Map() });
    const items = pallets.get(pk).items;
    if (!items.has(code)) items.set(code, { code, cartons: 0, qty: 0, desc: String(r.desc || '').slice(0, 60) });
    const it = items.get(code);
    it.cartons += cartons; it.qty += qty;
  }
  return [...pallets.values()].map((p) => ({
    order_no: p.order_no, pl_no: p.pl_no,
    items: [...p.items.values()],
  })).sort((a, b) => a.order_no.localeCompare(b.order_no) || a.pl_no - b.pl_no);
}

// 코드 목록 → product_id 매핑(코드=CTR NO는 products.code로 매칭). 미등록은 null.
async function matchProducts(q, codes) {
  const uniq = [...new Set(codes)];
  if (!uniq.length) return {};
  const { rows } = await q(
    `SELECT id, code, rack_location FROM products WHERE deleted_at IS NULL AND code = ANY($1)`,
    [uniq]);
  const map = {};
  for (const r of rows) map[r.code] = { id: Number(r.id), rack: r.rack_location || null };
  return map;
}

function summarize(pallets, pmap) {
  const skus = new Set(); let cartons = 0, qty = 0;
  const unmatched = new Set(), norack = new Set();
  for (const p of pallets) for (const it of p.items) {
    skus.add(it.code); cartons += it.cartons; qty += it.qty;
    const m = pmap[it.code];
    if (!m) unmatched.add(it.code);
    else if (!m.rack) norack.add(it.code);
  }
  return {
    pallets: pallets.length, cartons, qty, skus: skus.size,
    orders: [...new Set(pallets.map((p) => p.order_no))],
    unmatched: [...unmatched], norack: [...norack],
  };
}

export default async function inboundRoutes(app) {
  const g = { preHandler: [authGuard, requirePage('warehouse')] };

  // 패킹리스트 미리보기(검증만, 저장 안 함) --------------------------
  app.post('/api/inbound/preview', g, async (req) => {
    const pallets = aggregate(req.body?.rows);
    if (!pallets.length) return { error: 'empty' };
    const codes = []; pallets.forEach((p) => p.items.forEach((i) => codes.push(i.code)));
    const pmap = await matchProducts(query, codes);
    return { ok: true, summary: summarize(pallets, pmap), invoice_no: req.body?.invoice_no || null };
  });

  // 선적 생성(패킹리스트 확정 + ETA) ---------------------------------
  app.post('/api/inbound', g, async (req) => {
    const uid = req.ctx.perm.userId;
    const invoice_no = String(req.body?.invoice_no || '').trim() || null;
    const eta = req.body?.eta ? String(req.body.eta).slice(0, 10) : null;
    const pallets = aggregate(req.body?.rows);
    if (!pallets.length) return { error: 'empty' };
    if (!eta) return { error: 'eta_required' };
    const codes = []; pallets.forEach((p) => p.items.forEach((i) => codes.push(i.code)));
    const pmap = await matchProducts(query, codes);

    const shipmentId = await withTx(async (c) => {
      const q = c.query.bind(c);
      const s = (await q(
        `INSERT INTO inbound_shipments (invoice_no, eta, status, created_by)
         VALUES ($1,$2,'incoming',$3) RETURNING id`, [invoice_no, eta, uid])).rows[0];
      for (const p of pallets) {
        const cartons = p.items.reduce((a, i) => a + i.cartons, 0);
        const qty = p.items.reduce((a, i) => a + i.qty, 0);
        const pal = (await q(
          `INSERT INTO inbound_pallets (shipment_id, order_no, pl_no, status, cartons_expected, qty_expected)
           VALUES ($1,$2,$3,'wait',$4,$5) RETURNING id`,
          [s.id, p.order_no, p.pl_no, cartons, qty])).rows[0];
        for (const it of p.items) {
          const pid = pmap[it.code] ? pmap[it.code].id : null;
          await q(
            `INSERT INTO inbound_pallet_items
               (pallet_id, shipment_id, product_id, input_code, cartons, qty)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [pal.id, s.id, pid, it.code, it.cartons, it.qty]);
        }
      }
      return s.id;
    });
    await logEvent({ userId: uid, deviceId: req.ctx.deviceId, action: 'inbound_create', target: 'inbound:' + shipmentId, detail: { invoice_no, pallets: pallets.length } });
    return { ok: true, id: shipmentId };
  });

  // 선적 목록 --------------------------------------------------------
  app.get('/api/inbound', g, async () => {
    const { rows } = await query(
      `SELECT s.id, s.invoice_no, s.eta, s.status, s.created_at, s.closed_at,
              COUNT(DISTINCT pl.id)::int AS pallets,
              COALESCE(SUM(pi.cartons),0)::int AS cartons,
              COALESCE(SUM(pi.qty),0)      AS qty,
              COUNT(DISTINCT pl.id) FILTER (WHERE pl.status IN ('checked','done'))::int AS pallets_checked
         FROM inbound_shipments s
         LEFT JOIN inbound_pallets pl ON pl.shipment_id = s.id
         LEFT JOIN inbound_pallet_items pi ON pi.shipment_id = s.id
        WHERE s.deleted_at IS NULL
        GROUP BY s.id
        ORDER BY s.created_at DESC
        LIMIT 100`);
    return {
      items: rows.map((r) => ({
        id: Number(r.id), invoice_no: r.invoice_no, eta: r.eta, status: r.status,
        pallets: r.pallets, pallets_checked: r.pallets_checked,
        cartons: r.cartons, qty: num(r.qty),
        created_at: r.created_at, closed_at: r.closed_at,
      })),
    };
  });

  // 선적 상세(팔렛 + SKU별 라인) -------------------------------------
  app.get('/api/inbound/:id', g, async (req) => {
    const id = Number(req.params.id);
    const s = (await query(`SELECT * FROM inbound_shipments WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!s) return { error: 'not_found' };
    const pals = (await query(
      `SELECT id, order_no, pl_no, status, cartons_expected, qty_expected, checked_at
         FROM inbound_pallets WHERE shipment_id=$1 ORDER BY order_no, pl_no`, [id])).rows;
    const items = (await query(
      `SELECT pi.id, pi.pallet_id, pi.product_id, pi.input_code, pi.cartons, pi.qty,
              pi.scanned_cartons, pi.put_cartons, pi.rack_saved,
              p.name AS product_name, p.rack_location
         FROM inbound_pallet_items pi
         LEFT JOIN products p ON p.id = pi.product_id
        WHERE pi.shipment_id=$1`, [id])).rows;
    const byPal = {};
    for (const it of items) {
      (byPal[it.pallet_id] = byPal[it.pallet_id] || []).push({
        id: Number(it.id), product_id: it.product_id ? Number(it.product_id) : null,
        code: it.input_code, name: it.product_name || null,
        cartons: it.cartons, qty: num(it.qty),
        scanned_cartons: it.scanned_cartons, put_cartons: it.put_cartons,
        rack: it.rack_saved || it.rack_location || null,
        registered: it.product_id != null,
      });
    }
    return {
      shipment: { id: Number(s.id), invoice_no: s.invoice_no, eta: s.eta, status: s.status },
      pallets: pals.map((p) => ({
        id: Number(p.id), order_no: p.order_no, pl_no: p.pl_no, status: p.status,
        cartons_expected: p.cartons_expected, qty_expected: num(p.qty_expected),
        items: byPal[p.id] || [],
      })),
    };
  });

  // 하차 ------------------------------------------------------------
  app.post('/api/inbound/:id/pallets/:pid/unload', g, async (req) => {
    const pid = Number(req.params.pid);
    const r = await query(
      `UPDATE inbound_pallets SET status='unloaded'
        WHERE id=$1 AND shipment_id=$2 AND status='wait' RETURNING id`,
      [pid, Number(req.params.id)]);
    if (!r.rows.length) return { error: 'bad_state' };
    await query(`UPDATE inbound_shipments SET status='receiving' WHERE id=$1 AND status='incoming'`, [Number(req.params.id)]);
    return { ok: true };
  });

  // 검수 확정(프론트가 카톤 스캔으로 채운 카톤수 반영) ----------------
  //   body: { items: [{item_id, scanned_cartons}] }
  app.post('/api/inbound/:id/pallets/:pid/check', g, async (req) => {
    const uid = req.ctx.perm.userId;
    const id = Number(req.params.id), pid = Number(req.params.pid);
    const list = Array.isArray(req.body?.items) ? req.body.items : [];
    return await withTx(async (c) => {
      const q = c.query.bind(c);
      const pal = (await q(
        `SELECT id, status FROM inbound_pallets WHERE id=$1 AND shipment_id=$2 FOR UPDATE`, [pid, id])).rows[0];
      if (!pal) return { error: 'not_found' };
      if (pal.status === 'done') return { error: 'already_done' };
      const items = (await q(`SELECT id, cartons FROM inbound_pallet_items WHERE pallet_id=$1`, [pid])).rows;
      const exp = {}; items.forEach((i) => (exp[Number(i.id)] = i.cartons));
      for (const row of list) {
        const iid = Number(row.item_id);
        if (!(iid in exp)) continue;
        const sc = Math.max(0, Math.min(int(row.scanned_cartons), exp[iid])); // 초과 스캔 차단
        await q(`UPDATE inbound_pallet_items SET scanned_cartons=$1 WHERE id=$2`, [sc, iid]);
      }
      await q(`UPDATE inbound_pallets SET status='checked', checked_by=$1, checked_at=now() WHERE id=$2`, [uid, pid]);
      return { ok: true };
    });
  });

  // 적치(존→랙 스캔 결과 반영, 신규 SKU 랙 저장) ---------------------
  //   body: { items: [{item_id, put_cartons, rack, save_rack}] }
  app.post('/api/inbound/:id/pallets/:pid/putaway', g, async (req) => {
    const uid = req.ctx.perm.userId;
    const id = Number(req.params.id), pid = Number(req.params.pid);
    const list = Array.isArray(req.body?.items) ? req.body.items : [];
    return await withTx(async (c) => {
      const q = c.query.bind(c);
      const pal = (await q(
        `SELECT id, status FROM inbound_pallets WHERE id=$1 AND shipment_id=$2 FOR UPDATE`, [pid, id])).rows[0];
      if (!pal) return { error: 'not_found' };
      const items = (await q(
        `SELECT id, product_id, cartons FROM inbound_pallet_items WHERE pallet_id=$1`, [pid])).rows;
      const map = {}; items.forEach((i) => (map[Number(i.id)] = i));
      for (const row of list) {
        const iid = Number(row.item_id); const it = map[iid];
        if (!it) continue;
        const pc = Math.max(0, Math.min(int(row.put_cartons), it.cartons));
        const rack = row.rack ? String(row.rack).trim().slice(0, 40) : null;
        await q(`UPDATE inbound_pallet_items SET put_cartons=$1, rack_saved=$2 WHERE id=$3`, [pc, rack, iid]);
        // 랙 저장: 제품 마스터 위치 갱신(신규/변경) — 재고실사와 동일하게 위치만
        if (row.save_rack && rack && it.product_id) {
          await q(`UPDATE products SET rack_location=$1, updated_by=$2 WHERE id=$3`, [rack, uid, it.product_id]);
        }
      }
      // 모든 라인이 적치되면 done
      const rem = (await q(
        `SELECT COUNT(*)::int AS n FROM inbound_pallet_items WHERE pallet_id=$1 AND put_cartons < cartons`, [pid])).rows[0].n;
      await q(`UPDATE inbound_pallets SET status=$1 WHERE id=$2`, [rem === 0 ? 'done' : 'checking', pid]);
      return { ok: true, done: rem === 0 };
    });
  });

  // 마감 — 디렉터 PIN → 구매 received_qty 연동 -----------------------
  app.post('/api/inbound/:id/close', g, async (req) => {
    const uid = req.ctx.perm.userId;
    const id = Number(req.params.id);
    const pinRow = (await query(`SELECT pin_hash FROM users WHERE id=$1`, [uid])).rows[0];
    if (!verifyPin(String(req.body?.pin || ''), pinRow?.pin_hash)) return { error: 'bad_pin' };

    return await withTx(async (c) => {
      const q = c.query.bind(c);
      const s = (await q(`SELECT id, status FROM inbound_shipments WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0];
      if (!s) return { error: 'not_found' };
      if (s.status === 'closed') return { error: 'already_closed' };

      // 검수된 팔렛의 확정 수량을 ORDER NO(=구매 ref_no) × product 로 집계
      const recv = (await q(
        `SELECT pl.order_no, pi.product_id, SUM(pi.qty) AS qty
           FROM inbound_pallets pl
           JOIN inbound_pallet_items pi ON pi.pallet_id = pl.id
          WHERE pl.shipment_id=$1 AND pl.status IN ('checked','done') AND pi.product_id IS NOT NULL
          GROUP BY pl.order_no, pi.product_id`, [id])).rows;

      let updated = 0;
      const perOrder = {};
      for (const r of recv) {
        const qty = num(r.qty);
        perOrder[r.order_no] = (perOrder[r.order_no] || 0) + qty;
        // 해당 ORDER NO(ref_no) 발주의 그 product 라인에 입고 반영(잔량 한도)
        const line = (await q(
          `SELECT l.id, l.qty, l.received_qty
             FROM purchase_order_lines l
             JOIN purchase_orders po ON po.id = l.po_id
            WHERE po.ref_no=$1 AND l.product_id=$2 AND po.deleted_at IS NULL AND po.status<>'cancelled'
            ORDER BY (l.qty - l.received_qty) DESC
            LIMIT 1`, [r.order_no, r.product_id])).rows[0];
        if (line) {
          const room = num(line.qty) - num(line.received_qty);
          const add = Math.max(0, Math.min(qty, room));
          if (add > 0) {
            await q(`UPDATE purchase_order_lines SET received_qty = received_qty + $1 WHERE id=$2`, [add, line.id]);
            updated += 1;
          }
        }
      }
      await q(`UPDATE inbound_shipments SET status='closed', closed_by=$1, closed_at=now() WHERE id=$2`, [uid, id]);
      await logEvent({ userId: uid, deviceId: req.ctx.deviceId, action: 'inbound_close', target: 'inbound:' + id, detail: { po_lines_updated: updated } });
      return { ok: true, po_lines_updated: updated, orders: perOrder };
    });
  });

  // 선적 취소(디렉터) ------------------------------------------------
  app.delete('/api/inbound/:id', { preHandler: [authGuard, requirePage('warehouse')] }, async (req) => {
    const uid = req.ctx.perm.userId;
    const id = Number(req.params.id);
    const pinRow = (await query(`SELECT pin_hash, role FROM users WHERE id=$1`, [uid])).rows[0];
    if (pinRow?.role !== 'director') return { error: 'director_only' };
    if (!verifyPin(String(req.body?.pin || ''), pinRow?.pin_hash)) return { error: 'bad_pin' };
    const r = await query(
      `UPDATE inbound_shipments SET status='cancelled', deleted_at=now()
        WHERE id=$1 AND status<>'closed' AND deleted_at IS NULL RETURNING id`, [id]);
    if (!r.rows.length) return { error: 'bad_state' };
    return { ok: true };
  });
}
