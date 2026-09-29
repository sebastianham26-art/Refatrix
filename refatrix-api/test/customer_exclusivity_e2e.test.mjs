// =====================================================================
// 고객 독점 정책 + 판매 영업사원 + 서류 관문 — 종단 검증 (실 PostgreSQL, 0235)
//   실행: TEST_PG_URL=postgres://... node --test test/customer_exclusivity_e2e.test.mjs
//   청소하지 않는다 — 실행마다 이름·RFC 를 새로 만든다(인보이스에 딸린 행이 많아 완전 삭제가 어렵다).
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, app, todayMx;
const tok = {};
const ID = {};
const SFX = Date.now().toString(36).slice(-5).toUpperCase();
const TAG = 'EXC' + SFX;
const rfc = (n) => `E${String.fromCharCode(65 + n)}X9901${String(10 + n).padStart(2, '0')}${SFX.slice(-3).replace(/[^A-Z0-9]/g, 'A').padEnd(3, 'A')}`;

async function boot() {
  ({ query } = await import('../src/db.js'));
  ({ todayMx } = await import('../src/exclusivity.js'));
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const { registerExclusivityHooks } = await import('../src/exclusivity.js');

  const mkUser = async (name, role) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`,
    [`${TAG}${name}`, role, `${TAG}_${name}`.toLowerCase()])).rows[0].id);
  ID.dir = await mkUser('디렉터', 'director');
  ID.sup = await mkUser('지원', 'sales_support');
  ID.repA = await mkUser('영업A', 'sales');
  ID.repB = await mkUser('영업B', 'sales');
  for (const u of [ID.sup, ID.repA, ID.repB]) {
    for (const pg of ['sales', 'quote', 'customers', 'commission']) {
      await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
                   VALUES ($1,$2,'anywhere','edit') ON CONFLICT DO NOTHING`, [u, pg]);
    }
  }
  for (const u of [ID.repA, ID.repB]) {
    await query(`INSERT INTO commission_agents (user_id, default_rate, active, created_by, updated_by) VALUES ($1,3,true,$2,$2)`, [u, ID.dir]);
    await query(`INSERT INTO commission_agent_periods (user_id, start_date, end_date, basis, rate, created_by, updated_by)
                 VALUES ($1,'2026-07-01',NULL,'revenue',3,$2,$2)`, [u, ID.dir]);
  }
  ID.prod = Number((await query(
    `INSERT INTO products (code, name, list_price, stock_qty, is_active, avg_cost) VALUES ($1,$2,1000,500,true,300) RETURNING id`,
    [`${TAG}-P`, `${TAG} 부품`])).rows[0].id);

  const all = await import('../src/routes/salesRoutes.js');
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  registerExclusivityHooks(app);
  await app.register(all.default);
  await app.register((await import('../src/routes/quoteRoutes.js')).default);
  await app.register((await import('../src/routes/customerRoutes.js')).default);
  await app.register((await import('../src/routes/exclusivityRoutes.js')).default);
  await app.register((await import('../src/routes/commissionRoutes.js')).default);
  await app.register((await import('../src/routes/grossProfitRoutes.js')).default);
  await app.register((await import('../src/routes/devRequestRoutes.js')).default);
  await app.ready();
  for (const k of ['dir', 'sup', 'repA', 'repB']) tok[k] = app.jwt.sign({ sub: ID[k] });
}

const call = (who, method, url, body) => app.inject({ method, url, payload: body,
  headers: { authorization: 'Bearer ' + tok[who] } });
const sale = (who, customer_id, extra = {}) => call(who, 'POST', '/api/sales',
  { customer_id, inv_date: extra.inv_date || todayMx(), lines: [{ product_id: ID.prod, qty: 1 }], memo: TAG, ...extra });
const cust = async (id) => (await query(`SELECT * FROM customers WHERE id=$1`, [id])).rows[0];
const doc = (cid, t) => query(
  `INSERT INTO customer_documents (customer_id, doc_type, file_name, mime_type, byte_size, content, uploaded_by)
   VALUES ($1,$2,'a.pdf','application/pdf',1,'\\x00',$3) RETURNING id`, [cid, t, ID.dir]);

test('boot', { skip: SKIP }, async () => { await boot(); });

test('E1 승인일 = RFC 30일 기산일, 등록자 = 독점권자', { skip: SKIP }, async () => {
  ID.custP = Number((await query(
    `INSERT INTO customers (name, code, rfc, discount, credit_days, owner_id, rfc_claimed_by, rfc_claimed_at, approval_status, created_by)
     VALUES ($1,$2,$3,40,30,$4,$4,now(),'pending',$4) RETURNING id`, [`${TAG}신규P`, `${TAG}-P`, rfc(0), ID.repA])).rows[0].id);
  let c = await cust(ID.custP);
  assert.equal(c.rfc_excl_from, null, '승인 전에는 기산하지 않는다');
  const ap = await call('dir', 'POST', `/api/customer-registrations/${ID.custP}/approve`, {});
  assert.equal(ap.statusCode, 200, ap.body);
  c = await cust(ID.custP);
  const d = c.rfc_excl_from; const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.equal(ymd, todayMx());
  assert.equal(Number(c.rfc_excl_agent_id), ID.repA);
  const st = (await call('repA', 'GET', `/api/customers/${ID.custP}/exclusivity`)).json();
  assert.equal(st.current.kind, 'rfc'); assert.equal(st.current.days_left, 29);
});

test('E2 서류 관문: 할인 = Constancia+주소, 외상 = 경쟁사 인보이스', { skip: SKIP }, async () => {
  let c = await cust(ID.custP);
  assert.equal(Number(c.discount), 0); assert.equal(Number(c.credit_days), 0);
  assert.equal(Number(c.discount_agreed), 40); assert.equal(Number(c.credit_days_agreed), 30);
  await doc(ID.custP, 'constancia');
  assert.equal(Number((await cust(ID.custP)).discount), 0, 'Constancia 만으로는 할인 없음');
  await doc(ID.custP, 'domicilio');
  assert.equal(Number((await cust(ID.custP)).discount), 40);
  const f = await doc(ID.custP, 'factura_compra');
  assert.equal(Number((await cust(ID.custP)).credit_days), 30);
  await query(`UPDATE customer_documents SET deleted_at=now() WHERE id=$1`, [f.rows[0].id]);
  c = await cust(ID.custP);
  assert.equal(Number(c.credit_days), 0, '경쟁사 인보이스를 지우면 선입금으로'); assert.equal(Number(c.discount), 40);
  // 상세 화면은 약정값을 보이고 실효값을 따로 싣는다
  const dt = (await call('dir', 'GET', `/api/customers/${ID.custP}`)).json().customer;
  assert.equal(dt.credit_days, 30); assert.equal(dt.credit_days_effective, 0); assert.equal(dt.doc_gate, true);
  // 기존 고객(관문 없음)은 서류와 무관
  ID.custL = Number((await query(
    `INSERT INTO customers (name, code, rfc, discount, credit_days, owner_id, excl_policy, doc_gate, created_by)
     VALUES ($1,$2,$3,35,30,$4,false,false,$4) RETURNING id`, [`${TAG}기존L`, `${TAG}-L`, rfc(1), ID.repA])).rows[0].id);
  c = await cust(ID.custL);
  assert.equal(Number(c.discount), 35); assert.equal(Number(c.credit_days), 30);
});

test('E3 RFC 독점 중: 다른 영업은 견적·매출 차단, 영업지원 등록은 판매자=독점권자', { skip: SKIP }, async () => {
  const q = await call('repB', 'POST', '/api/quotes', { customer_id: ID.custP, lines: [{ product_id: ID.prod, qty: 1 }], memo: TAG });
  assert.equal(q.statusCode, 409, q.body); assert.equal(q.json().error, 'exclusive_other');
  const s = await sale('repB', ID.custP);
  assert.equal(s.statusCode, 409); assert.equal(s.json().error, 'exclusive_other');
  const ok = await sale('sup', ID.custP, { seller_id: ID.repB });   // 지원이 다른 이름을 넣어도 독점권자로 고정
  assert.equal(ok.statusCode, 200, ok.body);
  ID.invP1 = Number(ok.json().id);
  const inv = (await query(`SELECT seller_id, commission_agent_id, credit_days FROM sales_invoices WHERE id=$1`, [ID.invP1])).rows[0];
  assert.equal(Number(inv.seller_id), ID.repA); assert.equal(Number(inv.commission_agent_id), ID.repA);
  assert.equal(Number(inv.credit_days), 0, '경쟁사 인보이스가 없으니 외상 0일(선입금)');
  const c = await cust(ID.custP);
  assert.equal(c.excl_kind, 'sale'); assert.equal(Number(c.excl_agent_id), ID.repA);
});

test('E4 견적: 독점권자 이름이 판매 영업사원으로 들어가고 출력용 이름이 나온다', { skip: SKIP }, async () => {
  const q = await call('sup', 'POST', '/api/quotes', { customer_id: ID.custP, lines: [{ product_id: ID.prod, qty: 1 }], memo: TAG });
  assert.equal(q.statusCode, 200, q.body);
  const g = (await call('sup', 'GET', `/api/quotes/${q.json().id}`)).json();
  const qq = g.quote || g;
  assert.equal(Number(qq.seller_id), ID.repA); assert.equal(qq.seller_name, `${TAG}영업A`);
});

test('E5 개방 고객: 판매자 필수 · 먼저 판 사람이 1년 독점 · 담당자 이동', { skip: SKIP }, async () => {
  ID.custO = Number((await query(
    `INSERT INTO customers (name, code, rfc, discount, credit_days, owner_id, approval_status, created_by)
     VALUES ($1,$2,$3,0,0,$4,'approved',$4) RETURNING id`, [`${TAG}개방O`, `${TAG}-O`, rfc(2), ID.repA])).rows[0].id);
  // RFC 30일이 이미 지난 고객으로 만든다
  await query(`UPDATE customers SET rfc_excl_from = CURRENT_DATE - 45 WHERE id=$1`, [ID.custO]);
  const chk = (await call('sup', 'GET', `/api/exclusivity/check?customer_id=${ID.custO}`)).json();
  assert.equal(chk.open, true); assert.equal(chk.locked, false);
  const nos = await sale('sup', ID.custO);
  assert.equal(nos.statusCode, 400); assert.equal(nos.json().error, 'seller_required');
  const self = await sale('repB', ID.custO, { seller_id: ID.repA });
  assert.equal(self.statusCode, 403, '영업은 본인 이름으로만');
  const b = await sale('repB', ID.custO);
  assert.equal(b.statusCode, 200, b.body);
  ID.invO1 = Number(b.json().id);
  const c = await cust(ID.custO);
  assert.equal(Number(c.owner_id), ID.repB, '독점권자가 고객 담당자가 된다');
  assert.equal(c.excl_kind, 'sale');
  const a = await sale('repA', ID.custO);
  assert.equal(a.statusCode, 409, '이제 B 의 1년 독점');
});

test('E6 인보이스 삭제 → 훅이 재계산해 다시 개방', { skip: SKIP }, async () => {
  const del = await call('dir', 'DELETE', `/api/sales/${ID.invO1}`);
  assert.equal(del.statusCode, 200, del.body);
  // onResponse 훅은 응답 뒤에 돈다 — 최대 3초까지 기다린다(첫 실행 콜드스타트 대비)
  let c;
  for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 100)); c = await cust(ID.custO); if (c.excl_kind === null) break; }
  assert.equal(c.excl_kind, null);
  const a = await sale('repA', ID.custO);
  assert.equal(a.statusCode, 200, '개방됐으니 A 가 먼저 팔면 A 독점');
  assert.equal(Number((await cust(ID.custO)).owner_id), ID.repA);
});

test('E7 커미션: 인보이스 날짜의 독점권자로 고정 — 담당 이관 후에도 불변', { skip: SKIP }, async () => {
  const ym = todayMx().slice(0, 7);
  const lines = async (agent) => (await call('dir', 'GET', `/api/commission/overview?view=all&agent_id=${agent}&ym=${ym}`)).json()
    .groups.flatMap((g) => g.lines).map((l) => Number(l.invoice_id));
  assert.ok((await lines(ID.repA)).includes(ID.invP1));
  // 고객 P 를 B 에게 이관(기존 고객 방식) — 이미 발행된 인보이스 커미션은 A 에 남는다
  await query(`UPDATE customers SET owner_id=$1 WHERE id=$2`, [ID.repB, ID.custP]);
  assert.ok((await lines(ID.repA)).includes(ID.invP1), '이관 후에도 A');
  assert.ok(!(await lines(ID.repB)).includes(ID.invP1), 'B 에게 넘어가면 안 된다');
});

test('E8 기존 거래 고객: 독점 없이 판매 가능, 판매자 = 요청값 → 영업 본인 → 담당자', { skip: SKIP }, async () => {
  const b = await sale('repB', ID.custL);
  assert.equal(b.statusCode, 200, b.body);
  const inv = (await query(`SELECT seller_id, commission_agent_id, credit_days FROM sales_invoices WHERE id=$1`, [b.json().id])).rows[0];
  assert.equal(Number(inv.seller_id), ID.repB);
  assert.equal(Number(inv.credit_days), 30, '기존 고객 외상은 그대로');
  const s = await sale('sup', ID.custL);
  const inv2 = (await query(`SELECT seller_id FROM sales_invoices WHERE id=$1`, [s.json().id])).rows[0];
  assert.equal(Number(inv2.seller_id), ID.repA, '지정 없으면 고객 담당자');
});

test('E9 고객 수정: 서류 없는 신규 고객도 약정 할인 그대로 저장하면 변경으로 잡히지 않는다', { skip: SKIP }, async () => {
  const r = await call('dir', 'PATCH', `/api/customers/${ID.custP}`, { name: `${TAG}신규P2`, discount: 40, credit_days: 30 });
  assert.equal(r.statusCode, 200, r.body);
  const c = await cust(ID.custP);
  assert.equal(Number(c.discount_agreed), 40); assert.equal(Number(c.credit_days_agreed), 30);
  assert.equal(Number(c.credit_days), 0);
});

test('E10 SQL 스모크 — 0235 로 바뀐 조회가 실 DB 에서 모두 200', { skip: SKIP }, async () => {
  for (const u of ['/api/customers/template', '/api/customer-registrations?status=approved', '/api/customer-change-requests',
    `/api/customers/${ID.custP}/edit-basic`, `/api/customers/${ID.custP}`, `/api/customers/${ID.custP}/exclusivity`,
    `/api/exclusivity/check?customer_id=${ID.custO}`, '/api/sellers', `/api/commission/progress?agent_id=${ID.repA}`,
    `/api/commission/performance?agent_id=${ID.repA}`, '/api/gross-profit/by-customer', '/api/gross-profit',
    `/api/dashboard/funnel/invoice-lines?invoice_id=${ID.invP1}`, `/api/commission/payable?agent_id=${ID.repA}&settle_ym=${todayMx().slice(0, 7)}`]) {
    const r = await call('dir', 'GET', u);
    assert.ok(r.statusCode < 500, `${u} → ${r.statusCode} ${r.body.slice(0, 200)}`);
  }
  const fl = (await call('dir', 'GET', `/api/dashboard/funnel/invoice-lines?invoice_id=${ID.invP1}`)).json();
  assert.equal(fl.invoice.seller_name, `${TAG}영업A`, '인보이스 출력용 판매 영업사원');
  const rc = await call('dir', 'POST', '/api/exclusivity/recompute', {});
  assert.equal(rc.statusCode, 200, rc.body);
  assert.ok(rc.json().customers >= 3);
});

test('close', { skip: SKIP }, async () => {
  await app.close(); await (await import('../src/db.js')).pool.end();
  setTimeout(() => process.exit(0), 50).unref();   // devRequestRoutes 등이 남긴 타이머가 러너를 붙잡지 않게
});
