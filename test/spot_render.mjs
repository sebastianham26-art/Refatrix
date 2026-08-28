/* SKU 스팟점검 — 실제 Chromium 렌더로 PDA 화면에 다 들어가는지 '재본다'.
   이 화면의 위험은 "값이 틀림"이 아니라 "작업자가 화면에서 못 봄" 이라,
   DOM 단언이 아니라 렌더 후 getBoundingClientRect 로 측정한다.
   Chromium 이 없으면 skip(기본 CI 무영향).

   실행:  node test/spot_render.mjs          (PW_CHROMIUM 로 실행파일 경로 지정 가능) */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.REPO || path.resolve(here, '..');
const OUT = process.env.OUT || '/tmp/spot_shots';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch { console.log('playwright-core 없음 → skip'); process.exit(0); }
const EXE = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
if (!fs.existsSync(EXE)) { console.log('Chromium 없음(' + EXE + ') → skip'); process.exit(0); }

const SESSION = { id: 31, code: 'SP-2026-0001', mode: 'spot', status: 'draft', scope_note: '', started_at: '2026-08-27T10:00:00Z', lines: [] };
// 현장 라벨은 Code-128 `CTR-<제품번호>-<소입수량>`. 서버가 가운데 제품번호로 풀어 준다.
const P5 = { item_kind: 'part', source: 'ctr', product_id: 5, matched_code: 'CE0796', name: 'TERMINAL EXTERIOR IZQ. UNIVERSAL', system_qty: 480, avail_qty: 470, rack_location: 'B-01-01' };
const RESOLVE = {
  CE0796: { ...P5, from_label: false, label_qty: 0 },
  'CTR-CE0796-16': { ...P5, from_label: true, label_qty: 16 },
};

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

async function open({ w, h, lang, pda }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const state = { checks: [], summary: { checks: 0, skus: 0, ok: 0, mismatch: 0, rack_diff: 0 } };
  await page.route('**/*', async (route) => {
    const req = route.request(); const u = req.url();
    if (u.startsWith('https://api.test/')) {
      let body = {};
      if (/\/resolve\?/.test(u)) {
        const q = decodeURIComponent((u.split('code=')[1] || '')).toUpperCase();
        body = RESOLVE[q] || { item_kind: 'unknown', source: 'none' };
      } else if (/\/spot-checks$/.test(u) && req.method() === 'POST') {
        const b = JSON.parse(req.postData() || '{}');
        const r = RESOLVE[String(b.raw_code).toUpperCase()] || {};
        const check = { id: 901, count_id: 31, count_code: 'SP-2026-0001', item_kind: 'part', product_id: 5,
          raw_code: b.raw_code, matched_code: r.matched_code, match_source: r.source, item_name: r.name,
          system_qty: r.system_qty, master_rack: r.rack_location, result: b.result,
          rack_scanned: b.rack_scanned || '', rack_match: b.rack_scanned ? (b.rack_scanned === r.rack_location) : null,
          checked_by_name: 'U', checked_at: '2026-08-27T11:22:00Z' };
        state.checks = [check].concat(state.checks);
        state.summary = { checks: state.checks.length, skus: 1, ok: b.result === 'ok' ? 1 : 0, mismatch: b.result === 'ok' ? 0 : 1, rack_diff: 0 };
        body = { ok: true, check };
      } else if (/\/spot-checks/.test(u)) body = { count_id: 31, code: 'SP-2026-0001', count_status: 'draft', summary: state.summary, checks: state.checks };
      else if (/\/stock-counts\/active/.test(u)) body = { items: [] };
      else if (/\/stock-counts\/\d+$/.test(u)) body = SESSION;
      else if (/\/stock-counts/.test(u)) body = { items: [] };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (/refatrix-nav\.js/.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    if (/cdn\.jsdelivr\.net/.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    return route.continue();
  });
  await page.addInitScript(({ lang, pda }) => {
    sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { id: 9, name: 'U', role: 'warehouse' } }));
    localStorage.setItem('wh_lang', lang);
    if (pda != null) localStorage.setItem('wh_pda', pda); else localStorage.removeItem('wh_pda');
  }, { lang, pda });
  await page.goto('file://' + path.join(REPO, 'refatrix-stockcount.html'));
  await page.waitForSelector('#homeView', { timeout: 5000 });
  await page.evaluate(() => window.openCount(31));
  await page.waitForTimeout(250);
  return { ctx, page };
}
async function scan(page, v) {
  await page.fill('#spInput', v);
  await page.press('#spInput', 'Enter');
  await page.waitForTimeout(280);
}
const box = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; }).catch(() => null);

/* ---- ① PDA 360×640 : 스캔 직후 화면 ---- */
console.log('\n① PDA 360×640 (ES) — 제품 스캔 직후');
{
  const { ctx, page } = await open({ w: 360, h: 640, lang: 'es', pda: '1' });
  await scan(page, 'CTR-CE0796-16');
  const b = await box(page, '#spBox');
  const qty = await box(page, '.spfact.qty');
  const rack = await box(page, '.spfact.rack');
  const acts = await box(page, '#spActs');
  const inp = await box(page, '#spInput');
  ok('★ 시스템 수량이 첫 화면 안', qty && qty.top >= 0 && qty.bottom <= 640, qty);
  ok('★ 위치가 첫 화면 안', rack && rack.top >= 0 && rack.bottom <= 640, rack);
  ok('★ [✖ NO COINCIDE] 버튼이 첫 화면 안', acts && acts.bottom <= 640, acts);
  ok('스캔 입력칸도 첫 화면 안', inp && inp.bottom <= 640, inp);
  ok('결과 박스 전체가 화면 안', b && b.top >= 0 && b.bottom <= 640, b);
  const noH = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok('가로 스크롤 없음', noH);
  await page.screenshot({ path: path.join(OUT, 'pda_360x640_pending.png') });
  // 랙 스캔 → 저장 결과가 남는지
  await scan(page, 'B-01-01');
  const after = await box(page, '#spBox');
  const txt = await page.textContent('#spBox');
  ok('저장 후에도 결과 박스가 화면 안에 남는다', after && after.top >= 0 && after.bottom <= 640, after);
  ok('결과 문구가 보인다', /Registrado OK/.test(txt), txt.slice(0, 80));
  await page.screenshot({ path: path.join(OUT, 'pda_360x640_saved.png') });
  await ctx.close();
}

/* ---- ② 가장 좁은 경우 320×568 ---- */
console.log('\n② PDA 320×568 (가장 좁은 경우)');
{
  const { ctx, page } = await open({ w: 320, h: 568, lang: 'es', pda: '1' });
  await scan(page, 'CTR-CE0796-16');
  const qty = await box(page, '.spfact.qty');
  const acts = await box(page, '#spActs');
  ok('320px 에서도 시스템 수량이 화면 안', qty && qty.top >= 0 && qty.bottom <= 568, qty);
  ok('320px 에서도 [틀림] 버튼이 화면 안', acts && acts.bottom <= 568, acts);
  const noH = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok('가로 스크롤 없음', noH);
  await page.screenshot({ path: path.join(OUT, 'pda_320x568.png') });
  await ctx.close();
}

/* ---- ③ 아래로 스크롤해도 스캔 블록이 붙어 있는지 ---- */
console.log('\n③ 스크롤해도 스캔 블록 고정(.scanstick)');
{
  const { ctx, page } = await open({ w: 360, h: 640, lang: 'es', pda: '1' });
  await scan(page, 'CTR-CE0796-16');
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(150);
  const b = await box(page, '#spBox');
  ok('스크롤 후에도 결과 박스가 화면 안', b && b.bottom <= 640 && b.top < 640, b);
  await page.screenshot({ path: path.join(OUT, 'pda_scrolled.png') });
  await ctx.close();
}

/* ---- ④ 데스크톱 회귀 ---- */
console.log('\n④ 데스크톱 1280×900 (회귀)');
{
  const { ctx, page } = await open({ w: 1280, h: 900, lang: 'ko', pda: null });
  const isPda = await page.evaluate(() => document.body.classList.contains('pda'));
  ok('데스크톱에서는 컴팩트가 아니다', isPda === false);
  await scan(page, 'CTR-CE0796-16');
  const t = await page.textContent('#spBox');
  ok('한국어 라벨', /시스템 수량/.test(t));
  ok('기존 화면 요소 그대로(회귀)', await page.$('#rackInput') !== null && await page.$('#rcTable') !== null);
  await page.screenshot({ path: path.join(OUT, 'desktop_1280.png') });
  await ctx.close();
}

await browser.close();
console.log(`\n결과: ${pass} 통과 / ${fail} 실패   (스크린샷: ${OUT})`);
process.exit(fail ? 1 : 0);
