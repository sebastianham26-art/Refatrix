// =====================================================================
// refatrix-consult.html 「녹음 복구」 프런트 — 실제 Chromium(진짜 IndexedDB)
//
//   jsdom 에는 IndexedDB 가 없어 이 기능은 실제 브라우저로만 검증할 수 있다.
//   확인하는 것:
//     ① 녹음 조각이 IndexedDB 에 남아 있으면, **새로고침 뒤에도** 「업로드되지 않은 녹음」으로 뜬다
//     ② 거기서 업로드하면 평소 경로(조각 전송 → commit)를 그대로 타고, 끝나면 저장분이 지워진다
//     ③ 업로드 도중 401(세션 만료)이면 화면을 날리지 않고 **그 자리에서 재로그인 → 이어서 업로드**
//     ④ 서버에 남은 조각(pending-uploads)도 목록에 뜨고 [이어서 요약]으로 commit 된다
//     ⑤ 세션 만료가 나도 로그인 저장소를 지우지 않는다(__refatrixKeepSession)
//
//   실행: node --test test/consult_recovery_front.test.mjs      (playwright 없으면 자동 skip)
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
let chromium = null;
try { ({ chromium } = await import('playwright')); } catch (_) { /* 미설치 */ }
const SKIP = !chromium;
if (SKIP) console.log('[skip] playwright 없음 — 브라우저 검증 생략');

let srv, port, browser;
const PAGE_ERRORS = [];

async function startServer() {
  srv = http.createServer((req, res) => {
    const p = join(ROOT, decodeURIComponent(String(req.url).split('?')[0]));
    if (!p.startsWith(ROOT) || !existsSync(p)) { res.writeHead(404); return res.end('nf'); }
    const t = extname(p) === '.js' ? 'text/javascript' : extname(p) === '.css' ? 'text/css' : 'text/html';
    res.writeHead(200, { 'Content-Type': t + '; charset=utf-8' });
    res.end(readFileSync(p));
  });
  await new Promise((r) => srv.listen(0, r));
  port = srv.address().port;
}

// 화면이 부팅하며 부르는 API 들을 모두 받아 준다. calls 에 요청을 기록한다.
function makeRouter(state) {
  return async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    let body = null;
    try { body = req.postDataJSON(); } catch (_) {}
    state.calls.push({ url, method, body });
    const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });

    if (url.includes('/api/login')) return json({ token: 'tok-new', user: { id: 1, name: 'Sebastian', role: 'director' } });
    if (url.includes('/api/auth/refresh')) return json({ token: 'tok-refreshed', user: { id: 1, name: 'Sebastian', role: 'director' } });
    if (url.includes('/recordings/parts') && method === 'POST') {
      state.parts.push(body);
      if (state.failNextPartWith) { const s = state.failNextPartWith; state.failNextPartWith = 0; return json({ error: 'unauthorized' }, s); }
      return json({ ok: true });
    }
    if (url.includes('/recordings/commit')) { state.commits.push(body); return json({ id: 7, status: 'queued', stt_ready: true, ai_ready: true }); }
    if (url.includes('/recordings/pending-uploads')) return json({ ttl_hours: 72, items: state.pending });
    if (url.includes('/recordings')) return json({ items: [] });
    if (url.includes('/api/consults/categories')) return json({ items: [] });
    if (url.includes('/api/consults')) return json({ items: [] });
    if (url.includes('/api/portal/summary')) return json({ pages: [], isDirector: true });
    return json({ items: [] });
  };
}

async function openPage(state) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => PAGE_ERRORS.push(String(e)));
  await page.addInitScript(() => {
    sessionStorage.setItem('refatrix_session', JSON.stringify({
      token: 'tok-old', api: '', user: { id: 1, name: 'Sebastian', role: 'director' } }));
    localStorage.setItem('refatrix_session', JSON.stringify({
      token: 'tok-old', api: '', user: { id: 1, name: 'Sebastian', role: 'director' } }));
  });
  await page.route('**/api/**', makeRouter(state));
  await page.goto(`http://localhost:${port}/refatrix-consult.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('app').classList.contains('hidden'), { timeout: 15000 });
  return { ctx, page };
}

// IndexedDB 에 "업로드되지 않은 녹음" 을 심는다 — 화면 자신의 저장 함수를 그대로 쓴다.
async function seedRecording(page, { key = 'recTEST1', company = 'DANTE', sec = 7320, segs = 2 } = {}) {
  await page.evaluate(async ({ key, company, sec, segs }) => {
    let bytes = 0;
    for (let s = 0; s < segs; s++) {
      for (let i = 0; i < 2; i++) {
        const b = new Blob([new Uint8Array(4096)], { type: 'audio/webm' });
        bytes += b.size;
        await csIdbPutChunk(key, s, s * 2 + i, b);
      }
    }
    await csIdbPutMeta({ key, consult_id: 42, company, mode: 'full', mime: 'audio/webm',
      sec, bytes, segs, status: 'ready', created_at: Date.now(), updated_at: Date.now() });
  }, { key, company, sec, segs });
}

test('boot', { skip: SKIP }, async () => {
  await startServer();
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium' });
});

test('① 새로고침해도 IndexedDB 의 녹음이 「업로드되지 않은 녹음」으로 되살아난다', { skip: SKIP }, async () => {
  const state = { calls: [], parts: [], commits: [], pending: [] };
  const { ctx, page } = await openPage(state);
  await seedRecording(page);
  // 여기서 브라우저를 닫았다 켠 것과 같은 상황 — 메모리는 사라지고 IndexedDB 만 남는다
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('app').classList.contains('hidden'), { timeout: 15000 });
  await page.waitForSelector('#cs-restoreCard:not(.hidden)', { timeout: 10000 });
  const txt = await page.locator('#cs-restoreList').textContent();
  assert.ok(txt.includes('DANTE'), '업체명');
  assert.ok(txt.includes('122:00'), '길이 7,320초 = 122분');
  assert.ok(txt.includes('구간 2'), '구간 수');
  assert.ok(/0\.0MB|MB/.test(txt), '용량');
  await ctx.close();
});

test('② 복구 목록에서 업로드하면 조각 전송 → commit 까지 가고 저장분이 지워진다', { skip: SKIP }, async () => {
  const state = { calls: [], parts: [], commits: [], pending: [] };
  const { ctx, page } = await openPage(state);
  await seedRecording(page, { key: 'recUP', company: 'DANTE', sec: 60, segs: 2 });
  await page.evaluate(() => csRestoreScan());
  await page.waitForSelector('#cs-restoreCard:not(.hidden)');
  await page.locator('#cs-restoreList button', { hasText: '업로드해 요약' }).first().click();
  await page.waitForFunction(() => document.getElementById('cs-recMsg').textContent.indexOf('업로드 완료') >= 0,
    { timeout: 15000 });

  assert.equal(state.parts.length, 2, '구간 2개 = 조각 2개');
  assert.deepEqual(state.parts.map((p) => [p.seg_no, p.part_no]), [[0, 0], [1, 0]]);
  assert.equal(new Set(state.parts.map((p) => p.session_key)).size, 1, '한 업로드 세션 키로 묶인다');
  assert.equal(state.commits.length, 1);
  assert.equal(state.commits[0].mode, 'full');
  assert.equal(state.commits[0].duration_sec, 60);
  assert.deepEqual(state.commits[0].segments, [{ parts: 1 }, { parts: 1 }]);

  const left = await page.evaluate(async () => (await csIdbListMeta()).length);
  assert.equal(left, 0, '업로드가 끝나면 이 기기의 사본은 지운다');
  assert.ok(await page.locator('#cs-restoreCard').evaluate((el) => el.classList.contains('hidden')),
    '복구 카드도 닫힌다');
  await ctx.close();
});

test('③ 업로드 중 세션이 만료되면 그 자리에서 재로그인하고 이어서 올린다', { skip: SKIP }, async () => {
  const state = { calls: [], parts: [], commits: [], pending: [], failNextPartWith: 401 };
  const { ctx, page } = await openPage(state);
  await seedRecording(page, { key: 'rec401', company: 'DANTE', sec: 30, segs: 1 });
  await page.evaluate(() => csRestoreScan());
  await page.waitForSelector('#cs-restoreCard:not(.hidden)');
  await page.locator('#cs-restoreList button', { hasText: '업로드해 요약' }).first().click();

  // 화면이 로그인으로 떨어지지 않고, 녹음 카드 안에서 재로그인을 받는다
  await page.waitForSelector('#cs-raGo', { timeout: 10000 });
  assert.ok((await page.locator('#cs-recMsg').textContent()).includes('녹음은 그대로 있습니다'));
  assert.ok(!(await page.locator('#loginCard').evaluate((el) => !el.classList.contains('hidden'))),
    '전체 화면이 로그인으로 바뀌지 않는다');
  const kept = await page.evaluate(() => !!localStorage.getItem('refatrix_session'));
  assert.ok(kept, '로그인 저장소를 지우지 않는다');

  await page.fill('#cs-raId', 'admin');
  await page.fill('#cs-raPin', '1234');
  await page.click('#cs-raGo');
  await page.waitForFunction(() => document.getElementById('cs-recMsg').textContent.indexOf('업로드 완료') >= 0,
    { timeout: 15000 });
  assert.equal(state.commits.length, 1, '재로그인 뒤 commit 까지 이어진다');
  assert.equal(await page.evaluate(async () => (await csIdbListMeta()).length), 0);
  await ctx.close();
});

test('④ 서버에 남은 조각도 목록에 뜨고 [이어서 요약]이 commit 한다', { skip: SKIP }, async () => {
  const state = { calls: [], parts: [], commits: [], pending: [
    { session_key: 'sess_srv_1', consult_id: 42, company_name: 'DANTE', consult_date: '2026-09-04',
      parts: 9, segments: 2, size_bytes: 12582912, first_at: '2026-09-04 10:00', last_at: '2026-09-04 12:10', hours_left: 61.5 },
  ] };
  const { ctx, page } = await openPage(state);
  await page.waitForSelector('#cs-restoreCard:not(.hidden)', { timeout: 10000 });
  const txt = await page.locator('#cs-restoreList').textContent();
  assert.ok(txt.includes('서버에 올라가다 끊긴 조각') || txt.includes('DANTE'));
  assert.ok(txt.includes('61.5h'), '남은 보관 시간');
  assert.ok(txt.includes('12.0MB'));

  await page.locator('#cs-restoreList button', { hasText: '이어서 요약' }).first().click();
  await page.waitForFunction(() => document.getElementById('cs-restoreMsg').textContent.indexOf('이어붙였습니다') >= 0,
    { timeout: 10000 });
  assert.equal(state.commits.length, 1);
  assert.equal(state.commits[0].session_key, 'sess_srv_1');
  await ctx.close();
});

test('⑤ 남은 보관 시간이 12시간 미만이면 빨갛게 경고한다', { skip: SKIP }, async () => {
  const state = { calls: [], parts: [], commits: [], pending: [
    { session_key: 'sess_srv_2', consult_id: 42, company_name: 'DANTE', consult_date: '2026-09-04',
      parts: 3, segments: 1, size_bytes: 1048576, first_at: '', last_at: '2026-09-04 01:00', hours_left: 4.2 },
  ] };
  const { ctx, page } = await openPage(state);
  await page.waitForSelector('#cs-restoreCard:not(.hidden)', { timeout: 10000 });
  const html = await page.locator('#cs-restoreList').innerHTML();
  assert.ok(/#B23A2E[^>]*>4\.2h|4\.2h/.test(html));
  assert.ok(html.includes('#B23A2E'), '임박하면 빨간색');
  await ctx.close();
});

test('⑥ 복구 목록에서 [🗑] 로 지우면 IndexedDB 에서도 사라진다', { skip: SKIP }, async () => {
  const state = { calls: [], parts: [], commits: [], pending: [] };
  const { ctx, page } = await openPage(state);
  await seedRecording(page, { key: 'recDEL', company: 'DANTE', sec: 30, segs: 1 });
  await page.evaluate(() => csRestoreScan());
  await page.waitForSelector('#cs-restoreCard:not(.hidden)');
  page.on('dialog', (d) => d.accept());
  await page.locator('#cs-restoreList button', { hasText: '🗑' }).first().click();
  await page.waitForFunction(async () => (await csIdbListMeta()).length === 0, { timeout: 10000 });
  await ctx.close();
});

test('⑦ 페이지 오류 0 · 녹음 카드에 [⬇ 녹음파일 저장] 버튼이 있다', { skip: SKIP }, async () => {
  const state = { calls: [], parts: [], commits: [], pending: [] };
  const { ctx, page } = await openPage(state);
  assert.equal(await page.locator('#cs-recSave').count(), 1);
  assert.deepEqual(PAGE_ERRORS, [], '자바스크립트 오류 없음');
  await ctx.close();
});

test('zz 정리', { skip: SKIP }, async () => {
  if (browser) await browser.close();
  if (srv) await new Promise((r) => srv.close(r));
});
