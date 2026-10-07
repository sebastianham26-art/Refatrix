// 0258 화면 — 재무(거래등록·예정 내역·거래 상세)에서 전자결재 문서를 증빙으로 고르기 + 전자결재 회차별 자금 표시
//   jsdom 으로 실제 API(PostgreSQL)에 붙여 돈다.  실행: TEST_PG_URL=postgres://... node --test test/approval_finance_front.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const FIN = readFileSync(join(REPO, 'refatrix-finance.html'), 'utf8');
const APR = readFileSync(join(REPO, 'refatrix-approval.html'), 'utf8');
const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

after(async () => {
  if (!PG) return;
  const { pool } = await import('../src/db.js');
  await pool.end().catch(() => {});
  setTimeout(() => process.exit(process.exitCode || 0), 500);
});

test('G0 정적 — 빌드 토큰 · 버튼 · 인라인 핸들러 없음(새 코드)', () => {
  assert.match(FIN, /<title>[^<]*fin-1007aq<\/title>/);
  assert.match(APR, /<title>[^<]*b20261007gb<\/title>/);
  assert.match(FIN, /id="t-ap-btn"/); assert.match(FIN, /🖼 사진·파일에서 선택/);
  const block = FIN.slice(FIN.indexOf('0258 전자결재 문서를 증빙'), FIN.indexOf('// 거래목록 영수증 열'));
  assert.doesNotMatch(block, /\son(click|change|input)=/i);
});

test('G1 화면 — 거래등록에서 전자결재 고르기 · 예정 내역 표시 · 상세 연결/해제 · 전자결재 자금 열', { skip: !PG }, async () => {
  const { JSDOM } = await import('jsdom');
  const { buildApp } = await import('../src/server.js');
  const { pool } = await import('../src/db.js');
  const app = buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const API = `http://127.0.0.1:${app.server.address().port}`;
  const U = {};
  for (const r of (await pool.query(`SELECT id, login_id, role, name FROM users WHERE login_id = ANY($1)`,
    [['sebastian', 'christopher', 'jang', 'maria', 'oscar', 'jose', 'luis']])).rows) U[r.login_id] = { id: Number(r.id), role: r.role, name: r.name, tok: app.jwt.sign({ sub: Number(r.id), role: r.role }) };
  const api = async (who, method, url, payload) => {
    const res = await app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + U[who].tok } });
    const b = res.json(); assert.ok(res.statusCode < 300, `${url} ${res.statusCode} ${JSON.stringify(b)}`); return b;
  };
  const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return; } catch { /* 아직 */ } await new Promise((r) => setTimeout(r, 25)); } throw new Error('timeout: ' + fn.toString().slice(0, 140)); };
  const doms = [];
  try {
    await pool.query(`UPDATE approval_settings SET ceo_pre_threshold=100000, ceo_user_id=$1, director_user_id=$2, finance_user_id=$3 WHERE id=1`, [U.jang.id, U.sebastian.id, U.christopher.id]);
    const acc = Number((await pool.query(`INSERT INTO accounts(name, type, currency) VALUES ('BBVA 화면','bank','MXN') RETURNING id`)).rows[0].id);
    await pool.query(`INSERT INTO user_account_access(user_id, account_id, can_operate, can_detail) VALUES ($1,$2,true,true) ON CONFLICT DO NOTHING`, [U.christopher.id, acc]);
    await pool.query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'transactions','anywhere','edit') ON CONFLICT DO NOTHING`, [U.christopher.id]);
    const cat = (await api('sebastian', 'GET', '/api/approvals/bootstrap')).categories.find((c) => c.name === '비품');
    // 디렉터 기안 · 분할 2회 → 상신 즉시 승인 → 예정 2행
    const docId = (await api('sebastian', 'POST', '/api/approvals', { category_id: cat.id, title: '사무실 의자', vendor: 'Muebles MX', orig_sub: 1000, iva_applied: true,
      payment_type: 'installment', schedule: [{ due_date: '2026-11-10', amount: 580 }, { due_date: '2026-12-10', amount: 580 }], custom_steps: [] })).id;
    const sub = await api('sebastian', 'POST', `/api/approvals/${docId}/submit`);
    const det0 = await api('sebastian', 'GET', `/api/approvals/${docId}`);
    assert.equal(det0.doc.status, 'approved');
    const [pay1, pay2] = det0.payments.map((p) => p.id);

    // ── 재무 화면(Christopher)
    const dom = new JSDOM(FIN.replace(/<script src=[^>]*><\/script>/g, ''), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://erp.test/refatrix-finance.html' });
    doms.push(dom);
    const w = dom.window, d = w.document, $ = (s) => d.querySelector(s);
    const errs = []; w.addEventListener('error', (e) => errs.push(e.message));
    w.fetch = (u, o) => fetch(u, o); w.alert = () => {}; w.confirm = () => true; w.open = () => null; w.scrollTo = () => {};
    w.eval(`session={token:${JSON.stringify(U.christopher.tok)},user:{id:${U.christopher.id},name:'Christopher',role:'treasury'},api:${JSON.stringify(API)}};`);
    $('#app').classList.remove('hidden');
    await w.eval('loadCats()'); await w.eval('loadAccounts()');
    w.eval(`showTab('new')`);
    // 예정 내역: 전자결재 출처 · 문서 링크 · 삭제 불가
    await until(() => w.eval('ppItems.length') > 0);
    const ps = $('#pp-search'); ps.value = '의자'; ps.dispatchEvent(new w.Event('input'));   // 연·월 필터(이번 달) 밖이라 검색으로
    await until(() => [...d.querySelectorAll('#ppBody tr')].some((tr) => /전자결재/.test(tr.textContent)));
    const ppRows = [...d.querySelectorAll('#ppBody tbody tr[data-id]')].filter((tr) => /사무실 의자/.test(tr.textContent));
    assert.equal(ppRows.length, 2);
    assert.ok(ppRows[0].querySelector(`a[href="refatrix-approval.html#doc=${docId}"]`), '문서 링크');
    assert.ok(!ppRows[0].querySelector('.pp-del'), '전자결재 예정은 삭제 버튼 없음');
    // 실적 처리 폼에 전자결재 증빙 안내
    ppRows[0].querySelector('.pp-do').click();
    await until(() => $(`.pp-form[data-form="${ppRows[0].dataset.id}"]`) && /영수증 대용/.test($(`.pp-form[data-form="${ppRows[0].dataset.id}"]`).textContent));
    ppRows[0].querySelector('.pp-do').click();

    // 거래 등록: 📄 전자결재 문서에서 선택 → 칸 채움 → 등록
    $('#t-ap-btn').click();
    await until(() => d.querySelector('.ap-pick-ov .ap-pick'));
    assert.equal(d.querySelectorAll('.ap-pick-ov .ap-pick').length >= 2, true);
    const q = d.querySelector('.ap-pick-ov .ap-q'); q.value = '의자'; q.dispatchEvent(new w.Event('input'));
    d.querySelector(`.ap-pick-ov .ap-pick[data-pid="${pay1}"]`).click();
    assert.ok(!d.querySelector('.ap-pick-ov'), '고르면 창 닫힘');
    assert.equal($('#t-dir').value, 'out'); assert.equal($('#t-status').value, 'actual');
    assert.equal(Number($('#t-amt').value), 580); assert.equal($('#t-cat').value, '6120');
    assert.match($('#t-memo').value, /^\[전자결재\] .+ 사무실 의자 \(1\/2회차\) · Muebles MX$/);
    assert.match($('#t-ap-chip').textContent, /전자결재 증빙/);
    $('#t-acc').value = String(acc);
    $('#t-dir').value = 'in';                                   // 수입으로 바꾸면 막힘
    w.eval('saveTxn()');
    await until(() => /지출 · 실제/.test($('#newMsg').textContent));
    $('#t-dir').value = 'out';
    await w.eval('saveTxn()');
    await until(() => /증빙 연결 · 회차 집행완료/.test($('#newMsg').textContent));
    assert.equal($('#t-ap-chip').textContent.trim(), '', '등록 후 선택 해제');
    const p1 = (await pool.query(`SELECT p.status, p.exec_source, t.status AS ts, t.account_id FROM approval_payments p JOIN transactions t ON t.id=p.txn_id WHERE p.id=$1`, [pay1])).rows[0];
    assert.deepEqual([p1.status, p1.exec_source, p1.ts, Number(p1.account_id)], ['done', 'finance', 'actual', acc]);

    // 전자결재 화면의 「거래등록에서 집행」 바로가기(#tab=new&apay=) → 미리 채움
    await w.eval(`apPreselect(${pay2})`);
    assert.match($('#t-ap-chip').textContent, /2\/2회차/); assert.match($('#newMsg').textContent, /불러왔습니다/);
    w.eval('txnApSel=null;paintTxnAp()');

    // 거래 상세: 이미 등록한 지출에 「📄 전자결재 문서 연결」 → 증빙 표시 → 연결 해제
    const tid = Number((await api('christopher', 'POST', '/api/transactions', { status: 'actual', direction: 'out', account_id: acc, txn_date: '2026-12-09', amount: 580 })).id);
    w.eval(`txnMap[${tid}]={id:${tid},status:'actual',direction:'out',file_count:0,approval:null}`);
    const box = d.createElement('div'); d.body.appendChild(box);
    await w.eval(`appendTxnFiles(${tid}, document.body.lastElementChild)`);
    await until(() => box.querySelector('.tf-aplink'));
    box.querySelector('.tf-aplink').click();
    await until(() => d.querySelector(`.ap-pick-ov .ap-pick[data-pid="${pay2}"]`));
    assert.ok(!d.querySelector(`.ap-pick-ov .ap-pick[data-pid="${pay1}"]`), '처리된 회차는 목록에 없음');
    d.querySelector(`.ap-pick-ov .ap-pick[data-pid="${pay2}"]`).click();
    await until(() => /전자결재 증빙/.test(box.textContent) && box.querySelector('.tf-apunlink'));
    assert.match(box.textContent, /2\/2회차/);
    assert.equal(w.eval(`txnMap[${tid}].approval.doc_id`), docId);
    let dd = await api('sebastian', 'GET', `/api/approvals/${docId}`);
    assert.equal(dd.doc.exec_status, 'done'); assert.equal(dd.doc.post_status, 'pending');
    box.querySelector('.tf-apunlink').click();
    await until(() => box.querySelector('.tf-aplink'));
    dd = await api('sebastian', 'GET', `/api/approvals/${docId}`);
    assert.equal(dd.doc.exec_status, 'pending'); assert.deepEqual(dd.payments.map((p) => p.fin), ['actual', 'plan']);
    assert.deepEqual(errs, []);

    // ── 전자결재 화면(Christopher): 회차별 「자금」 열 · 거래등록 바로가기
    const adom = new JSDOM(APR, { runScripts: 'dangerously', pretendToBeVisual: true, url: `https://erp.test/refatrix-approval.html#doc=${docId}`,
      beforeParse(aw) { aw.fetch = (u, o) => fetch(u, o); aw.scrollTo = () => {}; aw.open = () => null;
        aw.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: U.christopher.tok, api: API, user: { id: U.christopher.id } })); } });
    doms.push(adom);
    const aw = adom.window, ad = aw.document;
    const aerrs = []; aw.addEventListener('error', (e) => aerrs.push(e.message));
    await until(() => aw.eval('DET') && aw.eval('DET.doc.id') === docId && ad.querySelector('.tbl.pays'));
    const rowsTxt = [...ad.querySelectorAll('.tbl.pays tbody tr')].map((tr) => tr.textContent);
    assert.match(rowsTxt[0], /거래등록 실적/); assert.match(rowsTxt[1], /자금계획 예정/);
    const link = ad.querySelector(`.tbl.pays a[href="refatrix-finance.html#tab=new&apay=${pay2}"]`);
    assert.ok(link, '거래등록에서 집행 바로가기'); assert.match(link.textContent, /거래등록에서 집행/);
    assert.match(ad.querySelector('#app').textContent, /미래자금계획/);
    assert.deepEqual(aerrs, []);
    void sub;
  } finally {
    for (const x of doms) x.window.close();
    await app.close();
  }
});
