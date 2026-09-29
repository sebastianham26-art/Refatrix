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
  assert.match(HTML, /<title>[^<]*b20260929ea<\/title>/);
  assert.match(HTML, /refatrix-nav\.js\?v=20260929ea/);
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
    o.type('[data-f="planned_sub"]', '90000');
    assert.equal(o.$('#cTot').textContent, '$104,400.00');
    assert.match(o.$('#ceoNote').textContent, /사전승인 포함/);
    o.type('[data-f="planned_sub"]', '80000');
    assert.match(o.$('#ceoNote').textContent, /사전승인 없음/);
    o.type('[data-f="planned_sub"]', '90000');
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

    for (const p of [o, s, j, c]) assert.deepEqual(p.errs, [], 'JS 오류 없음');
    await pool.query(`UPDATE approval_settings SET ceo_pre_threshold=100000 WHERE id=1`);
  } finally {
    for (const dom of doms) dom.window.close();
    await app.close();
    await pool.end();
    setTimeout(() => process.exit(process.exitCode || 0), 1500);
  }
});
