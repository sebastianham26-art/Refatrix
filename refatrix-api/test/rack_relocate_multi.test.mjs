/* 2026-10-16 · 위치변경 × 다중 랙 SKU (rackMoveRoutes 20261016rl1 · 0279)
   증상: 실사 랙 업로드로 2·3번째 랙은 랙별 재고(product_rack_stock)에만 있고 제품마스터(rack_location)에는 없다.
         → 위치변경 화면에서 그 랙을 스캔하면 「등록되지 않은 코드」, 출발 랙 기록이 없으면 도착 랙이 부풀어 랙 합 > 재고.
   실행:  TEST_PG_URL=postgres://... node test/rack_relocate_multi.test.mjs  (없으면 skip) */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(here, '..');
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  ✅ ' + n); }
  else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); }
};

const MIG = fs.readFileSync(path.join(API, 'migrations/0279_rack_registry_ubicaciones.sql'), 'utf8');
console.log('\n① 0279 정적 검사');
ok('기존 테이블 구조 변경 없음', !/ALTER TABLE|DROP /i.test(MIG));
ok('이미 지정된 랙은 건드리지 않음(NOT EXISTS · DO NOTHING)', /WHERE NOT EXISTS/.test(MIG) && /ON CONFLICT \(rack\) DO NOTHING/.test(MIG));
ok('170개 랙', (MIG.match(/^\s+\('[A-Z0-9-]+'\)/gm) || []).length === 170);

const URL = process.env.TEST_PG_URL;
if (!URL) { console.log('\nTEST_PG_URL 없음 → DB 파트 skip'); console.log(`\n결과: ${pass} 통과 / ${fail} 실패`); process.exit(fail ? 1 : 0); }
process.env.DATABASE_URL = URL;

const { pool, query } = await import('../src/db.js');
const rs = await import('../src/rackStock.js');
rs.setRackStockReady(true);
const routes = (await import('../src/routes/rackMoveRoutes.js')).default;
const H = {};
const app = {};
for (const m of ['get', 'post', 'put', 'patch', 'delete']) app[m] = (p, o, h) => { H[m.toUpperCase() + ' ' + p] = (typeof o === 'function' ? o : h); };
await routes(app);
const UID = { v: null };
async function call(key, { body = {}, query: q = {}, params = {} } = {}) {
  const r = { _code: 200, _sent: null }; r.code = (c) => { r._code = c; return r; }; r.send = (b) => { r._sent = b; return b; };
  const out = await H[key]({ user: { sub: UID.v }, ctx: { deviceId: null }, body, query: q, params }, r);
  return { out, code: r._code, sent: r._sent };
}
const TAG = 'TSTMR';
async function clean() {
  await query(`DELETE FROM rack_moves WHERE product_code LIKE '${TAG}%'`);
  await query(`DELETE FROM product_rack_moves WHERE product_id IN (SELECT id FROM products WHERE code LIKE '${TAG}%')`);
  await query(`DELETE FROM product_rack_stock WHERE product_id IN (SELECT id FROM products WHERE code LIKE '${TAG}%')`);
  await query(`DELETE FROM products WHERE code LIKE '${TAG}%'`);
  await query(`DELETE FROM rack_kinds WHERE rack IN ('ZZ9-1','zz9-2','FMT-01')`);
}
await clean();
UID.v = Number((await query(`INSERT INTO users (name, role, pin_hash) VALUES ('${TAG}창고','warehouse','x') RETURNING id`)).rows[0].id);
const mk = async (code, rack, stock) => Number((await query(
  `INSERT INTO products (code, name, rack_location, stock_qty) VALUES ($1,$1,$2,$3) RETURNING id`, [code, rack, stock])).rows[0].id);
const A = await mk(TAG + '01', 'ZZ1-1', 30);          // 마스터 = ZZ1-1 하나, 실제는 ZZ1-1 10 + ZZ2-3 20
const B = await mk(TAG + '02', 'ZZ1-1', 12);          // ZZ1-1 4 · 위치 미지정 8
const meta = { reason: 'import', ref: 'test', userId: UID.v };
await rs.setRackQty(null, A, 'ZZ1-1', 10, meta);
await rs.setRackQty(null, A, 'ZZ2-3', 20, meta);
await rs.setRackQty(null, B, 'ZZ1-1', 4, meta);
await query(`INSERT INTO rack_kinds (rack, kind) VALUES ('FMT-01','fast')`);
const racksOf = async (pid) => Object.fromEntries((await query(`SELECT rack, qty FROM product_rack_stock WHERE product_id=$1`, [pid])).rows.map((r) => [r.rack, Number(r.qty)]));
const sum = (o) => Object.values(o).reduce((s, v) => s + v, 0);

console.log('\n② 랙 목록 = 마스터 ∪ 랙별 재고 ∪ 유형 지정');
{
  const g = await call('GET /api/warehouse/racks');
  const by = Object.fromEntries(g.out.racks.map((r) => [r.rack.toUpperCase(), r]));
  ok('마스터에 없는 2번째 랙(ZZ2-3)도 목록에 나온다', !!by['ZZ2-3'], Object.keys(by).filter((k) => k.startsWith('ZZ')));
  ok('ZZ2-3 제품수 1', by['ZZ2-3'] && by['ZZ2-3'].products === 1, by['ZZ2-3']);
  ok('ZZ1-1 은 한 줄(중복 없음) · 제품수 2', g.out.racks.filter((r) => r.rack.toUpperCase() === 'ZZ1-1').length === 1 && by['ZZ1-1'].products === 2, by['ZZ1-1']);
}

console.log('\n③ 제품 조회 — 랙별 재고 같이');
{
  const r = await call('GET /api/warehouse/relocate/lookup', { query: { q: `CTR-${TAG}01-5` } });
  const list = (r.out.product.rack_stock || []).map((x) => x.rack + ':' + x.qty).sort();
  ok('rack_stock = ZZ1-1 10 · ZZ2-3 20', JSON.stringify(list) === JSON.stringify(['ZZ1-1:10', 'ZZ2-3:20']), r.out.product);
  ok('unassigned 0', r.out.product.unassigned === 0);
  ok('마스터 위치는 그대로(ZZ1-1)', r.out.product.rack === 'ZZ1-1');
  const r2 = await call('GET /api/warehouse/relocate/lookup', { query: { q: `${TAG}02` } });
  ok('B: unassigned 8', r2.out.product.unassigned === 8, r2.out.product);
}

console.log('\n④ 2번째 랙에서 위치변경');
let mv1;
{
  const r = await call('POST /api/warehouse/rack-moves', { body: { from_rack: 'ZZ2-3', to_rack: 'FMT-01', update_master: false,
    lines: [{ product_id: A, cartons: 4, per_carton: 5 }] } });
  mv1 = r.out.moved[0];
  ok('저장 성공', r.out.ok === true, r.sent || r.out);
  ok('rack 결과 short 0 · added 20', mv1.rack && mv1.rack.short === 0 && mv1.rack.added === 20, mv1.rack);
  const s = await racksOf(A);
  ok('ZZ2-3 0 · FMT-01 20 · ZZ1-1 10', !s['ZZ2-3'] && s['FMT-01'] === 20 && s['ZZ1-1'] === 10, s);
  ok('랙 합 = 재고 30', sum(s) === 30, s);
}

console.log('\n⑤ 출발 랙 기록이 모자람 → 도착 랙은 채울 수 있는 만큼만(재고 초과 금지)');
let mv2;
{
  const r = await call('POST /api/warehouse/rack-moves', { body: { from_rack: 'ZZ1-1', to_rack: 'FMT-01', update_master: false,
    lines: [{ product_id: A, cartons: 1, per_carton: 16 }] } });
  mv2 = r.out.moved[0];
  ok('taken 10 · added 10 · short 6', mv2.rack && mv2.rack.taken === 10 && mv2.rack.added === 10 && mv2.rack.short === 6, mv2.rack);
  ok('from_had 10', mv2.rack.from_had === 10);
  const s = await racksOf(A);
  ok('랙 합이 재고(30)를 넘지 않는다', sum(s) === 30, s);
  ok('rack_moves 기록은 실제 박스 수량(16) 그대로', Number((await query(`SELECT qty_ea FROM rack_moves WHERE id=$1`, [mv2.id])).rows[0].qty_ea) === 16);
}

console.log('\n⑥ 출발 랙 기록 없음 + 위치 미지정 있음 → 미지정에서 올라온 것으로');
{
  const r = await call('POST /api/warehouse/rack-moves', { body: { from_rack: 'ZZ3-3', to_rack: 'FMT-01', update_master: false,
    lines: [{ product_id: B, cartons: 1, per_carton: 6 }] } });
  const m = r.out.moved[0];
  ok('B: taken 0 · added 6 · short 0', m.rack && m.rack.taken === 0 && m.rack.added === 6 && m.rack.short === 0, m.rack);
  ok('다른 랙 안내에 ZZ1-1 4', (m.rack.others || []).some((x) => x.rack === 'ZZ1-1' && x.qty === 4), m.rack.others);
  const s = await racksOf(B);
  ok('B: ZZ1-1 4 · FMT-01 6 (합 10 ≤ 12)', s['ZZ1-1'] === 4 && s['FMT-01'] === 6, s);
}

console.log('\n⑦ 되돌리기 = 그 이동이 바꾼 랙 수량 그대로');
{
  const u2 = await call('POST /api/warehouse/rack-moves/:id/undo', { params: { id: mv2.id } });
  ok('되돌리기 성공', u2.out && u2.out.ok, u2.sent || u2.out);
  let s = await racksOf(A);
  ok('ZZ1-1 10 · FMT-01 20 (출발 랙이 16으로 부풀지 않음)', s['ZZ1-1'] === 10 && s['FMT-01'] === 20, s);
  await call('POST /api/warehouse/rack-moves/:id/undo', { params: { id: mv1.id } });
  s = await racksOf(A);
  ok('처음 상태로: ZZ1-1 10 · ZZ2-3 20', s['ZZ1-1'] === 10 && s['ZZ2-3'] === 20 && !s['FMT-01'], s);
}

console.log('\n⑧ 0279 실행 — 재실행 안전 · 기존 지정 보존');
{
  await query(`INSERT INTO rack_kinds (rack, kind) VALUES ('ae1-1','fast') ON CONFLICT DO NOTHING`).catch(() => {});
  const before = (await query(`SELECT rack, kind FROM rack_kinds WHERE UPPER(rack)='AE1-1'`)).rows;
  await query(MIG); await query(MIG);
  const after = (await query(`SELECT rack, kind FROM rack_kinds WHERE UPPER(rack)='AE1-1'`)).rows;
  ok('AE1-1 한 행 · 기존 유형 유지', after.length === 1 && after[0].kind === before[0].kind, { before, after });
  const n = Number((await query(`SELECT COUNT(DISTINCT UPPER(rack))::int n FROM rack_kinds WHERE UPPER(rack) IN (${
    (MIG.match(/\('([A-Z0-9-]+)'\)/g) || []).map((x) => x.slice(1, -1)).join(',')})`)).rows[0].n);
  ok('170개 랙 모두 등록', n === 170, n);
  const g = await call('GET /api/warehouse/racks');
  ok('빈 랙(AF3-6)도 스캔 목록에 나온다', g.out.racks.some((r) => r.rack.toUpperCase() === 'AF3-6'));
}

await clean();
await query(`DELETE FROM audit_log WHERE user_id=$1`, [UID.v]).catch(() => {});
await query(`DELETE FROM users WHERE id=$1`, [UID.v]);
await pool.end();
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
