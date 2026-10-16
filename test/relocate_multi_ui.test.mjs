// 2026-10-16 · 위치변경 화면 × 다중 랙 SKU (rel-1016a) — 운영 HTML 인라인 스크립트를 jsdom 에서 그대로 실행.
//   실행: JSDOM=<jsdom 경로> node test/relocate_multi_ui.test.mjs   (기본: require('jsdom'))
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { JSDOM } = require(process.env.JSDOM || 'jsdom');
const HTML = fs.readFileSync(path.join(here, '..', 'refatrix-relocate.html'), 'utf8')
  .replace(/<script src="refatrix-nav\.js[^"]*"><\/script>/, '');

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n + (e !== undefined ? ' — ' + JSON.stringify(e) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const posts = [];
let saveReply = null;
function boot() {
  const dom = new JSDOM(HTML, {
    url: 'https://refatrix.pages.dev/refatrix-relocate.html', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { role: 'warehouse', name: 'x' } }));
      w.localStorage.setItem('wh_lang', 'ko');
      w.AudioContext = undefined; w.webkitAudioContext = undefined;
      w.fetch = async (url, opt) => {
        const u = String(url);
        let body = {};
        if (u.includes('/api/warehouse/racks')) body = { racks: [
          { rack: 'AE1-1', products: 3, kind: 'carton', kind_set: true },
          { rack: 'AE2-3', products: 1, kind: 'carton', kind_set: true },
          { rack: 'D1-3', products: 1, kind: 'carton', kind_set: true },
          { rack: 'FM-01', products: 0, kind: 'fast', kind_set: true }] };
        else if (u.includes('/relocate/lookup')) body = { product: { id: 7, code: 'CB0011', name: 'BUJE', rack: 'AE1-1', racks: ['AE1-1'],
          rack_kind: 'carton', stock_qty: 46, rack_stock: [{ rack: 'AE1-1', qty: 30 }, { rack: 'AE2-3', qty: 8 }], unassigned: 8 },
          label: { raw: 'CTR-CB0011-4', code: 'CB0011', qty: 4 } };
        else if (u.includes('/rack-moves') && opt && opt.method === 'POST') { posts.push(JSON.parse(opt.body)); body = saveReply; }
        else body = {};
        return { ok: true, status: 200, json: async () => body };
      };
    },
  });
  return dom;
}
async function scan(w, v) {
  const inp = w.document.getElementById('relIn');
  inp.value = v; w.document.getElementById('btnScan').click();
  await sleep(60);
}

{
  const dom = boot(); const w = dom.window; await sleep(150);
  await scan(w, 'CTR-CB0011-4');
  const txt = w.document.getElementById('app').textContent;
  t('제품 스캔 후 「랙별 재고」 줄 표시', /랙별 재고/.test(txt) && /AE1-1/.test(txt) && /AE2-3/.test(txt), txt.slice(0, 400));
  t('위치 미지정 8 표시', /위치 미지정\s*8/.test(txt));

  await scan(w, 'AE2-3');      // 마스터(AE1-1)와 다르지만 랙별 재고에 있는 2번째 랙
  const t2 = w.document.getElementById('app').textContent;
  t('2번째 랙 스캔 → 경고 없이 「기존 위치 확인」', /기존 위치 확인/.test(t2) && !/제품마스터 위치와 다릅니다/.test(t2), t2.slice(0, 500));

  saveReply = { ok: true, moved: [{ id: 1, from_rack: 'AE2-3', rack: { taken: 4, added: 4, short: 0, from_had: 8, others: [] } }] };
  await scan(w, 'FM-01');
  await sleep(80);
  t('3단계 → 자동 저장 · from_rack=AE2-3', posts.length === 1 && posts[0].from_rack === 'AE2-3' && posts[0].to_rack === 'FM-01', posts);
  t('정상 저장 토스트', /이동 저장/.test(w.document.getElementById('toast').textContent));
  dom.window.close();
}
{
  const dom = boot(); const w = dom.window; await sleep(150);
  await scan(w, 'CTR-CB0011-4');
  await scan(w, 'D1-3');       // 이 제품 기록이 없는 랙
  const tx = w.document.getElementById('app').textContent;
  t('기록 없는 랙 → 경고 + 실제 랙 안내', /이 랙에는 이 제품 재고 기록이 없습니다/.test(tx) && /AE1-1 30/.test(tx), tx.slice(0, 500));
  saveReply = { ok: true, moved: [{ id: 2, from_rack: 'D1-3', rack: { taken: 0, added: 4, short: 0, from_had: 0, others: [] } }] };
  posts.length = 0;
  await scan(w, 'FM-01'); await sleep(80);
  t('경고여도 저장은 된다(현장 판단 우선)', posts.length === 1);
  dom.window.close();
}
{
  const dom = boot(); const w = dom.window; await sleep(150);
  await scan(w, 'CTR-CB0011-4');
  await scan(w, 'AE2-3');
  saveReply = { ok: true, moved: [{ id: 3, from_rack: 'AE2-3', rack: { taken: 2, added: 2, short: 2, from_had: 2, others: [{ rack: 'AE1-1', qty: 30 }] } }] };
  await scan(w, 'FM-01'); await sleep(80);
  const tt = w.document.getElementById('toast').textContent;
  t('일부만 반영(short) → 위치수정 안내 토스트', /랙별 재고는/.test(tt) && /2 \/ 4/.test(tt) && /위치수정/.test(tt), tt);
  dom.window.close();
}
{
  const html = fs.readFileSync(path.join(here, '..', 'refatrix-relocate.html'), 'utf8');
  t('빌드 토큰 rel-1016a (title·BUILD)', /build rel-1016a<\/title>/.test(html) && /var BUILD='rel-1016a'/.test(html));
}
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
