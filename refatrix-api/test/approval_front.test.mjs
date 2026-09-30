// 전자결재 화면(refatrix-approval.html) — jsdom 으로 실제 API(PostgreSQL) 에 붙여 돌리는 UI 행동 테스트
//
//   실행: TEST_PG_URL=postgres://... node --test test/approval_front.test.mjs
//   (사전 조건: approval.test.mjs 와 같음 — 0234 migrate, login_id sebastian/christopher/jang/maria/oscar/jose/luis)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const HTML = readFileSync(join(REPO, 'refatrix-approval.html'), 'utf8');
const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

test('F0 정적 — 인라인 핸들러 없음 · 빌드 토큰 · nav 토큰', () => {
  assert.doesNotMatch(HTML, /\son(click|change|input|submit)=/i, 'addEventListener 만 사용');
  assert.match(HTML, /<title>[^<]*b20260929ec<\/title>/);
  assert.match(HTML, /refatrix-nav\.js\?v=20260930td/);
});

test('F1 화면 흐름 — 작성·상신 → 결재 → 집행 → 대표이사 결재함 → 설정 → 리포트', { skip: !PG }, async () => {
  const { JSDOM } = await import('jsdom');
  const { buildApp } = await import('../src/server.js');
  const { pool } = await import('../src/db.js');
  const app = buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const API = `http://127.0.0.1:${app.server.address().port}`;
  const U = {};
  for (const r of (await pool.query(`SELECT id, login_id, role FROM users WHERE login_id = ANY($1)`,
    [['sebastian', 'christopher', 'jang', 'maria', 'oscar', 'jose', 'luis']])).rows) U[r.login_id] = { id: Number(r.id), tok: app.jwt.sign({ sub: Number(r.id), role: r.role }) };
  const doms = [];
  const open = async (who) => {
    const dom = new JSDOM(HTML, {
      runScripts: 'dangerously', url: 'https://erp.test/refatrix-approval.html', pretendToBeVisual: true,
      beforeParse(w) {
        w.fetch = (u, o) => fetch(u, o);
        w.scrollTo = () => {};
        w.open = () => null;
        w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: U[who].tok, api: API, user: { id: U[who].id } }));
      },
    });
    doms.push(dom);
    const w = dom.window, d = w.document;
    const errs = []; w.addEventListener('error', (e) => errs.push(e.message));
    const $ = (s) => d.querySelector(s);
    const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return; } catch { /* 아직 */ } await new Promise((r) => setTimeout(r, 25)); } throw new Error('timeout: ' + fn.toString().slice(0, 120)); };
    const click = (el) => { assert.ok(el, 'element'); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };
    const type = (sel, v) => { const el = $(sel); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
    const act = (a, extra = '') => $(`[data-act="${a}"]${extra}`);
    const idle = () => until(() => !w.eval('ui.busy'));
    await until(() => $('#tabs') && !$('#tabs').classList.contains('hidden'));
    return { w, d, $, until, click, type, act, idle, errs };
  };
  const tabNames = (p) => [...p.d.querySelectorAll('#tabs .tab')].map((b) => b.dataset.v);

  try {
    await pool.query(`UPDATE approval_settings SET ceo_pre_threshold=100000, threshold_basis='total', ceo_user_id=$1, director_user_id=$2, finance_user_id=$3 WHERE id=1`,
      [U.jang.id, U.sebastian.id, U.christopher.id]);

    // ① Oscar(영업): 탭 = 게시판·작성, 작성 → 기준액 이상이면 사전승인 미리보기 → 파일 첨부 → 상신
    const o = await open('oscar');
    assert.deepEqual(tabNames(o), ['board', 'compose']);
    o.click(o.$('[data-act="nav"][data-v="compose"]'));
    await o.until(() => o.$('#lprev'));
    const catSel = o.$('[data-f="category_id"]');
    catSel.value = catSel.options[2].value; catSel.dispatchEvent(new o.w.Event('input', { bubbles: true }));
    o.type('[data-f="title"]', 'UI 테스트 · 부스 제작');
    o.type('[data-f="orig_sub"]', '90000');
    assert.equal(o.$('#cTot').textContent, '$104,400.00');
    assert.match(o.$('#ceoNote').textContent, /사전승인 포함/);
    o.type('[data-f="orig_sub"]', '80000');
    assert.match(o.$('#ceoNote').textContent, /사전승인 없음/);
    o.type('[data-f="orig_sub"]', '90000');
    o.w.eval(`ui.cd.newFiles.push({file:new File(['%PDF-1.4 ui ' + Date.now()],'cotizacion_stand.pdf',{type:'application/pdf'}),name:'cotizacion_stand.pdf',size:30,kind:'견적서'})`);
    o.click(o.act('csubmit'));
    await o.until(() => o.w.eval('ui.view') === 'detail' && o.w.eval('DET') && o.w.eval('DET.doc.doc_no'));
    const docId = o.w.eval('DET.doc.id');
    assert.equal(o.w.eval('DET.files.length'), 1);
    assert.equal(o.d.querySelectorAll('.stp').length, 5, '기안·디렉터·사전·집행·사후');
    assert.ok(o.act('withdraw'), '처리 전 회수 버튼');

    // ② Sebastian(디렉터): 할 일 → 승인(모달) → 사전승인 대기로
    const s = await open('sebastian');
    assert.deepEqual(tabNames(s), ['board', 'compose', 'ceo', 'report', 'settings']);
    await s.until(() => s.$(`.row[data-id="${docId}"]`));
    s.click(s.$(`.row[data-id="${docId}"]`));
    await s.until(() => s.w.eval('DET') && s.act('approve'));
    s.click(s.act('approve'));
    await s.until(() => s.$('#mMemo'));
    s.$('#mMemo').value = 'UI 승인';
    s.click(s.act('mok'));
    await s.until(() => s.w.eval('DET.doc.stage') === 'pre');
    // 디렉터 작성 화면에는 재무 합의 토글
    s.click(s.$('[data-act="nav"][data-v="compose"]'));
    await s.until(() => s.$('#finTog'));
    assert.match(s.$('#lprev').textContent, /합의/);
    s.click(s.$('#finTog'));
    assert.doesNotMatch(s.$('#lprev').textContent, /합의/);

    // ③ Jang(대표이사): 결재함 → 사전승인
    const j = await open('jang');
    assert.ok(tabNames(j).includes('ceo'));
    j.click(j.$('[data-act="nav"][data-v="ceo"]'));
    await j.until(() => j.$(`[data-act="approve"][data-id="${docId}"]`));
    j.click(j.$(`[data-act="approve"][data-id="${docId}"]`));
    await j.until(() => j.$('#mMemo'));
    assert.match(j.$('#modalCard h2').textContent, /사전승인/);
    j.click(j.act('mok'));
    await j.until(() => !j.$(`[data-act="approve"][data-id="${docId}"]`));

    // ④ Christopher(재무): 집행 — 증빙 없으면 막힘 → 송금증 첨부 후 집행
    const c = await open('christopher');
    assert.deepEqual(tabNames(c), ['board', 'compose', 'report']);
    c.w.eval(`openDoc(${docId})`);
    await c.until(() => c.w.eval('DET') && c.act('exec'));
    c.click(c.act('exec'));
    await c.until(() => c.$('#mAmt'));
    c.$('#mAmt').value = '110000';
    c.click(c.act('mok'));
    await c.idle();
    assert.equal(c.w.eval('DET.doc.exec_status'), 'pending', '증빙 없이 집행 불가');
    c.w.eval(`ui.mFiles.push({file:new File(['SPEI ' + Date.now()],'comprobante_spei.pdf',{type:'application/pdf'}),name:'comprobante_spei.pdf',size:20,kind:'송금증'})`);
    c.click(c.act('mok'));
    await c.until(() => c.w.eval('DET.doc.exec_status') === 'done');
    assert.equal(c.w.eval('DET.doc.post_status'), 'pending');
    assert.match(c.$('#app').textContent, /실적이 예정보다 5\.4% 많습니다|실적 합계/);

    // ⑤ Jang: 사후승인 일괄 확인
    await j.w.eval('reload()');
    await j.until(() => j.$(`[data-act="psel"][data-id="${docId}"]`));
    j.click(j.$(`[data-act="psel"][data-id="${docId}"]`));
    await j.until(() => !j.$('[data-act="bulk"]').disabled);
    j.click(j.act('bulk'));
    await j.until(() => j.$('#modalCard h2') && /일괄/.test(j.$('#modalCard h2').textContent));
    j.click(j.act('mok'));
    await j.until(() => !j.$(`[data-act="psel"][data-id="${docId}"]`));
    const st = (await pool.query(`SELECT post_status FROM approval_documents WHERE id=$1`, [docId])).rows[0].post_status;
    assert.equal(st, 'confirmed');

    // ⑥ Oscar: 댓글 등록 → 타임라인 표시(일시 포함)
    await o.w.eval(`openDoc(${docId})`);
    await o.until(() => o.$('#cmtBody'));
    o.$('#cmtBody').value = 'UI 댓글';
    o.click(o.act('cpost'));
    await o.until(() => [...o.d.querySelectorAll('.tl .tx')].some((x) => x.textContent === 'UI 댓글'));
    assert.ok(o.d.querySelector('.tl time[title*="한국"]'), '일시 + 한국시간 툴팁');
    assert.equal(o.d.querySelectorAll('[data-act="cedit"]').length, 0, '직원은 댓글 수정 버튼 없음');

    // ⑦ Sebastian: 설정 저장(기준액) · 리포트
    s.click(s.$('[data-act="nav"][data-v="settings"]'));
    await s.until(() => s.$('#sThr'));
    s.$('#sThr').value = '120000';
    s.click(s.act('ssave'));
    await s.until(() => s.w.eval('B.settings.ceo_pre_threshold') === 120000);
    assert.match(s.$('#app').textContent, /\$120,000\.00/);
    s.click(s.$('[data-act="nav"][data-v="report"]'));
    await s.until(() => s.$('.tbl tbody tr') && s.w.eval('REP'));
    assert.match(s.$('#app').textContent, /완결성 점검/);

    // ⑧ 0237 — USD 환산 미리보기 · 정기 지급 일정 · 분할 합계 · 본문 그림 · 회차 집행
    const today = new Date().toISOString().slice(0, 10);
    await pool.query(`INSERT INTO fx_rates(rate_date, base, quote, rate, source) VALUES ($1,'USD','MXN',18.5,'test')
      ON CONFLICT (rate_date, base, quote) DO UPDATE SET rate=18.5, source='test'`, [today]);
    const m = await open('maria');
    m.click(m.$('[data-act="nav"][data-v="compose"]'));
    await m.until(() => m.$('#lprev'));
    const cs = m.$('[data-f="category_id"]'); cs.value = cs.options[1].value; cs.dispatchEvent(new m.w.Event('input', { bubbles: true }));
    m.type('[data-f="title"]', 'UI USD 정기');
    m.click(m.$('[data-act="ccur"][data-v="USD"]'));
    await m.until(() => /18\.5/.test(m.$('#cFx').textContent));
    m.click(m.$('[data-act="cpt"][data-v="recurring"]'));
    await m.until(() => m.$('[data-pl="per_sub"]'));
    m.$('[data-pl="start"]').value = '2026-10-05'; m.$('[data-pl="start"]').dispatchEvent(new m.w.Event('input', { bubbles: true }));
    m.$('[data-pl="count"]').value = '4'; m.$('[data-pl="count"]').dispatchEvent(new m.w.Event('input', { bubbles: true }));
    m.type('[data-pl="per_sub"]', '1000');
    assert.equal(m.$('#cTot').textContent, 'US$4,640.00');
    assert.match(m.$('#cFx').textContent, /\$85,840\.00 MXN/);
    assert.equal(m.d.querySelectorAll('#cSchedPrev .pc').length, 4);
    assert.match(m.$('#cSchedPrev').textContent, /2026-10-26/);
    // 본문: 텍스트 + 그림 노드 → 직렬화
    const ed = m.$('#bodyEd');
    ed.innerHTML = '주간 경비<br>4주<div>둘째 줄</div><img src="data:image/png;base64,iVBORw0KGgo=" data-w="8" data-h="8"><img src="javascript:alert(1)">';
    const nodes = m.w.eval('serializeEd(document.getElementById("bodyEd"))');
    assert.deepEqual(JSON.parse(JSON.stringify(nodes)), [{ t: 'p', v: '주간 경비\n4주\n둘째 줄' }, { t: 'img', src: 'data:image/png;base64,iVBORw0KGgo=', w: 8, h: 8 }], '위험한 그림 주소는 버림');
    m.click(m.act('csubmit'));
    await m.until(() => m.w.eval('ui.view') === 'detail' && m.w.eval('DET') && m.w.eval('DET.doc.doc_no'));
    const usdId = m.w.eval('DET.doc.id');
    assert.equal(m.w.eval('DET.doc.fx_rate'), 18.5); assert.equal(m.w.eval('DET.payments.length'), 4);
    assert.ok(m.$('.rbody img'), '본문 그림 표시'); assert.match(m.$('.rbody').textContent, /둘째 줄/);
    assert.match(m.$('#app').textContent, /18\.5 .*상신 때 고정/);
    // 인쇄(A4 1장 시트): 결재 도장 · 정보 · 지급 일정 · 본문 그림 · 증빙 · 이력 · 출력자
    let printed = 0; m.w.print = () => { printed++; };
    m.click(m.act('print'));
    await m.until(() => printed === 1);
    const ps = m.$('#printSheet');
    assert.ok(ps && ps.parentElement === m.d.body, '인쇄 시트는 body 바로 아래(인쇄 CSS 대상)');
    assert.match(ps.textContent, new RegExp(m.w.eval('DET.doc.doc_no')));
    assert.match(ps.textContent, /지급 일정 · 정기 지급 · 매주 4회/);
    assert.equal(ps.querySelectorAll('.pst-c').length, m.w.eval('DET.lines.length') + 1, '결재선 + 집행 칸');
    assert.equal(ps.querySelectorAll('.pimgs img').length, 1);
    assert.match(ps.textContent, /결재 의견 · 이력/); assert.match(ps.textContent, /출력 .*Maria/);
    assert.match(ps.textContent, /US\$5,104\.00|US\$4,640\.00/);
    assert.ok(!ps.classList.contains('measuring'), '측정 끝나면 화면용 표시 해제');
    m.click(m.act('print'));
    await m.until(() => printed === 2);
    assert.equal(m.d.querySelectorAll('#printSheet').length, 1, '다시 인쇄해도 시트는 하나');
    // 분할: 합계가 안 맞으면 저장 막힘 → 선급 30% + 잔금 버튼으로 맞춤
    m.click(m.$('[data-act="nav"][data-v="compose"]'));
    await m.until(() => m.$('#lprev'));
    m.click(m.$('[data-act="cpt"][data-v="installment"]'));
    await m.until(() => m.$('#cSched'));
    m.type('[data-f="orig_sub"]', '1000');
    m.type('[data-f="title"]', 'UI 분할');
    m.$('[data-sc="amount"][data-i="0"]').value = '100'; m.$('[data-sc="amount"][data-i="0"]').dispatchEvent(new m.w.Event('input', { bubbles: true }));
    assert.match(m.$('#cSchedSum').textContent, /차이/);
    m.click(m.act('scadv'));
    assert.match(m.$('#cSchedSum').textContent, /일치/);
    assert.equal(m.$('[data-sc="amount"][data-i="0"]').value, '348');
    // 디렉터 승인 → 재무: 회차별 집행 버튼 · 1회차 집행
    await s.w.eval(`openDoc(${usdId})`);
    await s.until(() => s.w.eval('DET') && s.w.eval('DET.doc.id') === usdId && s.act('approve'));
    s.click(s.act('approve')); await s.until(() => s.$('#mMemo')); s.click(s.act('mok'));
    await s.until(() => s.w.eval('DET.doc.status') === 'approved');
    await c.w.eval(`openDoc(${usdId})`);
    await c.until(() => c.w.eval('DET') && c.w.eval('DET.doc.id') === usdId && c.d.querySelectorAll('[data-act="exec"][data-pid]').length === 4);
    c.click(c.d.querySelector('[data-act="exec"][data-pid]'));
    await c.until(() => c.$('#mAmt'));
    assert.match(c.$('#modalCard h2').textContent, /1\/4회차/);
    assert.equal(c.$('#mAmt').value, '1160');
    c.w.eval(`ui.mFiles.push({file:new File(['SPEI w1 ' + Date.now()],'spei_w1.pdf',{type:'application/pdf'}),name:'spei_w1.pdf',size:12,kind:'송금증'})`);
    c.click(c.act('mok'));
    await c.until(() => c.w.eval('DET.payments[0].status') === 'done');
    assert.equal(c.w.eval('DET.payments[0].actual_mxn'), 21460);
    assert.equal(c.w.eval('DET.doc.exec_status'), 'pending', '남은 회차 있음');
    assert.equal(c.d.querySelectorAll('[data-act="exec"][data-pid]').length, 3);

    for (const p of [o, s, j, c, m]) assert.deepEqual(p.errs, [], 'JS 오류 없음');
    await pool.query(`UPDATE approval_settings SET ceo_pre_threshold=100000 WHERE id=1`);
  } finally {
    for (const dom of doms) dom.window.close();
    await app.close();
    await pool.end();
    setTimeout(() => process.exit(process.exitCode || 0), 1500);
  }
});
