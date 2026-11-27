// =====================================================================
// 2026-11-27 · 차종으로 제품찾기 — 차량 도면용 데이터 (디렉터 요청)
//   GET /api/products/vehicle-map?maker=&model=&year=   (제품 화면 열람자 · requirePage('products'))
//   11-27b · 메이커 · 모델은 이름 키(대소문자 · 하이픈 · 공백 · 악센트 무시)로 찾는다 — 카탈로그 원문은 그대로
//
//   응답 { vehicle, items:[…], competitors:[…], counts, defs }
//     items       = 이 차종에 적용되는 CTR 제품(product_applications) — 한 제품 1줄
//       { id, code, name, cat, syd:[…], baw:[…], oe:[…], pos:{blocks,levels,sides,src}|null,
//         stock_qty(창고 재고 = products.stock_qty), transit_qty, transit_eta, backorder_qty, sold_qty, racks:[{rack,qty}] }
//     competitors = CTR 카탈로그에 없지만 경쟁사(SYD · BAW) 마스터에 이 차종이 적힌 부품 — 크로스레퍼런스 마스터 활성 버전
//       { row_no, cat, descripcion, syd:[…], baw:[…], pos|null, aplicacion(맞은 조각), year_known }
//       · 같은 행의 SYD 가 ERP 제품에 연결돼 있으면(= CTR 있음) 빼고, items 쪽 BAW 칸에만 쓴다.
//
//   수량 정의 — 새 정의를 만들지 않는다
//     stock_qty     제품 현재고(창고 합계) — 제품 목록 「재고」와 같은 값
//     transit_qty   운송 중 — 창고›수입입고 마감 전 선적(v_incoming_stock) · 견적 「En tránsito」와 같은 값
//     backorder_qty 백오더 = 생산 중(En producción) = max(0, 발주 미입고 잔량 v_backorder − 운송 중) — 견적 엑셀과 같은 정의(11-27c)
//     po_open_qty   발주 미입고 잔량(v_backorder) = 운송 중 + 생산 중 — 제품 목록 「Backorder」 칸
//     short_qty     고객 주문 미출고 부족분(stock_shortages open 잔량) — 참고
//     sold_qty      누적 판매 — 게시 · 미삭제 인보이스 수량 전체 기간 · 제품 목록과 같은 팀 가시성
//   가격 · 원가는 보내지 않는다.
// =====================================================================
import { query } from '../db.js';
import { authGuard, requirePage } from '../middleware/authGuard.js';
import { visibleTeamIds } from '../teams.js';
import { oeByProduct } from '../oeCodes.js';
import { rackStockReady, rackMap } from '../rackStock.js';
import { activeVersionId, normCode } from '../xrefMaster.js';
import { partCat, posLoose, appMatch, posForVehicle, CAT_LABEL, nameKey, NK_SQL } from '../vehicleMap.js';

const MAX_PRODUCTS = 1500;
const MAX_XREF_ROWS = 4000;
const num = (v) => (v == null ? 0 : Number(v) || 0);
const NSQL = (col) => `regexp_replace(upper(COALESCE(${col},'')), '[^A-Z0-9]', '', 'g')`;

async function safe(fn, dflt) { try { return await fn(); } catch (_) { return dflt; } }

export default async function vehicleMapRoutes(app) {
  app.get('/api/products/vehicle-map', { preHandler: [authGuard, requirePage('products')] }, async (req, reply) => {
    const { perm } = req.ctx;
    const maker = String(req.query.maker || '').trim().slice(0, 80);
    const model = String(req.query.model || '').trim().slice(0, 120);
    const yRaw = req.query.year ? Number(req.query.year) : null;
    const year = Number.isInteger(yRaw) && yRaw >= 1950 && yRaw <= 2100 ? yRaw : null;
    if (!maker || !model) return reply.code(400).send({ error: 'maker_model_required' });
    const veh = { maker, model, year };

    // 1) 이 차종의 CTR 제품
    // 11-27b · 메이커 · 모델은 이름 키로(대소문자 · 하이픈 · 공백 · 악센트 무시) — 'CR-V' 와 'CRV' 가 같은 모델
    const params = [nameKey(maker), nameKey(model)];
    if (!params[0] || !params[1]) return reply.code(400).send({ error: 'maker_model_required' });
    let yCond = '';
    if (year != null) { params.push(year); yCond = ` AND a.year_from <= $3 AND a.year_to >= $3`; }
    const prods = (await query(
      `SELECT p.id, p.code, p.name, p.scode, COALESCE(p.stock_qty,0) AS stock_qty,
              string_agg(DISTINCT a.app_text, ' // ') AS app_hit
         FROM product_applications a JOIN products p ON p.id = a.product_id AND p.deleted_at IS NULL
        WHERE ${NK_SQL('a.maker')} = $1 AND ${NK_SQL('a.model')} = $2${yCond}
        GROUP BY p.id, p.code, p.name, p.scode, p.stock_qty
        ORDER BY p.code
        LIMIT ${MAX_PRODUCTS}`, params)).rows;
    const pids = prods.map((r) => Number(r.id));
    const codes = prods.map((r) => String(r.code || '').trim().toUpperCase());

    // 2) 장착위치 — CTR 확인값(mount_pos) → 업로드 줄(이 차종 우선)
    const own = new Map();
    if (pids.length) {
      const o = await safe(() => query(
        `SELECT id, btrim(mount_pos) AS v FROM products WHERE id = ANY($1::bigint[]) AND COALESCE(btrim(mount_pos),'') <> ''`, [pids]), { rows: [] });
      for (const r of o.rows) own.set(Number(r.id), r.v);
    }
    const posRows = new Map();
    if (codes.length) {
      const pr = await safe(() => query(
        `SELECT ctr_code, block, level, side, brand, model, y_from, y_to FROM product_positions WHERE ctr_code = ANY($1::text[])`, [codes]), { rows: [] });
      for (const r of pr.rows) { if (!posRows.has(r.ctr_code)) posRows.set(r.ctr_code, []); posRows.get(r.ctr_code).push(r); }
    }

    // 3) 수량 — 운송 · 백오더 · 누적판매(팀 가시성)
    const transit = new Map(), backorder = new Map(), poOpen = new Map(), sold = new Map();
    if (pids.length) {
      const inc = await safe(() => query(
        `SELECT product_id, incoming_qty, to_char(incoming_eta,'YYYY-MM-DD') AS eta FROM v_incoming_stock WHERE product_id = ANY($1::bigint[])`, [pids]), { rows: [] });
      for (const r of inc.rows) transit.set(Number(r.product_id), { qty: num(r.incoming_qty), eta: r.eta || null });
      // 11-27c · 백오더 = 생산 중(En producción) — 회사 공통 정의(quoteQtyCols): 발주 미입고 잔량(v_backorder) − 운송 중
      const po = await safe(() => query(
        `SELECT product_id, backorder_qty AS q FROM v_backorder WHERE product_id = ANY($1::bigint[])`, [pids]), { rows: [] });
      for (const r of po.rows) poOpen.set(Number(r.product_id), num(r.q));
      // 참고: 고객 주문 미출고 부족분(stock_shortages open 잔량) — 상세 카드에 따로 보인다
      const sh = await safe(() => query(
        `SELECT product_id, SUM(shortage_qty - COALESCE(resolved_qty,0)) AS q FROM stock_shortages
          WHERE product_id = ANY($1::bigint[]) AND status = 'open' AND (shortage_qty - COALESCE(resolved_qty,0)) > 0
          GROUP BY product_id`, [pids]), { rows: [] });
      for (const r of sh.rows) backorder.set(Number(r.product_id), num(r.q));
      const vis = visibleTeamIds(perm);
      const sp = [pids]; let join = '', cond = '';
      if (vis !== null) { sp.push(vis.length ? vis : [-1]); join = ' JOIN customers cu ON cu.id = si.customer_id'; cond = ' AND cu.team_id = ANY($2)'; }
      const sd = (await query(
        `SELECT sil.product_id, SUM(sil.qty) AS q FROM sales_invoice_lines sil
           JOIN sales_invoices si ON si.id = sil.invoice_id${join}
          WHERE si.status = 'posted' AND si.deleted_at IS NULL AND sil.product_id = ANY($1::bigint[])${cond}
          GROUP BY sil.product_id`, sp)).rows;
      for (const r of sd) sold.set(Number(r.product_id), num(r.q));
    }

    // 4) 코드 — SYD(product_syd_codes) · OE · BAW(크로스레퍼런스 마스터 같은 행 + product_xref_codes)
    const sydBy = new Map();
    if (pids.length) {
      const s = (await query(`SELECT product_id, syd_code FROM product_syd_codes WHERE product_id = ANY($1::bigint[]) ORDER BY product_id, syd_code`, [pids])).rows;
      for (const r of s) { const k = Number(r.product_id); if (!sydBy.has(k)) sydBy.set(k, []); sydBy.get(k).push(r.syd_code); }
    }
    const oeMap = await safe(() => oeByProduct(pids), new Map());
    const racks = (pids.length && (await safe(() => rackStockReady(), false))) ? await safe(() => rackMap(query, pids), new Map()) : new Map();
    const bawBy = new Map();
    const addBaw = (pid, c) => { if (!c) return; if (!bawBy.has(pid)) bawBy.set(pid, []); const a = bawBy.get(pid); if (!a.includes(c)) a.push(c); };
    if (pids.length) {
      const px = await safe(() => query(
        `SELECT product_id, xref_code FROM product_xref_codes WHERE product_id = ANY($1::bigint[]) AND upper(COALESCE(brand,'')) = 'BAW' ORDER BY id`, [pids]), { rows: [] });
      for (const r of px.rows) addBaw(Number(r.product_id), r.xref_code);
    }
    const vid = await safe(() => activeVersionId(), null);
    const sydNormToPid = new Map();
    for (const [pid, list] of sydBy) for (const s of list) { const n = normCode(s); if (!sydNormToPid.has(n)) sydNormToPid.set(n, []); sydNormToPid.get(n).push(pid); }
    if (vid && sydNormToPid.size) {
      const hit = await safe(() => query(
        `SELECT c.norm_code, r.codes FROM xref_master_codes c
           JOIN xref_master_rows r ON r.version_id = c.version_id AND r.row_no = c.row_no
          WHERE c.version_id = $1 AND c.brand = 'SYD' AND c.norm_code = ANY($2)`, [vid, [...sydNormToPid.keys()]]), { rows: [] });
      for (const r of hit.rows) {
        const baw = (r.codes && Array.isArray(r.codes.BAW)) ? r.codes.BAW : [];
        for (const pid of sydNormToPid.get(r.norm_code) || []) for (const b of baw) addBaw(pid, String(b));
      }
    }

    const items = prods.map((r) => {
      const id = Number(r.id), code = String(r.code || '').trim();
      const pos = posForVehicle(own.get(id), posRows.get(code.toUpperCase()), veh);
      const t = transit.get(id);
      return {
        id, code, name: r.name || '', cat: partCat(r.name), app_hit: r.app_hit || null,
        syd: sydBy.get(id) || (r.scode ? String(r.scode).split(/\s*\/\/\s*/).filter(Boolean) : []),
        baw: bawBy.get(id) || [],
        oe: (oeMap.get(id) || []).map((o) => o.oe_code),
        pos,
        stock_qty: num(r.stock_qty), transit_qty: t ? t.qty : 0, transit_eta: t ? t.eta : null,
        // backorder_qty = 생산 중 = max(0, 발주 미입고 잔량 − 운송 중) · po_open_qty = 발주 미입고 잔량(제품목록 「Backorder」)
        po_open_qty: poOpen.get(id) || 0,
        backorder_qty: Math.max(0, (poOpen.get(id) || 0) - (t ? t.qty : 0)),
        short_qty: backorder.get(id) || 0,
        sold_qty: sold.get(id) || 0,
        racks: (racks.get(id) || []).map((x) => ({ rack: x.rack, qty: x.qty })),
      };
    });

    // 5) 경쟁사만 있는 부품 — 마스터 APLICACIÓN 에 이 차종이 적힌 행, ERP CTR 로 이어지지 않는 것
    const competitors = [];
    let xrefScanned = 0;
    if (vid) {
      // 11-27b · 1차 거름 = 기호 · 공백을 지운 글에 모델 키가 들어 있는가(정밀 판정은 appMatch 의 낱말 경계)
      const like = '%' + nameKey(model) + '%';
      const rows = await safe(() => query(
        `SELECT row_no, codes, descripcion, aplicacion, ubicacion FROM xref_master_rows
          WHERE version_id = $1 AND ${NK_SQL('aplicacion')} LIKE $2 ORDER BY row_no LIMIT ${MAX_XREF_ROWS}`, [vid, like]), { rows: [] });
      xrefScanned = rows.rows.length;
      const makers = await safe(async () => (await query(`SELECT DISTINCT maker FROM product_applications WHERE maker IS NOT NULL AND maker <> ''`)).rows.map((x) => x.maker), []);
      const cand = [];
      for (const r of rows.rows) {
        const m = appMatch(r.aplicacion, veh, makers);
        if (!m.ok) continue;
        const syd = (r.codes && Array.isArray(r.codes.SYD)) ? r.codes.SYD.map(String) : [];
        const ctr = (r.codes && Array.isArray(r.codes.CTR)) ? r.codes.CTR.map(String) : [];
        const baw = (r.codes && Array.isArray(r.codes.BAW)) ? r.codes.BAW.map(String) : [];
        if (!syd.length && !baw.length) continue;
        cand.push({ r, m, syd, ctr, baw });
      }
      // ERP 에 이어진 행(SYD → 제품, 또는 CTR 칸 코드가 제품) 은 뺀다
      const sydAll = [...new Set(cand.flatMap((c) => c.syd.map(normCode)).filter(Boolean))];
      const ctrAll = [...new Set(cand.flatMap((c) => c.ctr.map(normCode)).filter(Boolean))];
      const bridgedSyd = new Set(), knownCtr = new Set();
      if (sydAll.length) {
        const b = await safe(() => query(
          `SELECT DISTINCT ${NSQL('s.syd_code')} AS n FROM product_syd_codes s JOIN products p ON p.id = s.product_id AND p.deleted_at IS NULL
            WHERE ${NSQL('s.syd_code')} = ANY($1)`, [sydAll]), { rows: [] });
        for (const x of b.rows) bridgedSyd.add(x.n);
      }
      if (ctrAll.length) {
        const b = await safe(() => query(`SELECT ${NSQL('code')} AS n FROM products WHERE deleted_at IS NULL AND ${NSQL('code')} = ANY($1)`, [ctrAll]), { rows: [] });
        for (const x of b.rows) knownCtr.add(x.n);
      }
      for (const c of cand) {
        if (c.syd.some((s) => bridgedSyd.has(normCode(s))) || c.ctr.some((s) => knownCtr.has(normCode(s)))) continue;
        const pos = posLoose(c.r.ubicacion) || posLoose(c.r.descripcion);
        competitors.push({
          row_no: Number(c.r.row_no), cat: partCat(c.r.descripcion), descripcion: c.r.descripcion || '',
          syd: c.syd, baw: c.baw, pos: pos ? { ...pos, src: 'xref' } : null,
          ubicacion: c.r.ubicacion || null, aplicacion: c.m.seg || c.r.aplicacion || '', year_known: !!c.m.year_known,
        });
      }
    }

    const placed = items.filter((x) => x.pos && x.pos.blocks && x.pos.blocks.length).length;
    return {
      vehicle: veh,
      items, competitors,
      counts: {
        ctr: items.length, ctr_in_stock: items.filter((x) => x.stock_qty > 0).length, ctr_placed: placed,
        competitors: competitors.length, xref_rows_scanned: xrefScanned, xref_version: vid,
        truncated: prods.length >= MAX_PRODUCTS,
      },
      cats: CAT_LABEL,
      defs: {
        stock: '창고 재고(제품 현재고 · 창고 합계)',
        transit: '운송 중(수입입고 마감 전 선적)',
        backorder: '백오더 = 생산 중(공장 발주 후 아직 선적 안 됨 · 발주 미입고 잔량 − 운송 중)',
        po_open: '발주 미입고 잔량(운송 + 생산 중) — 제품 목록 Backorder',
        short: '고객 주문 미출고 부족분(참고)',
        sold: '누적 판매(게시 인보이스 · 전체 기간)',
      },
    };
  });
}
