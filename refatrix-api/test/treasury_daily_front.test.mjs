// 일일 자금 · 월간실적 화면(refatrix-cashdaily.html) — jsdom 으로 실제 API(PostgreSQL) 에 붙여 돌리는 UI 행동 테스트
//   F0 정적 검사는 항상 · F1 은 TEST_PG_URL 이 있을 때(0240 까지 migrate 된 빈 DB, 멕시코 날짜 2026-09-30 기준 시나리오)
//   실행: TEST_PG_URL=postgres://... node --test test/treasury_daily_front.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const HTML = readFileSync(join(REPO, 'refatrix-cashdaily.html'), 'utf8');
const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

test('F0 정적 — 인라인 핸들러 없음 · 빌드 토큰 · nav 토큰 · 외부 스크립트는 허용 CDN 만', () => {
  assert.doesNotMatch(HTML, /\son(click|change|input|submit|keydown)=/i, 'addEventListener 만 사용');
  assert.match(HTML, /<title>[^<]*build cashd-1001a<\/title>/);
  assert.match(HTML, /refatrix-nav\.js\?v=20260930vr/);
  for (const m of HTML.matchAll(/src=['"](https?:[^'"]+)/g)) assert.match(m[1], /^https:\/\/cdn\.jsdelivr\.net\/npm\/xlsx-js-style/);
});


// 시나리오 기준 시각: MX 2026-09-30 12:00 (서버는 TREASURY_FAKE_NOW, 화면은 Date 고정)
const FAKE_NOW = '2026-09-30T18:00:00Z';
test('F1 주간(유첨 양식) → 월간 → 수신자 관리 → 미리보기', { skip: !PG }, async () => {
  process.env.TREASURY_FAKE_NOW = FAKE_NOW;
  const { JSDOM } = await import('jsdom');
  const { buildApp } = await import('../src/server.js');
  const { pool } = await import('../src/db.js');
  const q = (s, a) => pool.query(s, a);
  const one = async (s, a) => (await q(s, a)).rows[0];
  // ── 시드 (유첨 9/28~10/2 재현) ──
  await q(`DELETE FROM treasury_wa_sends; DELETE FROM treasury_wa_recipients; DELETE FROM treasury_daily_snapshots;`);
  const dir = (await one(`SELECT id FROM users WHERE login_id='tdir'`)) || await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ('T Director','director','x','tdir') RETURNING id`);
  const tag = 'TDF-' + Date.now();
  const mxn = await one(`INSERT INTO accounts (name, currency, open_balance) VALUES ($1,'MXN',0) RETURNING id`, [tag + ' MXN']);
  const usd = await one(`INSERT INTO accounts (name, currency, open_balance) VALUES ($1,'USD',4894) RETURNING id`, [tag + ' USD']);
  const cust = await one(`INSERT INTO customers (code, name) VALUES ($1,'Luemi') RETURNING id`, [tag]);
  await q(`INSERT INTO fx_rates (rate_date, rate, source) VALUES ('2026-09-25',18,'test') ON CONFLICT (rate_date, base, quote) DO UPDATE SET rate=18`);
  const tx = (d, dirn, amt, o = {}) => one(
    `INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, status, kind, approved, memo, sales_invoice_id, recurring_rule_id, plan_date, plan_amount)
     VALUES ($1,$2,$3,$4,'MXN',1,$4,$5,$6,true,$7,$8,$9,$10,$11) RETURNING id`,
    [mxn.id, d, dirn, amt, o.status || 'actual', o.kind || 'general', o.memo || null, o.inv || null, o.rule || null, o.plan_date || null, o.plan_date ? amt : null]);
  await tx('2026-09-10', 'in', 12047.4, { memo: 'Deposito inicial' });
  await tx('2026-09-15', 'out', 10000, { memo: 'Renta' });
  const inv34 = await one(`INSERT INTO sales_invoices (customer_id, inv_date, due_date, sat_no, total_mxn, status) VALUES ($1,'2026-09-01','2026-09-29','F-34',6984.4,'posted') RETURNING id`, [cust.id]);
  const pay = await one(`INSERT INTO sales_payments (customer_id, pay_date, account_id, amount) VALUES ($1,'2026-09-29',$2,6984.4) RETURNING id`, [cust.id, mxn.id]);
  const t34 = await tx('2026-09-29', 'in', 6984.4, { kind: 'payment', inv: inv34.id });
  await q(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount, txn_id) VALUES ($1,$2,6984.4,$3)`, [pay.id, inv34.id, t34.id]);
  for (const [sat, amt] of [['F-25', 25929], ['F-31', 39206]]) {
    const iv = await one(`INSERT INTO sales_invoices (customer_id, inv_date, due_date, sat_no, total_mxn, status) VALUES ($1,'2026-09-02','2026-10-02',$2,$3,'posted') RETURNING id`, [cust.id, sat, amt]);
    await q(`INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, sales_invoice_id, memo)
             VALUES (NULL,'2026-10-02','in',$1,'MXN',1,$1,'4010','plan','invoice',true,$2,'매출 입금예정')`, [amt, iv.id]);
  }
  const rules = [];
  for (const [n, a] of [['Nomina Maria', 4804], ['Nomina Oscar', 10180], ['Nomina Luis Mendez', 4281], ['Nomina Luis Guzman', 2914]]) {
    const r = await one(`INSERT INTO recurring_rules (name, amount, direction, freq, day_or_wday) VALUES ($1,$2,'out','month',2) RETURNING id`, [n, a]);
    rules.push(r.id);
    await tx('2026-10-02', 'out', a, { status: 'plan', rule: r.id, plan_date: '2026-10-02', memo: '[고정비] ' + n });
  }
  await tx('2026-10-02', 'out', 40000, { status: 'plan', memo: 'SAT', plan_date: '2026-10-02' });

  const app = buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const API = `http://127.0.0.1:${app.server.address().port}`;
  const tok = app.jwt.sign({ sub: Number(dir.id), role: 'director' });
  let dom;
  try {
    dom = new JSDOM(HTML, {
      runScripts: 'dangerously', url: 'https://erp.test/refatrix-cashdaily.html', pretendToBeVisual: true,
      beforeParse(w) {
        w.fetch = (u, o) => fetch(u, o);
        w.confirm = () => true; w.alert = () => {}; w.print = () => {};
        const RD = w.Date, fixed = Date.parse(FAKE_NOW);
        class FD extends RD { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } }
        w.Date = FD;
        w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: tok, api: API, user: { id: Number(dir.id), name: 'T Director', role: 'director' } }));
      },
    });
    const w = dom.window, d = w.document;
    const errs = []; w.addEventListener('error', (e) => errs.push(e.message));
    const $ = (s) => d.querySelector(s);
    const until = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return; } catch { /* 아직 */ } await new Promise((r) => setTimeout(r, 25)); } throw new Error('timeout: ' + fn.toString().slice(0, 140)); };
    const click = (el) => { assert.ok(el, 'element'); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };
    const rowCells = (rowSel) => [...d.querySelectorAll(rowSel)].map((tr) => [...tr.querySelectorAll('td.num,td.v')].map((td) => td.textContent.trim()));

    // ① 주간(유첨 양식)
    await until(() => $('table.ws'));
    assert.equal($('#wRng').textContent, '9/28 (월) ~ 10/3 (토)');
    assert.match($('#wScope').textContent, /집계 대상 계좌 \d+개/);
    assert.match($('#wRecon').textContent, /거래목록 「예정」 그대로 · 오늘 이후 7건 중 7건 표시 · 일치/);
    const heads = [...d.querySelectorAll('tr.date th')].slice(1).map((th) => th.textContent);
    assert.deepEqual(heads.map((h) => h.replace(/[^0-9/()A-Za-z ].*$/, '').trim()), ['9/28 (Mon)', '9/29 (Tue)', '9/30 (Wed)', '10/1 (Thu)', '10/2 (Fri)', '10/3 (Sat)'], '일요일(무거래) 숨김');
    assert.match(heads[0], /실적/); assert.match(heads[2], /오늘/); assert.match(heads[4], /예정/);
    const [bankMxn] = rowCells('tr.bank');
    assert.deepEqual(bankMxn.slice(0, 5), ['2,047', '2,047', '9,032', '9,032', '9,032'], '유첨 Bank Account MXN');
    const closeRows = rowCells('tr.close');
    assert.deepEqual(closeRows[0].slice(0, 5), ['2,047', '9,032', '9,032', '9,032', '11,988'], '유첨 Closing MXN');
    assert.deepEqual(closeRows[1].slice(0, 5), ['4,894', '4,894', '4,894', '4,894', '4,894']);
    assert.deepEqual(rowCells('tr.eq')[0].slice(0, 5), ['90,139', '97,124', '97,124', '97,124', '100,080'], '유첨 맨 아래 줄');
    const tots = rowCells('tr.tot');   // AR MXN, AR USD, AP MXN, AP USD
    assert.equal(tots[0][1], '6,984'); assert.equal(tots[0][4], '65,135'); assert.equal(tots[2][4], '62,179');
    const fri = [...d.querySelectorAll('tr.sec')].find((tr) => /AP/.test(tr.textContent)).querySelectorAll('td.num')[4];
    const names = [...fri.querySelectorAll('.it .nm')].map((x) => x.textContent);
    assert.deepEqual(names, ['SAT', 'Nomina Oscar', 'Nomina Maria', 'Nomina Luis Mendez', 'Nomina Luis Guzman']);
    assert.ok(fri.querySelector('.it.plan'), '예정 = 파랑');
    const tue = [...d.querySelectorAll('tr.sec')].find((tr) => /AR/.test(tr.textContent)).querySelectorAll('td.num')[1];
    assert.equal(tue.querySelector('.it.actual .nm').textContent, 'Luemi', '실적 = 회색 · 고객명');
    // 항목 표시 끄기 / 지난 주 이동
    $('#wItems').checked = false; $('#wItems').dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(d.querySelectorAll('.it').length, 0);
    click($('#wPrev'));
    await until(() => $('#wRng').textContent.startsWith('9/21'));

    // ② 월간
    click($('[data-tab="month"]'));
    await until(() => d.querySelectorAll('#mTable tr.row').length === 29);
    assert.equal($('#mRng').textContent, '2026년 9월');
    assert.match($('#mNote').textContent, /진행 중/);
    const kpi = [...d.querySelectorAll('.kpi')].map((k) => k.querySelector('.l').textContent + '=' + k.querySelector('.v').textContent);
    assert.ok(kpi.includes('수금 합계=19,032') && kpi.includes('지급 합계=10,000'), kpi.join(' | '));
    assert.ok(kpi.some((x) => x.startsWith('어제 잔고') && x.endsWith('=97,124')));
    assert.ok($('#mChart svg polyline'), '잔고 추이 선');
    const r29 = $('#mTable tr.row[data-d="2026-09-29"]');
    assert.ok(/미저장/.test(r29.textContent), '스냅샷 전');
    click(r29);
    await until(() => $('#mTable tr.det'));
    assert.match($('#mTable tr.det').textContent, /Luemi/);
    assert.match($('#mTopIn').textContent, /Luemi/);
    click($('#mRefresh'));
    await until(() => !/미저장/.test($('#mTable tr.row[data-d="2026-09-29"]').textContent));
    assert.equal($('#mNext').disabled, true, '미래 달 이동 불가');

    // ③ WhatsApp — 수신자 관리
    click($('[data-tab="wa"]'));
    await until(() => /수신자가 없습니다/.test($('#rcList').textContent));
    assert.match($('#waStatus').textContent, /미설정/);
    assert.equal($('#sendBtn').disabled, true, '미설정이면 발송 버튼 잠금');
    $('#rcName').value = 'Jang'; $('#rcPhone').value = '123';
    click($('#rcAdd'));
    await until(() => /번호 형식/.test($('#rcMsg').textContent));
    $('#rcPhone').value = '81 1234 5678'; $('#rcLang').value = 'ko';
    click($('#rcAdd'));
    await until(() => $('#rcList tr[data-id]'));
    assert.match($('#rcList').textContent, /521\*\*\*\*5678/);
    const cb = $('#rcList [data-f="get_daily"]');
    cb.checked = false; cb.dispatchEvent(new w.Event('change', { bubbles: true }));
    await until(async () => true);
    await new Promise((r) => setTimeout(r, 300));
    const saved = await one(`SELECT get_daily, lang FROM treasury_wa_recipients WHERE deleted_at IS NULL`);
    assert.equal(saved.get_daily, false); assert.equal(saved.lang, 'ko');
    // 집계 대상 계좌 카드 — 이 시드엔 금고·불공제가 없음 → 전부 자동 포함, 제외로 바꾸면 저장
    await until(() => $('#accList select[data-acc]'));
    const sel = $(`#accList tr[data-id="${usd.id}"] select`);
    sel.value = 'exclude'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    await until(() => /수동 제외/.test($(`#accList tr[data-id="${usd.id}"]`).textContent));
    assert.equal((await one(`SELECT treasury_exclude FROM accounts WHERE id=$1`, [usd.id])).treasury_exclude, true);
    const sel2 = $(`#accList tr[data-id="${usd.id}"] select`);
    sel2.value = 'auto'; sel2.dispatchEvent(new w.Event('change', { bubbles: true }));
    await until(() => /자동 포함/.test($(`#accList tr[data-id="${usd.id}"]`).textContent));
    // 미리보기(월간·한국어)
    $('#pvKind').value = 'monthly'; $('#pvLang').value = 'ko'; $('#pvPeriod').value = '2026-09';
    click($('#pvBtn'));
    await until(() => !$('#pvText').classList.contains('hidden'));
    assert.match($('#pvText').textContent, /월간 자금실적/);
    await until(() => !$('#pvImgWrap').classList.contains('hidden'));
    assert.match($('#pvImg').src, /^data:image\/png;base64,/);
    assert.match($('#pvText').textContent, /2026년 9월/);
    // 삭제
    click($('#rcList [data-act="del"]'));
    await until(() => /수신자가 없습니다/.test($('#rcList').textContent));
    assert.deepEqual(errs, [], '스크립트 오류 없음');
  } finally {
    if (dom) dom.window.close();
    await app.close();
    await q(`DELETE FROM sales_payment_allocations WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE customer_id=$1)`, [cust.id]);
    await q(`DELETE FROM sales_payments WHERE customer_id=$1`, [cust.id]);
    await q(`DELETE FROM transactions WHERE account_id = ANY($1)`, [[mxn.id, usd.id]]);
    await q(`DELETE FROM transactions WHERE sales_invoice_id IN (SELECT id FROM sales_invoices WHERE customer_id=$1)`, [cust.id]);
    await q(`DELETE FROM sales_invoices WHERE customer_id=$1`, [cust.id]);
    await q(`DELETE FROM recurring_rules WHERE id = ANY($1)`, [rules]);
    await q(`DELETE FROM customers WHERE id=$1`, [cust.id]);
    await q(`DELETE FROM treasury_wa_sends; DELETE FROM treasury_wa_recipients; DELETE FROM treasury_daily_snapshots;`);
    await q(`DELETE FROM accounts WHERE id = ANY($1)`, [[mxn.id, usd.id]]);
    await pool.end().catch(() => {});
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  }
});
