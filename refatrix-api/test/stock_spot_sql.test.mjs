/* SKU 스팟점검(0188) — 운영 라우트 모듈을 그대로 import 해서 실 PostgreSQL 위에서 실행한다.
   (SQL 복붙이 아니라 운영 코드 자체를 돌리므로, 코드가 바뀌면 이 테스트도 같이 바뀐다)

   실행:  TEST_PG_URL=postgres://... node test/stock_spot_sql.test.mjs
   TEST_PG_URL 이 없으면 DB 파트는 skip 하고 정적 가드 검사만 돈다(기본 CI 무영향). */
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

/* ---------- ① 정적 가드 (DB 없이도 항상 돈다) ---------- */
const SRC = fs.readFileSync(path.join(API, 'src/routes/stockCountRoutes.js'), 'utf8');
console.log('\n① 정적 가드 — 스팟점검은 재고를 바꾸지 않는다');
ok('rev 마커 갱신', /loaded rev 20260827spot/.test(SRC));
ok('세션 모드 2종만 허용', /const MODES = \['full', 'spot'\]/.test(SRC));
ok('스팟 세션 코드 접두사 SP', /mode === 'spot' \? 'SP' : 'SC'/.test(SRC));
// 재고를 바꾸는 문장은 기존 apply 경로에만 있어야 한다(스팟 추가로 늘어나지 않았는지)
ok('stock_qty 를 쓰는 UPDATE 는 딱 1곳(기존 apply)', (SRC.match(/UPDATE products SET stock_qty=/g) || []).length === 1);
ok('promo stock_qty UPDATE 도 1곳(기존 apply)', (SRC.match(/UPDATE promo_items SET stock_qty=/g) || []).length === 1);
ok('rack_location UPDATE 는 기존 apply 2곳뿐', (SRC.match(/SET rack_location=/g) || []).length === 2);
const spotBlock = SRC.slice(SRC.indexOf('SKU 스팟점검 (mode='), SRC.indexOf('================= 대조(reconcile)'));
ok('스팟 블록 안에 products UPDATE 없음', spotBlock.length > 1000 && !/UPDATE\s+products/.test(spotBlock));
ok('스팟 블록 안에 promo_items UPDATE 없음', !/UPDATE\s+promo_items/.test(spotBlock));
ok('스팟 블록 안에 stock_movements 기록 없음', !/stock_movements/.test(spotBlock));
ok('라인 기록에 spot 차단', /const sc = await loadSession\(id\);[\s\S]{0,220}FULL_ONLY/.test(SRC));
ok('대조(reconcile)에 spot 차단', /스팟점검 세션은 대조 대상이 아니다[\s\S]{0,160}FULL_ONLY/.test(SRC));
ok('반영(apply)에 spot 차단', /스팟점검은 기록 전용[\s\S]{0,160}error: 'full_only'/.test(SRC));
ok('점검 기록은 창고 편집권한', /'\/api\/stock-counts\/:id\/spot-checks', \{ preHandler: \[authGuard, requirePageEdit\('warehouse'\)\] \}/.test(SRC));
ok('점검 이력 조회는 창고 읽기권한', /'\/api\/stock-counts\/spot\/history', \{ preHandler: \[authGuard, requirePage\('warehouse'\)\] \}/.test(SRC));
ok('감사로그는 0057 CHECK 의 표준 액션만', (SRC.match(/action: '([a-z_]+)'/g) || []).every((s) => /'(create|update|delete)'/.test(s)));

const MIG = fs.readFileSync(path.join(API, 'migrations/0188_stock_count_spot.sql'), 'utf8');
console.log('\n② 마이그레이션 가드');
// 주석(-- …)을 걷어낸 뒤 실제 DDL 만 본다 — 설명문에 이름이 나오는 것은 변경이 아니다.
const MIG_SQL = MIG.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const alters = MIG_SQL.match(/ALTER TABLE (\w+)/g) || [];
ok('기존 테이블 변경은 stock_counts 뿐', alters.every((a) => /stock_counts|stock_count_spot_checks/.test(a)));
ok('stock_count_lines 에 손대지 않는다', !/stock_count_lines/.test(MIG_SQL));
ok('stock_count_adjustments 에 손대지 않는다', !/stock_count_adjustments/.test(MIG_SQL));
ok('mode CHECK 존재', /stock_counts_mode_chk/.test(MIG));
ok('result CHECK 존재', /scsc_result_chk/.test(MIG));
ok('part/promo 짝 CHECK 존재', /scsc_item_chk/.test(MIG));
ok('재실행 안전(IF NOT EXISTS/DO 가드)', /ADD COLUMN IF NOT EXISTS/.test(MIG) && /CREATE TABLE IF NOT EXISTS/.test(MIG));

const FRONT = fs.readFileSync(path.resolve(API, '..', 'refatrix-stockcount.html'), 'utf8');
ok('프런트 build 태그 갱신', /build sc0827spot/.test(FRONT));

/* ---------- ③ 실 DB 파트 ---------- */
const URL = process.env.TEST_PG_URL || process.env.DATABASE_URL;
if (!URL) {
  console.log('\n③ DB 파트 — TEST_PG_URL 없음 → skip');
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}
process.env.DATABASE_URL = URL;

const { pool, query } = await import('../src/db.js');
const routes = (await import('../src/routes/stockCountRoutes.js')).default;

const H = {};
const app = {};
for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
  app[m] = (p, o, h) => { H[m.toUpperCase() + ' ' + p] = (typeof o === 'function' ? o : h); };
}
await routes(app);

let WH = null, WH2 = null, DIR = null;
function mkReply() {
  const r = { _code: 200, _sent: null };
  r.code = (c) => { r._code = c; return r; };
  r.send = (b) => { r._sent = b; return b; };
  return r;
}
async function call(key, { as = 'wh', body = {}, query: q = {}, params = {} } = {}) {
  const h = H[key];
  if (!h) throw new Error('no handler: ' + key);
  const reply = mkReply();
  const who = as === 'dir' ? { userId: DIR, role: 'director' }
    : as === 'wh2' ? { userId: WH2, role: 'warehouse' } : { userId: WH, role: 'warehouse' };
  const req = { ctx: { perm: { ...who, fields: new Set() } }, body, query: q, params };
  const out = await h(req, reply);
  return { out, code: reply._code, sent: reply._sent, body: reply._sent || out };
}

async function seed() {
  await query(`DELETE FROM stock_count_spot_checks`);
  await query(`DELETE FROM stock_count_adjustments`);
  await query(`DELETE FROM stock_count_lines`);
  await query(`DELETE FROM stock_counts`);
  await query(`DELETE FROM product_syd_codes WHERE product_id IN (SELECT id FROM products WHERE code LIKE 'SPT%')`);
  await query(`DELETE FROM promo_items WHERE code LIKE 'SPT%'`);
  await query(`DELETE FROM products WHERE code LIKE 'SPT%'`);
  await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE name LIKE '스팟테스트%')`);
  await query(`DELETE FROM users WHERE name LIKE '스팟테스트%'`);
  const mkUser = async (name, role) => Number((await query(
    `INSERT INTO users (name, role, pin_hash) VALUES ($1,$2,'x') RETURNING id`, [name, role])).rows[0].id);
  WH = await mkUser('스팟테스트창고', 'warehouse');
  WH2 = await mkUser('스팟테스트창고2', 'warehouse');
  DIR = await mkUser('스팟테스트디렉터', 'director');
  const mk = async (code, name, rack, stock, ean) => Number((await query(
    `INSERT INTO products (code, name, rack_location, stock_qty, ean) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [code, name, rack, stock, ean])).rows[0].id);
  const a = await mk('SPTCE0796', 'TERMINAL EXTERIOR', 'B-01-01', 480, '7501234500019');
  const b = await mk('SPTCQ0445', 'BOMBA AGUA', 'AA3-2, B2-2', 36, null);
  const c = await mk('SPTCL0211', 'SENSOR', '', 12, null);
  const promo = Number((await query(
    `INSERT INTO promo_items (code, name, barcode, rack_location, stock_qty) VALUES ('SPTPROMO','GORRA','7509999900001','P-01',40) RETURNING id`)).rows[0].id);
  await query(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,'SYD-9911')`, [a]);
  return { a, b, c, promo };
}

const P = await seed();
console.log('\n③ 실 DB — 세션·기록');

// 세션 2개(전체/스팟)
const full = (await call('POST /api/stock-counts', { body: { scope_note: '전체' } })).body;
const spot = (await call('POST /api/stock-counts', { body: { scope_note: '스팟', mode: 'spot' } })).body;
ok('전체실사 코드 SC-', /^SC-\d{4}-\d{4}$/.test(full.code), full.code);
ok('스팟점검 코드 SP-', /^SP-\d{4}-\d{4}$/.test(spot.code), spot.code);
ok('스팟 세션 mode=spot', spot.mode === 'spot');
ok('전체 세션 mode=full (기존 동작 불변)', full.mode === 'full');
ok('알 수 없는 mode 는 full 로', (await call('POST /api/stock-counts', { body: { mode: 'xxx' } })).body.mode === 'full');

const SID = spot.id;
const post = (b, as) => call('POST /api/stock-counts/:id/spot-checks', { as, params: { id: SID }, body: b });

// ① 맞음 — 마스터 위치와 같은 랙을 스캔
let r = await post({ raw_code: 'SPTCE0796', result: 'ok', rack_scanned: 'B-01-01' });
ok('맞음 기록됨', r.code === 200 && r.body.check.result === 'ok');
ok('시스템 수량 스냅샷 저장', r.body.check.system_qty === 480, r.body.check.system_qty);
ok('마스터 위치 스냅샷 저장', r.body.check.master_rack === 'B-01-01');
ok('랙 일치 판정 true', r.body.check.rack_match === true);
ok('매칭 경로 ctr', r.body.check.match_source === 'ctr');

// ② EAN 스캔도 같은 제품으로
r = await post({ raw_code: '7501234500019', result: 'ok', rack_scanned: 'B-01-01' });
ok('EAN 으로도 같은 제품', r.body.check.product_id === P.a && r.body.check.match_source === 'ean');

// ③ SYD 코드 스캔
r = await post({ raw_code: 'SYD-9911', result: 'ok', rack_scanned: 'B-01-01' });
ok('SYD 역검색도 인식', r.body.check.product_id === P.a && r.body.check.match_source === 'syd');

// ④ 다른 랙을 스캔 — 막지 않고 저장하되 rack_match=false
r = await post({ raw_code: 'SPTCE0796', result: 'ok', rack_scanned: 'C-09-09' });
ok('다른 랙이어도 저장은 된다', r.code === 200);
ok('랙 불일치 판정 false', r.body.check.rack_match === false);

// ⑤ 마스터 위치가 콤마로 여러 랙인 제품 — 둘 중 하나만 맞아도 일치
r = await post({ raw_code: 'SPTCQ0445', result: 'ok', rack_scanned: 'B2-2' });
ok('콤마 다중 랙 — 두 번째 랙도 일치', r.body.check.rack_match === true, r.body.check.master_rack);

// ⑥ 스캐너 구분자 흔들림(AA32) 폴백
r = await post({ raw_code: 'SPTCQ0445', result: 'ok', rack_scanned: 'AA32' });
ok('구분자 없는 랙 표기도 일치로 붙는다', r.body.check.rack_match === true);

// ⑦ 마스터 위치가 비어 있으면 판정 불가(null) — 틀렸다고 단정하지 않는다
r = await post({ raw_code: 'SPTCL0211', result: 'ok', rack_scanned: 'Z-01' });
ok('마스터 위치 없으면 rack_match=null', r.body.check.rack_match === null);

// ⑧ 틀림 — 수량은 받지 않는다
r = await post({ raw_code: 'SPTCL0211', result: 'mismatch' });
ok('틀림 기록됨', r.code === 200 && r.body.check.result === 'mismatch');
ok('틀림은 랙 스캔 없이 저장', r.body.check.rack_scanned === '');

// ⑨ 랙 스캔 생략한 맞음
r = await post({ raw_code: 'SPTPROMO', result: 'ok' });
ok('프로모 품목도 점검 가능', r.code === 200 && r.body.check.item_kind === 'promo');
r = await post({ raw_code: '7509999900001', result: 'ok', rack_scanned: 'P-01' });
ok('프로모 바코드도 인식', r.body.check.promo_item_id === P.promo);

// ⑩ 거부되는 입력
ok('미등록 코드 404', (await post({ raw_code: 'NOPE-999', result: 'ok' })).code === 404);
ok('빈 코드 400', (await post({ raw_code: '  ', result: 'ok' })).code === 400);
ok('result 값이 이상하면 400', (await post({ raw_code: 'SPTCE0796', result: 'maybe' })).code === 400);
ok('수량을 보내도 무시(수량 컬럼 자체가 없음)',
  (await post({ raw_code: 'SPTCE0796', result: 'ok', counted_qty: 999, rack_scanned: 'B-01-01' })).code === 200);

console.log('\n④ ★ 재고·위치 불변 (스팟점검은 기록 전용)');
const after = (await query(`SELECT code, stock_qty, rack_location FROM products WHERE code LIKE 'SPT%' ORDER BY code`)).rows;
ok('SPTCE0796 재고 480 그대로', Number(after.find((x) => x.code === 'SPTCE0796').stock_qty) === 480);
ok('SPTCQ0445 재고 36 그대로', Number(after.find((x) => x.code === 'SPTCQ0445').stock_qty) === 36);
ok('SPTCL0211 재고 12 그대로(틀림을 기록해도)', Number(after.find((x) => x.code === 'SPTCL0211').stock_qty) === 12);
ok('마스터 위치도 그대로', after.find((x) => x.code === 'SPTCE0796').rack_location === 'B-01-01'
  && after.find((x) => x.code === 'SPTCQ0445').rack_location === 'AA3-2, B2-2');
ok('프로모 재고도 그대로', Number((await query(`SELECT stock_qty FROM promo_items WHERE code='SPTPROMO'`)).rows[0].stock_qty) === 40);
ok('stock_movements 에 실사 조정이 생기지 않았다',
  Number((await query(`SELECT COUNT(*)::int n FROM stock_movements WHERE source='count'`)).rows[0].n) === 0);

console.log('\n⑤ 요약 — 같은 SKU 는 최근 결과가 이긴다');
let list = (await call('GET /api/stock-counts/:id/spot-checks', { params: { id: SID } })).body;
ok('최신순 정렬', list.checks.length > 1 && list.checks[0].id > list.checks[1].id);
const sumBefore = list.summary;
ok('점검 건수 = 저장된 행 수', sumBefore.checks === list.checks.length);
ok('SKU 수는 중복 제외', sumBefore.skus === 4, sumBefore);
ok('SPTCE0796 은 마지막이 맞음', list.checks.find((c) => c.product_id === P.a).result === 'ok');
// 같은 SKU 를 다시 점검해 결과를 뒤집는다
await post({ raw_code: 'SPTCE0796', result: 'mismatch' });
list = (await call('GET /api/stock-counts/:id/spot-checks', { params: { id: SID } })).body;
ok('재점검하면 요약의 틀림이 늘고 맞음이 준다',
  list.summary.mismatch === sumBefore.mismatch + 1 && list.summary.ok === sumBefore.ok - 1, list.summary);
ok('SKU 수는 그대로(같은 SKU 재점검)', list.summary.skus === sumBefore.skus);
ok('원장은 지워지지 않는다(행이 늘어난다)', list.summary.checks === sumBefore.checks + 1);
ok('위치 불일치 건수 집계', typeof list.summary.rack_diff === 'number');
ok('점검 시점 수량과 현재 수량을 함께 준다', list.checks[0].current_qty === 12 || list.checks[0].current_qty === 480);

console.log('\n⑥ 점검 취소(오스캔 정정)');
const target = list.checks[0];
ok('남이 기록한 점검은 취소 못 함',
  (await call('DELETE /api/stock-counts/:id/spot-checks/:checkId', { as: 'wh2', params: { id: SID, checkId: target.id } })).code === 403);
ok('본인 기록은 취소 가능',
  (await call('DELETE /api/stock-counts/:id/spot-checks/:checkId', { params: { id: SID, checkId: target.id } })).code === 200);
const gone = (await call('GET /api/stock-counts/:id/spot-checks', { params: { id: SID } })).body;
ok('취소한 행이 사라짐', !gone.checks.some((c) => c.id === target.id));
const other = gone.checks[0];
ok('디렉터는 남의 기록도 취소 가능',
  (await call('DELETE /api/stock-counts/:id/spot-checks/:checkId', { as: 'dir', params: { id: SID, checkId: other.id } })).code === 200);

console.log('\n⑦ 모드 경계 — 서로의 기능을 쓸 수 없다');
ok('스팟 세션에 실사 라인 기록 → 409 full_only',
  (await call('POST /api/stock-counts/:id/lines', { params: { id: SID }, body: { raw_code: 'SPTCE0796' } })).body.error === 'full_only');
ok('스팟 세션 대조 → 409 full_only',
  (await call('GET /api/stock-counts/:id/reconcile', { params: { id: SID } })).body.error === 'full_only');
ok('스팟 세션 반영 미리보기 → 409 full_only',
  (await call('POST /api/stock-counts/:id/apply/preview', { as: 'dir', params: { id: SID } })).body.error === 'full_only');
// 전체실사 세션을 제출까지 올려놓고 스팟 반영을 시도해도 막히는지(반영은 submitted 에서만 열린다)
await query(`UPDATE stock_counts SET status='submitted', submitted_at=now() WHERE id=$1`, [SID]);
const applyTry = await call('POST /api/stock-counts/:id/apply', { as: 'dir', params: { id: SID }, body: { pin: '0000' } });
ok('스팟 세션 반영 → PIN 검사보다 먼저 full_only 로 막힌다',
  applyTry.code === 409 && applyTry.body.error === 'full_only', applyTry.body);
ok('전체 세션에 스팟 기록 → 409 spot_only',
  (await call('POST /api/stock-counts/:id/spot-checks', { params: { id: full.id }, body: { raw_code: 'SPTCE0796', result: 'ok' } })).body.error === 'spot_only');
ok('전체 세션 스팟 조회 → 409 spot_only',
  (await call('GET /api/stock-counts/:id/spot-checks', { params: { id: full.id } })).body.error === 'spot_only');
ok('완료(제출)된 스팟 세션엔 추가 불가',
  (await post({ raw_code: 'SPTCE0796', result: 'ok' })).body.error === 'not_draft');

console.log('\n⑧ 점검 이력 (세션을 넘나드는 조회)');
await query(`UPDATE stock_counts SET status='draft' WHERE id=$1`, [SID]);
const spot2 = (await call('POST /api/stock-counts', { body: { scope_note: '2회차', mode: 'spot' } })).body;
await call('POST /api/stock-counts/:id/spot-checks', { params: { id: spot2.id }, body: { raw_code: 'SPTCQ0445', result: 'mismatch' } });
let hist = (await call('GET /api/stock-counts/spot/history', { query: { days: 30 } })).body;
ok('두 세션의 기록이 함께 나온다', new Set(hist.checks.map((c) => c.count_id)).size === 2);
ok('세션 코드가 붙는다', hist.checks.every((c) => /^SP-/.test(c.count_code)));
ok('SKU별 최근 점검 요약', hist.by_sku.length >= 3 && hist.by_sku.every((s) => s.last_at && s.checks >= 1));
const q445 = hist.by_sku.find((s) => s.code === 'SPTCQ0445');
ok('가장 최근 결과가 by_sku 에 반영', q445 && q445.last_result === 'mismatch', q445);
ok('제품번호 필터', (await call('GET /api/stock-counts/spot/history', { query: { code: 'sptcq' } })).body.checks
  .every((c) => /SPTCQ/.test(c.matched_code)));
ok('결과 필터', (await call('GET /api/stock-counts/spot/history', { query: { result: 'mismatch' } })).body.checks
  .every((c) => c.result === 'mismatch'));
ok('세션 필터', (await call('GET /api/stock-counts/spot/history', { query: { count_id: spot2.id } })).body.checks
  .every((c) => c.count_id === spot2.id));
ok('랙 필터', (await call('GET /api/stock-counts/spot/history', { query: { rack: 'B-01-01' } })).body.checks.length > 0);
ok('기간 필터(내일부터) → 0건', (await call('GET /api/stock-counts/spot/history', {
  query: { from: new Date(Date.now() + 86400000).toISOString().slice(0, 10) } })).body.checks.length === 0);
// 취소된 세션은 이력에서 빠진다
await query(`UPDATE stock_counts SET status='canceled' WHERE id=$1`, [spot2.id]);
hist = (await call('GET /api/stock-counts/spot/history', { query: { days: 30 } })).body;
ok('취소된 세션은 이력에서 제외', !hist.checks.some((c) => c.count_id === spot2.id));
ok('전체실사 세션은 스팟 이력에 안 섞인다', !hist.checks.some((c) => c.count_id === full.id));

console.log('\n⑨ 목록 — 모드 표시·필터');
const all = (await call('GET /api/stock-counts', { query: {} })).body;
ok('목록에 mode 가 실린다', all.items.every((s) => s.mode === 'full' || s.mode === 'spot'));
ok('스팟 세션은 checks 건수를 준다', all.items.find((s) => s.id === SID).checks > 0);
ok('mode 필터', (await call('GET /api/stock-counts', { query: { mode: 'spot' } })).body.items.every((s) => s.mode === 'spot'));
ok('mode=full 필터', (await call('GET /api/stock-counts', { query: { mode: 'full' } })).body.items.every((s) => s.mode === 'full'));

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
await pool.end();
process.exit(fail ? 1 : 0);
