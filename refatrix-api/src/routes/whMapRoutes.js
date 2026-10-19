import { query } from '../db.js';
import { authGuard, requirePageAny } from '../middleware/authGuard.js';
import { pageAllowed } from '../permissions.js';
import { logEvent } from '../audit.js';
import { rackStockReady, normRack, rackNatKey } from '../rackStock.js';

// =====================================================================
// Refatrix ERP · whMapRoutes.js — 창고 도면 (Mapa del almacén) · 0288 · build 20261019wm1
//
//   디렉터 요청(2026-10-19): 도면 위에 랙 위치를 그리고, 랙 번호를 누르면 그 랙의 SKU · 수량을 보여 준다.
//   · 도면(구역 배치)은 warehouse_maps 한 장('main'). 없으면 기본 도면(SEED)을 돌려준다.
//   · 도면의 칸 = 랙 열(bay, 예 AA1). 실제 랙 AA1-1 … AA1-6 이 그 칸에 속한다.
//     칸 이름에 「-」가 있으면(예 FM-01) 그 랙 하나와 정확히 맞춘다.
//   · 수량은 랙별 재고(product_rack_stock)를 그대로 읽는다 — 도면 화면에서 수량을 바꾸지 않는다
//     (재고를 벗어나지 않게: 위치수정은 📍 랙별 재고 · 위치변경 화면에서).
//   권한: 읽기 = 창고·제품·창고도면 화면 열람 / 도면 저장 = 디렉터 또는 「창고 도면 수정(whmap)」 권한 수정.
// =====================================================================
export const WHMAP_BUILD = '20261019wm2';
//   2026-10-19 wm2 — 도면 수정 권한을 관리 › 사용자·권한의 「창고 도면 수정(whmap)」 으로 부여한다.
//     디렉터는 항상. whmap 권한 「수정」 = 도면 저장 가능 · 「열람」 = 보기만.
export const WHMAP_PAGE = 'whmap';
/** 도면 저장 가능 여부 — 디렉터 또는 whmap 권한 「수정」 */
export function canEditMap(perm, isRegistered) {
  if (!perm) return false;
  if (perm.role === 'director') return true;
  if (!pageAllowed(perm, WHMAP_PAGE, isRegistered)) return false;
  return ((perm.pageAccess && perm.pageAccess[WHMAP_PAGE]) || 'edit') === 'edit';
}

const r = (p, a, b) => Array.from({ length: b - a + 1 }, (_, i) => p + (a + i));
/** 기본 도면 — 디렉터가 준 warehouse_image.html 의 배치 그대로 */
export const SEED_ZONES = [
  { id: 'office', name: '사무실 · Oficina', type: 'area', x: 1.2, y: 2.3, w: 17.5, h: 51, rows: [] },
  { id: 'cage', name: '케이지 · Jaula', type: 'storage', x: 21, y: 2.8, w: 23, h: 45, rows: [['B2', 'C1'], ['B1', 'C2'], ['A2', 'D1'], ['A1', 'D2'], ['E1', 'E2'], ['E3', 'E4']] },
  { id: 'za', name: 'A 랙 · Racks A', type: 'storage', x: 46.3, y: 5.1, w: 35, h: 41, rows: [r('AA', 1, 6), r('AB', 1, 5), r('AC', 1, 5), r('AD', 1, 6), r('AE', 1, 6)] },
  { id: 'af', name: 'AF', type: 'storage', x: 82, y: 14, w: 4.8, h: 26, rows: [['AF1'], ['AF2'], ['AF3']] },
  { id: 'wc', name: '화장실·식당 · Baños/Comedor', type: 'area', x: 88, y: 2.3, w: 9.5, h: 52, rows: [] },
  { id: 'mez', name: '메자닌 2층 · Mezzanine', type: 'storage', x: 44.3, y: 58, w: 53, h: 36, rows: [r('BA', 1, 7), r('BB', 1, 6), r('BC', 1, 6), r('BD', 1, 7)] },
  { id: 'entry', name: '입구 · Entrada →', type: 'area', x: 1.2, y: 60, w: 12, h: 7, rows: [] },
  { id: 'ramp', name: '램프(상하차) · Rampa', type: 'area', x: 1.2, y: 71, w: 18, h: 25, rows: [] },
];

/** 랙 이름 → 열(bay). AA1-3 → AA1 · B2-2 → B2 · FM-01 → FM · AF1 → AF1 */
export function bayOf(rack) {
  const s = normRack(rack);
  const m = s.match(/^(.*\S)-\d+$/);
  return m ? m[1] : s;
}

const BAY_RE = /^[A-Z0-9][A-Z0-9\-_.\/]{0,39}$/;
/** 도면 검증 — 잘못된 값은 이유와 함께 거부. 통과하면 정리된 zones 를 돌려준다. */
export function cleanZones(raw) {
  if (!Array.isArray(raw)) return { error: 'bad_zones' };
  if (raw.length > 80) return { error: 'too_many_zones' };
  const out = [], seenId = new Set(), seenBay = new Map();
  const n = (v) => Math.round(Math.max(0, Math.min(100, Number(v) || 0)) * 10) / 10;
  let total = 0;
  for (const z of raw) {
    if (!z || typeof z !== 'object') return { error: 'bad_zone' };
    const id = String(z.id || '').trim().slice(0, 40);
    if (!id || seenId.has(id)) return { error: 'bad_zone_id', id };
    seenId.add(id);
    const type = z.type === 'area' ? 'area' : 'storage';
    const g = { x: n(z.x), y: n(z.y), w: Math.max(1, n(z.w)), h: Math.max(1, n(z.h)) };
    g.w = Math.min(g.w, 100 - g.x); g.h = Math.min(g.h, 100 - g.y);
    const rows = [];
    if (type === 'storage') {
      for (const row of (Array.isArray(z.rows) ? z.rows : []).slice(0, 60)) {
        const cells = [];
        for (const c of (Array.isArray(row) ? row : []).slice(0, 60)) {
          const b = normRack(c);
          if (!b) continue;
          if (!BAY_RE.test(b)) return { error: 'bad_bay', bay: String(c).slice(0, 40), zone: id };
          if (seenBay.has(b)) return { error: 'dup_bay', bay: b, zone: id, other: seenBay.get(b) };
          seenBay.set(b, id); cells.push(b); total += 1;
        }
        if (cells.length) rows.push(cells);
      }
    }
    out.push({ id, name: String(z.name || '').trim().slice(0, 60) || id, type, ...g, rows });
  }
  if (total > 3000) return { error: 'too_many_bays' };
  return { zones: out };
}

export default async function whMapRoutes(app) {
  try { console.log('[whMapRoutes] loaded ' + WHMAP_BUILD); } catch (_) {}
  const gRead = { preHandler: [authGuard, requirePageAny(['warehouse', 'products', WHMAP_PAGE])] };
  const gEdit = { preHandler: [authGuard, async (req, reply) => {
    const ctx = req.ctx || {};
    if (!canEditMap(ctx.perm, ctx.isRegistered)) return reply.code(403).send({ error: 'forbidden', page: WHMAP_PAGE, note: '창고 도면 수정 권한이 없습니다 (관리 › 사용자·권한).' });
  }] };
  let tableOk = false;
  async function ready() {
    if (tableOk) return true;
    try { tableOk = !!(await query(`SELECT to_regclass('public.warehouse_maps') IS NOT NULL AS ok`)).rows[0].ok; } catch (_) { tableOk = false; }
    return tableOk;
  }

  /* 도면 + 랙별 재고 요약 + ERP 에 등록된 랙 이름 */
  app.get('/api/wh-map', gRead, async (req) => {
    let map = null;
    if (await ready()) {
      map = (await query(`SELECT m.zones, m.version, m.updated_at, u.name AS by_name
                            FROM warehouse_maps m LEFT JOIN users u ON u.id = m.updated_by WHERE m.id='main'`)).rows[0] || null;
    }
    let racks = [];
    if (await rackStockReady()) {
      racks = (await query(
        `SELECT s.rack, COUNT(*)::int AS skus, SUM(s.qty) AS qty,
                COALESCE((SELECT k.kind FROM rack_kinds k WHERE UPPER(TRIM(k.rack)) = s.rack ORDER BY k.updated_at DESC LIMIT 1), 'carton') AS kind
           FROM product_rack_stock s WHERE s.qty > 0 GROUP BY s.rack`)).rows
        .map((x) => ({ rack: x.rack, skus: Number(x.skus), qty: Number(x.qty), kind: x.kind }));
    }
    const known = (await query(`SELECT DISTINCT UPPER(TRIM(rack)) AS rack FROM rack_kinds WHERE NULLIF(TRIM(rack),'') IS NOT NULL`)).rows.map((x) => x.rack);
    for (const x of racks) if (!known.includes(x.rack)) known.push(x.rack);
    return {
      ok: true, build: WHMAP_BUILD, table: await ready(),
      can_edit: canEditMap(req.ctx && req.ctx.perm, req.ctx && req.ctx.isRegistered),
      zones: map ? map.zones : SEED_ZONES, seeded: !map, version: map ? Number(map.version) : 0,
      updated_at: map ? map.updated_at : null, updated_by: map ? map.by_name : null,
      racks, known,
    };
  });

  /* 한 칸(bay)의 랙 × SKU × 수량 — ?bay=AA1 */
  app.get('/api/wh-map/bay', gRead, async (req, reply) => {
    const bay = normRack((req.query || {}).bay);
    if (!bay || !BAY_RE.test(bay)) return reply.code(400).send({ error: 'bad_bay' });
    if (!(await rackStockReady())) return { ok: true, bay, items: [] };
    const rows = (await query(
      `SELECT s.rack, s.qty, p.id AS product_id, p.code, p.name, p.stock_qty
         FROM product_rack_stock s JOIN products p ON p.id = s.product_id
        WHERE s.qty > 0 AND p.deleted_at IS NULL AND (s.rack = $1 OR left(s.rack, length($1) + 1) = $1 || '-')`, [bay])).rows;
    const items = rows.map((x) => ({ rack: x.rack, product_id: Number(x.product_id), code: x.code, name: x.name || '',
      qty: Number(x.qty), stock: Number(x.stock_qty) }))
      .sort((a, b) => (rackNatKey(a.rack) < rackNatKey(b.rack) ? -1 : rackNatKey(a.rack) > rackNatKey(b.rack) ? 1 : b.qty - a.qty));
    return { ok: true, bay, items };
  });

  /* 제품 검색 → 어느 랙에 있나 — ?q=코드·품명·SYD */
  app.get('/api/wh-map/search', gRead, async (req) => {
    const q = String((req.query || {}).q || '').trim().slice(0, 60);
    if (q.length < 2 || !(await rackStockReady())) return { ok: true, items: [] };
    const rows = (await query(
      `SELECT s.rack, s.qty, p.id AS product_id, p.code, p.name
         FROM product_rack_stock s JOIN products p ON p.id = s.product_id
        WHERE s.qty > 0 AND p.deleted_at IS NULL
          AND (p.code ILIKE '%' || $1 || '%' OR COALESCE(p.name,'') ILIKE '%' || $1 || '%' OR COALESCE(p.scode,'') ILIKE '%' || $1 || '%')
        ORDER BY p.code, s.rack LIMIT 300`, [q])).rows;
    return { ok: true, items: rows.map((x) => ({ rack: x.rack, bay: bayOf(x.rack), product_id: Number(x.product_id), code: x.code, name: x.name || '', qty: Number(x.qty) })) };
  });

  /* 도면 저장(디렉터 · whmap 「수정」 권한) — body { zones, version } · version 이 다르면 409(다른 사람이 먼저 저장) */
  app.put('/api/wh-map', gEdit, async (req, reply) => {
    if (!(await ready())) return reply.code(409).send({ error: 'not_ready', note: '마이그레이션 0288 을 먼저 실행하세요 (npm run migrate).' });
    const c = cleanZones(req.body && req.body.zones);
    if (c.error) return reply.code(400).send(c);
    const ver = Number(req.body && req.body.version) || 0;
    const uid = req.user && req.user.sub;
    const cur = (await query(`SELECT version FROM warehouse_maps WHERE id='main'`)).rows[0];
    if ((cur ? Number(cur.version) : 0) !== ver) return reply.code(409).send({ error: 'version_conflict', version: cur ? Number(cur.version) : 0 });
    const row = (await query(
      `INSERT INTO warehouse_maps (id, zones, version, updated_by, updated_at) VALUES ('main', $1::jsonb, 1, $2, now())
       ON CONFLICT (id) DO UPDATE SET zones = EXCLUDED.zones, version = warehouse_maps.version + 1,
              updated_by = EXCLUDED.updated_by, updated_at = now()
        WHERE warehouse_maps.version = $3
       RETURNING version, updated_at`, [JSON.stringify(c.zones), uid || null, ver])).rows[0];
    if (!row) return reply.code(409).send({ error: 'version_conflict' });
    await logEvent({ userId: uid, deviceId: req.ctx && req.ctx.deviceId, action: 'update', target: 'warehouse_map',
      detail: { zones: c.zones.length, bays: c.zones.reduce((s, z) => s + z.rows.flat().length, 0), version: Number(row.version) } });
    return { ok: true, version: Number(row.version), updated_at: row.updated_at, zones: c.zones };
  });
}
