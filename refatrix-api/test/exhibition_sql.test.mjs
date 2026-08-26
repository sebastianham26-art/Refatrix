// =====================================================================
// 전시회 미팅 — 실제 PostgreSQL 에 대고 도는 SQL 회귀 테스트 (2026-08-26)
//
//   pg-mem 은 타입 검사가 느슨해서 "컬럼은 bigint 인데 파라미터가 text 로 추론되는"
//   부류의 오류를 못 잡는다. 실제로 그 버그로 미팅 저장이 500 이 났었다(42804).
//   그래서 진짜 Postgres 로 마이그레이션을 적용하고 라우트가 쓰는 SQL 을 그대로 돌린다.
//
//   실행:  EXPO_TEST_PG='postgresql:///postgres?host=/tmp&port=5433' node --test test/exhibition_sql.test.mjs
//   환경변수가 없으면 통째로 건너뛴다(CI·로컬에서 안전).
// =====================================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const PG_URL = process.env.EXPO_TEST_PG || '';   // 전역 URL 을 가리지 않게 이름을 다르게
const skip = PG_URL ? false : '실제 PostgreSQL 없음 — EXPO_TEST_PG 를 설정하면 실행됩니다';
const SCHEMA = 'expo_sql_test';
const mig = (f) => readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8');

let pool;

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: PG_URL });
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await pool.query(`SET search_path TO ${SCHEMA}`);
  // 마이그레이션이 참조하는 최소 기반 테이블
  await pool.query(`
    SET search_path TO ${SCHEMA};
    CREATE TABLE users(id BIGSERIAL PRIMARY KEY, name TEXT, login_id TEXT, role TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE customers(id BIGSERIAL PRIMARY KEY, name TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE sales_consults(id BIGSERIAL PRIMARY KEY, consult_date DATE, company_name TEXT, customer_id BIGINT,
      contact_name TEXT, wa_phone TEXT, email TEXT, place_label TEXT, note TEXT, private_by BIGINT,
      created_by BIGINT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ);
    INSERT INTO users(name,login_id,role) VALUES ('Sebastian','admin','director'),('Oscar','oscar','sales');
    INSERT INTO customers(name) VALUES ('Refaccionaria El Águila');
  `);
  for (const f of ['0184_exhibitions.sql', '0185_consult_upload_parts.sql', '0186_expo_meeting_kind_confirm.sql']) {
    await pool.query(`SET search_path TO ${SCHEMA}; ` + mig(f));
  }
});

after(async () => {
  if (skip) return;
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
  await pool.end();
});

// 여러 문장을 한 번에 보내면 node-pg 가 결과 배열을 준다 — 마지막 것만 쓴다
async function q(text) {
  const res = await pool.query(`SET search_path TO ${SCHEMA}; ` + text);
  return Array.isArray(res) ? res[res.length - 1] : res;
}
// 다중 문장 + 파라미터는 못 섞으므로 파라미터 쿼리는 search_path 를 커넥션에 걸어 쓴다
async function qp(text, params) {
  const c = await pool.connect();
  try { await c.query(`SET search_path TO ${SCHEMA}`); return await c.query(text, params); }
  finally { c.release(); }
}

// 라우트(exhibitionRoutes.js)가 실제로 쓰는 INSERT 문 — 여기와 코드가 어긋나면 이 테스트가 깨진다
const INSERT_MEETING = `INSERT INTO exhibition_meetings
     (exhibition_id, day_no, slot_hour, meet_date, owner_user_id, customer_id, company_name,
      contact_name, wa_phone, email, goal_note, target_quote, target_order, memo, status, is_walkin,
      kind, is_confirmed, confirmed_at, confirmed_by, created_by)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`;

async function newExpo() {
  return Number((await qp(
    `INSERT INTO exhibitions (name,venue,start_date,day_count,start_hour,end_hour,currency,is_active,created_by)
     VALUES ('RUJAC','Expo Guadalajara','2026-09-16',3,8,18,'MXN',TRUE,1) RETURNING id`)).rows[0].id);
}
function meetParams(expoId, { kind = 'meeting', confirmed = false, userId = 1 } = {}) {
  return [expoId, 1, 9, '2026-09-16', 2, 1, 'Grupo Zeta', 'Juan', '8112345678', 'a@b.mx', '연간 계약 확인',
    850000, 400000, null, 'planned', false, kind,
    confirmed, confirmed ? new Date().toISOString() : null, confirmed ? userId : null, userId];
}

test('마이그레이션 0184·0185·0186 이 실제 Postgres 에 적용된다', { skip }, async () => {
  const cols = (await q(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = '${SCHEMA}' AND table_name = 'exhibition_meetings'`)).rows;
  const by = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
  assert.equal(by.kind, 'text');
  assert.equal(by.is_confirmed, 'boolean');
  assert.equal(by.confirmed_by, 'bigint');
  assert.ok(by.confirmed_at.startsWith('timestamp'));
});

test('0186 은 여러 번 적용해도 안전하다(멱등)', { skip }, async () => {
  await q(mig('0186_expo_meeting_kind_confirm.sql'));
  await q(mig('0186_expo_meeting_kind_confirm.sql'));
  const n = Number((await q(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema='${SCHEMA}' AND table_name='exhibition_meetings' AND column_name='kind'`)).rows[0].n);
  assert.equal(n, 1);
});

test('미팅 저장: 약속(미확정)·약속(확정)·부스 세 경우 모두 실제로 INSERT 된다', { skip }, async () => {
  const expo = await newExpo();
  for (const opt of [{ kind: 'meeting', confirmed: false }, { kind: 'meeting', confirmed: true }, { kind: 'booth', confirmed: false }]) {
    const r = await qp(INSERT_MEETING, meetParams(expo, opt));   // ← 여기서 42804 로 500 이 났었다
    const row = (await qp(`SELECT kind, is_confirmed, confirmed_by, confirmed_at FROM exhibition_meetings WHERE id=$1`,
      [r.rows[0].id])).rows[0];
    assert.equal(row.kind, opt.kind);
    assert.equal(row.is_confirmed, opt.confirmed);
    if (opt.confirmed) { assert.equal(Number(row.confirmed_by), 1); assert.ok(row.confirmed_at); }
    else { assert.equal(row.confirmed_by, null); assert.equal(row.confirmed_at, null); }
  }
});

test('kind CHECK 제약: booth/meeting 외의 값은 거부된다', { skip }, async () => {
  const expo = await newExpo();
  await assert.rejects(() => qp(INSERT_MEETING, meetParams(expo, { kind: 'otro' })), (e) => e.code === '23514');
});

test('확정 토글 UPDATE 가 실제로 돈다(켜기 → 끄기)', { skip }, async () => {
  const expo = await newExpo();
  const id = (await qp(INSERT_MEETING, meetParams(expo))).rows[0].id;
  await qp(`UPDATE exhibition_meetings SET is_confirmed=$2, confirmed_at=$3, confirmed_by=$4, updated_at=now() WHERE id=$1`,
    [id, true, new Date().toISOString(), 1]);
  let row = (await qp(`SELECT is_confirmed, confirmed_by FROM exhibition_meetings WHERE id=$1`, [id])).rows[0];
  assert.equal(row.is_confirmed, true);
  assert.equal(Number(row.confirmed_by), 1);
  await qp(`UPDATE exhibition_meetings SET is_confirmed=$2, confirmed_at=$3, confirmed_by=$4 WHERE id=$1`,
    [id, false, null, null]);
  row = (await qp(`SELECT is_confirmed, confirmed_by, confirmed_at FROM exhibition_meetings WHERE id=$1`, [id])).rows[0];
  assert.equal(row.is_confirmed, false);
  assert.equal(row.confirmed_by, null);
  assert.equal(row.confirmed_at, null);
});

test('보드 조회 SQL 이 실제로 돌고 NUMERIC 은 문자열로 온다(Number 변환 필요)', { skip }, async () => {
  const expo = await newExpo();
  await qp(INSERT_MEETING, meetParams(expo));
  const rows = (await qp(
    `SELECT m.*, u.name AS owner_name, u.login_id AS owner_login, c.private_by AS consult_private_by
       FROM exhibition_meetings m
       LEFT JOIN users u ON u.id = m.owner_user_id
       LEFT JOIN sales_consults c ON c.id = m.consult_id
      WHERE m.exhibition_id = $1 AND m.deleted_at IS NULL
      ORDER BY m.day_no ASC, m.slot_hour ASC, m.id ASC LIMIT 600`, [expo])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner_name, 'Oscar');
  assert.equal(typeof rows[0].target_quote, 'string', 'node-pg 는 NUMERIC 을 문자열로 준다');
  assert.equal(Number(rows[0].target_quote), 850000);
});

test('분할 업로드 조각 테이블에 실제로 넣고 조립 순서대로 읽힌다', { skip }, async () => {
  const cid = Number((await qp(
    `INSERT INTO sales_consults (consult_date, company_name, created_by) VALUES ('2026-09-16','Zeta',1) RETURNING id`)).rows[0].id);
  for (const [seg, part, b64] of [[0, 1, 'BBBB'], [0, 0, 'AAAA'], [1, 0, 'CCCC']]) {
    await qp(`INSERT INTO sales_consult_upload_parts (session_key, consult_id, seg_no, part_no, b64, created_by)
              VALUES ($1,$2,$3,$4,$5,$6)`, ['ukey12345678', cid, seg, part, b64, 1]);
  }
  const rows = (await qp(
    `SELECT seg_no, part_no, b64 FROM sales_consult_upload_parts
      WHERE session_key=$1 AND consult_id=$2 ORDER BY seg_no ASC, part_no ASC`, ['ukey12345678', cid])).rows;
  assert.deepEqual(rows.map((r) => r.b64), ['AAAA', 'BBBB', 'CCCC']);
  await assert.rejects(() => qp(
    `INSERT INTO sales_consult_upload_parts (session_key, consult_id, seg_no, part_no, b64, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`, ['ukey12345678', cid, 0, 0, 'DDDD', 1]), (e) => e.code === '23505',
  '같은 조각은 UNIQUE 로 막힌다(재전송은 DELETE 후 INSERT)');
});
