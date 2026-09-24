// 견적 화면 — 저장 후 「카탈로그 미등록 코드가 어디에 기록됐는지」 안내 (jsdom, 2026-09-21)
//   운영 HTML 을 그대로 로드하고 fetch 만 스텁한다.
//   실행: node --test test/quote_devreq_front.test.mjs   (jsdom 필요)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const Q_HTML = resolve(here, '..', '..', 'refatrix-quote.html');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* 미설치 → skip */ }
const SKIP = !JSDOM || !existsSync(Q_HTML);
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const SESSION = { token: 'T', api: 'https://api.test', user: { name: '디렉터', role: 'director' } };

function boot(saveResp) {
  const dom = new JSDOM(readFileSync(Q_HTML, 'utf-8'), {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-quote.html',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify(SESSION));
      w.alert = () => {}; w.confirm = () => true; w.prompt = () => '';
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
      w.fetch = async (url, o = {}) => {
        const u = String(url);
        const json = (d) => ({ ok: true, status: 200, json: async () => d });
        if (u.includes('/api/customers')) return json({ items: [{ id: 1, code: 'C001', name: 'REFACCIONARIA NORTE', discount: 30 }] });
        if (u.includes('/api/quotes/resolve-code')) return json({ matches: [], source: 'none' });
        if (u.includes('/api/quotes/preview')) return json({ lines: [
          { matched: false, input_code: 'CQ0988L', qty: 4, stock_flag: 'not_found' }],
          totals: { subtotal: 0, iva: 0, total: 0, totalQty: 0, skuCount: 0 } });
        if (u.endsWith('/api/quotes') && o.method === 'POST') return json(saveResp);
        return json({ items: [] });
      };
    },
  });
  return dom.window;
}

async function saveWith(resp) {
  const w = boot(resp); const d = w.document;
  await tick(250);
  d.getElementById('custSel').value = '1'; w.onCustChange(); await tick(150);
  d.getElementById('inCode').value = 'CQ0988L'; d.getElementById('inQty').value = '4';
  w.addLine(); await tick(250);
  w.saveQuote(); await tick(300);
  const m = d.getElementById('saveMsg');
  const out = { text: m.textContent, cls: m.className, title: d.title };
  w.close();
  return out;
}

test('저장 응답에 미등록 코드가 있으면 기록 위치를 알린다', { skip: SKIP }, async () => {
  const r = await saveWith({ id: 9, quote_no: 'Q-2026-0500', dev_lines: [{ id: 1, code: 'CQ0988L', qty: 4, status: 'received' }] });
  assert.match(r.text, /Q-2026-0500/);
  assert.match(r.text, /Fuera de catálogo: 1 \(CQ0988L\)/, '어느 코드인지');
  assert.match(r.text, /개발 요청/, '어디에 남았는지(메뉴 이름)');
  assert.match(r.cls, /warn/, '눈에 띄게');
  assert.match(r.title, /qt-0924np/, '빌드 토큰');
});

test('미등록 코드가 없으면 안내도 없다 (구 백엔드 응답 호환)', { skip: SKIP }, async () => {
  const r = await saveWith({ id: 10, quote_no: 'Q-2026-0501' });
  assert.doesNotMatch(r.text, /Fuera de catálogo/);
  assert.match(r.cls, /ok/);
});
