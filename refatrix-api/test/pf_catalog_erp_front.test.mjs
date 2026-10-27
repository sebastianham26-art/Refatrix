// =====================================================================
// pf_catalog_erp_front.test.mjs — ERP 제품 › 📜 제품 이력 탭의 「🌐 플랫폼 카탈로그 다운로드 기록」 (0302 · 2026-10-27)
//   운영 HTML(refatrix-products.html) 을 그대로 로드하고 fetch 만 스텁.
//   ① 디렉터: 카드 노출 · 자동 조회 · 일시/사용자/건수/조건/GPS 지도 링크/IP 추정 도시
//   ② 디렉터 아님: 카드 숨김 · 조회 안 함   ③ 값은 전부 이스케이프
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = resolve(here, '..', '..', 'refatrix-products.html');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* skip */ }
const SKIP = !JSDOM || !existsSync(HTML);

const EXPORTS = (evil) => ({
  total: 2, limit: 50, offset: 0,
  items: [
    { id: 7, at: '2026-10-27T17:40:00.000Z', user: evil || 'Park CTR', user_key: '12', rows: 1688,
      filters: { q: '', status: 'ok', active: '1' }, gps: { lat: 25.77691, lng: -100.18672, acc: 18 }, gps_status: 'ok',
      ip: '187.190.1.2', city: 'Monterrey', region: 'NLE', country: 'MX', user_agent: 'UA' },
    { id: 6, at: '2026-10-27T16:00:00.000Z', user: 'Lee CTR', user_key: '13', rows: 14021,
      filters: { q: 'NISSAN', status: '', active: 'all' }, gps: null, gps_status: 'unavailable',
      ip: '211.1.1.1', city: 'Seoul', region: '11', country: 'KR', user_agent: 'UA' },
  ],
});

async function boot({ role = 'director', evil = null, sheet = null } = {}) {
  const calls = []; const posts = [];
  const dom = new JSDOM(readFileSync(HTML, 'utf-8'), {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-products.html#tab=history',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 'T', api: 'https://api.test', user: { name: 'Dir', role } }));
      w.alert = () => {}; w.confirm = () => true;
      // 엑셀 도구 흉내 — 첫 시트를 행 배열로
      w.XLSX = { read: () => ({ SheetNames: ['S'], Sheets: { S: {} } }), utils: { sheet_to_json: () => sheet || [] } };
      w.fetch = async (url, o = {}) => {
        const u = String(url); calls.push(u);
        const json = (d) => ({ ok: true, status: 200, json: async () => d });
        if (u.includes('/api/pf-catalog/admin/mark-reviewed')) { posts.push(JSON.parse(o.body)); return json({ batch_id: 3, codes_in: 3, marked: 2, already: 1, skipped_draft: [], missing: ['ZZ9'] }); }
        if (u.includes('/api/pf-catalog/admin/bulk')) return json({ items: posts.length ? [{ id: 3, at: '2026-10-27T20:00:00Z', by: 'Dir', file: 'rev.xlsx', codes_in: 3, marked: 2, already: 1, skipped_draft: [], missing: ['ZZ9'] }] : [] });
        if (u.includes('/api/pf-catalog/admin/exports')) return json(EXPORTS(evil));
        if (u.includes('/api/products/history')) return json({ can_price: true, total: 0, limit: 50, offset: 0, items: [] });
        return json({ items: [], total: 0 });
      };
    },
  });
  const w = dom.window;
  await new Promise((r) => { if (w.document.readyState === 'complete') r(); else w.addEventListener('load', r); });
  await new Promise((r) => setTimeout(r, 120));
  return { w, d: w.document, calls, posts };
}

test('플랫폼 다운로드 기록 카드 — jsdom', { skip: SKIP && 'jsdom 없음' }, async (t) => {
  await t.test('① 디렉터 — 노출 · 자동 조회 · 내용', async () => {
    const { d, calls } = await boot();
    assert.ok(!d.getElementById('pfxCard').classList.contains('hidden'));
    assert.ok(calls.some((u) => u.includes('/api/pf-catalog/admin/exports')));
    const txt = d.getElementById('pfxBox').textContent;
    assert.match(txt, /전체 2건/); assert.match(txt, /Park CTR/); assert.match(txt, /1,688/);
    assert.match(txt, /확인완료 · 판매중만/); assert.match(txt, /전체 · 검색 「NISSAN」/);
    assert.match(txt, /25\.77691, -100\.18672/); assert.match(txt, /±18m/);
    assert.match(txt, /GPS 없음/); assert.match(txt, /IP 추정: Seoul, 11, KR/);
    const a = d.getElementById('pfxBox').querySelector('a');
    assert.equal(a.getAttribute('href'), 'https://www.google.com/maps?q=25.77691,-100.18672');
    assert.equal(a.getAttribute('target'), '_blank');
  });
  await t.test('② 디렉터 아님 — 숨김 · 조회 안 함', async () => {
    const { d, calls } = await boot({ role: 'sales' });
    assert.ok(d.getElementById('pfxCard').classList.contains('hidden'));
    assert.ok(!calls.some((u) => u.includes('/api/pf-catalog/admin/exports')));
  });
  await t.test('④ CTR 코드 엑셀 → 일괄 검토완료', async () => {
    const { w, d, posts } = await boot({ sheet: [['Clave CTR', 'Producto'], ['ca0011', 'x'], [' CB0318 ', 'y'], ['CA0011', 'dup'], ['', ''], ['ZZ9', 'z']] });
    assert.ok(!d.getElementById('pfbCard').classList.contains('hidden'), '디렉터에게 보임');
    const inp = d.getElementById('pfbFile');
    Object.defineProperty(inp, 'files', { configurable: true, value: [{ name: 'rev.xlsx', arrayBuffer: async () => new ArrayBuffer(4) }] });
    inp.dispatchEvent(new w.Event('change'));
    await new Promise((r) => setTimeout(r, 30));
    assert.match(d.getElementById('pfbPrev').textContent, /「Clave CTR」 열에서 코드 3개/);
    assert.equal(d.getElementById('pfbGo').disabled, false);
    d.getElementById('pfbGo').click();
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(posts[0], { codes: ['CA0011', 'CB0318', 'ZZ9'], file_name: 'rev.xlsx' });
    assert.match(d.getElementById('pfbMsg').textContent, /검토완료 2건 · 이미 확인·검토완료 1건 · 수정안 있어 건너뜀 0건 · ERP에 없는 코드 1건/);
    assert.match(d.getElementById('pfbList').textContent, /rev\.xlsx/);
  });
  await t.test('④-2 머리글 없는 첫 열', async () => {
    const { w, d, posts } = await boot({ sheet: [['CA0011'], ['CB0318']] });
    const inp = d.getElementById('pfbFile');
    Object.defineProperty(inp, 'files', { configurable: true, value: [{ name: 'a.xlsx', arrayBuffer: async () => new ArrayBuffer(4) }] });
    inp.dispatchEvent(new w.Event('change')); await new Promise((r) => setTimeout(r, 30));
    assert.match(d.getElementById('pfbPrev').textContent, /머리글 없음.*코드 2개/);
    d.getElementById('pfbGo').click(); await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(posts[0].codes, ['CA0011', 'CB0318']);
  });
  await t.test('④-3 디렉터 아님 — 일괄 카드 숨김', async () => {
    const { d } = await boot({ role: 'sales' });
    assert.ok(d.getElementById('pfbCard').classList.contains('hidden'));
  });
  await t.test('③ 이스케이프', async () => {
    const { w, d } = await boot({ evil: '<img src=x onerror="window.__pwned=1">' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(w.__pwned, undefined);
    assert.equal(d.getElementById('pfxBox').querySelectorAll('img').length, 0);
  });
});
