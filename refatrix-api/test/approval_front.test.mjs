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
  assert.match(HTML, /<title>[^<]*b20261002eg<\/title>/);
  assert.match(HTML, /refatrix-nav\.js\?v=20260930vr/);
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
    assert.equal(o.d.querySelectorAll('.dright .mstamps td.ms').length, 5, '제목 오른쪽 축소 결재선: 기안·디렉터·사전·집행·사후');
    assert.ok(o.$('.dtop .dleft h1') && o.$('.dtop .dright .mstamps'), '제목과 결재선이 한 줄(dtop)');
    assert.ok(!o.$('[data-act="lineedit"]'), '직원은 결재선 수정 버튼 없음');
    assert.ok(!o.$('[data-act="revise"]') && !o.$('[data-act="addend"]'), '상신한 기안자는 내용 수정·추가 작성 없음');
    assert.ok(o.act('withdraw'), '처리 전 회수 버튼');

    // ② Sebastian(디렉터): 할 일 → 승인(모달) → 사전승인 대기로
    const s = await open('sebastian');
    assert.deepEqual(tabNames(s), ['board', 'compose', 'ceo', 'report', 'settings']);
    await s.until(() => s.$(`.row[data-id="${docId}"]`));
    s.click(s.$(`.row[data-id="${docId}"]`));
    await s.until(() => s.w.eval('DET') && s.act('approve'));
    // 0244: 디렉터(내 차례) — 결재선 수정 · 추가 작성 · 내용 수정
    assert.ok(s.act('lineedit') && s.act('revise') && s.act('addend'));
    s.click(s.act('lineedit'));
    await s.until(() => s.$('#modalCard [data-le="addT"]'));
    assert.equal(s.d.querySelectorAll('#modalCard .le-row.locked').length, 1, '기안만 잠김');
    const at = s.$('[data-le="addT"]'); at.value = 'agree'; at.dispatchEvent(new s.w.Event('change', { bubbles: true }));
    const au = s.$('[data-le="addU"]'); au.value = String(U.christopher.id); au.dispatchEvent(new s.w.Event('change', { bubbles: true }));
    s.click(s.act('leadd'));
    await s.until(() => s.d.querySelectorAll('#modalCard .le-row:not(.locked) [data-le="type"]').length === 3);
    // 합의를 맨 끝(사전승인 뒤)에 두면 서버가 거부 → 위로 옮겨 저장
    s.click(s.act('mok'));
    await s.idle();
    assert.ok(s.w.eval('ui.modal'), '사전승인이 맨 끝이 아니면 저장 거부(모달 유지)');
    s.click(s.$('#modalCard [data-act="leup"][data-i="2"]'));
    await s.until(() => s.$('#modalCard [data-le="type"][data-i="1"]').value === 'agree');
    s.click(s.act('mok'));
    await s.until(() => !s.w.eval('ui.modal') && s.w.eval('DET.lines.some(l=>l.step_type==="agree")'));
    assert.deepEqual(JSON.parse(JSON.stringify(s.w.eval('DET.lines.map(l=>l.step_type)'))), ['draft', 'director', 'agree', 'pre_ceo', 'post_ceo']);
    assert.match(s.$('.tl').textContent, /결재선 수정/);
    // 추가 작성(그림 + 글)
    s.click(s.act('addend'));
    await s.until(() => s.$('#adEd'));
    s.$('#adEd').innerHTML = '디렉터 의견: 부스 위치 확인<img src="data:image/png;base64,iVBORw0KGgo=">';
    s.click(s.act('mok'));
    await s.until(() => s.w.eval('DET.addenda.length') === 1);
    assert.ok(s.$('.addm .rbody img'), '추가 작성 그림 표시'); assert.match(s.$('.addm').textContent, /디렉터 의견/);
    // 내용 수정(제목) → 수정 이력
    s.click(s.act('revise'));
    await s.until(() => s.w.eval('ui.view') === 'compose' && s.$('[data-act="rvcancel"]'));
    assert.ok(!s.$('#lprev'), '수정 모드에는 결재선 미리보기 없음');
    s.type('[data-f="title"]', 'UI 테스트 · 부스 제작 (디렉터 수정)');
    s.type('[data-f="reason"]', '제목 정리');
    s.click(s.act('csave'));
    await s.until(() => s.w.eval('ui.view') === 'detail' && s.w.eval('DET') && s.w.eval('DET.revisions.length') === 1);
    assert.match(s.$('h1').textContent, /디렉터 수정/);
    assert.match(s.$('details.revs').textContent, /제목 정리/);
    s.click(s.act('approve'));
    await s.until(() => s.$('#mMemo'));
    s.$('#mMemo').value = 'UI 승인';
    s.click(s.act('mok'));
    await s.until(() => s.w.eval('DET.lines.find(l=>l.step_type==="agree").status') === 'pending');
    // 합의(Christopher) 처리 → 사전승인 단계로
    const cx = await open('christopher');
    cx.w.eval(`openDoc(${docId})`);
    await cx.until(() => cx.w.eval('DET') && cx.w.eval('DET.doc.id') === docId && cx.act('approve'));
    assert.ok(cx.act('revise') && cx.act('addend'), '현재 차례 합의자도 수정·추가 가능');
    assert.ok(!cx.act('lineedit'), '결재선 수정은 디렉터만');
    cx.click(cx.act('approve')); await cx.until(() => cx.$('#mMemo')); cx.click(cx.act('mok'));
    await cx.until(() => cx.w.eval('DET.doc.stage') === 'pre');
    // 디렉터 작성 화면에는 재무 합의 토글
    s.click(s.$('[data-act="nav"][data-v="compose"]'));
    // 결재 전: 디렉터 작성 화면에서 결재선 직접 지정(내 결재 뒤) — 기본 재무 합의 → 삭제 → 경유 추가 → 재무 다시
    await s.until(() => s.$('#csEd'));
    const lp = () => [...s.d.querySelectorAll('#lprev .lp small')].map((x) => x.textContent);
    assert.deepEqual(lp().slice(0, 3), ['기안', '디렉터 결재', '합의'], '재무 합의가 내 결재 뒤');
    s.click(s.$('#csEd [data-act="csdel"][data-i="0"]'));
    assert.ok(!lp().includes('합의')); assert.ok(s.$('#csEd [data-act="csfin"]'), '재무 합의 빠른 추가 버튼');
    const ct = s.$('#csEd [data-cs="addT"]'); ct.value = 'pass'; ct.dispatchEvent(new s.w.Event('change', { bubbles: true }));
    const cu = s.$('#csEd [data-cs="addU"]'); cu.value = String(U.maria.id); cu.dispatchEvent(new s.w.Event('change', { bubbles: true }));
    s.click(s.$('#csEd [data-act="csadd"]'));
    s.click(s.$('#csEd [data-act="csfin"]'));
    assert.deepEqual(lp().slice(0, 4), ['기안', '디렉터 결재', '경유', '합의']);
    assert.deepEqual(JSON.parse(JSON.stringify(s.w.eval('cdSteps(ui.cd)'))), [{ step_type: 'pass', user_id: U.maria.id }, { step_type: 'agree', user_id: U.christopher.id }]);

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

    // 결재 후(승인완료·집행 전): 디렉터 결재선 수정 창에 단계 추가 + 재결재 경고
    await s.w.eval(`openDoc(${docId})`);
    await s.until(() => s.w.eval('DET') && s.w.eval('DET.doc.id') === docId && s.w.eval('DET.doc.status') === 'approved' && s.act('lineedit'));
    s.click(s.act('lineedit'));
    await s.until(() => s.$('#modalCard [data-le="addT"]'));
    assert.match(s.$('#modalCard').textContent, /다시 결재중/);
    s.click(s.act('mx'));
    await s.until(() => !s.w.eval('ui.modal'));
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

    for (const p of [o, s, j, c, m, cx]) assert.deepEqual(p.errs, [], 'JS 오류 없음');
    await pool.query(`UPDATE approval_settings SET ceo_pre_threshold=100000 WHERE id=1`);
  } finally {
    for (const dom of doms) dom.window.close();
    await app.close();
    await pool.end();
    setTimeout(() => process.exit(process.exitCode || 0), 1500);
  }
});
