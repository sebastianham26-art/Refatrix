// =====================================================================
// refatrix-consult.html 「📁 휴대폰 녹음파일 올리기」 — 실제 Chromium (2026-11-02)
//   ① 파일을 고르면 3MB 조각으로 seg 0 에 순서대로 보내고 commit 에 source:'file'·파일명을 싣는다
//   ② 변환기 없음 + 25MB 넘는 m4a / amr → 올리기 전에 막고 이유를 보여준다(전송 0)
//   ③ 이미지 등 오디오가 아닌 파일은 막는다
//   ④ 서버 마이그레이션 전(commit 503 migration_required)이면 그 사실을 알린다
//   ⑤ 녹음 카드: 📁 파일명 표시, ffmpeg_missing 오류를 한국어로
//   ⑥ 페이지 오류 0
//   실행: node --test test/consult_file_upload_front.test.mjs   (playwright 없으면 skip)
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
let chromium = null;
try { ({ chromium } = await import('playwright')); } catch (_) {}
const SKIP = !chromium;

let srv, port, browser;
const PAGE_ERRORS = [];
// 로그인 게이트(2026-10-21)를 통과하는 모양의 토큰 — 서명은 보지 않는다
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const TOKEN = 'h.' + b64u({ sub: 1, exp: Math.floor(Date.now() / 1000) + 86400 }) + '.s';

async function startServer() {
  srv = http.createServer((req, res) => {
    const p = join(ROOT, decodeURIComponent(String(req.url).split('?')[0]));
    if (!p.startsWith(ROOT) || !existsSync(p)) { res.writeHead(404); return res.end('nf'); }
    const t = extname(p) === '.js' ? 'text/javascript' : 'text/html';
    res.writeHead(200, { 'Content-Type': t + '; charset=utf-8' });
    res.end(readFileSync(p));
  });
  await new Promise((r) => srv.listen(0, r));
  port = srv.address().port;
}

function router(state) {
  return async (route) => {
    const req = route.request(); const url = req.url(); const method = req.method();
    let body = null; try { body = req.postDataJSON(); } catch (_) {}
    const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
    if (url.includes('/recordings/capabilities')) return json(state.caps);
    if (url.includes('/recordings/parts') && method === 'POST') { state.parts.push(body); return json({ ok: true }); }
    if (url.includes('/recordings/commit')) {
      state.commits.push(body);
      if (state.commitFail) return json({ error: state.commitFail }, 503);
      return json({ id: 9, status: 'queued', source: 'file', stt_ready: true, ai_ready: true, convert_ready: true });
    }
    if (url.includes('/recordings/pending-uploads')) return json({ ttl_hours: 72, items: [] });
    if (/\/api\/consults\/\d+\/recordings/.test(url)) return json({ items: state.recs || [] });
    if (url.includes('/api/portal/summary')) return json({ pages: [], isDirector: true });
    return json({ items: [] });
  };
}

async function openPage(state) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });   // 휴대폰 화면
  const page = await ctx.newPage();
  page.on('pageerror', (e) => PAGE_ERRORS.push(String(e)));
  await page.addInitScript((tok) => {
    const s = JSON.stringify({ token: tok, api: '', user: { id: 1, name: 'Sebastian', role: 'director' } });
    sessionStorage.setItem('refatrix_session', s); localStorage.setItem('refatrix_session', s);
  }, TOKEN);
  await page.route('**/api/**', router(state));
  await page.goto(`http://localhost:${port}/refatrix-consult.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('app').classList.contains('hidden'), { timeout: 15000 });
  await page.evaluate(() => csShowRec(42, 'Refaccionaria Aguila'));
  await page.waitForSelector('#cs-recCard:not(.hidden)');
  return { ctx, page };
}
const msgText = (page) => page.locator('#cs-recMsg').textContent();
const CAPS_OK = { stt_ready: true, ai_ready: true, convert_ready: true, file_max_mb: 200, pass_max_mb: 24 };
const CAPS_NOFF = { ...CAPS_OK, convert_ready: false };

test('boot', { skip: SKIP }, async () => {
  await startServer();
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium' });
});

test('① 7MB m4a → 3조각 seg0 순서대로 · commit 에 source:file · 파일명 · 모드', { skip: SKIP }, async () => {
  const state = { parts: [], commits: [], caps: CAPS_OK };
  const { ctx, page } = await openPage(state);
  assert.ok(await page.locator('#cs-fileBtn').isVisible(), '📁 버튼이 보인다');
  await page.waitForFunction(() => document.getElementById('cs-fileCap').textContent.includes('✅'));
  const buf = Buffer.alloc(7 * 1024 * 1024 + 5, 7);
  await page.setInputFiles('#cs-fileIn', { name: 'Grabación 2026-11-02.m4a', mimeType: 'audio/mp4', buffer: buf });
  await page.waitForFunction(() => document.getElementById('cs-recMsg').textContent.includes('올리기 완료'), { timeout: 20000 });
  assert.deepEqual(state.parts.map((p) => [p.seg_no, p.part_no]), [[0, 0], [0, 1], [0, 2]]);
  assert.equal(new Set(state.parts.map((p) => p.session_key)).size, 1);
  const joined = Buffer.from(state.parts.map((p) => p.b64).join(''), 'base64');
  assert.ok(joined.equals(buf), '조각을 이어붙이면 원본 파일과 바이트 단위로 같다');
  assert.equal(state.commits.length, 1);
  const c = state.commits[0];
  assert.equal(c.source, 'file');
  assert.equal(c.file_name, 'Grabación 2026-11-02.m4a');
  assert.equal(c.mime, 'audio/mp4');
  assert.equal(c.mode, 'full');
  assert.deepEqual(c.segments, [{ parts: 3 }]);
  assert.equal(await page.locator('#cs-fileBtn').isDisabled(), false, '끝나면 버튼이 다시 살아난다');
  await ctx.close();
});

test('② 변환기 없음: 30MB m4a 와 amr 은 올리기 전에 막는다(전송 0)', { skip: SKIP }, async () => {
  const state = { parts: [], commits: [], caps: CAPS_NOFF };
  const { ctx, page } = await openPage(state);
  await page.setInputFiles('#cs-fileIn', { name: 'larga.m4a', mimeType: 'audio/mp4', buffer: Buffer.alloc(30 * 1024 * 1024, 1) });
  await page.waitForFunction(() => document.getElementById('cs-recMsg').textContent.includes('올릴 수 없습니다'));
  assert.match(await msgText(page), /ffmpeg/);
  await page.setInputFiles('#cs-fileIn', { name: 'Call_811.amr', mimeType: '', buffer: Buffer.alloc(2000, 1) });
  await page.waitForFunction(() => document.getElementById('cs-recMsg').textContent.includes('amr'));
  assert.equal(state.parts.length, 0);
  // WhatsApp 오디오(.mp4) 는 변환기 없이 막는다(Whisper 가 Invalid file format 으로 거절 — 2026-11-02 사고)
  await page.setInputFiles('#cs-fileIn', { name: 'WhatsApp Audio 2026-11-02 at 2.39.49 PM.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(5000, 1) });
  await page.waitForFunction(() => document.getElementById('cs-recMsg').textContent.includes('WhatsApp'));
  assert.equal(state.parts.length, 0);
  assert.match(await page.locator('#cs-fileCap').textContent(), /❌ 없음/, '변환기 상태가 버튼 아래 보인다');
  // 같은 조건에서 작은 m4a 는 통과
  await page.setInputFiles('#cs-fileIn', { name: 'corta.m4a', mimeType: '', buffer: Buffer.alloc(1000, 1) });
  await page.waitForFunction(() => document.getElementById('cs-recMsg').textContent.includes('올리기 완료'));
  assert.equal(state.parts.length, 1);
  await ctx.close();
});

test('③ 오디오가 아닌 파일은 막는다', { skip: SKIP }, async () => {
  const state = { parts: [], commits: [], caps: CAPS_OK };
  const { ctx, page } = await openPage(state);
  await page.setInputFiles('#cs-fileIn', { name: 'foto.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(1000, 1) });
  await page.waitForFunction(() => document.getElementById('cs-recMsg').textContent.includes('오디오 녹음 파일이 아닙니다'));
  assert.equal(state.parts.length, 0);
  await ctx.close();
});

test('④ 마이그레이션 전이면 그 사실을 알린다', { skip: SKIP }, async () => {
  const state = { parts: [], commits: [], caps: CAPS_OK, commitFail: 'migration_required' };
  const { ctx, page } = await openPage(state);
  await page.setInputFiles('#cs-fileIn', { name: 'a.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(1000, 1) });
  await page.waitForFunction(() => document.getElementById('cs-recMsg').textContent.includes('마이그레이션'));
  assert.match(await msgText(page), /원본 파일은 휴대폰에 그대로/);
  await ctx.close();
});

test('⑤ 녹음 카드: 📁 파일명 표시 · ffmpeg_missing 을 한국어로', { skip: SKIP }, async () => {
  const state = { parts: [], commits: [], caps: CAPS_OK, recs: [
    { id: 1, mode: 'full', status: 'failed', error: 'ffmpeg_missing: too_big', source: 'file', file_name: 'Voz 003.m4a', attempts: 1 },
    { id: 2, mode: 'memo', status: 'queued', source: 'rec', attempts: 0 },
  ] };
  const { ctx, page } = await openPage(state);
  await page.waitForFunction(() => document.getElementById('cs-recList').textContent.includes('Voz 003.m4a'));
  const t = await page.locator('#cs-recList').textContent();
  assert.ok(t.includes('📁 Voz 003.m4a'));
  assert.ok(t.includes('24MB가 넘는 파일'), t);
  assert.ok(!t.includes('ffmpeg_missing: too_big'), '코드 그대로 노출하지 않는다');
  await ctx.close();
});

test('⑥ 페이지 오류 0', { skip: SKIP }, async () => {
  assert.deepEqual(PAGE_ERRORS, []);
  await browser.close(); srv.close();
});
