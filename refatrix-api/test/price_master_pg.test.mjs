// 가격 마스터 v2(0229) — 실 PostgreSQL 종단 테스트
//   실 priceMasterRoutes.js · productRoutes.js · purchaseRoutes.js + Fastify inject (인증만 스텁)
//   실행: PGADMIN_URL=postgres://postgres@localhost:5432/postgres node test/price_master_pg.test.mjs
//   PGADMIN_URL = CREATE DATABASE 권한이 있는 접속 URL. 없으면 건너뛴다.
//   전용 DB(pmtest_0229)를 새로 만들어 쓰고 운영 DB 는 건드리지 않는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import pg from 'pg';

const ADMIN = process.env.PGADMIN_URL || '';
if (!ADMIN) { console.log('PGADMIN_URL 없음 — 실 DB 테스트 건너뜀'); process.exit(0); }
const DB = 'pmtest_0229';
{
  const a = new pg.Client({ connectionString: ADMIN }); await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
}
{ const u = new URL(ADMIN); u.pathname = '/' + DB; process.env.DATABASE_URL = u.toString(); }
const { pool, query } = await import('../src/db.js');
const { hashPin } = await import('../src/auth.js');
const PM = await import('../src/priceMaster.js');
const priceMasterRoutes = (await import('../src/routes/priceMasterRoutes.js')).default;
const productRoutes = (await import('../src/routes/productRoutes.js')).default;
const purchaseRoutes = (await import('../src/routes/purchaseRoutes.js')).default;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✔', name); }
  catch (e) { fail++; console.log('  ✘', name, '\n     ', e.message.split('\n').slice(0, 6).join('\n      ')); }
}

await query(readFileSync(new URL('./price_master_schema.sql', import.meta.url), 'utf8'));
await query(`INSERT INTO users (id,name,login_id,role,pin_hash) VALUES (1,'Sebastian','seb','director',$1),(2,'Maria','maria','sales_support',$1)`, [hashPin('1234')]);
const P = [
  // code, name, origin, list, active, maker, model, material, syd codes
  ['CQ0728R', 'HORQUILLA', 'KR', 1031, true, 'NISSAN', 'X-TRAIL', 'aluminio', ['54500-8H310']],
  ['CQ0728L', 'HORQUILLA', 'KR', 1031, true, 'NISSAN', 'X-TRAIL', 'aluminio', ['54501-8H310']],
  ['CB0011', 'RÓTULA', 'KR', 344, true, 'DODGE', '200', null, ['1026018', '1026017']],
  ['CE0839L', 'TERMINAL EXTERIOR', 'CN', 412.37, true, 'VOLKSWAGEN', 'VENTO', null, ['K-9647']],
  ['GV1187', 'BUJE', 'TR', 200, true, 'NISSAN', 'X-TRAIL', null, []],
  ['GY0421', 'AMORTIGUADOR', 'CN', 1830, true, 'TOYOTA', 'HILUX', null, ['GY-421']],
  ['CQ0346', 'HORQUILLA', 'TR', 1120, false, 'VOLKSWAGEN', 'GOLF', null, []],
  ['CQ9999', 'HORQUILLA', 'KR', null, true, 'NISSAN', 'VERSA', null, ['CQ-9999-S']],
  ['CE0203', 'TERMINAL EXTERIOR', null, 298, true, 'HONDA', 'FIT', null, []],
  ['TK0004', 'BRAKE PAD', 'VN', 4, true, 'CHEVROLET', 'AVEO', null, []],
];
for (const [code, name, origin, price, active, maker, model, material, syds] of P) {
  const r = await query(`INSERT INTO products (code,name,origin,list_price,is_active,app,material) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [code, name, origin, price, active, `${maker} ${model} 2010-2015`, material]);
  await query(`INSERT INTO product_applications (product_id,app_text,maker,model) VALUES ($1,$2,$3,$4)`, [r.rows[0].id, `${maker} ${model} 2010-2015`, maker, model]);
  for (const s of syds) await query(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,$2)`, [r.rows[0].id, s]);
}
await query(`INSERT INTO products (code,name,origin,list_price,deleted_at) VALUES ('DEL001','HORQUILLA','KR',500,now())`);
await query(`INSERT INTO fx_rates (base,quote,rate,rate_date) VALUES ('USD','MXN',18.00,'2026-09-01'),('USD','MXN',18.35,'2026-09-20')`);
const pid = async (code) => Number((await query(`SELECT id FROM products WHERE code=$1`, [code])).rows[0].id);
const val = async (code, col = 'list_price') => { const v = (await query(`SELECT ${col} AS v FROM products WHERE code=$1`, [code])).rows[0].v; return v == null ? null : Number(v); };
const price = (c) => val(c, 'list_price');
const fob = (c) => val(c, 'fob_usd');

const app = Fastify({ bodyLimit: 12 * 1024 * 1024 });
app.register(priceMasterRoutes); app.register(productRoutes); app.register(purchaseRoutes);
await app.ready();
const call = async (method, url, body, user = '1:director') => {
  const [u, pages] = String(user).split('|');                 // "2:sales_support|pricemaster=view"
  const r = await app.inject({ method, url, payload: body, headers: { 'x-test-user': u, 'x-test-pages': pages || '' } });
  let j = {}; try { j = r.json(); } catch (_) {}
  return { ...j, status_body: j.status, status: r.statusCode };
};
const TODAY = PM.mxToday();
const addDays = (n) => new Date(Date.parse(TODAY + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

console.log('A. 0229 적용 전 (반쪽 배포)');
await t('facets 200 + ready:false · 가격표·적용은 503', async () => {
  const f = await call('GET', '/api/price-master/facets'); assert.equal(f.status, 200); assert.equal(f.ready, false);
  PM._resetReadyForTest();
  assert.equal((await call('GET', '/api/price-master/table')).status, 503);
  assert.equal((await call('POST', '/api/price-master/batches', { pin: '1234', direction: 1, pct: 5, note: 'x1', filter: {} })).error, 'migration_required');
});
await t('0229 전에도 제품 ✎ 수정 · 구매 미리보기 정상(FOB 검증은 쉼)', async () => {
  PM._resetReadyForTest();
  assert.equal((await call('PATCH', `/api/products/${await pid('GV1187')}`, { list_price: 210 })).status, 200);
  await call('PATCH', `/api/products/${await pid('GV1187')}`, { list_price: 200 });
  const r = await call('POST', '/api/purchases/preview', { rows: [{ code: 'CQ0728R', ref: 'R1', qty: 1, cost_usd: 17 }] });
  assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.lines[0].fob_status, undefined);
});
await t('비디렉터 403', async () => { assert.equal((await call('GET', '/api/price-master/facets', null, '2:sales_support')).status, 403); });

console.log('B. 마이그레이션');
const MIG = readFileSync(new URL('../migrations/0229_price_master.sql', import.meta.url), 'utf8');
await t('적용 + List initial 적재 · 재실행 멱등', async () => {
  await query(MIG); await query(MIG);
  assert.equal((await query(`SELECT COUNT(*)::int n FROM product_price_history WHERE source='initial' AND price_type='list'`)).rows[0].n, 9);
  assert.equal((await query(`SELECT COUNT(*)::int n FROM product_price_history`)).rows[0].n, 9);
});
PM._resetReadyForTest(); await PM.priceMasterReady(true);

console.log('C. 계산');
await t('JS 계산 = SQL 계산 (무작위 2,000건 · List·FOB 반올림 전부)', async () => {
  const U = [0.001, 0.01, 1, 10];
  for (let i = 0; i < 2000; i++) {
    const old = Math.round((Math.random() * 5000 + 1) * 1000) / 1000;
    const dir = Math.random() < 0.5 ? 1 : -1;
    const pct = Number((Math.floor(Math.random() * 30000) / 1000 + 0.001).toFixed(3));
    const r = U[i % 4];
    const sql = Number((await query(`SELECT ${PM.newPriceSql('$1::numeric', 2, 3, 4)} AS v`, [old, dir, pct.toFixed(3), r])).rows[0].v);
    const js = PM.calcNewPrice(old, dir, pct, r);
    if (Math.abs(sql - js) > 1e-9) throw new Error(`불일치 ${old} ${dir} ${pct} ${r}: sql=${sql} js=${js}`);
  }
});
await t('입력 검증 — 방향·%·반올림(List/FOB 별)·비율', async () => {
  assert.equal(PM.normalizeChange({ direction: -1, pct: 100 }).error, 'bad_pct');
  assert.equal(PM.normalizeChange({ direction: 1, pct: 5, rounding: 0.001 }).error, 'bad_rounding');   // List 에 0.001 없음
  assert.equal(PM.normalizeChange({ price_type: 'fob', direction: 1, pct: 5, rounding: 0.001 }).rounding, 0.001);
  assert.equal(PM.normalizeChange({ price_type: 'fob', mode: 'ratio', ratio: 0.9 }).error, 'ratio_list_only');
  assert.equal(PM.normalizeChange({ mode: 'ratio', ratio: 0 }).error, 'bad_ratio');
  assert.equal(PM.sydNorm(' 54500-8h310 '), '545008H310');
});

console.log('D. ① FOB·List 엑셀 · 가격표 · 단일 수정');
let impFob;
await t('엑셀 미리보기: FOB 변경·List 변경·같음·모름·오류·중복', async () => {
  const rows = [{ code: 'cq0728r', fob: '17.28', list: 1031 }, { code: 'CQ0728L', fob: 17.28 }, { code: 'CB0011', fob: '$5.95', list: 350 },
    { code: 'GV1187', fob: 3.35 }, { code: 'GY0421', fob: 31.2 }, { code: 'NOPE01', fob: 1 }, { code: 'CE0203', fob: 'abc' }, { code: 'GV1187', fob: 4 }];
  const r = await call('POST', '/api/price-master/import/preview', { rows });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.fob_changes, 5); assert.equal(r.list_changes, 1); assert.equal(r.unknown_count, 1); assert.equal(r.error_count, 2);
});
await t('엑셀 반영(오늘): FOB 묶음 + List 묶음 · 되돌리기 가능한 set 묶음', async () => {
  const rows = [{ code: 'CQ0728R', fob: 17.28 }, { code: 'CQ0728L', fob: 17.28 }, { code: 'CB0011', fob: 5.95, list: 350 }, { code: 'GV1187', fob: 3.35 }, { code: 'GY0421', fob: 31.2 }];
  assert.equal((await call('POST', '/api/price-master/import/commit', { rows, pin: '1', note: '공장 단가표' })).status, 403);
  const r = await call('POST', '/api/price-master/import/commit', { rows, pin: '1234', note: 'CTR 공장 단가표 2026-09' });
  assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.fob.count, 5); assert.equal(r.fob.applied, 5); assert.equal(r.list.applied, 1);
  impFob = r.fob.id;
  assert.equal(await fob('CQ0728R'), 17.28); assert.equal(await price('CB0011'), 350);
  const h = (await query(`SELECT price_type, source, old_price, new_price FROM product_price_history WHERE batch_id=$1`, [impFob])).rows;
  assert.equal(h.length, 5); assert.ok(h.every((x) => x.price_type === 'fob' && x.old_price == null));
});
await t('가격표: FOB·List·배수(최신 환율 18.35)·CTR÷SYD · 보기 필터', async () => {
  await query(`UPDATE products SET list_price_syd=1140 WHERE code='CQ0728R'`);
  await query(`UPDATE products SET list_price_syd=300 WHERE code='CB0011'`);
  const r = await call('GET', '/api/price-master/table?q=CQ0728R');
  assert.equal(r.status, 200, JSON.stringify(r)); const x = r.rows[0];
  assert.equal(x.fob_usd, 17.28); assert.equal(x.mult, Math.round(1031 / (17.28 * 18.35) * 100) / 100); assert.equal(x.ratio, 0.9044);
  assert.equal(r.fx.rate, 18.35);
  const nf = await call('GET', '/api/price-master/table?view=no_fob');
  assert.ok(nf.rows.every((y) => y.fob_usd == null)); assert.ok(nf.rows.some((y) => y.code === 'CE0839L'));
  const so = await call('GET', '/api/price-master/table?view=syd_over');
  assert.deepEqual(so.rows.map((y) => y.code), ['CB0011']);
  const ml = await call('GET', '/api/price-master/table?view=mult_lt&mult_lt=3.3');
  assert.ok(ml.rows.map((y) => y.code).includes('CQ0728R'));   // 3.25
});
await t('단일 수정 List(오늘) → 즉시 · 단일 수정 FOB(미래) → 예약 · 같은 값 거부', async () => {
  const id = await pid('CQ0728R');
  assert.equal((await call('POST', '/api/price-master/single', { product_id: id, price_type: 'list', price: 1031, pin: '1234', note: '같음' })).error, 'same_price');
  const a = await call('POST', '/api/price-master/single', { product_id: id, price_type: 'list', price: '1,060', pin: '1234', note: '고객 요청 재검토' });
  assert.equal(a.status, 200, JSON.stringify(a)); assert.equal(a.status_body, 'applied'); assert.equal(await price('CQ0728R'), 1060);
  const b = await call('POST', '/api/price-master/single', { product_id: id, price_type: 'fob', price: 17.8, pin: '1234', note: 'FOB 인상 통보', effective_date: addDays(5) });
  assert.equal(b.status_body, 'scheduled'); assert.equal(await fob('CQ0728R'), 17.28);
  const h = await call('GET', '/api/price-master/product?code=CQ0728R');
  assert.equal(h.upcoming[0].price_type, 'fob'); assert.equal(h.upcoming[0].new_price, 17.8);
  assert.equal(h.history[0].condition, '단일 수정');
  await PM.applyDue({ today: addDays(5) }); assert.equal(await fob('CQ0728R'), 17.8);
});

console.log('E. ② 일괄 변경 — 조건 확장 · FOB · SYD 비율');
await t('조건: 원산지 KR + 품목 HORQUILLA (AND) · 활성만 · 정가 없음은 대상 아님', async () => {
  const r = await call('POST', '/api/price-master/preview', { filter: { origin: ['KR'], cat: ['horquilla'] }, direction: 1, pct: 5 });
  assert.deepEqual(r.rows.map((x) => x.code).sort(), ['CQ0728L', 'CQ0728R', 'CQ9999']);
  assert.equal(r.summary.eligible, 2); assert.equal(r.summary.not_eligible, 1);
  assert.equal(r.rows.find((x) => x.code === 'CQ0728L').new_price, 1082.55);
});
await t('조건 추가: 소재 · List 범위 · CTR÷SYD 범위 · 배수 범위 · 코드 붙여넣기', async () => {
  let r = await call('POST', '/api/price-master/preview', { filter: { material: ['ALUMINIO'] }, direction: 1, pct: 1 });
  assert.deepEqual(r.rows.map((x) => x.code).sort(), ['CQ0728L', 'CQ0728R']);
  r = await call('POST', '/api/price-master/preview', { filter: { list_min: 300, list_max: 500 }, direction: 1, pct: 1 });
  assert.deepEqual(r.rows.map((x) => x.code).sort(), ['CB0011', 'CE0839L']);
  r = await call('POST', '/api/price-master/preview', { filter: { ratio_max: 0.95 }, direction: 1, pct: 1 });
  assert.deepEqual(r.rows.map((x) => x.code), ['CQ0728R']);                  // 1060/1140 = 0.93
  r = await call('POST', '/api/price-master/preview', { filter: { mult_max: 3.3 }, direction: 1, pct: 1 });
  assert.ok(r.rows.map((x) => x.code).includes('GV1187'));                   // 200/(3.35×18.35) = 3.25
  r = await call('POST', '/api/price-master/preview', { filter: { codes: 'cb0011\nGV1187, nope' }, direction: 1, pct: 1 });
  assert.deepEqual(r.rows.map((x) => x.code).sort(), ['CB0011', 'GV1187']);
});
await t('FOB 일괄 % (CN · FOB 없는 제품은 제외) · 예약 겹침 경고는 같은 가격 종류만', async () => {
  const pv = await call('POST', '/api/price-master/preview', { price_type: 'fob', filter: { origin: ['CN'] }, direction: 1, pct: 3, rounding: 0.001 });
  assert.equal(pv.summary.eligible, 1); assert.equal(pv.rows.find((x) => x.code === 'GY0421').new_price, 32.136);
  const r = await call('POST', '/api/price-master/batches', { price_type: 'fob', filter: { origin: ['CN'] }, direction: 1, pct: 3, rounding: 0.001, pin: '1234', note: '공장 단가 인상', effective_date: addDays(10) });
  assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.product_count, 1);
  const pl = await call('POST', '/api/price-master/preview', { filter: { origin: ['CN'] }, direction: 1, pct: 1 });
  assert.equal(pl.overlaps.length, 0);                                       // List 미리보기엔 FOB 예약이 안 겹침
  const pf = await call('POST', '/api/price-master/preview', { price_type: 'fob', filter: { origin: ['CN'] }, direction: 1, pct: 1, rounding: 0.01 });
  assert.equal(pf.overlaps.length, 1);
  await call('POST', `/api/price-master/batches/${r.id}/cancel`);
});
await t('SYD 비율 맞추기: 새 List = SYD × 비율 · SYD 없는 제품은 no_syd', async () => {
  const pv = await call('POST', '/api/price-master/preview', { mode: 'ratio', ratio: 0.95, scope: 'selected', product_ids: [await pid('CQ0728R'), await pid('GV1187')], filter: {} });
  assert.equal(pv.summary.eligible, 1); assert.equal(pv.summary.after_sum, 1083);
  const r = await call('POST', '/api/price-master/batches', { mode: 'ratio', ratio: 0.95, scope: 'selected', product_ids: [await pid('CQ0728R'), await pid('GV1187')], filter: {}, pin: '1234', note: 'SYD 95%' });
  assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.applied_count, 1); assert.equal(await price('CQ0728R'), 1083);
  const d = await call('GET', `/api/price-master/batches/${r.id}`);
  assert.equal(d.items.length, 1);                                           // GV1187 은 SYD 가 없어 대상 스냅샷에서 빠짐
});
await t('% 적용 · 예약 복리 · 동시 적용 1번 · 0 이하 제외 (v1 동작 유지)', async () => {
  const a = await call('POST', '/api/price-master/batches', { scope: 'selected', product_ids: [await pid('GV1187')], filter: {}, direction: -1, pct: 3, note: '인하A', pin: '1234', effective_date: addDays(7) });
  const b = await call('POST', '/api/price-master/batches', { scope: 'selected', product_ids: [await pid('GV1187')], filter: {}, direction: 1, pct: 10, note: '인상B', pin: '1234', effective_date: addDays(7) });
  assert.equal(a.status, 200, JSON.stringify(a)); assert.equal(b.status, 200, JSON.stringify(b));
  const [x, y] = await Promise.all([PM.applyDue({ today: addDays(7) }), PM.applyDue({ today: addDays(7) })]);
  assert.equal(x.ran + y.ran, 2); assert.equal(await price('GV1187'), 213.4);   // 200 → 194 → 213.40
  assert.ok(a.id && b.id);
  const z = await call('POST', '/api/price-master/batches', { filter: { origin: ['VN'] }, direction: -1, pct: 10, rounding: 10, note: '0 테스트', pin: '1234' });
  assert.equal(z.applied_count, 0); assert.equal((await call('GET', `/api/price-master/batches/${z.id}`)).items[0].result, 'to_zero');
});

console.log('F. 화면 수정·제품 엑셀도 List 장부에');
await t('✎ 수정 → manual(list) · 직접 추가 → manual · 제품 엑셀 → import', async () => {
  await call('PATCH', `/api/products/${await pid('CQ0728L')}`, { list_price: '1,100' });
  const h = (await query(`SELECT * FROM product_price_history WHERE product_id=$1 ORDER BY id DESC LIMIT 1`, [await pid('CQ0728L')])).rows[0];
  assert.equal(h.source, 'manual'); assert.equal(h.price_type, 'list'); assert.equal(Number(h.new_price), 1100);
  const n = await call('POST', '/api/products', { code: 'NEW001', name: 'BUJE', list_price: 150 });
  assert.equal((await query(`SELECT COUNT(*)::int n FROM product_price_history WHERE product_id=$1`, [n.id])).rows[0].n, 1);
  const r = await call('POST', '/api/products/import/commit', { header: ['Clave CTR', 'Nombre del producto', 'List Price'], rows: [['GY0421', 'AMORTIGUADOR', 1900], ['NEW002', 'BUJE', 99.5]] });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal((await query(`SELECT source FROM product_price_history WHERE product_id=$1 ORDER BY id DESC LIMIT 1`, [await pid('GY0421')])).rows[0].source, 'import');
});
await t('장부 쓰기가 실패해도 제품 저장은 산다 (SAVEPOINT)', async () => {
  await query(`ALTER TABLE product_price_history ADD CONSTRAINT tmp_block CHECK (new_price <> 777)`);
  assert.equal((await call('PATCH', `/api/products/${await pid('CE0203')}`, { list_price: 777 })).status, 200);
  assert.equal(await price('CE0203'), 777);
  await query(`ALTER TABLE product_price_history DROP CONSTRAINT tmp_block`);
  await call('PATCH', `/api/products/${await pid('CE0203')}`, { list_price: 298 });
});

console.log('G. 되돌리기 (가격 종류별)');
await t('FOB 엑셀 묶음 되돌리기: 뒤에 FOB 가 바뀐 CQ0728R(단일 수정)만 건너뜀 · List 변경은 영향 없음', async () => {
  const r = await call('POST', `/api/price-master/batches/${impFob}/revert`, { pin: '1234' });
  assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.reverted, 4);
  assert.deepEqual(r.skipped, [{ code: 'CQ0728R', reason: 'later_change' }]);
  assert.equal(await fob('CB0011'), null); assert.equal(await fob('CQ0728R'), 17.8);
  assert.equal((await call('POST', `/api/price-master/batches/${impFob}/revert`, { pin: '1234' })).status, 409);
  // 다시 채워 둔다(구매 검증용)
  const again = await call('POST', '/api/price-master/import/commit', { rows: [{ code: 'CQ0728L', fob: 17.28 }, { code: 'CB0011', fob: 5.95 }, { code: 'GV1187', fob: 3.35 }, { code: 'GY0421', fob: 31.2 }], pin: '1234', note: '다시' });
  assert.equal(again.fob.applied, 4);
});

console.log('H. ⑤ 경쟁사 SYD 리스트');
let L1, L2;
await t('첫 리스트: 전부 신규 · 대응품번으로 SYD List 갱신(CTR 1개에 SYD 여럿 → 가장 높은 값)', async () => {
  const rows = [{ code: '54500-8H310', price: 1086, familia: 'HORQUILLA' }, { code: '54501 8H310', price: 1086, familia: 'HORQUILLA' },
    { code: '1026018', price: 380, familia: 'ROTULA' }, { code: '1026017', price: 395, familia: 'ROTULA' },
    { code: 'K-9647', price: 450, familia: 'TERMINAL' }, { code: 'GY-421', price: 1990, familia: 'AMORT' }, { code: 'X-GONE', price: 10, familia: 'OTRO' },
    { code: 'K-9647', price: 999 }, { code: '', price: 5 }, { code: 'BAD', price: 'x' }];
  const r = await call('POST', '/api/price-master/syd/lists', { list_date: addDays(-90), file_name: 'syd_jun.xlsx', rows });
  assert.equal(r.status, 200, JSON.stringify(r)); L1 = r.id;
  assert.equal(r.codes, 7); assert.equal(r.dup, 1); assert.equal(r.error_count, 2); assert.equal(r.new, 7);
  assert.equal(await val('CB0011', 'list_price_syd'), 395);                 // 1026018=380, 1026017=395 → 높은 값
  assert.equal(await val('CE0839L', 'list_price_syd'), 450);                 // 중복은 첫 값
});
await t('두 번째 리스트: 인상·인하·같음·신규·사라짐 집계 · 최신이면 SYD List 갱신', async () => {
  const rows = [{ code: '54500-8H310', price: 1140, familia: 'HORQUILLA' }, { code: '54501-8H310', price: 1140, familia: 'HORQUILLA' },
    { code: '1026018', price: 399, familia: 'ROTULA' }, { code: '1026017', price: 395, familia: 'ROTULA' },
    { code: 'K-9647', price: 420, familia: 'TERMINAL' }, { code: 'GY-421', price: 1990, familia: 'AMORT' }, { code: 'NEW-1', price: 50, familia: 'OTRO' }];
  const r = await call('POST', '/api/price-master/syd/lists', { list_date: addDays(-1), file_name: 'syd_sep.xlsx', rows });
  assert.equal(r.status, 200, JSON.stringify(r)); L2 = r.id;
  assert.deepEqual([r.up, r.down, r.same, r.new, r.gone], [3, 1, 2, 1, 1]);
  assert.equal(await val('CQ0728R', 'list_price_syd'), 1140); assert.equal(await val('CB0011', 'list_price_syd'), 399);
  assert.equal(await val('CE0839L', 'list_price_syd'), 420);
});
await t('옛 날짜 리스트를 나중에 올려도 SYD List 를 덮지 않는다', async () => {
  const r = await call('POST', '/api/price-master/syd/lists', { list_date: addDays(-200), rows: [{ code: '1026018', price: 1 }] });
  assert.equal(r.is_latest, false); assert.equal(r.products_synced, 0); assert.equal(await val('CB0011', 'list_price_syd'), 399);
  await call('DELETE', `/api/price-master/syd/lists/${r.id}`, { pin: '1234' });
});
await t('미래 날짜 · 빈 파일 거부', async () => {
  assert.equal((await call('POST', '/api/price-master/syd/lists', { list_date: addDays(3), rows: [{ code: 'A', price: 1 }] })).error, 'future_date');
  assert.equal((await call('POST', '/api/price-master/syd/lists', { list_date: TODAY, rows: [] })).error, 'no_rows');
});
let rep;
await t('리포트: 목표 비율 기본값 = 현재 실제 평균 · 인상+우리가 목표보다 쌈 → 제안가', async () => {
  rep = await call('GET', `/api/price-master/syd/lists/${L2}/report`);
  assert.equal(rep.status, 200, JSON.stringify(rep).slice(0, 300));
  assert.equal(rep.list.prev_id, L1); assert.equal(rep.kpi.up, 3); assert.equal(rep.kpi.linked, 5);
  // 평균 = (1083/1086 + 1100/1086 + 350/395 + 412.37/450 + 1900/1990) / 5
  const avg = (1083 / 1086 + 1100 / 1086 + 350 / 395 + 412.37 / 450 + 1900 / 1990) / 5;
  assert.equal(rep.target_default, Math.round(avg * 10000) / 10000);
  const codes = rep.rows.map((r) => r.code).sort();
  assert.deepEqual(codes, ['CB0011', 'CQ0728R']);   // CQ0728L(1,100)은 이미 목표 이상 → 제안 없음
  const cb = rep.rows.find((r) => r.code === 'CB0011');
  assert.equal(cb.syd_old, 395); assert.equal(cb.syd_new, 399);           // 둘 다 가장 높은 값 기준
  assert.equal(cb.suggested, PM.roundTo(399 * rep.target, 0.01));
  assert.ok(rep.by_familia.find((f) => f.familia === 'HORQUILLA').up === 2);
});
await t('리포트 보기: 인하인데 우리가 SYD보다 비쌈 · 목표 비율 바꾸기', async () => {
  await query(`UPDATE products SET list_price=430 WHERE code='CE0839L'`);
  const d = await call('GET', `/api/price-master/syd/lists/${L2}/report?view=down_above`);
  assert.deepEqual(d.rows.map((r) => r.code), ['CE0839L']); assert.equal(d.rows[0].over_syd, true);
  const hi = await call('GET', `/api/price-master/syd/lists/${L2}/report?target=0.5`);
  assert.equal(hi.rows.length, 0);                                           // 목표 0.5 면 모두 이미 목표 이상
});
await t('체크 → 제안가로 변경 만들기(set · origin syd) → 적용 · 제품 이력에 SYD 가격 표시', async () => {
  const items = rep.rows.filter((r) => r.code !== 'CQ0728L').map((r) => ({ product_id: r.product_id, price: r.suggested }));
  const r = await call('POST', '/api/price-master/batches', { items, syd_list_id: L2, pin: '1234', note: 'SYD 인상 따라감' });
  assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.applied_count, 2);
  assert.equal(await price('CB0011'), items.find((i) => i.product_id === rep.rows.find((x) => x.code === 'CB0011').product_id).price);
  const list = await call('GET', '/api/price-master/batches');
  const b = list.items.find((x) => x.id === r.id); assert.equal(b.origin, 'syd'); assert.ok(b.condition.startsWith('SYD 제안 2개'));
  const h = await call('GET', '/api/price-master/product?code=CB0011');
  assert.equal(h.syd.length, 2); assert.equal(h.syd[0].price, 399); assert.equal(h.syd[0].prev, 395);
});
await t('SYD 리스트 삭제(PIN) → 최신 리스트 기준으로 SYD List 다시 맞춤', async () => {
  assert.equal((await call('DELETE', `/api/price-master/syd/lists/${L2}`, { pin: '0' })).status, 403);
  const r = await call('DELETE', `/api/price-master/syd/lists/${L2}`, { pin: '1234' });
  assert.equal(r.status, 200); assert.equal(r.latest, L1); assert.equal(await val('CB0011', 'list_price_syd'), 395);
  assert.equal((await query(`SELECT COUNT(*)::int n FROM price_change_batches WHERE syd_list_id IS NULL AND origin='syd'`)).rows[0].n, 1);
});

console.log('I. ⑥ 구매가 검증 (허용 오차 0)');
let po1;
await t('구매 기록: 주문일 당시 FOB 와 비교 — 일치·비쌈·쌈·FOB 없음·미등록', async () => {
  // FOB 이력: CQ0728L 17.28(오늘) · GY0421 31.2(오늘) — 주문일을 내일로 잡아 「그날 FOB」가 되게
  const od = addDays(1);
  const po = (await query(`INSERT INTO purchase_orders (ref_no, order_date, currency, status) VALUES ('100RA26E1C',$1,'USD','recorded') RETURNING id`, [od])).rows[0];
  po1 = Number(po.id);
  const L = [['CQ0728L', 120, 17.28], ['CB0011', 300, 6.10], ['GV1187', 80, 3.20], ['CE0839L', 40, 7.00], ['ZZNOPE', 5, 1]];
  for (const [c, q, u] of L) {
    const p = (await query(`SELECT id FROM products WHERE code=$1`, [c])).rows[0];
    await query(`INSERT INTO purchase_order_lines (po_id, product_id, input_code, qty, unit_cost_usd, amount_usd) VALUES ($1,$2,$3,$4,$5,$6)`,
      [po1, p ? p.id : null, c, q, u, q * u]);
  }
  const r = await call('GET', `/api/price-master/purchase-check/${po1}`);
  assert.equal(r.status, 200, JSON.stringify(r));
  const st = Object.fromEntries(r.lines.map((l) => [l.code, l.status]));
  assert.deepEqual(st, { CQ0728L: 'ok', CB0011: 'over', GV1187: 'under', CE0839L: 'no_fob', ZZNOPE: 'unmatched' });
  assert.equal(r.summary.over_usd, 45); assert.equal(r.summary.under_usd, -12);
  assert.equal(r.lines.find((l) => l.code === 'CB0011').diff_pct, Math.round((6.1 - 5.95) / 5.95 * 10000) / 10000);
});
await t('1센트 차이도 불일치', async () => {
  await query(`UPDATE purchase_order_lines SET unit_cost_usd=17.29 WHERE po_id=$1 AND input_code='CQ0728L'`, [po1]);
  const r = await call('GET', `/api/price-master/purchase-check/${po1}`);
  assert.equal(r.lines.find((l) => l.code === 'CQ0728L').status, 'over');
  await query(`UPDATE purchase_order_lines SET unit_cost_usd=17.28 WHERE po_id=$1 AND input_code='CQ0728L'`, [po1]);
});
await t('주문일 기준: FOB 이력 이전 주문은 가장 이른 FOB 로(basis earliest) · 이후 FOB 인상은 옛 주문에 영향 없음', async () => {
  const old = (await query(`INSERT INTO purchase_orders (ref_no, order_date, currency, status) VALUES ('OLD1',$1,'USD','recorded') RETURNING id`, [addDays(-300)])).rows[0];
  await query(`INSERT INTO purchase_order_lines (po_id, product_id, input_code, qty, unit_cost_usd, amount_usd) VALUES ($1,$2,'GY0421',10,31.2,312)`, [old.id, await pid('GY0421')]);
  let r = await call('GET', `/api/price-master/purchase-check/${old.id}`);
  assert.equal(r.lines[0].fob_basis, 'earliest'); assert.equal(r.lines[0].status, 'ok');
  await call('POST', '/api/price-master/single', { product_id: await pid('GY0421'), price_type: 'fob', price: 33, pin: '1234', note: '인상', effective_date: addDays(2) });
  await PM.applyDue({ today: addDays(2) });
  r = await call('GET', `/api/price-master/purchase-check/${po1}`);          // 주문일(내일) 기준은 여전히 31.2
  assert.ok(r.lines.every((l) => l.code !== 'GY0421'));
  const po2 = (await query(`INSERT INTO purchase_orders (ref_no, order_date, currency, status) VALUES ('NEW2',$1,'USD','recorded') RETURNING id`, [addDays(3)])).rows[0];
  await query(`INSERT INTO purchase_order_lines (po_id, product_id, input_code, qty, unit_cost_usd, amount_usd) VALUES ($1,$2,'GY0421',10,31.2,312)`, [po2.id, await pid('GY0421')]);
  r = await call('GET', `/api/price-master/purchase-check/${po2.id}`);
  assert.equal(r.lines[0].fob, 33); assert.equal(r.lines[0].status, 'under');
});
await t('검증 목록: 기간 · 불일치만 · 합계', async () => {
  const r = await call('GET', `/api/price-master/purchase-check?only_bad=1`);
  assert.equal(r.status, 200); assert.ok(r.items.find((x) => x.ref_no === '100RA26E1C'));
  assert.equal(r.items.some((x) => x.ref_no === 'OLD1'), false);
  assert.ok(r.total.over >= 1 && r.total.under >= 2);
});
await t('구매 화면: 목록 fob_bad · 상세 줄 FOB · 업로드 미리보기 경고 (구매단가 권한자만)', async () => {
  const l = await call('GET', '/api/purchases');
  assert.equal(l.status, 200, JSON.stringify(l).slice(0, 200));
  assert.equal(l.items.find((x) => x.id === po1).fob_bad, 2);
  const d = await call('GET', `/api/purchases/${po1}`);
  assert.equal(d.lines.find((x) => x.input_code === 'CB0011').fob_status, 'over'); assert.equal(d.lines.find((x) => x.input_code === 'CB0011').fob_usd, 5.95);
  const pv = await call('POST', '/api/purchases/preview', { order_date: addDays(1), rows: [{ code: 'CB0011', ref: 'X', qty: 1, cost_usd: 5.95 }, { code: 'GV1187', ref: 'X', qty: 1, cost_usd: 9 }] });
  assert.equal(pv.summary.fob_mismatch, 1); assert.equal(pv.lines[0].fob_status, 'ok'); assert.equal(pv.lines[1].fob_status, 'over');
  const lm = await call('GET', '/api/purchases', null, '2:sales_support');
  assert.equal(lm.items.find((x) => x.id === po1).fob_bad, undefined);
  const dm = await call('GET', `/api/purchases/${po1}`, null, '2:sales_support');
  assert.equal(dm.lines[0].fob_usd, undefined);
});

console.log('J. 이력 · 삭제');
await t('변경 이력: 가격 종류 · 방식 · 조건 · 작성자', async () => {
  const r = await call('GET', '/api/price-master/batches?price_type=fob');
  assert.ok(r.items.length >= 3 && r.items.every((x) => x.price_type === 'fob'));
  assert.ok(r.items.some((x) => x.origin === 'import' && x.condition.startsWith('엑셀')));
  const all = await call('GET', '/api/price-master/batches');
  assert.ok(all.items.some((x) => x.mode === 'ratio'));
});
await t('정가·FOB 이력이 있어도 제품 삭제 가능(함께 정리)', async () => {
  const id = await pid('NEW001');
  await call('POST', '/api/price-master/single', { product_id: id, price_type: 'fob', price: 2, pin: '1234', note: '삭제전' });
  const c = await call('GET', `/api/products/${id}/delete-check`);
  assert.equal(c.can_delete, true, JSON.stringify(c.blockers));
  assert.equal((await call('DELETE', `/api/products/${id}`, { pin: '1234', code: 'NEW001' })).status, 200);
});

console.log('K. 권한 — 관리 › 사용자·권한 「가격 마스터」(pricemaster: 열람/수정)');
const NONE = '2:sales_support', VIEW = '2:sales_support|pricemaster=view', EDIT = '2:sales_support|pricemaster=edit';
await t('권한 없음 → 모든 가격 마스터 API 403', async () => {
  for (const [m, u] of [['GET', '/api/price-master/facets'], ['GET', '/api/price-master/table'], ['POST', '/api/price-master/preview'],
    ['GET', '/api/price-master/batches'], ['GET', '/api/price-master/syd/lists'], ['GET', '/api/price-master/purchase-check'], ['POST', '/api/price-master/single']]) {
    const r = await call(m, u, m === 'POST' ? { filter: {} } : undefined, NONE);
    assert.equal(r.status, 403, m + ' ' + u); assert.equal(r.error, 'forbidden');
  }
});
await t('열람 → 조회·미리보기·리포트·구매 검증 200 · can_edit false', async () => {
  const f = await call('GET', '/api/price-master/facets', undefined, VIEW); assert.equal(f.status, 200); assert.equal(f.can_edit, false);
  assert.equal((await call('GET', '/api/price-master/table', undefined, VIEW)).status, 200);
  assert.equal((await call('POST', '/api/price-master/preview', { filter: {}, direction: 1, pct: 1 }, VIEW)).status, 200);
  const b = await call('GET', '/api/price-master/batches', undefined, VIEW); assert.equal(b.status, 200);
  assert.equal((await call('GET', `/api/price-master/batches/${b.items[0].id}`, undefined, VIEW)).status, 200);
  assert.equal((await call('GET', '/api/price-master/product?code=CB0011', undefined, VIEW)).status, 200);
  const L = await call('GET', '/api/price-master/syd/lists', undefined, VIEW); assert.equal(L.status, 200);
  assert.equal((await call('GET', `/api/price-master/syd/lists/${L.items[0].id}/report`, undefined, VIEW)).status, 200);
  assert.equal((await call('GET', '/api/price-master/purchase-check', undefined, VIEW)).status, 200);
});
await t('열람 → 바꾸는 API 8개 전부 403 read_only (값 그대로)', async () => {
  const before = await price('CB0011');
  const id = await pid('CB0011');
  const bs = (await call('GET', '/api/price-master/batches')).items;
  const applied = bs.find((x) => x.status === 'applied'); const L = (await call('GET', '/api/price-master/syd/lists')).items[0];
  for (const [m, u, body] of [
    ['POST', '/api/price-master/single', { product_id: id, price_type: 'list', price: 999, pin: '1234', note: '열람자' }],
    ['POST', '/api/price-master/import/preview', { rows: [{ code: 'CB0011', list: 1 }] }],
    ['POST', '/api/price-master/import/commit', { rows: [{ code: 'CB0011', list: 1 }], pin: '1234', note: '열람자' }],
    ['POST', '/api/price-master/batches', { filter: {}, direction: 1, pct: 5, pin: '1234', note: '열람자' }],
    ['POST', `/api/price-master/batches/${applied.id}/cancel`, {}],
    ['POST', `/api/price-master/batches/${applied.id}/revert`, { pin: '1234' }],
    ['POST', '/api/price-master/syd/lists', { list_date: TODAY, rows: [{ code: 'A', price: 1 }] }],
    ['DELETE', `/api/price-master/syd/lists/${L.id}`, { pin: '1234' }]]) {
    const r = await call(m, u, body, VIEW);
    assert.equal(r.status, 403, m + ' ' + u); assert.equal(r.error, 'read_only', m + ' ' + u);
  }
  assert.equal(await price('CB0011'), before);
});
await t('수정 → can_edit true · 본인 PIN 으로 단일 수정 · 틀린 PIN 403 · 기록에 본인 이름', async () => {
  assert.equal((await call('GET', '/api/price-master/facets', undefined, EDIT)).can_edit, true);
  const id = await pid('CB0011');
  assert.equal((await call('POST', '/api/price-master/single', { product_id: id, price_type: 'list', price: 401.5, pin: '0000', note: '영업지원 수정' }, EDIT)).error, 'bad_pin');
  const r = await call('POST', '/api/price-master/single', { product_id: id, price_type: 'list', price: 401.5, pin: '1234', note: '영업지원 수정' }, EDIT);
  assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(await price('CB0011'), 401.5);
  const b = (await call('GET', '/api/price-master/batches', undefined, EDIT)).items.find((x) => x.id === r.id);
  assert.equal(b.created_by_name, 'Maria');
});
await t('디렉터는 키 없이도 전체 · can_edit true', async () => {
  const f = await call('GET', '/api/price-master/facets'); assert.equal(f.can_edit, true);
});

console.log('L. ⑦ 제품 수익성 · 판관비율');
await t('판관비율: 0231 전에는 ready:false · 저장 503', async () => {
  const r = await call('GET', '/api/price-master/profit');
  assert.equal(r.status, 200, JSON.stringify(r).slice(0, 200)); assert.equal(r.sga.ready, false); assert.equal(r.rows.length, 0);
  assert.equal((await call('PUT', '/api/price-master/settings/sga', { pct: 18, pin: '1234' })).status, 503);
});
const MIG31 = readFileSync(new URL('../migrations/0231_price_master_settings.sql', import.meta.url), 'utf8');
await query(MIG31); await query(MIG31); PM._resetSettingsForTest();
// 수입 배치: A(승인·USD 18) 부대비율 0.1 · B(승인·USD 20) 부대비율 1.0 · C(대기) 무시 · D(승인·삭제) 무시
const bA = (await query(`INSERT INTO import_batches (status, currency, fx_rate) VALUES ('approved','USD',18) RETURNING id`)).rows[0].id;
await query(`INSERT INTO import_lines (batch_id, product_id, qty, import_price) VALUES ($1,$2,100,10),($1,$3,100,2)`, [bA, await pid('CQ0728R'), await pid('GV1187')]);
await query(`INSERT INTO import_overheads (batch_id, label, amount, currency) VALUES ($1,'flete',2160,'MXN')`, [bA]);   // 2160 / 21600 = 0.1
const bB = (await query(`INSERT INTO import_batches (status, currency, fx_rate) VALUES ('approved','USD',20) RETURNING id`)).rows[0].id;
await query(`INSERT INTO import_lines (batch_id, product_id, qty, import_price) VALUES ($1,$2,50,4)`, [bB, await pid('CB0011')]);
await query(`INSERT INTO import_overheads (batch_id, label, amount, currency) VALUES ($1,'aduana',200,'USD')`, [bB]);    // 4000 / 4000 = 1.0
const bC = (await query(`INSERT INTO import_batches (status, currency, fx_rate) VALUES ('pending','USD',20) RETURNING id`)).rows[0].id;
await query(`INSERT INTO import_lines (batch_id, product_id, qty, import_price) VALUES ($1,$2,50,4)`, [bC, await pid('CB0011')]);
await query(`INSERT INTO import_overheads (batch_id, label, amount, currency) VALUES ($1,'x',99999,'USD')`, [bC]);
const bD = (await query(`INSERT INTO import_batches (status, currency, fx_rate, deleted_at) VALUES ('approved','USD',20, now()) RETURNING id`)).rows[0].id;
await query(`INSERT INTO import_overheads (batch_id, label, amount, currency) VALUES ($1,'x',99999,'USD')`, [bD]);
const bE = (await query(`INSERT INTO import_batches (status, currency, fx_rate, exclude_from_cost) VALUES ('approved','USD',20, true) RETURNING id`)).rows[0].id;   // 원가 제외(0069) — 무시
await query(`INSERT INTO import_lines (batch_id, product_id, qty, import_price) VALUES ($1,$2,50,4)`, [bE, await pid('CB0011')]);
await query(`INSERT INTO import_overheads (batch_id, label, amount, currency) VALUES ($1,'x',99999,'USD')`, [bE]);
// 매출: 게시 인보이스 2건 + 삭제 1건 + 초안 1건(둘 다 무시)
const inv = async (d, st, del) => (await query(`INSERT INTO sales_invoices (inv_date, status, deleted_at) VALUES ($1,$2,$3) RETURNING id`, [d, st, del ? new Date() : null])).rows[0].id;
const i1 = await inv('2026-01-10', 'posted'), i2 = await inv('2026-06-01', 'posted'), i3 = await inv('2026-06-02', 'posted', true), i4 = await inv('2026-06-03', 'draft');
const line = async (i, c, q, amt, cogs) => query(`INSERT INTO sales_invoice_lines (invoice_id, product_id, qty, line_amount_mxn, cogs_mxn) VALUES ($1,$2,$3,$4,$5)`, [i, await pid(c), q, amt, cogs]);
await line(i1, 'CQ0728R', 10, 6000, 3000); await line(i1, 'GV1187', 5, 1000, 400);
await line(i2, 'CQ0728R', 5, 3200, 1500); await line(i2, 'CE0203', 4, 1200, 800); await line(i2, 'CE0839L', 2, 900, 500);
await line(i3, 'CQ0728R', 100, 99999, 1); await line(i4, 'CQ0728R', 100, 99999, 1);
const FX = 18.35, GRATE = (2160 + 4000) / (21600 + 4000);
let prof;
await t('수익성: 누적 수량·매출(게시만) · 1개당 원가 = FOB × 환율 × (1 + 제품 부대비율) · 부대비율 없으면 전체 평균', async () => {
  prof = await call('GET', '/api/price-master/profit');
  assert.equal(prof.status, 200);
  assert.equal(prof.overhead.batches, 2); assert.equal(prof.overhead.rate, Math.round(GRATE * 10000) / 10000);
  const cq = prof.rows.find((r) => r.code === 'CQ0728R');
  assert.equal(cq.qty, 15); assert.equal(cq.revenue, 9200); assert.equal(cq.basis, 'fob'); assert.equal(cq.oh_rate, 0.1); assert.equal(cq.oh_source, 'product');
  const fobCq = await fob('CQ0728R');
  assert.ok(Math.abs(cq.unit_cost - fobCq * FX * 1.1) < 0.001, cq.unit_cost + ' vs ' + fobCq * FX * 1.1);
  assert.ok(Math.abs(cq.gp - (9200 - 15 * fobCq * FX * 1.1)) < 0.02);
  const gv = prof.rows.find((r) => r.code === 'GV1187'); assert.equal(gv.oh_rate, 0.1);
});
await t('FOB 없는 제품 → 판매 시점 실제원가(basis actual) · 이익 = 매출 − 실제원가', async () => {
  const ce = prof.rows.find((r) => r.code === 'CE0203');
  assert.equal(ce.basis, 'actual'); assert.equal(ce.unit_cost, 200); assert.equal(ce.gp, 400); assert.equal(ce.unit_price, 300);
});
await t('판매 없는 제품·삭제/초안 인보이스·대기/삭제 배치는 계산에서 빠짐', async () => {
  assert.equal(prof.rows.length, 4); assert.equal(prof.rows.some((r) => r.code === 'CB0011'), false);
});
await t('기간: 2026-03-01 부터 → CQ0728R 5개', async () => {
  const r = await call('GET', '/api/price-master/profit?from=2026-03-01');
  assert.equal(r.rows.find((x) => x.code === 'CQ0728R').qty, 5); assert.equal(r.rows.some((x) => x.code === 'GV1187'), false);
});
await t('차종 지역: 유럽 · 아시아 · 중복선택(OR) · 칩 개수', async () => {
  let r = await call('GET', '/api/price-master/profit?region=eu');
  assert.deepEqual(r.rows.map((x) => x.code), ['CE0839L']);
  r = await call('GET', '/api/price-master/profit?region=eu,asia');
  assert.equal(r.rows.length, 4);
  assert.equal(r.regions.find((x) => x.key === 'asia').n, 3); assert.equal(r.regions.find((x) => x.key === 'cn').n, 0);
  assert.deepEqual(PM.regionOf('Mercedes Benz Sprinter'), 'eu'); assert.equal(PM.regionOf('CHIREY'), 'cn'); assert.equal(PM.regionOf('LADA'), null);
});
await t('품목 중복선택 + 지역 겹치기 · 품목 칩 개수는 지역 조건 반영', async () => {
  const r = await call('GET', '/api/price-master/profit?cat=HORQUILLA,BUJE&region=asia');
  assert.deepEqual(r.rows.map((x) => x.code).sort(), ['CQ0728R', 'GV1187']);
  const e = await call('GET', '/api/price-master/profit?region=eu');
  assert.deepEqual(e.cats.map((c) => c.v), ['TERMINAL EXTERIOR']);
});
await t('판관비율 저장: 비디렉터 403 · PIN 틀림 403 · 범위 400 · 저장 → 조회에 값·작성자', async () => {
  assert.equal((await call('PUT', '/api/price-master/settings/sga', { pct: 18, pin: '1234' }, '2:sales_support|pricemaster=edit')).status, 403);
  assert.equal((await call('PUT', '/api/price-master/settings/sga', { pct: 18, pin: '0' })).error, 'bad_pin');
  assert.equal((await call('PUT', '/api/price-master/settings/sga', { pct: 120, pin: '1234' })).error, 'bad_sga');
  const s = await call('PUT', '/api/price-master/settings/sga', { pct: '18,5', pin: '1234' });
  assert.equal(s.status, 200); assert.equal(s.sga.pct, 18.5);
  const g = await call('GET', '/api/price-master/profit', undefined, '2:sales_support|pricemaster=view');
  assert.equal(g.sga.pct, 18.5); assert.equal(g.sga.by_name, 'Sebastian'); assert.equal(g.can_set_sga, false);
});
await t('정렬: ① 가격표 제목(sort·dir) · ② 미리보기 제목', async () => {
  const a = await call('GET', '/api/price-master/table?sort=list&dir=asc&limit=500');
  const l = a.rows.map((r) => r.list_price).filter((x) => x != null); assert.deepEqual(l, [...l].sort((x, y) => x - y));
  const n = await call('GET', '/api/price-master/table?sort=name&dir=desc&limit=500');
  const nm = n.rows.map((r) => String(r.name || '').toUpperCase()); assert.deepEqual(nm, [...nm].sort().reverse());
  const pv = await call('POST', '/api/price-master/preview', { filter: {}, direction: 1, pct: 5, sort: 'new', dir: 'desc', limit: 500 });
  const nv = pv.rows.map((r) => r.new_price).filter((x) => x != null); assert.deepEqual(nv, [...nv].sort((x, y) => y - x));
  const pv2 = await call('POST', '/api/price-master/preview', { filter: {}, direction: 1, pct: 5, sort: 'code', dir: 'desc', limit: 500 });
  assert.equal(pv2.rows[0].code > pv2.rows[pv2.rows.length - 1].code, true);
});

await app.close(); await pool.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
