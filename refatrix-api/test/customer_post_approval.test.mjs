// =====================================================================
// 0267 · 고객 등록 **사후승인** — 종단 검증 (실 PostgreSQL)
//   실행: TEST_PG_URL=postgres://... node --test test/customer_post_approval.test.mjs
//
//   디렉터 지시 (2026-10-09):
//     "여러 조건으로 고객등록을 하고 디렉터 승인을 받아야 고객으로 등록이 되고
//      CRM으로 전송이 되고 있어. 이걸 단순화해야겠어."
//     → "디렉터 사후승인으로 하자. 디렉터가 승인안한걸 모아서 나중에 승인하는 걸로 해줘"
//     → 필수에서 뺄 것: 기준품목(SYD) 구매단가 · 회사종류 TIER
//
//   여기서 잠그는 것 — 이 네 가지가 깨지면 단순화가 되돌아간 것이다:
//     ① 등록하면 **그 자리에서 쓸 수 있다** (approved + 견적 가능)
//     ② 등록하면 **그 자리에서 CRM 으로 나간다** (아웃박스에 행이 생긴다)
//     ③ 구매단가·TIER 없이 등록된다. 이메일·전화는 **여전히 막는다**(상대가 요구한다)
//     ④ 사후승인은 **모아서** 되고, 사후 반려는 **붙어 있는 일을 보고** 결정한다
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, app;
const tok = {};
const ID = {};
const SFX = Date.now().toString(36).slice(-5).toUpperCase();
const TAG = 'RAT' + SFX;
//   RFC 는 실제 형식(법인 3~4자 + YYMMDD + 동음이의 3자)을 지켜야 validateRfcOptional 을 통과한다.
//   ⚠ 실행마다 **달라야 한다** — RFC 는 유니크라 고정값이면 두 번째 실행이 rfc_taken 으로 죽는다.
//     SFX 에 숫자가 섞이므로 글자만 쓰는 자리는 코드포인트로 알파벳에 매핑한다.
const AL = [...SFX].map((ch) => String.fromCharCode(65 + (ch.charCodeAt(0) % 26))).join('');
const rfc = (n) => `${AL.slice(0, 3)}990115${AL.slice(3, 5)}${n}`;

async function boot() {
  ({ query } = await import('../src/db.js'));
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;

  const mkUser = async (name, role) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`,
    [`${TAG}${name}`, role, `${TAG}_${name}`.toLowerCase()])).rows[0].id);
  ID.dir = await mkUser('디렉터', 'director');
  ID.rep = await mkUser('영업', 'sales');
  for (const pg of ['sales', 'quote', 'customers']) {
    await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
                 VALUES ($1,$2,'anywhere','edit') ON CONFLICT DO NOTHING`, [ID.rep, pg]);
  }
  ID.team = Number((await query(
    `INSERT INTO sales_teams (name) VALUES ($1) RETURNING id`, [`${TAG}팀`])).rows[0].id);
  await query(`UPDATE users SET team_id=$1 WHERE id=$2`, [ID.team, ID.rep]);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register((await import('../src/routes/customerRoutes.js')).default);
  await app.ready();
  for (const k of ['dir', 'rep']) tok[k] = app.jwt.sign({ sub: ID[k] });
}

const call = (who, method, url, body) => app.inject({ method, url, payload: body,
  headers: { authorization: 'Bearer ' + tok[who] } });
const cust = async (id) => (await query(`SELECT * FROM customers WHERE id=$1`, [id])).rows[0];

/** 최소 등록 본문 — 0267 이후 **이것만으로** 등록돼야 한다. */
const minimal = (n, extra = {}) => ({
  name: `${TAG}고객${n}`, rfc: rfc(n), team_id: ID.team,
  contact: `c${n}@${TAG.toLowerCase()}.mx`, phone: `81${String(n).padStart(8, '0')}`,
  discount: 10, credit_days: 0, ...extra,
});

test('boot', { skip: SKIP }, async () => { await boot(); });

// ── ① 등록이 승인을 기다리지 않는다 ──────────────────────────────────
test('① 구매단가·TIER 없이 등록되고, 그 자리에서 활성이 된다', { skip: SKIP }, async () => {
  const r = await call('rep', 'POST', '/api/customers', minimal(1));
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  ID.c1 = Number(d.id);   // ⚠ bigint 는 JSON 에서 문자열로 온다
  assert.equal(d.approval_status, 'approved', '등록 즉시 쓸 수 있어야 한다');
  assert.equal(d.awaiting_ratify, true, '사후승인 대기라는 사실은 분명히 말해야 한다');
  assert.equal(d.pending_approval, false, '예전 키는 「아직 못 쓴다」는 뜻 — true 면 화면이 고객을 막는다');
  assert.equal(d.suggested_discount, null, '구매단가가 없으면 제안 근거도 없다(지어내지 않는다)');

  const c = await cust(ID.c1);
  assert.equal(c.approval_status, 'approved');
  assert.equal(c.ratified_at, null, '아직 아무도 승인하지 않았다');
  assert.equal(c.approved_by, null, '승인자가 박히면 승인 이력이 거짓이 된다');
  assert.equal(c.customer_type, null, 'TIER 는 비어도 등록된다');
  assert.equal(c.syd_ref_buy_price, null, '구매단가도 비어도 등록된다');
  //   ⚠ 0247 서류 관문: 증빙(Constancia+주소)이 붙기 전에는 discount 가 0 으로 유보되고
  //     합의값은 discount_agreed 에 남는다. 0267 은 그 규칙을 건드리지 않았다.
  assert.equal(Number(c.discount_agreed), 10, '등록자가 정한 할인율이 합의값으로 남아야 한다');
});

test('② 등록하는 순간 CRM 아웃박스에 들어간다 — 승인을 기다리지 않는다', { skip: SKIP }, async () => {
  const rows = (await query(
    `SELECT op, origin FROM crm_customer_outbox WHERE customer_id=$1 ORDER BY id`, [ID.c1])).rows;
  assert.ok(rows.length >= 1, '등록 시점에 전송이 걸려야 한다 — 이게 단순화의 목적이었다');
  assert.equal(rows[0].op, 'upsert');
  assert.equal(rows[0].origin, 'registration_create');
});

test('③ 이메일·전화는 여전히 막는다 — 없는 값을 CRM 에 지어내 보낼 수 없다', { skip: SKIP }, async () => {
  const noMail = await call('rep', 'POST', '/api/customers',
    { ...minimal(2), contact: '' });
  assert.equal(noMail.statusCode, 400);
  assert.equal(noMail.json().error, 'contact_required');

  const noPhone = await call('rep', 'POST', '/api/customers',
    { ...minimal(3), phone: '' });
  assert.equal(noPhone.statusCode, 400);
  assert.equal(noPhone.json().error, 'phone_required');
});

test('③-b 구매단가를 넣으면 종전대로 제안 할인율이 계산된다', { skip: SKIP }, async () => {
  // 선택으로 풀었을 뿐, 넣었을 때의 계산을 없애지 않았다.
  //   기준품목은 SYD 코드로 찾는다 — scode 를 채워야 조회가 걸린다(운영과 같은 경로).
  const p = Number((await query(
    `INSERT INTO products (code, name, scode, list_price, list_price_syd, stock_qty, is_active, avg_cost)
     VALUES ($1,$2,$3,1000,900,10,true,300) RETURNING id`,
    [`${TAG}-BASE`, `${TAG} 기준품목`, `${TAG}-BASE`])).rows[0].id);
  assert.ok(p > 0);
  const r = await call('rep', 'POST', '/api/customers',
    { ...minimal(4), syd_ref_code: `${TAG}-BASE`, syd_ref_buy_price: 600 });
  assert.equal(r.statusCode, 200, r.body);
  ID.c4 = Number(r.json().id);
  const c = await cust(ID.c4);
  assert.equal(Number(c.syd_ref_buy_price), 600);
  assert.ok(c.suggested_discount != null, '구매단가를 주면 제안값이 나와야 한다');
});

// ── ② 사후승인 ───────────────────────────────────────────────────────
test('④ 사후승인 목록은 「아직 확인 안 한 등록」이다 — 상태가 아니라 확인 여부로 고른다', { skip: SKIP }, async () => {
  const d = (await call('dir', 'GET', '/api/customer-registrations?status=pending')).json();
  assert.ok(!d.migration_required, '0267 마이그레이션이 적용돼 있어야 한다');
  const ids = (d.items || []).map((x) => Number(x.id));
  assert.ok(ids.includes(ID.c1), 'approved 인데도 목록에 있어야 한다 — 확인 안 했으니까');
  const row = d.items.find((x) => Number(x.id) === ID.c1);
  assert.equal(row.approval_status, 'approved');
  assert.equal(row.ratified_at, null);
  assert.equal(row.quote_cnt, 0);
  assert.equal(row.sale_cnt, 0, '붙어 있는 일을 디렉터가 보고 반려를 판단한다');
});

test('⑤ 모아서 한 번에 승인한다 (디렉터 지시의 핵심)', { skip: SKIP }, async () => {
  const r = await call('dir', 'POST', '/api/customer-registrations/ratify-bulk',
    { ids: [ID.c1, ID.c4] });
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.equal(d.ratified_count, 2);
  for (const id of [ID.c1, ID.c4]) {
    const c = await cust(id);
    assert.ok(c.ratified_at, '사후승인 시각이 찍혀야 한다');
    assert.equal(Number(c.ratified_by), ID.dir);
    assert.equal(c.approval_status, 'approved');
  }
  // 승인으로도 한 번 더 전송한다 — 할인율이 바뀌었을 수 있고, 전환으로 넘어온 건은 첫 전송이다.
  const ops = (await query(
    `SELECT origin FROM crm_customer_outbox WHERE customer_id=$1 ORDER BY id`, [ID.c1])).rows;
  assert.ok(ops.some((o) => o.origin === 'registration_ratify_bulk'));
});

test('⑥ 같은 건을 두 번 승인해도 숫자가 늘지 않는다(멱등)', { skip: SKIP }, async () => {
  const r = await call('dir', 'POST', '/api/customer-registrations/ratify-bulk', { ids: [ID.c1] });
  assert.equal(r.statusCode, 200);
  const d = r.json();
  assert.equal(d.ratified_count, 0, '이미 승인된 건은 다시 승인되지 않는다');
  assert.deepEqual(d.skipped.map(Number), [ID.c1], '왜 건너뛰었는지 돌려줘야 화면이 설명할 수 있다');
});

test('⑦ 승인한 건은 목록에서 빠진다', { skip: SKIP }, async () => {
  const d = (await call('dir', 'GET', '/api/customer-registrations?status=pending')).json();
  const ids = (d.items || []).map((x) => Number(x.id));
  assert.ok(!ids.includes(ID.c1));
  assert.ok(!ids.includes(ID.c4));
});

test('⑧ 단건 승인은 할인율을 조정할 수 있다 — 일괄에는 없는 기능', { skip: SKIP }, async () => {
  const r = await call('rep', 'POST', '/api/customers', minimal(5));
  assert.equal(r.statusCode, 200, r.body);
  const id = Number(r.json().id);
  const ap = await call('dir', 'POST', `/api/customer-registrations/${id}/approve`, { discount: 25 });
  assert.equal(ap.statusCode, 200, ap.body);
  assert.equal(ap.json().ratified, true);
  const c = await cust(id);
  assert.equal(Number(c.discount_agreed == null ? c.discount : c.discount_agreed), 25);
  assert.ok(c.ratified_at);
});

// ── ③ 사후 반려는 되돌리는 일이다 ────────────────────────────────────
test('⑨ 견적이 붙어 있으면 확인 없이는 반려하지 않는다', { skip: SKIP }, async () => {
  const r = await call('rep', 'POST', '/api/customers', minimal(6));
  const id = Number(r.json().id);
  await query(`INSERT INTO quotes (quote_no, customer_id, quote_date, created_by)
               VALUES ($1,$2,CURRENT_DATE,$3)`, [`${TAG}-Q1`, id, ID.rep]);

  const blocked = await call('dir', 'POST', `/api/customer-registrations/${id}/reject`,
    { reason: '중복 등록' });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error, 'has_quotes');
  assert.equal(blocked.json().quote_cnt, 1, '몇 건인지 숫자로 말해야 디렉터가 판단한다');
  assert.equal((await cust(id)).deleted_at, null, '막혔으면 아무것도 건드리지 않았어야 한다');

  const ok = await call('dir', 'POST', `/api/customer-registrations/${id}/reject`,
    { reason: '중복 등록', confirm: true });
  assert.equal(ok.statusCode, 200, ok.body);
  const c = await cust(id);
  assert.equal(c.approval_status, 'rejected');
  assert.ok(c.deleted_at);
  assert.ok(c.ratified_at, '반려도 결론이다 — 대기 목록에 남으면 안 된다');
  // 등록 시점에 이미 CRM 으로 나갔으므로, 되돌리는 전송이 반드시 있어야 한다.
  const ops = (await query(
    `SELECT op FROM crm_customer_outbox WHERE customer_id=$1 ORDER BY id`, [id])).rows;
  assert.ok(ops.some((o) => o.op === 'reject'),
    '반려를 CRM 에 안 보내면 CRM 에만 살아 있는 고객이 된다');
});

test('⑩ 매출이 있으면 아예 반려할 수 없다', { skip: SKIP }, async () => {
  const r = await call('rep', 'POST', '/api/customers', minimal(7));
  const id = Number(r.json().id);
  //   invoices 는 한 줄이 한 품목이다(inv_no 가 아니라 sat_no · product_id · qty · unit_price).
  const prod = Number((await query(
    `INSERT INTO products (code, name, list_price, stock_qty, is_active, avg_cost)
     VALUES ($1,$2,500,10,true,100) RETURNING id`, [`${TAG}-SP`, `${TAG} 매출품`])).rows[0].id);
  await query(`INSERT INTO invoices (sat_no, customer_id, product_id, qty, unit_price, inv_date, owner_id)
               VALUES ($1,$2,$3,1,500,CURRENT_DATE,$4)`, [`${TAG}-I1`, id, prod, ID.rep]);
  const res = await call('dir', 'POST', `/api/customer-registrations/${id}/reject`,
    { reason: '취소', confirm: true });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'has_sales', 'confirm 을 보내도 매출 앞에서는 막혀야 한다');
  assert.equal((await cust(id)).deleted_at, null);
});

test('⑪ 반려된 고객은 사후승인 대상이 아니다', { skip: SKIP }, async () => {
  const r = await call('rep', 'POST', '/api/customers', minimal(8));
  const id = Number(r.json().id);
  await call('dir', 'POST', `/api/customer-registrations/${id}/reject`, { reason: '오등록' });
  const again = await call('dir', 'POST', `/api/customer-registrations/${id}/approve`, {});
  assert.equal(again.statusCode, 404, '반려를 승인으로 뒤집는 뒷문이 있으면 안 된다');
  const bulk = await call('dir', 'POST', '/api/customer-registrations/ratify-bulk', { ids: [id] });
  assert.equal(bulk.json().ratified_count, 0);
});

// ── ④ 권한·입력 경계 ─────────────────────────────────────────────────
test('⑫ 일괄 승인은 디렉터만, 빈 선택·과다 선택은 막는다', { skip: SKIP }, async () => {
  const notDir = await call('rep', 'POST', '/api/customer-registrations/ratify-bulk', { ids: [ID.c1] });
  assert.ok(notDir.statusCode === 403 || notDir.statusCode === 401, '영업사원이 승인하면 안 된다');

  const empty = await call('dir', 'POST', '/api/customer-registrations/ratify-bulk', { ids: [] });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().error, 'ids_required');

  const many = await call('dir', 'POST', '/api/customer-registrations/ratify-bulk',
    { ids: Array.from({ length: 201 }, (_, i) => i + 1) });
  assert.equal(many.statusCode, 400);
  assert.equal(many.json().error, 'too_many', '한 번에 수천 건이 들어오면 화면이 멈춘다');

  // 쓰레기 값이 섞여도 터지지 않고 걸러져야 한다.
  const junk = await call('dir', 'POST', '/api/customer-registrations/ratify-bulk',
    { ids: ['abc', -1, 0, null] });
  assert.equal(junk.statusCode, 400);
  assert.equal(junk.json().error, 'ids_required');
});

// ── ⑤ 뒷정리 ─────────────────────────────────────────────────────────
//   이 저장소의 시험들은 **DB 하나를 공유**한다. 그리고 customer_merge 는 정리 과정에서
//   `DELETE FROM customers` 를 통째로 돌린다. 그래서 견적·매출 행을 남겨 두면
//   **다음 스위트가 외래키 위반으로 죽는다** — 내 시험이 통과하고 남을 깨뜨리는 셈이다.
//   그 자리에서 실패 원인을 찾기 어려운 종류의 사고라, 만든 행은 만든 쪽이 지운다.
test('zz 뒷정리 — 다음 스위트가 쓰는 DB 를 더럽히지 않는다', { skip: SKIP }, async () => {
  const ids = (await query(`SELECT id FROM customers WHERE name LIKE $1`, [`${TAG}%`])).rows
    .map((r) => Number(r.id));
  if (ids.length) {
    // 지우는 순서가 곧 외래키 순서다(자식 먼저).
    for (const t of ['quote_lines', 'quotes', 'invoices', 'crm_customer_outbox',
                     'customer_registration_events', 'customer_terms_history',
                     'customer_documents', 'customer_stage_history']) {
      try {
        await query(`DELETE FROM ${t} WHERE ${t === 'quote_lines'
          ? 'quote_id IN (SELECT id FROM quotes WHERE customer_id = ANY($1::bigint[]))'
          : 'customer_id = ANY($1::bigint[])'}`, [ids]);
      } catch (_) { /* 그 테이블이 없는 배포 — 넘어간다 */ }
    }
    await query(`DELETE FROM customers WHERE id = ANY($1::bigint[])`, [ids]);
  }
  try { await query(`DELETE FROM products WHERE code LIKE $1`, [`${TAG}%`]); } catch (_) {}
  try { await query(`DELETE FROM user_page_access WHERE user_id IN
                       (SELECT id FROM users WHERE name LIKE $1)`, [`${TAG}%`]); } catch (_) {}
  try { await query(`DELETE FROM audit_log WHERE user_id IN
                       (SELECT id FROM users WHERE name LIKE $1)`, [`${TAG}%`]); } catch (_) {}
  try { await query(`UPDATE users SET team_id=NULL WHERE name LIKE $1`, [`${TAG}%`]); } catch (_) {}
  try { await query(`DELETE FROM users WHERE name LIKE $1`, [`${TAG}%`]); } catch (_) {}
  try { await query(`DELETE FROM sales_teams WHERE name LIKE $1`, [`${TAG}%`]); } catch (_) {}
  const left = (await query(`SELECT count(*)::int AS n FROM customers WHERE name LIKE $1`,
    [`${TAG}%`])).rows[0];
  assert.equal(Number(left.n), 0, '내가 만든 고객은 내가 치운다');
});
