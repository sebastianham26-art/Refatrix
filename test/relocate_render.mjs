/* 위치변경 화면 — 실제 Chromium 렌더로 PDA 화면에 스캔 블록이 들어가는지 '재본다'.
   이 화면의 위험은 "값이 틀림"이 아니라 "화면에 안 들어감" 이라, DOM 단언이 아니라
   렌더 후 getBoundingClientRect 로 측정한다. Chromium 이 없으면 skip(기본 CI 무영향).

   실행:  node test/relocate_render.mjs          (PW_CHROMIUM 로 실행파일 경로 지정 가능) */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.REPO || path.resolve(here, '..');
const OUT = process.env.OUT || '/tmp/relocate_shots';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch { console.log('playwright-core 없음 → skip'); process.exit(0); }

const EXE = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
if (!fs.existsSync(EXE)) { console.log('Chromium 없음(' + EXE + ') → skip'); process.exit(0); }

const RACKS = [
  { rack: 'B-01-01', products: 12, group: 'B', kind: 'carton', kind_set: true, zone: 2 },
  { rack: 'B-01-02', products: 3, group: 'B', kind: 'carton', kind_set: false, zone: 2 },
  { rack: 'FM-01', products: 0, group: 'FM', kind: 'fast', kind_set: true, zone: null },
];
const LOOKUP = { product: { id: 5, code: 'CE0796', name: 'TERMINAL EXTERIOR', rack: 'B-01-01', rack_kind: 'carton', stock_qty: 480 },
  label: { raw: 'CTR-CE0796-16', code: 'CE0796', qty: 16, prefix: 'CTR' } };

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

async function open({ w, h, lang, pda }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.route('**/*', async (route) => {
    const u = route.request().url();
    if (u.startsWith('https://api.test/')) {
      let body = {};
      if (/\/warehouse\/racks/.test(u)) body = { racks: RACKS, default_kind: 'carton', totals: { racks: 3, fast: 1, carton: 2, unset: 1 } };
      else if (/relocate\/lookup/.test(u)) body = LOOKUP;
      else if (/rack-moves/.test(u)) body = { moves: [], count: 0, ok: true, moved: [{ id: 1 }], totals: { lines: 1, cartons: 1, qty_ea: 16, master_updated: 1 } };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (/refatrix-nav\.js/.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    return route.continue();
  });
  await page.addInitScript(({ lang, pda }) => {
    sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { id: 9, name: 'U', role: 'warehouse' } }));
    localStorage.setItem('wh_lang', lang);
    if (pda != null) localStorage.setItem('wh_pda', pda);
  }, { lang, pda });
  await page.goto('file://' + path.join(REPO, 'refatrix-relocate.html'));
  await page.waitForSelector('#relIn', { timeout: 5000 });
  return { ctx, page };
}
async function scan(page, v) {
  await page.fill('#relIn', v);
  await page.press('#relIn', 'Enter');
  await page.waitForTimeout(250);
}
const box = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: r.height }; }).catch(() => null);

/* ---- PDA 360×640 (현장 스캐너) ---- */
console.log('\n① PDA 360×640 (ES)');
{
  const { ctx, page } = await open({ w: 360, h: 640, lang: 'es', pda: '1' });
  await scan(page, 'CTR-CE0796-16');
  await scan(page, 'B-01-01');
  const res = await box(page, '.scanbox');
  const inp = await box(page, '#relIn');
  const steps = await box(page, '.steps');
  ok('스캔 결과 박스가 화면 안에 온전히 보인다', res && res.top >= 0 && res.bottom <= 640, res);
  ok('입력칸도 첫 화면에 들어온다', inp && inp.bottom <= 640, inp);
  ok('3단계 표시가 화면 상단에', steps && steps.top >= 0 && steps.bottom < 200, steps);
  const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok('가로 스크롤 없음', noHScroll);
  await page.screenshot({ path: path.join(OUT, 'pda_360x640_es.png'), fullPage: false });
  await ctx.close();
}

console.log('\n② PDA 320×568 (가장 좁은 경우)');
{
  const { ctx, page } = await open({ w: 320, h: 568, lang: 'es', pda: '1' });
  await scan(page, 'CTR-CE0796-16');
  await scan(page, 'B-01-01');
  const res = await box(page, '.scanbox');
  ok('320px 에서도 결과 박스가 화면 안', res && res.top >= 0 && res.bottom <= 568, res);
  const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok('가로 스크롤 없음', noHScroll);
  await page.screenshot({ path: path.join(OUT, 'pda_320x568_es.png') });
  await ctx.close();
}

console.log('\n③ 데스크톱 1280×900 (회귀)');
{
  const { ctx, page } = await open({ w: 1280, h: 900, lang: 'ko', pda: null });
  const isPda = await page.evaluate(() => document.body.classList.contains('pda'));
  ok('데스크톱에서는 컴팩트가 아니다', isPda === false);
  await scan(page, 'CTR-CE0796-16');
  await scan(page, 'B-01-01');
  await scan(page, 'FM-01');
  await page.waitForTimeout(300);
  ok('저장 후 이번 작업 목록이 보인다', (await page.textContent('body')).includes('이번 작업에서 저장한 이동'));
  await page.screenshot({ path: path.join(OUT, 'desktop_1280.png'), fullPage: false });
  await ctx.close();
}

console.log('\n④ 랙 유형 탭 렌더');
{
  const { ctx, page } = await open({ w: 1280, h: 900, lang: 'ko', pda: null });
  await page.click('.tab[data-t="kinds"]');
  await page.waitForTimeout(200);
  ok('랙 유형 표가 그려진다', (await page.$$('select.ksel')).length === 3);
  await page.screenshot({ path: path.join(OUT, 'kinds_1280.png'), fullPage: false });
  await ctx.close();
}

await browser.close();
console.log('\n스크린샷: ' + OUT);
console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
