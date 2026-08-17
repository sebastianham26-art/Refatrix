import { query, withTx } from '../db.js';
import { authGuard, requirePage, requirePageAny } from '../middleware/authGuard.js';
import { verifyPin } from '../auth.js';
import { logEvent } from '../audit.js';
import { NEW_KEY } from './zoneRoutes.js';

// build 20260718a-inbound
// 수입 입고(Recepción): 패킹리스트 업로드 → 팔렛/검수/적치 → 마감(구매 received_qty 연동)
//   재고/평균원가는 건드리지 않음(기존 수입원가 승인에서 반영). 창고는 수량·위치만.

const num = (v) => (v == null ? 0 : Number(v));
const int = (v) => Math.round(num(v));

// 팔렛 점유 표시(0171) 유효 시간(초). 프런트 자동 갱신 주기 25초의 약 4배 + 여유.
// 하트비트가 끊기면(탭 닫힘·이동) 이 시간이 지나 자동으로 "작업 중"이 사라진다.
const WORKING_WINDOW_SECONDS = 120;

// 패킹리스트 원본 rows([{order_no, pl_no, code, cartons, qty, desc, box_from, box_to}])를
// 팔렛(ORDER NO+PL NO)으로 묶는다. code→product 매칭은 호출부에서 주입.
// ⚠ 라인을 합산하지 않는다(2026-08-17): 같은 SKU 라도 파일의 각 라인이 곧 카톤 묶음이고
//   라인마다 소입수량(qty÷cartons)이 다를 수 있다. 파일에 적힌 그대로 한 줄 = 한 행으로 보존한다.
function aggregate(rows) {
  const pallets = new Map(); // key: order_no|pl_no
  for (const r of rows || []) {
    const order_no = String(r.order_no || '').trim();
    const code = String(r.code || '').trim();
    if (!order_no || !code) continue;
    const pl_no = int(r.pl_no);
    const cartons = Math.max(0, int(r.cartons)); // 0 허용(2026-07-31): 카톤번호 없는 행(혼적 병합셀·낱개)도 수량 집계에 포함 — 스캔 대상만 아님
    const qty = num(r.qty);
    if (qty <= 0) continue;
    const pk = order_no + '|' + pl_no;
    if (!pallets.has(pk)) pallets.set(pk, { order_no, pl_no, items: [] });
    pallets.get(pk).items.push({
      code, cartons, qty, desc: String(r.desc || '').slice(0, 60),
      box_from: r.box_from == null ? null : int(r.box_from),
      box_to: r.box_to == null ? null : int(r.box_to),
    });
  }
  return [...pallets.values()].map((p) => ({
    order_no: p.order_no, pl_no: p.pl_no, items: p.items,   // 파일 등장 순서 유지
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
  const gView = { preHandler: [authGuard, requirePageAny(['warehouse', 'purchase'])] }; // 파일 열람: 창고+구매

  // 패킹리스트 원본 파일 검증(data URL base64) — bodyLimit 12MB 안에서 원본 약 8MB까지
  function validFile(b) {
    const name = String(b?.file_name || '').trim().slice(0, 200);
    const data = String(b?.file_data || '');
    if (!name || !data.startsWith('data:')) return null;
    if (data.length > 11.5 * 1024 * 1024) return { error: 'file_too_large' };
    const mime = (data.slice(5).split(/[;,]/)[0] || '').slice(0, 100) || null;
    return { name, data, mime, size: Math.round((data.length - (data.indexOf(',') + 1)) * 3 / 4) };
  }

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

    // 패킹리스트 원본 파일(선택) — 함께 저장해 ERP에서 재다운로드 가능하게
    const pf = (req.body && req.body.file_data) ? validFile(req.body) : null;
    if (pf && pf.error) return { error: pf.error };

    const shipmentId = await withTx(async (c) => {
      const q = c.query.bind(c);
      const s = (await q(
        `INSERT INTO inbound_shipments (invoice_no, eta, status, created_by)
         VALUES ($1,$2,'incoming',$3) RETURNING id`, [invoice_no, eta, uid])).rows[0];
      if (pf) {
        await q(
          `INSERT INTO inbound_packing_files (shipment_id, file_name, mime_type, file_data, file_size, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6)`, [s.id, pf.name, pf.mime, pf.data, pf.size, uid]);
      }
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
               (pallet_id, shipment_id, product_id, input_code, cartons, qty, box_from, box_to)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [pal.id, s.id, pid, it.code, it.cartons, it.qty, it.box_from, it.box_to]);
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
      `SELECT pl.id, pl.order_no, pl.pl_no, pl.status, pl.cartons_expected, pl.qty_expected, pl.checked_at,
              pl.working_by, pl.working_step, pl.working_at,
              (pl.working_at IS NOT NULL AND pl.working_at > now() - ($2 || ' seconds')::interval) AS working,
              u.name AS working_by_name
         FROM inbound_pallets pl
         LEFT JOIN users u ON u.id = pl.working_by
        WHERE pl.shipment_id=$1 ORDER BY pl.order_no, pl.pl_no`, [id, WORKING_WINDOW_SECONDS])).rows;
    const me = req.ctx.perm.userId;
    const items = (await query(
      `SELECT pi.id, pi.pallet_id, pi.product_id, pi.input_code, pi.cartons, pi.qty,
              pi.scanned_cartons, pi.put_cartons, pi.rack_saved, pi.box_from, pi.box_to,
              p.name AS product_name, p.rack_location,
              rz.zone AS rack_zone, wz.name AS rack_zone_name
         FROM inbound_pallet_items pi
         LEFT JOIN products p ON p.id = pi.product_id
         LEFT JOIN rack_zones rz
                ON UPPER(rz.rack) = UPPER(TRIM(COALESCE(NULLIF(TRIM(pi.rack_saved), ''), p.rack_location)))
         LEFT JOIN warehouse_zones wz ON wz.zone = rz.zone
        WHERE pi.shipment_id=$1
        ORDER BY pi.id`, [id])).rows;   // id 순 = 패킹리스트 라인 순(생성 시 파일 순서대로 INSERT)
    // 랙이 없는 신규 SKU 는 '__NEW__' 로 지정된 기본 존으로 안내한다(0172)
    const nz = (await query(
      `SELECT rz.zone, wz.name FROM rack_zones rz
         JOIN warehouse_zones wz ON wz.zone = rz.zone
        WHERE rz.rack = $1`, [NEW_KEY])).rows[0] || null;
    const byPal = {};
    for (const it of items) {
      (byPal[it.pallet_id] = byPal[it.pallet_id] || []).push({
        id: Number(it.id), product_id: it.product_id ? Number(it.product_id) : null,
        code: it.input_code, name: it.product_name || null,
        cartons: it.cartons, qty: num(it.qty),
        box_from: it.box_from, box_to: it.box_to,   // 패킹리스트의 카톤 번호 범위(라인 구분용)
        scanned_cartons: it.scanned_cartons, put_cartons: it.put_cartons,
        rack: it.rack_saved || it.rack_location || null,
        // 존 이동용 임시 팔렛 번호(0172). 랙에 지정된 존 → 없으면 신규 기본 존 → 그것도 없으면 null
        zone: it.rack_zone != null ? Number(it.rack_zone) : (nz ? Number(nz.zone) : null),
        zone_name: it.rack_zone != null ? (it.rack_zone_name || null) : (nz ? nz.name : null),
        zone_is_default: it.rack_zone == null && !!nz,   // 랙이 아니라 신규 기본값으로 정해진 존
        registered: it.product_id != null,
      });
    }
    return {
      shipment: { id: Number(s.id), invoice_no: s.invoice_no, eta: s.eta, status: s.status },
      pallets: pals.map((p) => ({
        id: Number(p.id), order_no: p.order_no, pl_no: p.pl_no, status: p.status,
        cartons_expected: p.cartons_expected, qty_expected: num(p.qty_expected),
        checked_at: p.checked_at,   // 적치 목표(검수된 카톤) 판정용 — 프런트가 같은 기준을 쓴다
        // 점유 표시(소프트 락) — 최근 하트비트가 있는 동안만 working=true
        working: !!p.working, working_step: p.working ? (p.working_step || null) : null,
        working_by: p.working ? Number(p.working_by) : null,
        working_by_name: p.working ? (p.working_by_name || null) : null,
        working_is_me: !!(p.working && Number(p.working_by) === Number(me)),
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

  // 하차 취소 — 잘못 누른 하차를 대기로 되돌린다 ---------------------
  //   되돌릴 수 있는 조건: 팔렛 status='unloaded' + 스캔/적치 기록 0 + 선적 미마감.
  //   (검수·적치가 시작된 팔렛은 기록이 있으므로 되돌리지 않는다 — 자료 유실 방지)
  app.post('/api/inbound/:id/pallets/:pid/unload-cancel', g, async (req) => {
    const uid = req.ctx.perm.userId;
    const id = Number(req.params.id), pid = Number(req.params.pid);
    return await withTx(async (c) => {
      const q = c.query.bind(c);
      const s = (await q(
        `SELECT id, status FROM inbound_shipments WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0];
      if (!s) return { error: 'not_found' };
      if (s.status === 'closed') return { error: 'closed' };
      const pal = (await q(
        `SELECT id, status FROM inbound_pallets WHERE id=$1 AND shipment_id=$2 FOR UPDATE`, [pid, id])).rows[0];
      if (!pal) return { error: 'not_found' };
      if (pal.status === 'wait') return { ok: true, already: true };   // 멱등
      if (pal.status !== 'unloaded') return { error: 'bad_state' };    // checking/checked/done
      const sc = (await q(
        `SELECT COALESCE(SUM(scanned_cartons),0)::int AS sc, COALESCE(SUM(put_cartons),0)::int AS pc
           FROM inbound_pallet_items WHERE pallet_id=$1`, [pid])).rows[0];
      if (num(sc.sc) > 0 || num(sc.pc) > 0) return { error: 'has_scan' };
      await q(`UPDATE inbound_pallets SET status='wait', checked_by=NULL, checked_at=NULL WHERE id=$1`, [pid]);
      // 진행 중인 팔렛이 하나도 없으면 선적도 '운송중'으로 되돌린다
      const rem = (await q(
        `SELECT COUNT(*)::int AS n FROM inbound_pallets WHERE shipment_id=$1 AND status<>'wait'`, [id])).rows[0].n;
      let reverted = false;
      if (rem === 0) {
        const r = await q(`UPDATE inbound_shipments SET status='incoming' WHERE id=$1 AND status='receiving' RETURNING id`, [id]);
        reverted = r.rows.length > 0;
      }
      await logEvent({ userId: uid, deviceId: req.ctx.deviceId, action: 'update', target: 'inbound_pallet:' + pid, detail: { shipment: id, unload_cancel: true, shipment_reverted: reverted } });
      return { ok: true, shipment_reverted: reverted };
    });
  });

  // 팔렛 점유 표시(소프트 락) — 다수 작업자 동시 작업용 -----------------
  //   POST .../working        body { step:'check'|'put' }  — 열 때 1회 + 25초 자동갱신마다 하트비트
  //   POST .../working/clear  — 내가 잡고 있던 것만 해제(남의 점유는 건드리지 않음)
  //   막지 않는다(강제 락 아님). 같은 팔렛을 굳이 잡아도 증분 저장으로 합산된다.
  app.post('/api/inbound/:id/pallets/:pid/working', g, async (req) => {
    const uid = req.ctx.perm.userId;
    const step = ['check', 'put', 'unload'].includes(String(req.body?.step)) ? String(req.body.step) : null;
    const r = await query(
      `UPDATE inbound_pallets SET working_by=$1, working_step=$2, working_at=now()
        WHERE id=$3 AND shipment_id=$4 RETURNING id`,
      [uid, step, Number(req.params.pid), Number(req.params.id)]);
    if (!r.rows.length) return { error: 'not_found' };
    return { ok: true };
  });
  app.post('/api/inbound/:id/pallets/:pid/working/clear', g, async (req) => {
    await query(
      `UPDATE inbound_pallets SET working_by=NULL, working_step=NULL, working_at=NULL
        WHERE id=$1 AND shipment_id=$2 AND working_by=$3`,
      [Number(req.params.pid), Number(req.params.id), req.ctx.perm.userId]);
    return { ok: true };
  });

  // 검수 확정(프론트가 카톤 스캔으로 채운 카톤수 반영) ----------------
  //   body: { items: [{item_id, scanned_delta}] }   ← 권장(증분)
  //         { items: [{item_id, scanned_cartons}] } ← 구버전(절대값, 하위호환)
  //   ⚠ 증분(delta)이 있으면 scanned_cartons = LEAST(기존 + delta, 예상 카톤) 로 **더한다**.
  //     두 사람이 같은 팔렛을 나눠 스캔해도 합산되어 서로의 스캔을 덮어쓰지 않는다.
  //     (절대값 방식은 나중 저장이 앞의 스캔을 지우는 문제가 있었다 — 2026-08-14)
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
        if (row.scanned_delta !== undefined) {
          const d = Math.max(0, int(row.scanned_delta));
          if (!d) continue;
          await q(
            `UPDATE inbound_pallet_items
                SET scanned_cartons = LEAST(scanned_cartons + $1, cartons)
              WHERE id=$2`, [d, iid]);
        } else {
          const sc = Math.max(0, Math.min(int(row.scanned_cartons), exp[iid])); // 초과 스캔 차단
          await q(`UPDATE inbound_pallet_items SET scanned_cartons=$1 WHERE id=$2`, [sc, iid]);
        }
      }
      await q(`UPDATE inbound_pallets SET status='checked', checked_by=$1, checked_at=now() WHERE id=$2`, [uid, pid]);
      return { ok: true };
    });
  });

  // 적치(랙 스캔 결과 반영, 랙 미지정/변경 시 제품 마스터 저장) -------
  //   body: { items: [{item_id, put_delta, rack, save_rack}] }   ← 권장(증분)
  //         { items: [{item_id, put_cartons, ...}] }             ← 구버전(절대값, 하위호환)
  //   ⚠ 증분(delta)이 있으면 put_cartons = LEAST(기존 + delta, 목표) 로 **더한다**.
  //     두 사람이 같은 팔렛을 동시에 적치해도 합산되어 서로의 스캔이 사라지지 않는다.
  //   ⚠ 적치 목표 카톤 = **검수된 카톤(scanned_cartons)** — 실제로 도착한 분량.
  //     검수 전 팔렛만 예상 카톤(cartons)으로 대체한다. (예전에는 항상 cartons 기준이어서
  //     부족 검수된 팔렛이 적치를 다 해도 done 이 되지 않았다 — 2026-08-14 수정)
  app.post('/api/inbound/:id/pallets/:pid/putaway', g, async (req) => {
    const uid = req.ctx.perm.userId;
    const id = Number(req.params.id), pid = Number(req.params.pid);
    const list = Array.isArray(req.body?.items) ? req.body.items : [];
    const out = await withTx(async (c) => {
      const q = c.query.bind(c);
      const pal = (await q(
        `SELECT id, status, checked_at FROM inbound_pallets WHERE id=$1 AND shipment_id=$2 FOR UPDATE`, [pid, id])).rows[0];
      if (!pal) return { error: 'not_found' };
      const byScan = pal.checked_at != null;   // 검수 확정분 기준
      const items = (await q(
        `SELECT pi.id, pi.product_id, pi.cartons, pi.scanned_cartons, pi.rack_saved,
                p.rack_location, p.code AS product_code
           FROM inbound_pallet_items pi
           LEFT JOIN products p ON p.id = pi.product_id
          WHERE pi.pallet_id=$1`, [pid])).rows;
      const map = {}; items.forEach((i) => (map[Number(i.id)] = i));
      const rackChanges = [];
      for (const row of list) {
        const iid = Number(row.item_id); const it = map[iid];
        if (!it) continue;
        const cap = byScan ? int(it.scanned_cartons) : int(it.cartons);
        const rack = row.rack ? String(row.rack).trim().slice(0, 40) : null;
        // rack 이 없으면 기존 rack_saved 를 지우지 않는다(COALESCE)
        if (row.put_delta !== undefined) {
          const d = Math.max(0, int(row.put_delta));
          await q(
            `UPDATE inbound_pallet_items
                SET put_cartons = LEAST(put_cartons + $1, $2), rack_saved = COALESCE($3, rack_saved)
              WHERE id=$4`, [d, cap, rack, iid]);
        } else {
          const pc = Math.max(0, Math.min(int(row.put_cartons), cap));
          await q(`UPDATE inbound_pallet_items SET put_cartons=$1, rack_saved=COALESCE($2, rack_saved) WHERE id=$3`, [pc, rack, iid]);
        }
        // 랙 저장: 제품 마스터 위치 갱신(미지정 신규 / 현장 변경) — 재고실사와 동일하게 위치만
        if (row.save_rack && rack && it.product_id) {
          const prev = it.rack_location || null;
          if (prev !== rack) rackChanges.push({ code: it.product_code || null, from: prev, to: rack });
          await q(`UPDATE products SET rack_location=$1, updated_by=$2 WHERE id=$3`, [rack, uid, it.product_id]);
        }
      }
      // 목표 카톤을 모두 적치하면 done (검수 0인 라인은 목표 0 → 완료를 막지 않음)
      const rem = (await q(
        `SELECT COUNT(*)::int AS n FROM inbound_pallet_items
          WHERE pallet_id=$1
            AND put_cartons < (CASE WHEN $2::boolean THEN scanned_cartons ELSE cartons END)`, [pid, byScan])).rows[0].n;
      await q(`UPDATE inbound_pallets SET status=$1 WHERE id=$2`, [rem === 0 ? 'done' : 'checking', pid]);
      return { ok: true, done: rem === 0, _rackChanges: rackChanges };
    });
    // 랙 변경(제품 기본 위치 변경)은 감사로그에 남긴다 — 실물과 마스터가 어긋난 이력을 추적
    if (out && out.ok && out._rackChanges && out._rackChanges.length) {
      await logEvent({ userId: uid, deviceId: req.ctx.deviceId, action: 'update',
        target: 'inbound_pallet:' + pid, detail: { shipment: id, rack_changes: out._rackChanges } });
    }
    if (out) delete out._rackChanges;
    return out;
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

  // 패킹리스트 파일 추가 첨부(기존 선적) — 업로드 때 못 넣은 파일을 나중에 첨부
  app.post('/api/inbound/:id/file', g, async (req, reply) => {
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const s = (await query(`SELECT id FROM inbound_shipments WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const pf = validFile(req.body);
    if (!pf) return reply.code(400).send({ error: 'file_required' });
    if (pf.error) return reply.code(413).send({ error: pf.error });
    const r = (await query(
      `INSERT INTO inbound_packing_files (shipment_id, file_name, mime_type, file_data, file_size, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [id, pf.name, pf.mime, pf.data, pf.size, req.ctx.perm.userId])).rows[0];
    await logEvent({ userId: req.ctx.perm.userId, deviceId: req.ctx.deviceId, action: 'inbound_file', target: 'inbound:' + id, detail: { file: pf.name, size: pf.size } });
    return { ok: true, id: Number(r.id) };
  });

  // 패킹리스트 파일 목록(메타만 — file_data 제외). 창고+구매 열람.
  app.get('/api/inbound/:id/files', gView, async (req, reply) => {
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const rows = (await query(
      `SELECT f.id, f.file_name, f.mime_type, f.file_size, f.uploaded_at, u.name AS uploaded_by_name
         FROM inbound_packing_files f LEFT JOIN users u ON u.id=f.uploaded_by
        WHERE f.shipment_id=$1 ORDER BY f.uploaded_at DESC, f.id DESC`, [id])).rows;
    return { items: rows.map((r) => ({ id: Number(r.id), file_name: r.file_name, mime_type: r.mime_type, file_size: r.file_size == null ? null : Number(r.file_size), uploaded_at: r.uploaded_at, uploaded_by_name: r.uploaded_by_name || null })) };
  });

  // 패킹리스트 파일 다운로드(data URL). 창고+구매 열람.
  app.get('/api/inbound/files/:fileId', gView, async (req, reply) => {
    const fid = Number(req.params.fileId);
    if (!fid) return reply.code(400).send({ error: 'bad_id' });
    const r = (await query(
      `SELECT id, shipment_id, file_name, mime_type, file_data FROM inbound_packing_files WHERE id=$1`, [fid])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return { id: Number(r.id), shipment_id: Number(r.shipment_id), file_name: r.file_name, mime_type: r.mime_type, file_data: r.file_data };
  });

  // 선적 정보 수정(인보이스 번호·ETA) — 마감 전 선적만. 업로드 때 못 채운 번호를 나중에 입력/수정.
  app.patch('/api/inbound/:id', g, async (req, reply) => {
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const sets = []; const args = [];
    if (req.body && req.body.invoice_no !== undefined) {
      const v = String(req.body.invoice_no || '').trim().slice(0, 60) || null;
      args.push(v); sets.push(`invoice_no=$${args.length}`);
    }
    if (req.body && req.body.eta !== undefined) {
      const e = String(req.body.eta || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e)) return reply.code(400).send({ error: 'bad_eta' });
      args.push(e); sets.push(`eta=$${args.length}`);
    }
    if (!sets.length) return reply.code(400).send({ error: 'nothing_to_update' });
    args.push(id);
    const r = await query(
      `UPDATE inbound_shipments SET ${sets.join(', ')}
        WHERE id=$${args.length} AND deleted_at IS NULL AND status <> 'closed' RETURNING id, invoice_no, eta`, args);
    if (!r.rows.length) return reply.code(409).send({ error: 'bad_state' });
    await logEvent({ userId: req.ctx.perm.userId, deviceId: req.ctx.deviceId, action: 'inbound_update', target: 'inbound:' + id, detail: { invoice_no: r.rows[0].invoice_no, eta: r.rows[0].eta } });
    return { ok: true, invoice_no: r.rows[0].invoice_no, eta: r.rows[0].eta };
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
