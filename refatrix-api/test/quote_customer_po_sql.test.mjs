// =====================================================================
// 고객 PO번호(Orden de compra) — 실제 PostgreSQL 회귀 테스트 (0225)
//
//   왜 실제 PG 인가: pg-mem 은 타입 검사가 느슨해 「칼럼은 text 인데 파라미터가 다른 타입으로
//   추론되는」 부류를 못 잡는다(2026-08-26 전시회 저장 500 이 그 사고였다). 이번 변경은
//   INSERT 파라미터 개수가 **마이그레이션 여부에 따라 달라지는** 코드라 더 위험하다 —
//   파라미터를 하나 더 보내는데 쿼리가 안 쓰면 Postgres 는 bind 단계에서 바로 죽는다.
//   그래서 라우트가 실제로 만드는 문자열을 **그대로** 만들어 진짜 PG 에 던진다.
//
//   실행:
//     PO_TEST_PG='postgresql://postgres@/postgres?host=/var/lib/pgtest/sock&port=5433' \
//       node --test test/quote_customer_po_sql.test.mjs
//   환경변수가 없으면 통째로 건너뛴다(CI·로컬 안전).
// =====================================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { normalizePoNo, poSelectFrag, quoteSearchClause, PO_MAX_LEN } from '../src/quoteBuild.js';

const PG_URL = process.env.PO_TEST_PG || '';
const skip = PG_URL ? false : '실제 PostgreSQL 없음 — PO_TEST_PG 를 설정하면 실행됩니다';
const SCHEMA = 'po_sql_test';
const mig = (f) => readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8');

let pool;
const q = async (sql, args) => pool.query(`SET search_path TO ${SCHEMA}; ` === '' ? sql : sql, args);

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: PG_URL });
  // 모든 커넥션이 같은 스키마를 보도록 — 풀은 커넥션마다 search_path 를 따로 가진다.
  pool.on('connect', (c) => c.query(`SET search_path TO ${SCHEMA}`));
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await pool.query(`
    SET search_path TO ${SCHEMA};
    CREATE TABLE users(id BIGSERIAL PRIMARY KEY, name TEXT, role TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE customers(id BIGSERIAL PRIMARY KEY, code TEXT, name TEXT, rfc TEXT, discount NUMERIC DEFAULT 0,
      owner_id BIGINT, team_id BIGINT, ship_address TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE quotes(
      id BIGSERIAL PRIMARY KEY, quote_no TEXT UNIQUE, customer_id BIGINT, guest_name TEXT,
      quote_date DATE DEFAULT CURRENT_DATE, discount_rate NUMERIC DEFAULT 0, iva_rate NUMERIC DEFAULT 16,
      memo TEXT, status TEXT DEFAULT 'draft',
      subtotal_mxn NUMERIC DEFAULT 0, iva_mxn NUMERIC DEFAULT 0, total_mxn NUMERIC DEFAULT 0,
      total_qty NUMERIC DEFAULT 0, sku_count INT DEFAULT 0,
      invoice_id BIGINT, created_by BIGINT, updated_by BIGINT,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
      reserve_expires_at TIMESTAMPTZ, packing_printed_at TIMESTAMPTZ, packing_due_at TIMESTAMPTZ,
      packed_at TIMESTAMPTZ, shipped_at TIMESTAMPTZ,
      external_quote_no TEXT, origin TEXT);
    CREATE TABLE quote_lines(id BIGSERIAL PRIMARY KEY, quote_id BIGINT, line_no INT, product_id BIGINT,
      input_code TEXT, ctr_code TEXT, syd_codes TEXT, product_name TEXT, app_text TEXT,
      qty NUMERIC, list_price NUMERIC, discount_rate NUMERIC, final_price NUMERIC,
      line_subtotal NUMERIC, line_iva NUMERIC, line_total NUMERIC,
      avail_stock NUMERIC, reserved_qty NUMERIC DEFAULT 0, stock_flag TEXT, issue TEXT);
    CREATE TABLE sales_invoices(id BIGSERIAL PRIMARY KEY, customer_id BIGINT, inv_date DATE, sat_no TEXT,
      subtotal_mxn NUMERIC, iva_mxn NUMERIC, total_mxn NUMERIC, status TEXT DEFAULT 'posted', deleted_at TIMESTAMPTZ);
    CREATE TABLE sales_invoice_lines(id BIGSERIAL PRIMARY KEY, invoice_id BIGINT, product_id BIGINT, qty NUMERIC);
    CREATE TABLE packing_box_line(id BIGSERIAL PRIMARY KEY, quote_id BIGINT, box_id BIGINT, product_id BIGINT, qty NUMERIC);

    INSERT INTO users(name,role) VALUES ('Sebastian','director');
    INSERT INTO customers(code,name,rfc) VALUES ('C001','REFACCIONARIA NORTE','RFN010101AAA'),
                                                ('C002','AUTOPARTES SUR','APS020202BBB');
  `);
  // 실제 마이그레이션 파일을 그대로 적용한다 — **두 번** 적용해 멱등도 같이 본다.
  await pool.query(`SET search_path TO ${SCHEMA}; ` + mig('0225_quote_customer_po.sql'));
  await pool.query(`SET search_path TO ${SCHEMA}; ` + mig('0225_quote_customer_po.sql'));
});

after(async () => {
  if (skip || !pool) return;
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
});

// ── 순수 함수: PO 정리 규칙 ───────────────────────────────────────────
test('normalizePoNo — 공백만 정리하고 번호는 고치지 않는다', () => {
  assert.equal(normalizePoNo('  4471 '), '4471');
  assert.equal(normalizePoNo('OC  2026   118'), 'OC 2026 118', '내부 연속 공백은 한 칸으로');
  assert.equal(normalizePoNo('oc-2026-118'), 'oc-2026-118', '대소문자는 손대지 않는다');
  assert.equal(normalizePoNo('0004471'), '0004471', '0 채움을 벗기지 않는다 — 고객 번호 그대로');
  assert.equal(normalizePoNo(''), null);
  assert.equal(normalizePoNo('   '), null, '공백만 있으면 null (DB 에 빈칸을 남기지 않는다)');
  assert.equal(normalizePoNo(null), null);
  assert.equal(normalizePoNo(undefined), null);
  assert.equal(normalizePoNo(4471), '4471', '숫자로 와도 받는다');
  assert.equal(normalizePoNo('X'.repeat(200)).length, PO_MAX_LEN, '상한 60자');
});

test('poSelectFrag — 마이그레이션 전/후 모두 같은 이름의 칼럼을 돌려준다', () => {
  assert.equal(poSelectFrag(true), 'q.customer_po_no');
  assert.equal(poSelectFrag(false), 'NULL::text');
  assert.equal(poSelectFrag(true, 'x'), 'x.customer_po_no');
});

test('quoteSearchClause — 빈 검색어는 조건을 만들지 않는다', () => {
  const a = [];
  assert.equal(quoteSearchClause('', a), null);
  assert.equal(quoteSearchClause('   ', a), null);
  assert.equal(a.length, 0, '빈 검색어로 파라미터를 밀어 넣지 않는다');
  const b = [];
  const c1 = quoteSearchClause('4471', b, { poReady: false });
  assert.equal(b.length, 1);
  assert.equal(b[0], '%4471%');
  assert.ok(!c1.includes('customer_po_no'), '마이그레이션 전에는 PO 칸을 보지 않는다');
  const d = [];
  const c2 = quoteSearchClause('4471', d, { poReady: true });
  assert.ok(c2.includes('customer_po_no'));
});

// ── 실제 PG ────────────────────────────────────────────────────────────
test('마이그레이션 0225', { skip }, async (t) => {
  await t.test('칼럼 타입은 text, 인덱스가 하나 생긴다 (두 번 적용해도 하나)', async () => {
    const col = (await pool.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='quotes' AND column_name='customer_po_no'`, [SCHEMA])).rows;
    assert.equal(col.length, 1, '칼럼이 정확히 하나');
    assert.equal(col[0].data_type, 'text');
    assert.equal(col[0].is_nullable, 'YES', 'PO 없는 오더가 대부분이다 — NOT NULL 이면 안 된다');
    const idx = (await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname='idx_quotes_customer_po'`, [SCHEMA])).rows;
    assert.equal(idx.length, 1, '멱등 — 두 번 적용해도 인덱스는 하나');
  });

  await t.test('같은 PO번호를 여러 오더가 쓸 수 있다 (UNIQUE 를 걸지 않았다)', async () => {
    await pool.query(`INSERT INTO quotes(quote_no,customer_id,customer_po_no) VALUES ('Q-DUP-1',1,'4471')`);
    await pool.query(`INSERT INTO quotes(quote_no,customer_id,customer_po_no) VALUES ('Q-DUP-2',1,'4471')`);
    await pool.query(`INSERT INTO quotes(quote_no,customer_id,customer_po_no) VALUES ('Q-DUP-3',2,'4471')`);
    const n = (await pool.query(`SELECT count(*)::int n FROM quotes WHERE customer_po_no='4471'`)).rows[0].n;
    assert.equal(n, 3, '분할 발주·타 고객 우연 일치 — 막으면 안 된다');
    await pool.query(`DELETE FROM quotes WHERE quote_no LIKE 'Q-DUP-%'`);
  });
});

test('견적 INSERT — 마이그레이션 전/후 두 모양이 모두 실제로 돈다', { skip }, async (t) => {
  // quoteRoutes.js 가 만드는 문자열을 **그대로** 재현한다(파라미터 개수 불일치 = bind 오류).
  const insertSql = (poReady) =>
    `INSERT INTO quotes (quote_no, customer_id, guest_name, quote_date, discount_rate, iva_rate, memo, status, subtotal_mxn, iva_mxn, total_mxn, total_qty, sku_count, created_by, reserve_expires_at${poReady ? ', customer_po_no' : ''})
     VALUES ($1,$2,$3,COALESCE($4,CURRENT_DATE),$5,$6,$7,'draft',$8,$9,$10,$11,$12,$13, now() + interval '24 hours'${poReady ? ', $14' : ''}) RETURNING id, quote_no, customer_po_no`;

  await t.test('poReady=true — PO 가 들어가고 그대로 읽힌다', async () => {
    const r = (await pool.query(insertSql(true),
      ['Q-2026-9001', 1, null, '2026-09-18', 0, 16, null, 100, 16, 116, 2, 1, 1, normalizePoNo(' OC-2026-118 ')])).rows[0];
    assert.equal(r.customer_po_no, 'OC-2026-118');
  });

  await t.test('poReady=false — 파라미터를 13개만 보내도 정상 저장(반쪽배포 안전장치)', async () => {
    const r = (await pool.query(insertSql(false),
      ['Q-2026-9002', 1, null, '2026-09-18', 0, 16, null, 100, 16, 116, 2, 1, 1])).rows[0];
    assert.equal(r.customer_po_no, null);
  });

  await t.test('PO 없는 견적은 NULL 로 남는다 (빈 문자열이 아니다)', async () => {
    const r = (await pool.query(insertSql(true),
      ['Q-2026-9003', 2, null, '2026-08-11', 0, 16, null, 50, 8, 58, 1, 1, 1, normalizePoNo('  ')])).rows[0];
    assert.equal(r.customer_po_no, null, "''(빈칸)이 섞이면 검색 조건이 두 배가 된다");
  });
});

test('PUT 편집 — PO 키를 안 보내면 기존 PO 를 지키고, 보내면 바꾼다', { skip }, async (t) => {
  const upd = (touchPo) =>
    `UPDATE quotes SET customer_id=$1, discount_rate=$2, memo=$3, subtotal_mxn=$4, iva_mxn=$5, total_mxn=$6, total_qty=$7, sku_count=$8, updated_by=$9, updated_at=now()${touchPo ? ', customer_po_no=$11' : ''} WHERE id=$10`;
  const id = (await pool.query(`SELECT id FROM quotes WHERE quote_no='Q-2026-9001'`)).rows[0].id;

  await t.test('SKU·수량만 고치는 편집은 PO 를 건드리지 않는다', async () => {
    await pool.query(upd(false), [1, 0, null, 200, 32, 232, 4, 2, 1, id]);
    const po = (await pool.query(`SELECT customer_po_no FROM quotes WHERE id=$1`, [id])).rows[0].customer_po_no;
    assert.equal(po, 'OC-2026-118', '편집 한 번에 PO 가 사라지면 아무도 눈치채지 못한다');
  });

  await t.test('PO 키를 보내면 바뀐다', async () => {
    await pool.query(upd(true), [1, 0, null, 200, 32, 232, 4, 2, 1, id, 'OC-2026-999']);
    const po = (await pool.query(`SELECT customer_po_no FROM quotes WHERE id=$1`, [id])).rows[0].customer_po_no;
    assert.equal(po, 'OC-2026-999');
    await pool.query(upd(true), [1, 0, null, 200, 32, 232, 4, 2, 1, id, 'OC-2026-118']);   // 원복
  });
});

test('CRM 재전송 — PO 는 비어 있을 때만 채운다', { skip }, async (t) => {
  const backfill = `UPDATE quotes SET customer_po_no=$1, updated_at=now()
                      WHERE id=$2 AND COALESCE(customer_po_no,'')='' RETURNING id`;

  await t.test('PO 가 비어 있으면 채운다', async () => {
    const id = (await pool.query(`SELECT id FROM quotes WHERE quote_no='Q-2026-9002'`)).rows[0].id;
    const r = await pool.query(backfill, ['OC-WEB-1', id]);
    assert.equal(r.rows.length, 1, '채워졌다');
    const po = (await pool.query(`SELECT customer_po_no FROM quotes WHERE id=$1`, [id])).rows[0].customer_po_no;
    assert.equal(po, 'OC-WEB-1');
  });

  await t.test('사람이 이미 넣어 둔 PO 는 웹이 덮어쓰지 못한다', async () => {
    const id = (await pool.query(`SELECT id FROM quotes WHERE quote_no='Q-2026-9001'`)).rows[0].id;
    const r = await pool.query(backfill, ['OC-WEB-DEBERIA-NO', id]);
    assert.equal(r.rows.length, 0, '아무 줄도 안 바뀌어야 한다');
    const po = (await pool.query(`SELECT customer_po_no FROM quotes WHERE id=$1`, [id])).rows[0].customer_po_no;
    assert.equal(po, 'OC-2026-118', '현장 입력이 늘 더 정확했다');
  });
});

test('견적 목록 한 칸 검색 — 견적번호 · 고객명 · PO', { skip }, async (t) => {
  const run = async (kw, poReady = true) => {
    const args = [];
    const conds = ['q.deleted_at IS NULL'];
    const c = quoteSearchClause(kw, args, { poReady });
    if (c) conds.push(c);
    return (await pool.query(
      `SELECT q.quote_no, ${poSelectFrag(poReady)} AS customer_po_no
         FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id
        WHERE ${conds.join(' AND ')} ORDER BY q.id`, args)).rows;
  };

  await t.test('고객 PO번호로 찾는다 — 이게 이번 요구의 핵심이다', async () => {
    const rows = await run('OC-2026-118');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].quote_no, 'Q-2026-9001');
  });

  await t.test('부분일치·대소문자 무시', async () => {
    assert.equal((await run('oc-2026')).length, 1, '소문자로 쳐도 잡힌다');
    assert.ok((await run('118')).some((r) => r.quote_no === 'Q-2026-9001'), '뒷자리만 쳐도 잡힌다');
  });

  await t.test('우리 견적번호로도, 고객 이름으로도 같은 칸에서 찾는다', async () => {
    assert.ok((await run('Q-2026-9003')).length === 1, '견적번호');
    const byName = await run('autopartes');
    assert.ok(byName.some((r) => r.quote_no === 'Q-2026-9003'), '고객명(소문자)');
  });

  await t.test('마이그레이션 전이면 PO 로는 안 잡히지만 **죽지도 않는다**', async () => {
    const rows = await run('OC-2026-118', false);
    assert.equal(rows.length, 0);
    assert.equal((await run('Q-2026-9001', false)).length, 1, '견적번호 검색은 그대로 된다');
  });
});

test('매출 확정 목록 — 검색 중에는 기간을 넘어서 찾는다', { skip }, async (t) => {
  before(async () => {});
  // 9001(9월, 미전환) · 9003(8월, 미전환) 에 즉시(ok) 라인을 달아 able 대상으로 만든다
  await pool.query(`
    INSERT INTO quote_lines(quote_id,line_no,product_id,qty,stock_flag)
    SELECT id, 1, 10, 3, 'ok' FROM quotes WHERE quote_no IN ('Q-2026-9001','Q-2026-9003')
      AND NOT EXISTS (SELECT 1 FROM quote_lines l WHERE l.quote_id=quotes.id)`);

  const able = async (months, kw, poReady = true) => {
    const args = [months]; let search = '';
    if (kw) {
      args.push('%' + kw.toLowerCase() + '%'); const i = args.length;
      search = ` AND (lower(COALESCE(q.quote_no,'')) LIKE $${i}`
        + ` OR lower(COALESCE(c.name, q.guest_name, '')) LIKE $${i}`
        + (poReady ? ` OR lower(COALESCE(q.customer_po_no,'')) LIKE $${i}` : '') + ')';
    }
    return (await pool.query(
      `SELECT q.id, q.quote_no, ${poSelectFrag(poReady)} AS customer_po_no
         FROM quotes q JOIN quote_lines ql ON ql.quote_id=q.id LEFT JOIN customers c ON c.id=q.customer_id
        WHERE q.deleted_at IS NULL AND q.status IN ('draft','confirmed')
          AND (to_char(q.quote_date,'YYYY-MM') = ANY($1) OR ${kw ? 'TRUE' : 'FALSE'})${search}
        GROUP BY q.id, q.quote_no, ${poReady ? 'q.customer_po_no, ' : ''}c.name, q.guest_name, q.customer_id, q.quote_date
       HAVING COUNT(*) FILTER (WHERE ql.stock_flag='ok') > 0
        ORDER BY q.quote_date ASC`, args)).rows;
  };

  await t.test('검색어 없음 — 선택한 달만 나온다(기존 동작 회귀)', async () => {
    const rows = await able(['2026-09'], '');
    assert.ok(rows.some((r) => r.quote_no === 'Q-2026-9001'));
    assert.ok(!rows.some((r) => r.quote_no === 'Q-2026-9003'), '8월 건은 안 나온다');
  });

  await t.test('9월을 골라 둔 채 8월 건의 PO 로 검색해도 찾아진다', async () => {
    await pool.query(`UPDATE quotes SET customer_po_no='PO-AGO-77' WHERE quote_no='Q-2026-9003'`);
    const rows = await able(['2026-09'], 'PO-AGO-77');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].quote_no, 'Q-2026-9003', '「PO 4471 언제 나가요」에 몇 월인지 되물을 수 없다');
  });

  await t.test('검색 파라미터가 늘어도 $1(months) 은 계속 참조된다 — bind 오류 방지', async () => {
    // 이 테스트가 존재하는 이유: $1 을 안 쓰는 쿼리에 파라미터를 보내면 Postgres 가 bind 에서 죽는다.
    await assert.doesNotReject(() => able(['2026-09'], 'nada-que-coincide'));
  });
});

test('창고 출고 조회 — 패킹리스트가 쓰는 SQL 이 PO 를 같이 준다', { skip }, async (t) => {
  await t.test('poReady=true / false 둘 다 같은 이름으로 돌려준다', async () => {
    await pool.query(`UPDATE quotes SET packed_at=now() WHERE quote_no='Q-2026-9001'`);
    for (const ready of [true, false]) {
      const r = (await pool.query(
        `SELECT q.id, q.quote_no, ${poSelectFrag(ready)} AS customer_po_no,
                COALESCE(c.name, q.guest_name, '-') AS customer_name
           FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id
          WHERE q.quote_no='Q-2026-9001' AND q.deleted_at IS NULL`)).rows[0];
      assert.ok('customer_po_no' in r, '칼럼 이름이 항상 있다 — 화면 코드가 갈리지 않게');
      assert.equal(r.customer_po_no, ready ? 'OC-2026-118' : null);
    }
  });
});
