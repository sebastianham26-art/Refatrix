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

async function boot({ role = 'director', evil = null } = {}) {
  const calls = [];
  const dom = new JSDOM(readFileSync(HTML, 'utf-8'), {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-products.html#tab=history',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 'T', api: 'https://api.test', user: { name: 'Dir', role } }));
      w.alert = () => {};
      w.fetch = async (url, o = {}) => {
        const u = String(url); calls.push(u);
        const json = (d) => ({ ok: true, status: 200, json: async () => d });
        if (u.includes('/api/pf-catalog/admin/exports')) return json(EXPORTS(evil));
        if (u.includes('/api/products/history')) return json({ can_price: true, total: 0, limit: 50, offset: 0, items: [] });
        return json({ items: [], total: 0 });
      };
    },
  });
  const w = dom.window;
  await new Promise((r) => { if (w.document.readyState === 'complete') r(); else w.addEventListener('load', r); });
  await new Promise((r) => setTimeout(r, 120));
  return { w, d: w.document, calls };
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
  await t.test('③ 이스케이프', async () => {
    const { w, d } = await boot({ evil: '<img src=x onerror="window.__pwned=1">' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(w.__pwned, undefined);
    assert.equal(d.getElementById('pfxBox').querySelectorAll('img').length, 0);
  });
});
