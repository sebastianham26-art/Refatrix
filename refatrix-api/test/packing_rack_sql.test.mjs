// =====================================================================
// 포장작업지시서 랙 위치 — 백엔드 convert-preview 검증
//   · 운영 소스(quoteRoutes.js)에서 convert-preview 핸들러를 **통째로 추출해 그대로 실행**한다.
//     (손으로 베낀 쿼리가 아니라 배포되는 코드가 도는지 본다 — 코드가 바뀌면 테스트도 같이 바뀐다)
//   · 임시 스키마 + ROLLBACK — 기존 데이터를 건드리지 않는다.
//   · TEST_PG_URL 미설정이면 DB 테스트 skip(정적 검사는 항상 돈다).
//     예) TEST_PG_URL="postgres://postgres@127.0.0.1:5433/postgres" node --test test/packing_rack_sql.test.mjs
// =====================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTE = path.join(__dirname, '..', 'src', 'routes', 'quoteRoutes.js');
const SRC = fs.readFileSync(ROUTE, 'utf8');

// ---- 운영 소스에서 convert-preview 핸들러를 그대로 뽑아온다 ----------
function extractPreviewHandler() {
  const at = SRC.indexOf("app.get('/api/quotes/:id/convert-preview'");
  assert.ok(at > 0, 'convert-preview 라우트를 소스에서 찾지 못했습니다');
  const seg = SRC.slice(at);
  const fnAt = seg.indexOf('async (req, reply) => {');
  assert.ok(fnAt > 0, 'convert-preview 핸들러 시그니처를 찾지 못했습니다');
  const rest = seg.slice(fnAt);
  const end = rest.indexOf('\n  });');
  assert.ok(end > 0, 'convert-preview 핸들러의 끝을 찾지 못했습니다');
  const text = rest.slice(0, end) + '\n  }';
  // eslint-disable-next-line no-new-func
  return new Function('query', `return (${text})`);
}
const makeHandler = extractPreviewHandler();

// 정적 회귀 — DB 없이도 항상 돈다
test('정적 · 랙 위치를 조회하고 응답에 실어 보낸다', () => {
  const at = SRC.indexOf("app.get('/api/quotes/:id/convert-preview'");
  const ep = SRC.slice(at, at + 2500);
  assert.match(ep, /SELECT stock_qty, rack_location FROM products WHERE id=\$1/, '제품 조회에 rack_location 이 있어야 한다');
  assert.match(ep, /inStock\.push\(\{[^}]*rack_location: rack/, '즉시매출 항목에 rack_location 을 실어야 한다');
  assert.match(ep, /shortage\.push\(\{[^}]*rack_location: rack/, '부족 항목에도 rack_location 을 실어야 한다');
  assert.match(ep, /requirePageAny\(\['quote','sales'\]\)/, '권한 가드 회귀');
  assert.ok(!/UPDATE|INSERT|DELETE/.test(ep), '미리보기는 읽기 전용이어야 한다');
});

const URL_ = process.env.TEST_PG_URL;
const opts = URL_ ? {} : { skip: 'TEST_PG_URL 미설정 — DB 테스트 skip' };

async function withDb(fn) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: URL_ });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE products (
        id BIGSERIAL PRIMARY KEY, code TEXT, name TEXT,
        stock_qty NUMERIC(15,3) DEFAULT 0,
        rack_location TEXT, deleted_at TIMESTAMPTZ) ON COMMIT DROP;
      CREATE TEMP TABLE quotes (
        id BIGSERIAL PRIMARY KEY, customer_id BIGINT, status TEXT DEFAULT 'draft',
        deleted_at TIMESTAMPTZ) ON COMMIT DROP;
      CREATE TEMP TABLE quote_lines (
        id BIGSERIAL PRIMARY KEY, quote_id BIGINT, line_no INT,
        product_id BIGINT, ctr_code TEXT, input_code TEXT, product_name TEXT,
        qty NUMERIC(15,3), reserved_qty NUMERIC(15,3) DEFAULT 0) ON COMMIT DROP;`);
    const query = (sql, params) => client.query(sql, params);
    await fn(client, query);
  } finally {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    await client.end();
  }
}

// products/quote_lines 를 심고 실제 핸들러를 돌린다.
async function preview(query, rows) {
  await query(`INSERT INTO quotes (id, customer_id, status) VALUES (1, 10, 'draft')`);
  let n = 0;
  for (const r of rows) {
    n += 1;
    const pid = r.product_id === null ? null : n;
    if (pid !== null) {
      await query(`INSERT INTO products (id, code, name, stock_qty, rack_location) VALUES ($1,$2,$3,$4,$5)`,
        [pid, r.code, r.name || ('Prod ' + r.code), r.stock, r.rack]);
    }
    await query(`INSERT INTO quote_lines (quote_id, line_no, product_id, ctr_code, input_code, product_name, qty, reserved_qty)
                 VALUES (1,$1,$2,$3,$4,$5,$6,$7)`,
      [n, pid, r.code, r.code, r.name || ('Prod ' + r.code), r.qty, r.reserved ?? r.qty]);
  }
  const handler = makeHandler(query);
  return handler({ params: { id: 1 } }, { code: () => ({ send: (o) => o }) });
}

test('① 랙 위치가 in_stock 에 그대로 실려 나온다', opts, async () => {
  await withDb(async (_c, query) => {
    const pv = await preview(query, [
      { code: 'CE0001', stock: 10, qty: 5, rack: 'A-01-03' },
      { code: 'CE0002', stock: 10, qty: 5, rack: 'B-02-11' },
    ]);
    assert.equal(pv.in_stock.length, 2);
    assert.deepEqual(pv.in_stock.map((x) => x.rack_location), ['A-01-03', 'B-02-11']);
    assert.deepEqual(pv.in_stock.map((x) => x.ctr_code), ['CE0001', 'CE0002']);
    assert.deepEqual(pv.in_stock.map((x) => x.qty), [5, 5], '수량 회귀');
  });
});

test('② NULL·공백 랙은 빈 문자열로 정규화된다 (프런트가 SIN UBICACIÓN 판정)', opts, async () => {
  await withDb(async (_c, query) => {
    const pv = await preview(query, [
      { code: 'CE0001', stock: 3, qty: 3, rack: null },
      { code: 'CE0002', stock: 3, qty: 3, rack: '   ' },
      { code: 'CE0003', stock: 3, qty: 3, rack: '  C-01-01  ' },
    ]);
    assert.deepEqual(pv.in_stock.map((x) => x.rack_location), ['', '', 'C-01-01'], '양끝 공백은 잘라 준다');
    for (const x of pv.in_stock) assert.equal(typeof x.rack_location, 'string', 'null 이 아니라 문자열이어야 한다');
  });
});

test('③ 부족·미등록 분류 회귀 — 랙 추가가 3갈래 분류를 바꾸지 않는다', opts, async () => {
  await withDb(async (_c, query) => {
    const pv = await preview(query, [
      { code: 'CE0001', stock: 10, qty: 4, reserved: 4, rack: 'A-01-01' },   // 즉시매출
      { code: 'CE0002', stock: 1, qty: 5, reserved: 1, rack: 'A-02-01' },    // 부족
      { code: 'CE0003', stock: 0, qty: 2, reserved: 0, rack: 'A-03-01' },    // 부족(확보 0)
      { code: 'NUEVO1', stock: 0, qty: 7, product_id: null, rack: null },    // 미등록
    ]);
    assert.deepEqual(pv.counts, { in_stock: 1, shortage: 2, new_dev: 1 });
    assert.equal(pv.in_stock[0].ctr_code, 'CE0001');
    assert.deepEqual(pv.shortage.map((x) => [x.ctr_code, x.fulfill, x.short, x.rack_location]),
      [['CE0002', 1, 4, 'A-02-01'], ['CE0003', 0, 2, 'A-03-01']]);
    assert.equal(pv.new_dev[0].input_code, 'NUEVO1');
    assert.equal(pv.new_dev[0].rack_location, undefined, '미등록 SKU 엔 랙 개념이 없다');
  });
});

test('④ 예약분은 실물재고로 캡된다 (기존 규칙 유지)', opts, async () => {
  await withDb(async (_c, query) => {
    const pv = await preview(query, [{ code: 'CE0001', stock: 2, qty: 5, reserved: 5, rack: 'A-01-01' }]);
    assert.equal(pv.counts.in_stock, 0);
    assert.equal(pv.shortage[0].fulfill, 2);
    assert.equal(pv.shortage[0].short, 3);
  });
});
