// =====================================================================
// 견적 「재고 재검증」 (POST /api/quotes/:id/revalidate-stock) 검증
//   · 운영 소스(quoteRoutes.js)에서 assignReservations 와 라인 조회 SQL 을 **그대로 추출**해
//     실제 PostgreSQL 에서 실행한다(손으로 베낀 쿼리가 아니라 배포되는 코드를 검증).
//   · 임시 스키마 + ROLLBACK — 기존 데이터를 건드리지 않는다.
//   · TEST_PG_URL 미설정이면 skip(기본 npm test 에 영향 없음).
//     예) TEST_PG_URL="postgres://postgres@127.0.0.1:5433/postgres" node --test test/quote_revalidate_sql.test.mjs
// =====================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTE = path.join(__dirname, '..', 'src', 'routes', 'quoteRoutes.js');
const SRC = fs.readFileSync(ROUTE, 'utf8');

// ---- 운영 소스에서 그대로 뽑아온다 ----------------------------------
function extractAssignReservations() {
  const m = SRC.match(/async function assignReservations\(c, quoteId\) \{[\s\S]*?\n  \}\n/);
  assert.ok(m, 'assignReservations 를 소스에서 찾지 못했습니다 (이름·시그니처가 바뀌었나요?)');
  // eslint-disable-next-line no-new-func
  return new Function(`return (${m[0].trim()})`)();
}
function extractLineSql() {
  const m = SRC.match(/const LINE_SQL = `([\s\S]*?)`;/);
  assert.ok(m, '재검증 라우트의 LINE_SQL 을 찾지 못했습니다');
  return m[1];
}
const assignReservations = extractAssignReservations();
const LINE_SQL = extractLineSql();

// 라우트에 가드가 그대로 살아있는지(정적) — 회귀로 빠지기 쉬운 부분
test('라우트 가드 · 불변 규칙이 소스에 존재한다', () => {
  const ep = SRC.slice(SRC.indexOf("'/api/quotes/:id/revalidate-stock'"));
  assert.match(ep, /requirePageEditAny\(\['quote', ?'sales'\]\)/, '견적 편집 권한 가드');
  assert.match(ep, /not_open/, '작성중·확정만 허용');
  assert.match(ep, /packing_locked/, '포장지시서 출력분 차단');
  assert.match(ep, /quote_expired/, '만료 견적 차단');
  const body = ep.slice(0, ep.indexOf('// 견적 복제'));
  assert.ok(!/reserve_expires_at\s*=/.test(body), '재검증은 만료시각을 변경하면 안 됩니다(생성 기준 고정)');
  assert.ok(!/UPDATE quote_lines SET (qty|final_price|line_total)/.test(body), '재검증은 가격·수량을 바꾸면 안 됩니다');
  assert.ok(!/stock_flag\s*=/.test(body), '저장 스냅샷 stock_flag 는 보존되어야 합니다(오더퍼널 추이 연속성)');
});

const URL_ = process.env.TEST_PG_URL;
const opts = URL_ ? {} : { skip: 'TEST_PG_URL 미설정 — DB 테스트 skip' };

// ---- 테스트 하네스 --------------------------------------------------
async function withDb(fn) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: URL_ });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE products (
        id BIGSERIAL PRIMARY KEY, code TEXT, name TEXT, stock_qty NUMERIC(15,3) DEFAULT 0) ON COMMIT DROP;
      CREATE TEMP TABLE quotes (
        id BIGSERIAL PRIMARY KEY, quote_no TEXT, status TEXT NOT NULL DEFAULT 'draft',
        reserve_expires_at TIMESTAMPTZ, packing_printed_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ) ON COMMIT DROP;
      CREATE TEMP TABLE quote_lines (
        id BIGSERIAL PRIMARY KEY, quote_id BIGINT NOT NULL, line_no INT NOT NULL DEFAULT 0,
        product_id BIGINT, ctr_code TEXT, product_name TEXT,
        qty NUMERIC(15,3) NOT NULL DEFAULT 0, reserved_qty NUMERIC(15,3) NOT NULL DEFAULT 0) ON COMMIT DROP;
    `);
    await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}
const mkProduct = async (c, code, stock) =>
  Number((await c.query(`INSERT INTO products (code,name,stock_qty) VALUES ($1,$2,$3) RETURNING id`, [code, code + ' 부품', stock])).rows[0].id);
async function mkQuote(c, { status = 'draft', expires = '+24 hours', printed = null, deleted = null } = {}) {
  const exp = expires === null ? null : `now() ${expires}`;
  return Number((await c.query(
    `INSERT INTO quotes (quote_no,status,reserve_expires_at,packing_printed_at,deleted_at)
     VALUES ('Q-TEST',$1, ${exp ? `now() + interval '${expires.replace('+', '').trim()}'` : 'NULL'}, $2, $3) RETURNING id`,
    [status, printed, deleted])).rows[0].id);
}
const mkLine = async (c, quoteId, productId, qty, reserved = 0, lineNo = 1, code = 'CT-1') =>
  Number((await c.query(
    `INSERT INTO quote_lines (quote_id,line_no,product_id,ctr_code,product_name,qty,reserved_qty)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [quoteId, lineNo, productId, code, code + ' 부품', qty, reserved])).rows[0].id);
const resv = async (c, quoteId) =>
  (await c.query(`SELECT id, qty::float8 AS qty, reserved_qty::float8 AS r FROM quote_lines WHERE quote_id=$1 ORDER BY line_no, id`, [quoteId])).rows;

// 라우트의 요약 로직(변경 diff)과 동일 — 화면 배너가 읽는 값
const flagOf = (r, q) => (r >= q ? 'ok' : 'low_stock');
function summarize(before, after) {
  const wasBy = new Map(before.map((l) => [Number(l.id), Number(l.r) || 0]));
  const changes = [];
  let okLines = 0; let shortLines = 0;
  for (const l of after) {
    const qty = Number(l.qty) || 0; const now = Number(l.r) || 0;
    const was = wasBy.has(Number(l.id)) ? wasBy.get(Number(l.id)) : 0;
    if (now >= qty) okLines++; else shortLines++;
    if (now === was) continue;
    changes.push({ before: was, after: now, before_flag: flagOf(was, qty), after_flag: flagOf(now, qty) });
  }
  return {
    changed: changes.length, ok_lines: okLines, short_lines: shortLines,
    upgraded: changes.filter((x) => x.before_flag !== 'ok' && x.after_flag === 'ok').length,
    downgraded: changes.filter((x) => x.before_flag === 'ok' && x.after_flag !== 'ok').length,
  };
}

// =====================================================================
test('① 디렉터 보고 시나리오 — 같은 고객의 옛 견적을 지우면 재검증으로 즉시매출가능 회복', opts, async () => {
  await withDb(async (c) => {
    const p = await mkProduct(c, 'CE0536R', 5);
    const A = await mkQuote(c); await mkLine(c, A, p, 5, 5);      // 선착순으로 5 선점
    const B = await mkQuote(c); await mkLine(c, B, p, 5, 0);      // 재고 있으나 '부족'

    let before = await resv(c, B);
    assert.equal(before[0].r, 0, '전제: B 는 확보 0(부족)');

    // 재검증만 해서는 회복되지 않는다 — A 가 여전히 선점 중(선착순 유지)
    await assignReservations(c, B);
    assert.equal((await resv(c, B))[0].r, 0, 'A 가 유효한 동안에는 B 가 재고를 뺏지 못한다');

    // 디렉터가 A(옛 견적)를 삭제 → 재검증
    await c.query(`UPDATE quotes SET deleted_at=now() WHERE id=$1`, [A]);
    before = await resv(c, B);
    await assignReservations(c, B);
    const after = await resv(c, B);
    assert.equal(after[0].r, 5, '재검증 후 B 가 5 확보 → 즉시매출가능');

    const s = summarize(before, after);
    assert.deepEqual(s, { changed: 1, ok_lines: 1, short_lines: 0, upgraded: 1, downgraded: 0 });
  });
});

test('② 다른 견적이 만료되어 풀린 재고를 회수한다', opts, async () => {
  await withDb(async (c) => {
    const p = await mkProduct(c, 'CQ0445L', 10);
    const A = await mkQuote(c, { expires: '-1 minute' });  // 24h 경과(스위퍼 전이라 status 는 draft)
    await mkLine(c, A, p, 10, 10);
    const B = await mkQuote(c); await mkLine(c, B, p, 10, 0);
    const before = await resv(c, B);
    await assignReservations(c, B);
    const after = await resv(c, B);
    assert.equal(after[0].r, 10, '만료된 예약은 가용재고로 돌아온다');
    assert.equal(summarize(before, after).upgraded, 1);
  });
});

test('③ 포장작업지시서 출력분은 만료시각이 지나도 계속 재고를 잡는다', opts, async () => {
  await withDb(async (c) => {
    const p = await mkProduct(c, 'CB0101', 4);
    const A = await mkQuote(c, { expires: '-3 hours', printed: new Date() });
    await mkLine(c, A, p, 4, 4);
    const B = await mkQuote(c); await mkLine(c, B, p, 4, 0);
    await assignReservations(c, B);
    assert.equal((await resv(c, B))[0].r, 0, '유효 고정된 피킹 대상 재고는 뺏기지 않는다');
  });
});

test('④ 전환·취소 견적의 예약은 가용재고를 막지 않는다', opts, async () => {
  await withDb(async (c) => {
    for (const st of ['converted', 'cancelled', 'expired', 'delete_pending', 'pricelist']) {
      const p = await mkProduct(c, 'CX-' + st, 6);
      const A = await mkQuote(c, { status: st }); await mkLine(c, A, p, 6, 6);
      const B = await mkQuote(c); await mkLine(c, B, p, 6, 0);
      await assignReservations(c, B);
      assert.equal((await resv(c, B))[0].r, 6, `${st} 상태 견적은 예약을 붙잡지 않아야 한다`);
    }
  });
});

test('⑤ 재고가 줄었으면 정직하게 하향(즉시 → 부족)된다', opts, async () => {
  await withDb(async (c) => {
    const p = await mkProduct(c, 'CD0777', 10);
    const B = await mkQuote(c); await mkLine(c, B, p, 10, 10);
    const before = await resv(c, B);
    await c.query(`UPDATE products SET stock_qty=3 WHERE id=$1`, [p]);   // 그 사이 출고
    await assignReservations(c, B);
    const after = await resv(c, B);
    assert.equal(after[0].r, 3);
    const s = summarize(before, after);
    assert.equal(s.downgraded, 1); assert.equal(s.upgraded, 0); assert.equal(s.short_lines, 1);
  });
});

test('⑥ 부분 확보 · 다중 라인(같은 제품)은 line_no 순 greedy', opts, async () => {
  await withDb(async (c) => {
    const p = await mkProduct(c, 'CE1000', 7);
    const B = await mkQuote(c);
    await mkLine(c, B, p, 5, 0, 1, 'CE1000');
    await mkLine(c, B, p, 5, 0, 2, 'CE1000');
    await assignReservations(c, B);
    const rows = await resv(c, B);
    assert.deepEqual(rows.map((r) => r.r), [5, 2], '첫 줄 5 전량, 둘째 줄 잔여 2만');
    assert.equal(summarize([{ id: rows[0].id, r: 0, qty: 5 }, { id: rows[1].id, r: 0, qty: 5 }], rows).upgraded, 1);
  });
});

test('⑦ 미매칭(개발필요) 라인은 재검증이 건드리지 않는다', opts, async () => {
  await withDb(async (c) => {
    const B = await mkQuote(c);
    await mkLine(c, B, null, 3, 0, 1, 'ZZZ-NEW');
    await assignReservations(c, B);
    const rows = await resv(c, B);
    assert.equal(rows[0].r, 0, '개발필요 라인은 예약 대상이 아니다');
  });
});

test('⑧ 예약 만료시각·수량은 재검증으로 변하지 않는다', opts, async () => {
  await withDb(async (c) => {
    const p = await mkProduct(c, 'CF0001', 9);
    const B = await mkQuote(c); await mkLine(c, B, p, 4, 0);
    const b = (await c.query(`SELECT reserve_expires_at, status FROM quotes WHERE id=$1`, [B])).rows[0];
    await assignReservations(c, B);
    const a = (await c.query(`SELECT reserve_expires_at, status FROM quotes WHERE id=$1`, [B])).rows[0];
    assert.equal(+new Date(a.reserve_expires_at), +new Date(b.reserve_expires_at), '만료시각 불변(생성 기준 고정)');
    assert.equal(a.status, b.status);
    assert.equal((await resv(c, B))[0].qty, 4, '요청수량 불변');
  });
});

test('⑨ 재검증은 멱등 — 두 번 눌러도 같은 결과, 두 번째는 "변동 없음"', opts, async () => {
  await withDb(async (c) => {
    const p = await mkProduct(c, 'CG0002', 8);
    const B = await mkQuote(c); await mkLine(c, B, p, 8, 0);
    const b1 = await resv(c, B); await assignReservations(c, B); const a1 = await resv(c, B);
    const b2 = await resv(c, B); await assignReservations(c, B); const a2 = await resv(c, B);
    assert.equal(summarize(b1, a1).changed, 1);
    assert.equal(summarize(b2, a2).changed, 0, '두 번째 클릭은 변동 없음');
    assert.equal(a2[0].r, 8);
  });
});

test('⑩ 라우트의 LINE_SQL 이 실제로 실행되고 필요한 필드를 준다', opts, async () => {
  await withDb(async (c) => {
    const p = await mkProduct(c, 'CH0003', 12);
    const B = await mkQuote(c);
    await mkLine(c, B, p, 5, 5, 1, 'CH0003');
    await mkLine(c, B, null, 2, 0, 2, 'ZZZ');
    const rows = (await c.query(LINE_SQL, [B])).rows;
    assert.equal(rows.length, 1, '매칭 라인만(개발필요 제외)');
    assert.equal(rows[0].ctr_code, 'CH0003');
    assert.equal(Number(rows[0].cur_stock), 12);
    assert.equal(Number(rows[0].reserved_qty), 5);
    assert.ok('product_name' in rows[0] && 'qty' in rows[0]);
  });
});

test('⑪ 동시 재검증 — FOR UPDATE 로 같은 재고를 중복 배분하지 않는다', opts, async () => {
  if (!URL_) return;
  const { default: pg } = await import('pg');
  // 임시테이블은 세션 로컬이라 동시성 테스트는 실제 테이블이 필요 → 별도 스키마를 만들고 끝에 drop
  const admin = new pg.Client({ connectionString: URL_ }); await admin.connect();
  const S = 'reval_test_' + process.pid;
  try {
    await admin.query(`CREATE SCHEMA ${S}`);
    await admin.query(`SET search_path TO ${S}`);
    await admin.query(`
      CREATE TABLE ${S}.products (id BIGSERIAL PRIMARY KEY, code TEXT, name TEXT, stock_qty NUMERIC(15,3) DEFAULT 0);
      CREATE TABLE ${S}.quotes (id BIGSERIAL PRIMARY KEY, quote_no TEXT, status TEXT NOT NULL DEFAULT 'draft',
        reserve_expires_at TIMESTAMPTZ, packing_printed_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ);
      CREATE TABLE ${S}.quote_lines (id BIGSERIAL PRIMARY KEY, quote_id BIGINT, line_no INT DEFAULT 0, product_id BIGINT,
        ctr_code TEXT, product_name TEXT, qty NUMERIC(15,3) DEFAULT 0, reserved_qty NUMERIC(15,3) NOT NULL DEFAULT 0);`);
    const pid = Number((await admin.query(`INSERT INTO ${S}.products (code,stock_qty) VALUES ('CC1',10) RETURNING id`)).rows[0].id);
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const q = Number((await admin.query(`INSERT INTO ${S}.quotes (quote_no,reserve_expires_at) VALUES ('Q'||$1, now()+interval '24 hours') RETURNING id`, [i])).rows[0].id);
      await admin.query(`INSERT INTO ${S}.quote_lines (quote_id,line_no,product_id,ctr_code,qty,reserved_qty) VALUES ($1,1,$2,'CC1',10,0)`, [q, pid]);
      ids.push(q);
    }
    const run = async (qid) => {
      const c = new pg.Client({ connectionString: URL_ }); await c.connect();
      await c.query(`SET search_path TO ${S}`); await c.query('BEGIN');
      await assignReservations(c, qid);
      await c.query('COMMIT'); await c.end();
    };
    await Promise.all(ids.map(run));   // 동시에 재검증
    const tot = Number((await admin.query(`SELECT COALESCE(SUM(reserved_qty),0) AS s FROM ${S}.quote_lines`)).rows[0].s);
    assert.equal(tot, 10, '총 예약이 현재고(10)를 넘지 않아야 한다 — 과배분 없음');
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`).catch(() => {});
    await admin.end();
  }
});
