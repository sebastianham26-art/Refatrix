// =====================================================================
// Refatrix ERP · rackStockRoutes.js  (랙별 재고 조회·수동 조정) · 0245
//   읽기: 창고(warehouse) 또는 제품(products) 화면 권한
//   쓰기: 디렉터 전용(수동 조정, 반영완료된 과거 실사에서 랙재고 가져오기)
//   수량 변경 로직은 전부 ../rackStock.js 에 있다 — 여기는 HTTP 껍데기.
//
//   0269 (2026-10-12):
//     · POST /api/rack-stock/transfer        창고 위치수정(기존 위치 → 새 위치 + 수량) — 창고 edit 권한
//     · POST /api/rack-stock/import/preview  실사 랙 업로드 미리보기 — 창고 열람 권한
//     · POST /api/rack-stock/import          실사 랙 업로드 적용 — 디렉터
//     · GET  /api/rack-stock/imports         업로드 이력
// =====================================================================
import { query, withTx } from '../db.js';
import { authGuard, requirePageAny, requirePageEdit, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { rackStockReady, rackMap, setRackQty, applyCountToRacks, normRack, RACK_BUILD,
  rackEditReady, holdsDetail, transferRack, analyzeImport, applyImport, RackError } from '../rackStock.js';

const NOT_READY = { error: 'rack_stock_not_ready', note: '마이그레이션 0245 를 먼저 실행하세요 (npm run migrate).' };
const EDIT_NOT_READY = { error: 'rack_edit_not_ready', note: '마이그레이션 0269 를 먼저 실행하세요 (npm run migrate).' };
const MAX_IMPORT_ROWS = 20000;
const TOO_MANY = { error: 'too_many_rows', note: `한 번에 ${MAX_IMPORT_ROWS.toLocaleString('en-US')} 줄(랙/수량 쌍)까지 올릴 수 있습니다. 파일을 나눠 올리세요 — 잘라서 저장하면 일부 랙이 지워질 수 있어 받지 않습니다.` };
/** 업로드 줄 정리 — [{line, code, rack, qty, sig}] 만 남긴다 */
function cleanRows(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, MAX_IMPORT_ROWS).map((r, i) => ({
    line: Number(r && r.line) || i + 1,
    code: r && r.code != null ? String(r.code).slice(0, 60) : '',
    rack: r && r.rack != null ? String(r.rack).slice(0, 60) : '',
    qty: r ? r.qty : null,
    sig: r && r.sig != null ? String(r.sig).slice(0, 300) : null,
  }));
}

export default async function rackStockRoutes(app) {
  try { console.log('[rackStockRoutes] loaded ' + RACK_BUILD); } catch (_) {}
  const gRead = { preHandler: [authGuard, requirePageAny(['warehouse', 'products'])] };
  const gDir = { preHandler: [authGuard, requireDirector] };
  const num = (v) => (v == null ? 0 : Number(v));

  /* SKU 별 랙 재고 목록 — ?q=코드·품명 &rack=랙 &unassigned=1 &limit=&offset=
     기본: 랙 기록이 있는 SKU 전체(코드순). */
  app.get('/api/rack-stock', gRead, async (req, reply) => {
    if (!(await rackStockReady())) return reply.code(409).send(NOT_READY);
    const q = req.query || {};
    const limit = Math.max(1, Math.min(1000, Number(q.limit) || 300));
    const offset = Math.max(0, Number(q.offset) || 0);
    const where = ['p.deleted_at IS NULL'];
    const params = [];
    const term = String(q.q || '').trim();
    const rack = normRack(q.rack);
    if (term) {
      params.push(term);
      where.push(`(p.code ILIKE '%' || $${params.length} || '%' OR COALESCE(p.name,'') ILIKE '%' || $${params.length} || '%'
                   OR COALESCE(p.scode,'') ILIKE '%' || $${params.length} || '%')`);
    }
    if (rack) {
      params.push(rack);
      where.push(`p.id IN (SELECT product_id FROM product_rack_stock WHERE rack LIKE $${params.length} || '%')`);
    }
    const located = `COALESCE((SELECT SUM(s.qty) FROM product_rack_stock s WHERE s.product_id = p.id), 0)`;
    const onlyGap = String(q.unassigned || '') === '1';
    // 위치 미지정만 = 시스템 재고와 랙 수량 합이 다른 SKU(랙 기록이 전혀 없는 재고 SKU 포함)
    if (onlyGap) where.push(`(COALESCE(p.stock_qty,0) > ${located} OR ${located} > COALESCE(p.stock_qty,0))`);
    else if (!term && !rack) where.push(`p.id IN (SELECT product_id FROM product_rack_stock)`);
    const base = `FROM products p WHERE ${where.join(' AND ')}`;
    const total = Number((await query(`SELECT COUNT(*)::int AS n ${base}`, params)).rows[0].n);
    params.push(limit, offset);
    const prods = (await query(
      `SELECT p.id, p.code, p.name, p.stock_qty, p.rack_location ${base}
        ORDER BY p.code LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
    const map = await rackMap(null, prods.map((p) => p.id));
    const items = prods.map((p) => {
      const racks = map.get(Number(p.id)) || [];
      const located = racks.reduce((s, r) => s + r.qty, 0);
      const stock = num(p.stock_qty);
      return {
        product_id: Number(p.id), code: p.code, name: p.name || '', stock_qty: stock,
        master_rack: p.rack_location || '', racks,
        located: Math.round(located * 1000) / 1000,
        unassigned: Math.max(0, Math.round((stock - located) * 1000) / 1000),
        over: Math.max(0, Math.round((located - stock) * 1000) / 1000),
      };
    });
    return { total, limit, offset, items };
  });

  /* 랙별 요약 — 랙마다 SKU 수·수량·유형 */
  app.get('/api/rack-stock/racks', gRead, async (req, reply) => {
    if (!(await rackStockReady())) return reply.code(409).send(NOT_READY);
    const rows = (await query(
      `SELECT s.rack, COUNT(*)::int AS skus, SUM(s.qty) AS qty,
              COALESCE((SELECT k.kind FROM rack_kinds k WHERE UPPER(TRIM(k.rack)) = s.rack
                         ORDER BY k.updated_at DESC LIMIT 1), 'carton') AS kind
         FROM product_rack_stock s
        WHERE s.qty > 0
        GROUP BY s.rack ORDER BY s.rack`)).rows;
    return { racks: rows.map((r) => ({ rack: r.rack, skus: Number(r.skus), qty: num(r.qty), kind: r.kind })) };
  });

  /* 한 SKU 의 랙 재고 + 최근 이력 */
  app.get('/api/rack-stock/product/:id', gRead, async (req, reply) => {
    if (!(await rackStockReady())) return reply.code(409).send(NOT_READY);
    const id = Number(req.params.id);
    const p = (await query(`SELECT id, code, name, stock_qty, rack_location FROM products WHERE id=$1`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const racks = (await rackMap(null, [id])).get(id) || [];
    // 0269 · 랙마다 다른 포장지시서가 잡아 둔 수량(옮길 수 없는 분량) — 위치수정 화면 안내용
    if (await rackEditReady()) {
      const h = await holdsDetail(null, id, 0);
      for (const r of racks) {
        const x = h.get(r.rack);
        r.held = x ? x.qty : 0; r.held_quotes = x ? x.quotes : [];
        r.movable = Math.max(0, Math.round((r.qty - r.held) * 1000) / 1000);
      }
    }
    const moves = (await query(
      `SELECT m.id, m.rack, m.delta, m.qty_after, m.reason, m.ref, m.sales_invoice_id, m.quote_id, m.note,
              m.created_at, u.name AS by_name
         FROM product_rack_moves m LEFT JOIN users u ON u.id = m.created_by
        WHERE m.product_id=$1 ORDER BY m.created_at DESC, m.id DESC LIMIT 100`, [id])).rows
      .map((m) => ({ ...m, id: Number(m.id), delta: num(m.delta), qty_after: num(m.qty_after),
        sales_invoice_id: m.sales_invoice_id == null ? null : Number(m.sales_invoice_id),
        quote_id: m.quote_id == null ? null : Number(m.quote_id) }));
    const located = racks.reduce((s, r) => s + r.qty, 0);
    return {
      product: { id: Number(p.id), code: p.code, name: p.name || '', stock_qty: num(p.stock_qty), master_rack: p.rack_location || '' },
      racks, located, unassigned: Math.max(0, num(p.stock_qty) - located), moves,
      edit_ready: await rackEditReady(),
    };
  });

  /* 0269 · 창고 위치수정 — body: { product_id, moves:[{from, to, qty}], note }  (from/to 빈값 = 위치 미지정)
     단건 형식 { product_id, from, to, qty, note } 도 받는다. 합계 보존 이동이라 재고를 벗어날 수 없다. */
  app.post('/api/rack-stock/transfer', { preHandler: [authGuard, requirePageEdit('warehouse')] }, async (req, reply) => {
    if (!(await rackStockReady()) || !(await rackEditReady())) return reply.code(409).send(EDIT_NOT_READY);
    const b = req.body || {};
    const pid = Number(b.product_id);
    if (!pid) return reply.code(400).send({ error: 'product_required', note: '제품을 지정하세요.' });
    const moves = Array.isArray(b.moves) ? b.moves : [{ from: b.from, to: b.to, qty: b.qty }];
    if (moves.length > 50) return reply.code(400).send({ error: 'too_many', note: '한 번에 50건까지 옮길 수 있습니다.' });
    const uid = req.ctx.perm.userId;
    const note = String(b.note || '').trim().slice(0, 200) || null;
    try {
      const out = await withTx(async (c) => transferRack(c, pid, moves, { userId: uid, note }));
      await logEvent({ userId: uid, action: 'update', target: `rack_stock:${pid}`, detail: { step: 'transfer', moves: out.moved, note } });
      return { ok: true, product_id: pid, ...out };
    } catch (e) {
      if (e instanceof RackError) return reply.code(e.code === 'not_found' ? 404 : 409).send({ error: e.code, note: e.note, ...(e.extra || {}) });
      throw e;
    }
  });

  /* 0269 · 실사 랙 업로드 미리보기 — body: { rows:[{line, code, rack, qty, sig}] } (엑셀은 화면에서 읽어 줄로 보낸다) */
  app.post('/api/rack-stock/import/preview', gRead, async (req, reply) => {
    if (!(await rackStockReady()) || !(await rackEditReady())) return reply.code(409).send(EDIT_NOT_READY);
    const raw = (req.body || {}).rows;
    if (Array.isArray(raw) && raw.length > MAX_IMPORT_ROWS) return reply.code(413).send(TOO_MANY);
    const rows = cleanRows(raw);
    if (!rows || !rows.length) return reply.code(400).send({ error: 'no_rows', note: '읽은 줄이 없습니다.' });
    return { ok: true, ...(await analyzeImport(null, rows)) };
  });

  /* 0269 · 실사 랙 업로드 적용(디렉터) — 파일에 나온 SKU 의 랙재고를 파일 내용으로 맞춘다.
     랙 합이 등록 재고를 넘는 SKU 는 저장하지 않는다. 파일에 없는 SKU 는 그대로. */
  app.post('/api/rack-stock/import', gDir, async (req, reply) => {
    if (!(await rackStockReady()) || !(await rackEditReady())) return reply.code(409).send(EDIT_NOT_READY);
    const b = req.body || {};
    if (Array.isArray(b.rows) && b.rows.length > MAX_IMPORT_ROWS) return reply.code(413).send(TOO_MANY);
    const rows = cleanRows(b.rows);
    if (!rows || !rows.length) return reply.code(400).send({ error: 'no_rows', note: '읽은 줄이 없습니다.' });
    const uid = req.ctx.perm.userId;
    // SKU 묶음마다 짧은 트랜잭션(교착·잠금 한도 방지) — rackStock.applyImport 참고
    const out = await applyImport(withTx, rows, { userId: uid, fileName: b.file_name || null, note: b.note || null });
    await logEvent({ userId: uid, action: 'update', target: `rack_import:${out.id}`,
      detail: { step: 'rack_import', file: b.file_name || null, skus: out.skus, blocked: out.blocked.length, held: out.held.length, unknown: out.unknown.length } });
    return { ok: true, ...out };
  });

  /* 0269 · 업로드 이력 */
  app.get('/api/rack-stock/imports', gRead, async (req, reply) => {
    if (!(await rackEditReady())) return { items: [] };
    const rows = (await query(
      `SELECT i.id, i.file_name, i.note, i.rows_in, i.skus, i.blocked, i.summary, i.created_at, u.name AS by_name
         FROM rack_stock_imports i LEFT JOIN users u ON u.id = i.created_by
        ORDER BY i.id DESC LIMIT 30`)).rows;
    return { items: rows.map((r) => ({ ...r, id: Number(r.id) })) };
  });

  /* 디렉터 수동 조정 — body: { product_id, rack, qty, note } (qty=0 이면 그 랙에서 제거) */
  app.post('/api/rack-stock/set', gDir, async (req, reply) => {
    if (!(await rackStockReady())) return reply.code(409).send(NOT_READY);
    const b = req.body || {};
    const pid = Number(b.product_id);
    const rack = normRack(b.rack).slice(0, 40);
    const qty = Number(b.qty);
    if (!pid || !rack) return reply.code(400).send({ error: 'product_and_rack_required' });
    if (!isFinite(qty) || qty < 0) return reply.code(400).send({ error: 'bad_qty' });
    const p = (await query(`SELECT id, code FROM products WHERE id=$1 AND deleted_at IS NULL`, [pid])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const uid = req.ctx.perm.userId;
    const note = String(b.note || '').trim().slice(0, 200) || null;
    const delta = await withTx(async (c) => setRackQty(c, pid, rack, qty, { reason: 'manual', ref: 'manual', userId: uid, note }));
    await logEvent({ userId: uid, action: 'update', target: `rack_stock:${pid}`, detail: { code: p.code, rack, qty, delta, note } });
    return { ok: true, product_id: pid, rack, qty, delta };
  });

  /* 이미 반영완료된 과거 실사에서 랙재고 가져오기(이 기능 배포 전에 반영한 세션용).
     보류(반영 안 함)로 끝난 수량차이 SKU 는 제외한다 — 반영 경로와 같은 규칙. */
  app.post('/api/rack-stock/from-count/:id', gDir, async (req, reply) => {
    if (!(await rackStockReady())) return reply.code(409).send(NOT_READY);
    const id = Number(req.params.id);
    const sc = (await query(`SELECT id, code, status, mode FROM stock_counts WHERE id=$1`, [id])).rows[0];
    if (!sc) return reply.code(404).send({ error: 'not_found' });
    if (sc.mode === 'spot') return reply.code(409).send({ error: 'full_only', note: '전체 재고실사만 가져올 수 있습니다.' });
    if (sc.status !== 'reconciled') return reply.code(409).send({ error: 'not_reconciled', note: '반영완료된 실사만 가져올 수 있습니다. 제출된 실사는 반영할 때 자동으로 저장됩니다.' });
    const uid = req.ctx.perm.userId;
    // 이미 랙재고로 저장된 실사는 다시 가져오지 않는다 — 그 뒤 출고·위치변경이 오래된 수량으로 덮이기 때문.
    const done = (await query(`SELECT 1 FROM product_rack_moves WHERE ref=$1 LIMIT 1`, [`count:${id}`])).rows[0];
    if (done) return reply.code(409).send({ error: 'already_imported', note: '이 실사의 랙 수량은 이미 랙재고에 저장되어 있습니다.' });
    const skipRows = (await query(
      `SELECT DISTINCT product_id FROM stock_count_adjustments
        WHERE count_id=$1 AND product_id IS NOT NULL AND decision = 'skip' AND delta <> 0`, [id])).rows;
    const skip = new Set(skipRows.map((r) => Number(r.product_id)));
    const out = await withTx(async (c) => applyCountToRacks(c, id, { skip, userId: uid, code: sc.code }));
    await logEvent({ userId: uid, action: 'update', target: `stock_count:${id}`, detail: { step: 'rack_stock_import', ...out, skipped: skip.size } });
    return { ok: true, code: sc.code, ...out, skipped: skip.size };
  });
}
