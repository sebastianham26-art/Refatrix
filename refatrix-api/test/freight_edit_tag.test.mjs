// fin-1013fr 운반비(6160) 매출 인보이스 태그 — 등록 이후 경로(직접 수정 · 수정요청 승인 · 예정 지급확인/실적처리)
//   + 거래등록에서 전자결재 회차를 고르면 계정이 6160 일 때 선택기가 뜨는지.
//   실행: TEST_PG_URL=postgres://... node --test test/freight_edit_tag.test.mjs  (전체 migrate 후)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const FIN = readFileSync(join(REPO, 'refatrix-finance.html'), 'utf8');
const ROUTES = readFileSync(join(REPO, 'refatrix-api/src/routes/financeRoutes.js'), 'utf8');
const PG = process.env.TEST_PG_URL || '';
const RUN = Date.now().toString(36);   // 재실행해도 고객 코드·메모가 겹치지 않게
if (PG) process.env.DATABASE_URL = PG;

after(async () => {
  if (!PG) return;
  const { pool } = await import('../src/db.js');
  await pool.end().catch(() => {});
  setTimeout(() => process.exit(process.exitCode || 0), 500);
});

test('R0 정적 — 빌드 토큰 · 세 경로에 선택기 · 전자결재 선택 후 선택기 갱신 · 인라인 핸들러 없음', () => {
  assert.match(FIN, /<title>[^<]*fin-1026ea<\/title>/);
  assert.match(FIN, /bindFreightPicker\(box\.querySelector\('\.e-cat'\)/);
  assert.match(FIN, /bindFreightPicker\(box\.querySelector\('\.cf-cat'\)/);
  assert.match(FIN, /bindFreightPicker\(tr\.querySelector\('\.pp-cat'\)/);
  const ap = FIN.slice(FIN.indexOf('function applyTxnAp('), FIN.indexOf('function paintTxnAp('));
  assert.match(ap, /\$\('t-cat'\)\.value=o\.category_code;\s*\n\s*updateTxCustRow\(\);/);
  const blk = FIN.slice(FIN.indexOf('운반비 인보이스 선택기(재사용)'), FIN.indexOf('function freightErrText'));
  assert.doesNotMatch(blk, /\son(click|change|input)=/i);
  for (const k of ['parseFreightTag(query, b)', 'parseFreightTag(query, payload)', 'parseFreightTag(cq, p)', 'parseFreightTag(query, b0)']) assert.ok(ROUTES.includes(k), k);
  assert.equal((ROUTES.match(/syncFreightTag\(/g) || []).length, 1 + 4, 'PATCH · 승인 · confirm(close) · confirm(keep) + 정의');
});

test('R1 규칙 — syncFreightTag/parseFreightTag 실DB', { skip: !PG }, async () => {
  const { pool, query } = await import('../src/db.js');
  const F = await import('../src/routes/financeRoutes.js');
  const cu = Number((await pool.query(`INSERT INTO customers(code,name) VALUES ('FRT-R1-'||$1,'R1 고객') RETURNING id`, [RUN])).rows[0].id);
  const i1 = Number((await pool.query(`INSERT INTO sales_invoices(customer_id,inv_date,total_mxn) VALUES ($1,'2026-10-01',1000) RETURNING id`, [cu])).rows[0].id);
  assert.deepEqual(await F.parseFreightTag(query, {}), { set: false });
  assert.deepEqual(await F.parseFreightTag(query, { freight_invoice_ids: [999999999] }), { error: 'bad_invoice' });
  assert.deepEqual(await F.parseFreightTag(query, { customer_id: 'x' }), { error: 'bad_customer' });
  const tg = await F.parseFreightTag(query, { customer_id: null, freight_invoice_ids: [i1] });
  assert.equal(tg.set, true); assert.equal(tg.customerId, cu, '인보이스 한 고객 → 고객 자동 확정');
  const clr = await F.parseFreightTag(query, { customer_id: null, freight_invoice_ids: null });
  assert.deepEqual(clr, { set: true, customerId: null, invRows: [] });
});

test('R2 E2E — 수정 PATCH · 수정요청 승인 · 예정 지급확인(마감/남겨두기) · 잘못된 인보이스 · 화면', { skip: !PG }, async () => {
  const { JSDOM } = await import('jsdom');
  const { buildApp } = await import('../src/server.js');
  const { pool } = await import('../src/db.js');
  const app = buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const API = `http://127.0.0.1:${app.server.address().port}`;
  const doms = [];
  try {
    // ── 준비: 디렉터 · 재무담당 · 계좌 · 고객 2곳 · 게시 인보이스 3건
    const mk = async (login, role) => Number((await pool.query(
      `INSERT INTO users(name, role, pin_hash, login_id) VALUES ($1,$2,'x',$1)
       ON CONFLICT (login_id) WHERE login_id IS NOT NULL DO UPDATE SET role=EXCLUDED.role RETURNING id`, [login, role])).rows[0].id);
    const U = { dir: { id: await mk('frt_dir', 'director') }, fin: { id: await mk('frt_fin', 'treasury') } };
    U.dir.tok = app.jwt.sign({ sub: U.dir.id, role: 'director' }); U.fin.tok = app.jwt.sign({ sub: U.fin.id, role: 'treasury' });
    const acc = Number((await pool.query(`INSERT INTO accounts(name, type, currency) VALUES ('FRT 계좌','bank','MXN') RETURNING id`)).rows[0].id);
    await pool.query(`INSERT INTO user_account_access(user_id, account_id, can_operate, can_detail) VALUES ($1,$2,true,true) ON CONFLICT DO NOTHING`, [U.fin.id, acc]);
    await pool.query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'transactions','anywhere','edit') ON CONFLICT DO NOTHING`, [U.fin.id]);
    const cA = Number((await pool.query(`INSERT INTO customers(code,name) VALUES ('FRT-A-'||$1,'Refaccionaria A') RETURNING id`, [RUN])).rows[0].id);
    const cB = Number((await pool.query(`INSERT INTO customers(code,name) VALUES ('FRT-B-'||$1,'Refaccionaria B') RETURNING id`, [RUN])).rows[0].id);
    const inv = async (c, d, tot, st = 'posted') => Number((await pool.query(
      `INSERT INTO sales_invoices(customer_id,inv_date,total_mxn,status,sat_no) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [c, d, tot, st, 'SAT-' + RUN + '-' + d + '-' + tot])).rows[0].id);
    const a1 = await inv(cA, '2026-10-02', 5000), a2 = await inv(cA, '2026-10-05', 7000), b1 = await inv(cB, '2026-10-06', 3000);
    const call = async (who, method, url, payload) => {
      const res = await app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + U[who].tok } });
      let body = null; try { body = res.json(); } catch { body = res.body; }
      return { code: res.statusCode, body };
    };
    const ok = async (...a) => { const r = await call(...a); assert.ok(r.code < 300, `${a[1]} ${a[2]} → ${r.code} ${JSON.stringify(r.body)}`); return r.body; };
    const allocs = async (id) => (await pool.query(`SELECT sales_invoice_id, customer_id, amount_mxn FROM transaction_freight_allocations WHERE transaction_id=$1 ORDER BY id`, [id]))
      .rows.map((x) => [Number(x.sales_invoice_id), Number(x.customer_id), Number(x.amount_mxn)]);
    const txn = async (id) => (await pool.query(`SELECT status, category_code, customer_id, amount_mxn, approved FROM transactions WHERE id=$1`, [id])).rows[0];
    const today = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);

    // ── E1 미승인 지출(재무담당 등록) → 직접 수정에서 계정을 6160 + 혼적 인보이스 3건
    const t1 = (await ok('fin', 'POST', '/api/transactions', { account_id: acc, txn_date: today, direction: 'out', amount: 1000, currency: 'MXN', category_code: '6100', status: 'actual' })).id;
    await ok('fin', 'PATCH', `/api/transactions/${t1}`, { category_code: '6160', amount: 1000, customer_id: null, freight_invoice_ids: [a1, a2, b1] });
    assert.deepEqual(await allocs(t1), [[a1, cA, 333.33], [a2, cA, 333.33], [b1, cB, 333.34]]);
    assert.equal((await txn(t1)).customer_id, null, '혼적 → 고객 NULL');
    // 태그 없이 금액만 수정 → 재분할
    await ok('fin', 'PATCH', `/api/transactions/${t1}`, { amount: 900 });
    assert.deepEqual((await allocs(t1)).map((x) => x[2]), [300, 300, 300]);
    // 한 고객만 → 고객 자동 확정
    await ok('fin', 'PATCH', `/api/transactions/${t1}`, { category_code: '6160', customer_id: null, freight_invoice_ids: [a2] });
    assert.deepEqual(await allocs(t1), [[a2, cA, 900]]); assert.equal(Number((await txn(t1)).customer_id), cA);
    // 잘못된 인보이스 → 400, 기존 그대로
    const bad = await call('fin', 'PATCH', `/api/transactions/${t1}`, { category_code: '6160', freight_invoice_ids: [987654321] });
    assert.equal(bad.code, 400); assert.equal(bad.body.error, 'bad_invoice'); assert.deepEqual(await allocs(t1), [[a2, cA, 900]]);
    // 계정을 6160 에서 다른 계정으로 → 태그 제거
    await ok('fin', 'PATCH', `/api/transactions/${t1}`, { category_code: '6100' });
    assert.deepEqual(await allocs(t1), []); assert.equal((await txn(t1)).customer_id, null);

    // ── E2 승인된 거래 → 수정요청(태그 포함) → 상세 비교 → 디렉터 승인 반영
    const t2 = (await ok('dir', 'POST', '/api/transactions', { account_id: acc, txn_date: today, direction: 'out', amount: 600, currency: 'MXN', category_code: '6100', status: 'actual' })).id;
    const badReq = await call('fin', 'POST', `/api/transactions/${t2}/edit-request`, { payload: { category_code: '6160', freight_invoice_ids: [987654321] } });
    assert.equal(badReq.code, 400, '요청 시점 검증');
    const cr = (await ok('fin', 'POST', `/api/transactions/${t2}/edit-request`, { payload: { category_code: '6160', amount: 600, customer_id: cB, freight_invoice_ids: [a1, b1] }, reason: '운반비' })).id;
    const det = await ok('dir', 'GET', `/api/transactions/change-requests/${cr}/detail`);
    assert.equal(det.orig.freight, null); assert.equal(det.next.freight, `인보이스 #${a1}, #${b1}`);
    await ok('dir', 'POST', `/api/transactions/change-requests/${cr}/approve`);
    assert.deepEqual(await allocs(t2), [[a1, cA, 300], [b1, cB, 300]]);
    assert.equal((await txn(t2)).category_code, '6160');
    // 승인 경로 금액 변경도 재분할(종전 누락)
    const cr2 = (await ok('fin', 'POST', `/api/transactions/${t2}/edit-request`, { payload: { amount: 800 } })).id;
    await ok('dir', 'POST', `/api/transactions/change-requests/${cr2}/approve`);
    assert.deepEqual((await allocs(t2)).map((x) => x[2]), [400, 400]);

    // ── E3 예정(계정 다른 것) → 지급 확인에서 6160 + 인보이스(마감)
    const p1 = (await ok('dir', 'POST', '/api/transactions', { account_id: acc, txn_date: today, direction: 'out', amount: 1200, currency: 'MXN', category_code: '6100', status: 'plan', memo: 'FRT 예정1' })).id;
    const badCat = await call('dir', 'POST', `/api/transactions/${p1}/confirm-pay`, { account_id: acc, category_code: '9999x' });
    assert.equal(badCat.code, 400); assert.equal((await txn(p1)).status, 'plan');
    await ok('dir', 'POST', `/api/transactions/${p1}/confirm-pay`, { account_id: acc, pay_date: today, amount: 1200, category_code: '6160', customer_id: cA, freight_invoice_ids: [a1, a2] });
    const p1r = await txn(p1);
    assert.deepEqual([p1r.status, p1r.category_code, Number(p1r.customer_id)], ['actual', '6160', cA]);
    assert.deepEqual(await allocs(p1), [[a1, cA, 600], [a2, cA, 600]]);
    // 계정 키를 안 보내면 기존 계정 유지(구 화면 호환)
    const p2 = (await ok('dir', 'POST', '/api/transactions', { account_id: acc, txn_date: today, direction: 'out', amount: 500, currency: 'MXN', category_code: '6160', status: 'plan', memo: 'FRT 예정2 ' + RUN })).id;
    await ok('dir', 'POST', `/api/transactions/${p2}/confirm-pay`, { account_id: acc, pay_date: today, amount: 300, remainder: 'keep', freight_invoice_ids: [b1] });
    assert.equal((await txn(p2)).category_code, '6160'); assert.deepEqual(await allocs(p2), [[b1, cB, 300]], '남겨두기 — 실집행분만 배분');
    const rem = (await pool.query(`SELECT category_code, amount, status FROM transactions WHERE memo=$1`, ['FRT 예정2 ' + RUN + ' (잔액)'])).rows[0];
    assert.deepEqual([rem.category_code, Number(rem.amount), rem.status], ['6160', 200, 'plan']);
    // 손익 화면 집계 경로(실제·승인)가 배분행을 그대로 읽는다
    const gp = (await pool.query(`SELECT SUM(a.amount_mxn) s FROM transaction_freight_allocations a JOIN transactions t ON t.id=a.transaction_id
      WHERE t.status='actual' AND t.approved AND t.deleted_at IS NULL AND t.category_code='6160' AND a.customer_id=$1`, [cA])).rows[0].s;
    assert.equal(Number(gp), 400 + 1200, '고객 A 몫 = t2 의 a1(400) + p1(600×2)');

    // ── 화면(jsdom) — 재무담당
    const dom = new JSDOM(FIN.replace(/<script src=[^>]*><\/script>/g, ''), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://erp.test/refatrix-finance.html' });
    doms.push(dom);
    const w = dom.window, d = w.document, $ = (s) => d.querySelector(s);
    const errs = []; w.addEventListener('error', (e) => errs.push(e.message));
    w.fetch = (u, o) => fetch(u, o); w.alert = () => {}; w.confirm = () => true; w.open = () => null; w.scrollTo = () => {};
    const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return; } catch { /* */ } await new Promise((r) => setTimeout(r, 25)); } throw new Error('timeout: ' + fn.toString().slice(0, 160)); };
    w.eval(`session={token:${JSON.stringify(U.dir.tok)},user:{id:${U.dir.id},name:'Dir',role:'director'},api:${JSON.stringify(API)}};`);
    $('#app').classList.remove('hidden');
    await w.eval('loadCats()'); await w.eval('loadAccounts()');

    // (a) 거래 수정 패널 — 미승인(재무담당 등록) 거래, 계정을 6160 으로 바꾸면 선택기가 뜨고 저장 시 배분
    const t3 = (await ok('fin', 'POST', '/api/transactions', { account_id: acc, txn_date: today, direction: 'out', amount: 2000, currency: 'MXN', category_code: '6100', status: 'actual', memo: 'FRT 화면수정' })).id;
    await w.eval('loadTxns()');
    await until(() => w.eval(`!!txnMap[${t3}]`));
    const box = d.createElement('div'); d.body.appendChild(box);
    w.eval(`renderTxnDetail(${t3}, document.body.lastElementChild)`);
    assert.equal(box.querySelector('.e-fi').style.display, 'none', '6100 이면 숨김');
    const ec = box.querySelector('.e-cat'); ec.value = '6160'; ec.dispatchEvent(new w.Event('change'));
    await until(() => box.querySelector('.e-fi .fp-cust') && box.querySelector('.e-fi .fp-cust').options.length > 2);
    const fc = box.querySelector('.e-fi .fp-cust'); fc.value = String(cA); fc.dispatchEvent(new w.Event('change'));
    await until(() => box.querySelectorAll('.e-fi .fi-invrow').length === 2);
    box.querySelector(`.e-fi .fi-invrow[data-inv="${a2}"]`).click();
    fc.value = String(cB); fc.dispatchEvent(new w.Event('change'));
    await until(() => box.querySelector(`.e-fi .fi-invrow[data-inv="${b1}"]`));
    box.querySelector(`.e-fi .fi-invrow[data-inv="${b1}"]`).click();
    assert.match(box.querySelector('.e-fi .fp-sum').textContent, /2건.*고객 2곳 혼적/);
    assert.match(box.querySelector('.e-fi .fp-per').textContent, /1,000/);
    await w.eval(`submitTxnEdit(${t3}, document.body.lastElementChild, true)`);
    assert.deepEqual(await allocs(t3), [[a2, cA, 1000], [b1, cB, 1000]]);
    // 다시 열면 기존 배분이 미리 선택됨
    await w.eval('loadTxns()');
    await until(() => w.eval(`txnMap[${t3}] && txnMap[${t3}].freight_alloc_n==2`));
    box.innerHTML = ''; w.eval(`renderTxnDetail(${t3}, document.body.lastElementChild)`);
    await until(() => box.querySelectorAll('.e-fi .fi-chip').length === 2);
    assert.equal(box.querySelector('.e-fi').style.display, '');

    // (b) 예정 내역 「실적 처리」 — 전자결재처럼 다른 계정으로 생긴 예정을 6160 으로 바꾸고 인보이스 선택
    const p3 = (await ok('dir', 'POST', '/api/transactions', { account_id: acc, txn_date: today, direction: 'out', amount: 900, currency: 'MXN', category_code: '6100', status: 'plan', memo: 'FRT 화면예정' })).id;
    await w.eval('loadPendingPlans()');
    await until(() => d.querySelector(`#ppBody .pp-do[data-id="${p3}"]`));
    d.querySelector(`#ppBody .pp-do[data-id="${p3}"]`).click();
    const form = await (async () => { await until(() => d.querySelector(`.pp-form[data-form="${p3}"] .pp-cat`)); return d.querySelector(`.pp-form[data-form="${p3}"]`); })();
    assert.equal(form.querySelector('.pp-fi').style.display, 'none');
    const pc = form.querySelector('.pp-cat'); pc.value = '6160'; pc.dispatchEvent(new w.Event('change'));
    await until(() => form.querySelector('.pp-fi .fp-cust') && form.querySelector('.pp-fi .fp-cust').options.length > 2);
    const pfc = form.querySelector('.pp-fi .fp-cust'); pfc.value = String(cA); pfc.dispatchEvent(new w.Event('change'));
    await until(() => form.querySelector(`.pp-fi .fi-invrow[data-inv="${a1}"]`));
    form.querySelector(`.pp-fi .fi-invrow[data-inv="${a1}"]`).click();
    form.querySelector('.pp-go').click();
    await until(() => !d.querySelector(`#ppBody .pp-do[data-id="${p3}"]`), 8000);
    assert.deepEqual([(await txn(p3)).status, (await txn(p3)).category_code], ['actual', '6160']);
    assert.deepEqual(await allocs(p3), [[a1, cA, 900]]);

    // (c) 거래목록 예정 「지급 확인」 패널에도 계정·선택기
    const p4 = (await ok('dir', 'POST', '/api/transactions', { account_id: acc, txn_date: today, direction: 'out', amount: 450, currency: 'MXN', category_code: '6160', status: 'plan', memo: 'FRT 화면예정2' })).id;
    await w.eval('loadTxns()');
    await until(() => w.eval(`!!txnMap[${p4}]`));
    box.innerHTML = ''; w.eval(`renderTxnDetail(${p4}, document.body.lastElementChild)`);
    assert.equal(box.querySelector('.cf-cat').value, '6160');
    await until(() => box.querySelector('.cf-fi .fp-cust') && box.querySelector('.cf-fi .fp-cust').options.length > 2);
    assert.equal(box.querySelector('.cf-fi').style.display, '', '이미 6160 예정이면 바로 보임');
    const cfc = box.querySelector('.cf-fi .fp-cust'); cfc.value = String(cB); cfc.dispatchEvent(new w.Event('change'));
    await until(() => box.querySelector(`.cf-fi .fi-invrow[data-inv="${b1}"]`));
    box.querySelector(`.cf-fi .fi-invrow[data-inv="${b1}"]`).click();
    await w.eval(`confirmPay(${p4}, document.body.lastElementChild)`);
    assert.deepEqual(await allocs(p4), [[b1, cB, 450]]);

    // (d) 거래등록 — 전자결재 회차를 고르면 계정 6160 일 때 선택기가 바로 보인다
    w.eval(`showTab('new')`);
    $('#t-dir').value = 'out'; $('#t-dir').dispatchEvent(new w.Event('change'));
    assert.equal($('#t-custRow').style.display, 'none');
    w.eval(`applyTxnAp({payment_id:1,doc_id:1,doc_no:'EA-T',title:'운반',vendor:'Fletes',seq:1,pay_n:1,currency:'MXN',planned_amount:700,category_code:'6160',plan_txn_id:null})`);
    assert.equal($('#t-cat').value, '6160');
    await until(() => $('#t-custRow').style.display === '' && $('#t-cust').options.length > 2);
    w.eval('txnApSel=null;paintTxnAp()');

    assert.deepEqual(errs, []);
  } catch (e) { console.error('R2 실패 지점:', e && e.stack); throw e;
  } finally {
    await new Promise((r) => setTimeout(r, 300));   // 화면의 진행 중 fetch 가 끝난 뒤 창을 닫는다
    doms.forEach((x) => x.window.close());
    await app.close();
  }
});
