/* promo_products_sql.test.mjs — 프로모션 품목 = 제품마스터(PRO) 등록 (2026-09-18)
 *
 *   확인하는 것
 *     ① 정적 가드 — 운영 소스(stockCountRoutes.js)가 규칙을 지키는지
 *        · PRO 접두사가 아닌 제품은 이 경로로 못 만지는지(assertPro / pro_prefix_required)
 *        · stock_qty 를 바꾸는 곳은 열거된 3곳뿐이고, **전부 stock_movements 를 함께 남기는지**
 *     ② 런타임 — 이 파일에 적힌 SQL 이 **운영 소스에 그대로 있는지 먼저 대조한 뒤**(드리프트 방지)
 *        pg-mem 위에서 실제로 실행해 결과를 확인한다.
 *
 *   실행:  npm i pg-mem   &&   node refatrix-api/test/promo_products_sql.test.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { newDb } from 'pg-mem';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(HERE, '..');                       // refatrix-api/
const SRC = fs.readFileSync(path.join(API, 'src/routes/stockCountRoutes.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  ✅ ' + n); }
  else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); }
};
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const inSrc = (sql) => squash(SRC).includes(squash(sql));

/* ───────────────────────── ① 정적 가드 ───────────────────────── */
console.log('\n① 정적 가드 — 부품 마스터는 이 경로로 절대 안 바뀐다');
ok('rev 마커 갱신', /loaded rev 20260918promo/.test(SRC));
ok('PRO 접두사 판정 함수 존재', /const isProCode = \(c\) => PRO_RE\.test/.test(SRC));
ok('코드 미지정 시 자동 제안', /const finalCode = code \|\| \(await nextProCode\(exec\)\)/.test(SRC));
ok('PRO 아닌 코드로 등록 거부', /pro_prefix_required/.test(SRC));
ok('PRO 가드 함수(assertPro) 로 PATCH 보호', /const g = await assertPro\(query, id\)/.test(SRC));
ok('adjust 는 트랜잭션 안에서 다시 PRO 확인', /if \(!isProCode\(p\.code\)\) return \{ error: 'not_promo_product'/.test(SRC));
ok('수량조정 사유 필수', /reason_required/.test(SRC));
ok('프로모 등록/조정은 창고 편집권한',
  (SRC.match(/'\/api\/promo-products[^']*', \{ preHandler: \[authGuard, requirePageEdit\('warehouse'\)\] \}/g) || []).length === 3);
ok('프로모 조회는 창고 읽기권한',
  (SRC.match(/'\/api\/promo-products(\/next-code)?', \{ preHandler: \[authGuard, requirePage\('warehouse'\)\] \}/g) || []).length === 2);

// 재고를 바꾸는 문장 = 실사 apply(1) + 프로모 초기등록(1) + 프로모 수량조정(1) = 3곳.
const stockUpdates = (SRC.match(/UPDATE products SET stock_qty=/g) || []).length;
ok('products.stock_qty UPDATE 는 정확히 3곳', stockUpdates === 3, stockUpdates);
ok('promo_items.stock_qty UPDATE 는 종전 1곳(실사 apply)', (SRC.match(/UPDATE promo_items SET stock_qty=/g) || []).length === 1);
// 그 3곳 모두 원장을 남긴다 — stock_movements INSERT 도 3곳이어야 한다.
const moveInserts = (SRC.match(/INSERT INTO stock_movements/g) || []).length;
ok('stock_movements INSERT 도 3곳 (수량 변경과 1:1)', moveInserts === 3, moveInserts);
// 스팟점검 블록은 여전히 재고를 안 건드린다(기존 규칙 회귀)
const spotBlock = SRC.slice(SRC.indexOf('SKU 스팟점검 (mode='), SRC.indexOf('================= 대조(reconcile)'));
ok('스팟 블록은 여전히 products UPDATE 없음', spotBlock.length > 1000 && !/UPDATE\s+products/.test(spotBlock));
ok('감사로그는 0057 CHECK 의 표준 액션만',
  (SRC.match(/action: '([a-z_]+)'/g) || []).every((s) => /'(create|update|delete)'/.test(s)));
ok('프로모 등록이 promo_items 를 쓰지 않는다',
  !/INSERT INTO promo_items/.test(SRC.slice(SRC.indexOf('프로모션 품목 = 제품마스터'))));

/* ───────────────── ② 운영 SQL 대조 + pg-mem 실행 ───────────────── */
console.log('\n② 운영 SQL 대조 — 테스트가 쓰는 SQL 이 소스에 그대로 있는가');
const SQL = {
  proCodes: `SELECT UPPER(code) AS code FROM products WHERE code ILIKE 'PRO%'`,
  dup: `SELECT id, deleted_at FROM products WHERE UPPER(code)=UPPER($1)`,
  setQty: `UPDATE products SET stock_qty=$1, updated_by=$2 WHERE id=$3`,
  move: `INSERT INTO stock_movements (product_id, move_type, qty, unit_cost_mxn, ref, note, source, moved_at, event_no, created_by)
           VALUES ($1,'adjust',$2,$3,$4,$5,'manual', now(), $6, $7)`,
  list: `SELECT id, code, name, ean, rack_location, stock_qty, list_price, iva_rate, sat_code, is_active, avg_cost
           FROM products
          WHERE deleted_at IS NULL AND code ILIKE 'PRO%'
          ORDER BY code`,
  lock: `SELECT id, code, name, stock_qty, avg_cost FROM products WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
};
for (const [k, v] of Object.entries(SQL)) ok(`SQL 일치: ${k}`, inSrc(v));

console.log('\n③ pg-mem 런타임');
const db = newDb();
db.public.none(`
  CREATE TABLE products (
    id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    ean TEXT, rack_location TEXT, list_price NUMERIC, iva_rate NUMERIC, sat_code TEXT, origin TEXT,
    stock_qty NUMERIC NOT NULL DEFAULT 0, avg_cost NUMERIC, is_active BOOLEAN NOT NULL DEFAULT TRUE,
    deleted_at TIMESTAMPTZ, created_by INT, updated_by INT);
  CREATE TABLE stock_movements (
    id SERIAL PRIMARY KEY, product_id INT NOT NULL, move_type TEXT NOT NULL, qty NUMERIC NOT NULL,
    unit_cost_mxn NUMERIC, ref TEXT, note TEXT, source TEXT, moved_at TIMESTAMPTZ, event_no INT, created_by INT);
  CREATE SEQUENCE stock_event_seq;
`);
// 파라미터 바인딩은 pg 어댑터(Pool)로만 된다 — db.public.query 는 $1 을 모른다.
const { Pool } = db.adapters.createPg();
const pool = new Pool();
const q = (sql, args = []) => pool.query(sql, args);
const exec = (sql, args = []) => pool.query(sql, args);

// 운영과 같은 알고리즘 — SQL 은 위에서 소스와 대조된 것만 쓴다.
async function nextProCode() {
  const rows = (await exec(SQL.proCodes, [])).rows;
  let max = 0; const taken = new Set();
  for (const r of rows) {
    const c = String(r.code || '').toUpperCase();
    taken.add(c);
    if (!/^PRO[0-9]+$/.test(c)) continue;
    const n = Number(c.slice(3));
    if (Number.isFinite(n) && n > max) max = n;
  }
  let n = max + 1; let code = `PRO${String(n).padStart(3, '0')}`;
  while (taken.has(code) && n < 100000) { n += 1; code = `PRO${String(n).padStart(3, '0')}`; }
  return code;
}

const run = async () => {
  // 부품 + 문자형 PRO 코드가 섞인 현실적인 마스터
  await q(`INSERT INTO products (code,name) VALUES ('CE0796','TERMINAL EXTERIOR'),('CB0318','ROTULA'),('PRO-CAP','GORRA')`);
  ok('PRO 숫자코드가 하나도 없으면 PRO001', (await nextProCode()) === 'PRO001', await nextProCode());

  await q(`INSERT INTO products (code,name) VALUES ('PRO001','GUANTE'),('PRO002','PLAYERA'),('PRO013','TERMO')`);
  ok('최대번호 다음을 제안 (PRO013 → PRO014)', (await nextProCode()) === 'PRO014', await nextProCode());

  // 번호가 이미 점유돼 있으면 건너뛴다 (삭제 제품도 UNIQUE 를 점유)
  await q(`INSERT INTO products (code,name,deleted_at) VALUES ('PRO014','BORRADO', now())`);
  ok('삭제된 PRO014 를 피해 PRO015', (await nextProCode()) === 'PRO015', await nextProCode());

  // ---- 신규 등록 + 초기수량 30 ----
  const code = await nextProCode();
  const dup = (await exec(SQL.dup, [code])).rows[0];
  ok('중복 없음 확인', !dup);
  await q(`INSERT INTO products (code,name,ean,rack_location,list_price,iva_rate,avg_cost,created_by,updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) `, [code, 'PLAYERA REFATRIX', '7501234567890', 'P-01', 120, 16, 45, 9]);
  const pid = (await q(`SELECT id FROM products WHERE code=$1`, [code])).rows[0].id;
  await exec(SQL.setQty, [30, 9, pid]);
  const ev = (await q(`SELECT nextval('stock_event_seq') AS n`)).rows[0].n;
  await exec(SQL.move, [pid, 30, 45, `promo:init:${code}`, '프로모션 품목 초기등록', ev, 9]);

  const p = (await q(`SELECT * FROM products WHERE id=$1`, [pid])).rows[0];
  ok('등록 코드 PRO015', p.code === 'PRO015', p.code);
  ok('초기수량 30 이 재고에 들어감', Number(p.stock_qty) === 30, p.stock_qty);
  ok('판매정가 120 · IVA 16 저장', Number(p.list_price) === 120 && Number(p.iva_rate) === 16);
  ok('is_active 기본 TRUE (견적에서 바로 선택 가능)', p.is_active === true);
  const mv = (await q(`SELECT * FROM stock_movements WHERE product_id=$1`, [pid])).rows;
  ok('초기수량이 이동내역 1건으로 남음', mv.length === 1 && Number(mv[0].qty) === 30 && mv[0].move_type === 'adjust', mv);
  ok('이동 참조가 promo:init', mv[0].ref === `promo:init:${code}`);

  // ---- 제품조회(PRO 필터)에 잡히는가 ----
  const listed = (await exec(SQL.list, [])).rows.map((r) => r.code);
  ok('PRO 목록에 신규 코드 포함', listed.includes('PRO015'), listed);
  ok('부품(CE0796)은 PRO 목록에 없음', !listed.includes('CE0796'));
  ok('삭제된 PRO014 는 목록에서 빠짐', !listed.includes('PRO014'));

  // ---- 수량조정 30 → 12 (엑스포 배포) ----
  const cur = Number((await exec(SQL.lock.replace(' FOR UPDATE', ''), [pid])).rows[0].stock_qty);
  const target = 12; const delta = target - cur;
  await exec(SQL.setQty, [target, 9, pid]);
  const ev2 = (await q(`SELECT nextval('stock_event_seq') AS n`)).rows[0].n;
  await exec(SQL.move, [pid, delta, 45, `promo:adjust:${code}`, '프로모션 수량조정 · 엑스포 배포', ev2, 9]);
  const after = (await q(`SELECT stock_qty FROM products WHERE id=$1`, [pid])).rows[0];
  const mv2 = (await q(`SELECT * FROM stock_movements WHERE product_id=$1 ORDER BY id`, [pid])).rows;
  ok('조정 후 수량 12', Number(after.stock_qty) === 12, after.stock_qty);
  ok('감소분이 음수 조정으로 남음(-18)', Number(mv2[1].qty) === -18, mv2[1].qty);
  ok('원장 합계 = 현재 재고', mv2.reduce((s, m) => s + Number(m.qty), 0) === 12);
  ok('사유가 이동내역 비고에 남음', /엑스포 배포/.test(mv2[1].note));

  // ---- 가드: 부품 코드로는 이 경로를 못 탄다 ----
  const isProCode = (c) => /^PRO/i.test(String(c || '').trim());
  ok('CE0796 은 프로모 경로 거부', !isProCode('CE0796'));
  ok('pro001(소문자)도 PRO 로 인정', isProCode('pro001'));

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
};
run().catch((e) => { console.error(e); process.exit(1); });
