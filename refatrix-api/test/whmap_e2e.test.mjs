/* 2026-10-19 · 창고 도면(0288 · whMapRoutes 20261019wm1) — 운영 라우트를 실 PostgreSQL 에서 그대로 실행.
   ⚠ db.js 가 import 시점에 DATABASE_URL 을 읽으므로 DATABASE_URL 도 같이 지정할 것.
   실행: TEST_PG_URL=postgres://... node test/whmap_e2e.test.mjs  (없으면 순수 함수만) */
import { bayOf, cleanZones, SEED_ZONES, canEditMap } from '../src/routes/whMapRoutes.js';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

console.log('\n① 순수 함수');
ok('bayOf AA1-3 → AA1', bayOf('AA1-3') === 'AA1');
ok('bayOf b2-2 → B2', bayOf(' b2-2 ') === 'B2');
ok('bayOf FM-01 → FM', bayOf('FM-01') === 'FM');
ok('bayOf AF1 → AF1', bayOf('AF1') === 'AF1');
const seed = cleanZones(SEED_ZONES);
ok('기본 도면 검증 통과 · 8구역', !seed.error && seed.zones.length === 8, seed.error);
ok('기본 도면 랙 열 수(12+28+3+26=69)', seed.zones.reduce((s, z) => s + z.rows.flat().length, 0) === 69);
ok('중복 랙 거부', cleanZones([{ id: 'a', type: 'storage', x: 0, y: 0, w: 10, h: 10, rows: [['AA1']] }, { id: 'b', type: 'storage', x: 0, y: 0, w: 10, h: 10, rows: [['aa1']] }]).error === 'dup_bay');
ok('잘못된 랙 이름 거부', cleanZones([{ id: 'a', type: 'storage', x: 0, y: 0, w: 10, h: 10, rows: [['A A']] }]).error === 'bad_bay'
  && cleanZones([{ id: 'a', type: 'storage', x: 0, y: 0, w: 10, h: 10, rows: [['#X']] }]).error === 'bad_bay');
ok('같은 구역 id 거부', cleanZones([{ id: 'a', x: 0, y: 0, w: 5, h: 5 }, { id: 'a', x: 0, y: 0, w: 5, h: 5 }]).error === 'bad_zone_id');
const clip = cleanZones([{ id: 'a', type: 'area', x: 90, y: 95, w: 30, h: 30, rows: [['X1']] }]).zones[0];
ok('범위 밖 크기는 잘라냄 · area 는 rows 비움', clip.w === 10 && clip.h === 5 && clip.rows.length === 0, clip);

console.log('\n①-2 도면 수정 권한(whmap)');
ok('디렉터 = 항상', canEditMap({ role: 'director' }, false));
ok('whmap 수정 = 가능', canEditMap({ role: 'warehouse', pages: { whmap: 'anywhere' }, pageAccess: { whmap: 'edit' } }, false));
ok('whmap 열람 = 불가', !canEditMap({ role: 'warehouse', pages: { whmap: 'anywhere' }, pageAccess: { whmap: 'view' } }, false));
ok('권한 없음(창고만) = 불가', !canEditMap({ role: 'warehouse', pages: { warehouse: 'anywhere' }, pageAccess: { warehouse: 'edit' } }, false));
ok('등록기기 전용인데 미등록 기기 = 불가', !canEditMap({ role: 'warehouse', pages: { whmap: 'registered_only' }, pageAccess: { whmap: 'edit' } }, false)
  && canEditMap({ role: 'warehouse', pages: { whmap: 'registered_only' }, pageAccess: { whmap: 'edit' } }, true));
ok('소시오도 권한 없으면 불가', !canEditMap({ role: 'socio', pages: {} }, false));

const URL = process.env.TEST_PG_URL;
if (!URL) { console.log(`\n결과: ${pass} 통과 / ${fail} 실패`); process.exit(fail ? 1 : 0); }
process.env.DATABASE_URL = URL;
const { pool, query } = await import('../src/db.js');
const rs = await import('../src/rackStock.js'); rs.setRackStockReady(true);
const routes = (await import('../src/routes/whMapRoutes.js')).default;
const H = {}; const app = {};
const OPTS = {};
for (const m of ['get', 'post', 'put', 'patch', 'delete']) app[m] = (p, o, h) => { H[m.toUpperCase() + ' ' + p] = (typeof o === 'function' ? o : h); OPTS[m.toUpperCase() + ' ' + p] = o; };
await routes(app);
const TAG = 'TSTWM';
const DIRPERM = { role: 'director' };
const uid = Number((await query(`INSERT INTO users (name, role, pin_hash) VALUES ('${TAG}','director','x') RETURNING id`)).rows[0].id);
async function call(k, { body = {}, q = {} } = {}) {
  const r = { _c: 200, _s: null, code(c) { this._c = c; return this; }, send(b) { this._s = b; return b; } };
  const out = await H[k]({ user: { sub: uid }, ctx: { deviceId: null, perm: DIRPERM, isRegistered: false }, body, query: q, params: {} }, r);
  return { out, code: r._c };
}
await query(`DELETE FROM warehouse_maps WHERE id='main'`);
const mk = async (code, name, stock) => Number((await query(`INSERT INTO products (code, name, stock_qty) VALUES ($1,$2,$3) RETURNING id`, [code, name, stock])).rows[0].id);
const P1 = await mk(TAG + '01', 'TERMINAL TEST', 50), P2 = await mk(TAG + '02', 'RÓTULA TEST', 20);
const meta = { reason: 'manual', ref: 'test', userId: uid };
await rs.setRackQty(null, P1, 'ZQ1-1', 30, meta); await rs.setRackQty(null, P1, 'ZQ1-3', 10, meta);
await rs.setRackQty(null, P2, 'ZQ1-2', 20, meta); await rs.setRackQty(null, P2, 'ZQ10-1', 5, meta);

console.log('\n② 도면 읽기');
let g = await call('GET /api/wh-map');
ok('저장 전 → 기본 도면 · seeded', g.out.ok && g.out.seeded && g.out.zones.length === 8 && g.out.version === 0);
ok('랙 요약에 ZQ1-1 30', g.out.racks.some((x) => x.rack === 'ZQ1-1' && x.qty === 30));
ok('known 에 랙별 재고 랙 포함', g.out.known.includes('ZQ1-2'));
ok('디렉터 → can_edit true', g.out.can_edit === true);
{
  const pre = OPTS['PUT /api/wh-map'].preHandler[1];
  const mkR = () => ({ _c: 200, _s: null, code(c) { this._c = c; return this; }, send(b) { this._s = b; return b; } });
  let rr = mkR(); await pre({ ctx: { perm: { role: 'warehouse', pages: { warehouse: 'anywhere' }, pageAccess: {} }, isRegistered: false } }, rr);
  ok('저장 가드: 창고 권한만 → 403', rr._c === 403 && rr._s.page === 'whmap');
  rr = mkR(); await pre({ ctx: { perm: { role: 'warehouse', pages: { whmap: 'anywhere' }, pageAccess: { whmap: 'edit' } }, isRegistered: false } }, rr);
  ok('저장 가드: whmap 수정 → 통과', rr._c === 200 && rr._s === null);
  const gr = OPTS['GET /api/wh-map'].preHandler.length === 2;
  ok('읽기 가드 존재', gr);
}

console.log('\n③ 칸(bay) 상세');
let b = await call('GET /api/wh-map/bay', { q: { bay: 'zq1' } });
ok('ZQ1 → ZQ1-1·ZQ1-2·ZQ1-3 (ZQ10-1 제외)', b.out.items.length === 3 && b.out.items.every((x) => /^ZQ1-/.test(x.rack)), b.out.items);
ok('층 순서 ZQ1-1 → ZQ1-2 → ZQ1-3', b.out.items.map((x) => x.rack).join(',') === 'ZQ1-1,ZQ1-2,ZQ1-3');
b = await call('GET /api/wh-map/bay', { q: { bay: 'ZQ1-3' } });
ok('정확한 랙 이름(ZQ1-3)도 됨', b.out.items.length === 1 && b.out.items[0].qty === 10);
b = await call('GET /api/wh-map/bay', { q: { bay: "x'1" } });
ok('잘못된 bay 400', b.code === 400);

console.log('\n④ 검색');
const s = await call('GET /api/wh-map/search', { q: { q: 'rótula test' } });
ok('품명 검색 → ZQ1-2 · ZQ10-1 (bay 포함)', s.out.items.length === 2 && s.out.items.some((x) => x.bay === 'ZQ10'), s.out.items);
ok('한 글자 검색은 빈 결과', (await call('GET /api/wh-map/search', { q: { q: 'Z' } })).out.items.length === 0);

console.log('\n⑤ 저장 · 버전');
const zones = [...SEED_ZONES, { id: 'zq', name: 'ZQ', type: 'storage', x: 1, y: 1, w: 10, h: 10, rows: [['ZQ1', 'ZQ10']] }];
let p = await call('PUT /api/wh-map', { body: { zones, version: 0 } });
ok('첫 저장 version 1', p.out.ok && p.out.version === 1, p.out);
p = await call('PUT /api/wh-map', { body: { zones, version: 0 } });
ok('옛 version 으로 저장 → 409', p.code === 409 && p.out.error === 'version_conflict');
p = await call('PUT /api/wh-map', { body: { zones: [...zones, { id: 'dup', type: 'storage', x: 0, y: 0, w: 5, h: 5, rows: [['AA1']] }], version: 1 } });
ok('중복 랙 → 400 dup_bay', p.code === 400 && p.out.error === 'dup_bay' && p.out.bay === 'AA1');
p = await call('PUT /api/wh-map', { body: { zones, version: 1 } });
ok('두 번째 저장 version 2', p.out.ok && p.out.version === 2);
g = await call('GET /api/wh-map');
ok('읽기 → 저장본(9구역 · seeded false · 저장자)', !g.out.seeded && g.out.zones.length === 9 && g.out.version === 2 && g.out.updated_by === TAG);

await query(`DELETE FROM warehouse_maps WHERE id='main'`);
await query(`DELETE FROM product_rack_moves WHERE product_id = ANY($1)`, [[P1, P2]]);
await query(`DELETE FROM product_rack_stock WHERE product_id = ANY($1)`, [[P1, P2]]);
await query(`DELETE FROM products WHERE id = ANY($1)`, [[P1, P2]]);
await query(`DELETE FROM audit_log WHERE user_id=$1`, [uid]).catch(() => {});
await query(`DELETE FROM users WHERE id=$1`, [uid]);
await pool.end();
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
