// =====================================================================
// 2026-10-19 · 창고 홈 포장지시 → 창고 도면 피킹 위치 (refatrix-warehouse.html build 1019pm1)
//   ① 포장 대기 카드에 [🗺 도면] — 누르면 refatrix-whmap.html?pick=<견적id> 로 이동, 카드(포장 화면)는 열리지 않음
//   ② 포장 화면(포장지시서) 위 [🗺 도면에서 피킹 위치 보기] — 같은 주소로 이동
//   ③ 스페인어 문구
//   실행: node --test test/warehouse_pickmap_front.test.mjs   (jsdom 필요)
// =====================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
let JSDOM;
try { ({ JSDOM } = await import('jsdom')); } catch { /* skip */ }
const opts = JSDOM ? {} : { skip: 'jsdom 미설치 — skip (npm i -D jsdom)' };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function boot(lang) {
  const calls = [], gone = [];
  const dom = new JSDOM(read('refatrix-warehouse.html'), { runScripts: 'dangerously', url: 'https://example.test/refatrix-warehouse.html',
    beforeParse(win) {
      win.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { name: 'u', role: 'warehouse' } }));
      win.localStorage.setItem('wh_lang', lang);
      win.HTMLMediaElement && (win.HTMLMediaElement.prototype.play = () => Promise.resolve());
      win.AudioContext = undefined; win.webkitAudioContext = undefined;
      win.confirm = () => true; win.alert = () => {};
      win.__whGo = (u) => gone.push(u);
      win.fetch = async (url) => {
        const u = String(url); calls.push(u);
        const json = (o) => ({ ok: true, status: 200, json: async () => o });
        if (/packing-queue$/.test(u)) return json({ count: 1, in_business: false, items: [{ quote_id: 77, quote_no: 'SQ-77', customer: 'Cliente', printed_at: '2026-10-19T15:00:00Z', elapsed_biz_sec: 0, total_qty: 5, packed_qty: 0 }] });
        if (/\/packing\/77\/photos/.test(u)) return json({ photos: [] });
        if (/\/packing\/77$/.test(u)) return json({ quote_id: 77, quote_no: 'SQ-77', customer: 'Cliente', elapsed_biz_sec: 0, required_total: 5, scanned_total: 0, all_done: false, photos_ok: false, boxes: [],
          items: [{ product_id: 1, ctr_code: 'CB0257', syd_code: '', ean: '1', required: 5, scanned: 0, remaining: 5, box_nos: [], rack_location: 'AD2-1 ×5', picks: [{ rack: 'AD2-1', qty: 5, kind: 'carton' }], racks_all: [] }] });
        if (/ship-queue/.test(u)) return json({ items: [] });
        return json({});
      };
    } });
  await new Promise((r) => dom.window.addEventListener('load', r));
  await tick(80);
  return { dom, w: dom.window, $: (id) => dom.window.document.getElementById(id), calls, gone };
}

test('① 카드 [🗺 도면] → 도면 피킹 주소 · 포장 화면은 안 열림', opts, async () => {
  const { w, $, calls, gone } = await boot('ko');
  assert.match(w.document.title, /build 1030kitv/);   // 0306 키트 묶음에서 갱신
  const b = $('queue').querySelector('.qcard[data-id="77"] .qmap');
  assert.ok(b, '카드에 도면 버튼');
  assert.match(b.textContent, /🗺 도면/);
  b.click(); await tick(60);
  assert.deepEqual(gone, ['refatrix-whmap.html?pick=77']);
  assert.ok(!$('panel').classList.contains('on'), '카드 클릭으로 번지지 않음');
  assert.ok(!calls.some((u) => /\/packing\/77$/.test(u)));
  w.close();
});

test('② 포장 화면 [🗺 도면에서 피킹 위치 보기]', opts, async () => {
  const { w, $, gone } = await boot('ko');
  $('queue').querySelector('.qcard[data-id="77"]').click(); await tick(80);
  assert.ok($('panel').classList.contains('on'), '카드 클릭 = 포장지시(포장 화면) 열림');
  assert.match($('mapBtn').textContent, /도면에서 피킹 위치 보기/);
  $('mapBtn').click(); await tick(20);
  assert.deepEqual(gone, ['refatrix-whmap.html?pick=77']);
  w.close();
});

test('③ 스페인어', opts, async () => {
  const { w, $ } = await boot('es');
  await tick(120);
  assert.match($('mapBtn').textContent, /Ver ubicaciones en el mapa/);
  assert.match($('queue').querySelector('.qmap').textContent, /Mapa/);
  w.close();
});
