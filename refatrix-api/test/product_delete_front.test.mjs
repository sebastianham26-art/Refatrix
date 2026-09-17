// =====================================================================
// 제품 영구 삭제 UI (refatrix-products.html, build pd-0917a) — jsdom
//   운영 HTML 을 그대로 로드하고 fetch 만 스텁해서
//   · 디렉터에게만 🗑 버튼이 보이는지
//   · 판매 이력이 있으면 「삭제 불가 + 이유」만 나오고 PIN 칸이 없는지
//   · 삭제 가능하면 PIN 을 넣어야 DELETE 가 나가고 본문이 맞는지
//   · confirm 을 취소하면 아무 요청도 안 나가는지
//   · XSS(코드·이유 문자열)
//   를 검증한다.
// 실행: node --test test/product_delete_front.test.mjs   (jsdom 필요)
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = resolve(here, '..', '..', 'refatrix-products.html');

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* 미설치 → skip */ }
const SKIP = !JSDOM || !existsSync(HTML);
if (SKIP) console.log('[skip] jsdom 또는 refatrix-products.html 없음');

const FOUND = { items: [{ id: 77, code: 'CB-DEL', name: '테스트 로툴라', scode: 'SYD-9' }], total: 1 };

const CHECK_OK = {
  product: { id: 77, code: 'CB-DEL', name: '테스트 로툴라', stock_qty: 0 },
  can_delete: true, sold_count: 0, purchase_count: 0, blockers: [],
  cleanups: [
    { table: 'product_syd_codes', label: 'SyD 코드', count: 2, capped: false, kind: 'cleanup' },
    { table: 'product_change_log', label: '제품 변경 이력', count: 4, capped: false, kind: 'nullify' },
  ],
  reasons: [],
};
const CHECK_BLOCKED = {
  product: { id: 77, code: 'CB-DEL', name: '테스트 로툴라', stock_qty: 0 },
  can_delete: false, sold_count: 3, purchase_count: 1,
  blockers: [
    { table: 'sales_invoice_lines', label: '판매(인보이스) 라인', count: 3, capped: false },
    { table: 'purchase_order_lines', label: '구매 발주 라인', count: 1, capped: false },
  ],
  reasons: ['판매 이력이 있습니다 (3건) — 판매된 제품은 삭제할 수 없습니다.', '구매(발주·수입) 이력이 있습니다 (1건).'],
};

async function boot(opts = {}) {
  const calls = [];
  const dom = new JSDOM(readFileSync(HTML, 'utf-8'), {
    runScripts: 'dangerously',
    url: 'https://example.test/refatrix-products.html#tab=upload',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({
        token: 'T', api: 'https://api.test', user: { name: '테스트디렉터', role: opts.role || 'director' },
      }));
      w.alert = () => {};
      w.confirm = () => opts.confirm !== false;
      w.fetch = async (url, o = {}) => {
        const u = String(url);
        calls.push({ url: u, method: o.method || 'GET', body: o.body ? JSON.parse(o.body) : null });
        const json = (d, ok = true, status = 200) => ({ ok, status, json: async () => d });
        if (u.includes('/delete-check')) return json(opts.blocked ? CHECK_BLOCKED : (opts.check || CHECK_OK));
        if (/\/api\/products\/\d+$/.test(u.split('?')[0]) && (o.method || '') === 'DELETE') {
          if (opts.deleteError) return json({ error: opts.deleteError }, false, 403);
          return json({ ok: true, id: 77, code: 'CB-DEL', removed: 'SyD 코드 2건' });
        }
        if (u.includes('/api/products?q=')) return json(opts.found || FOUND);
        return json({ items: [], total: 0 });
      };
    },
  });
  const w = dom.window;
  await new Promise((r) => { if (w.document.readyState === 'complete') r(); else w.addEventListener('load', r); });
  await new Promise((r) => setTimeout(r, 60));
  return { w, d: w.document, calls, dom };
}
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

// 「수정할 제품 검색」에 코드를 넣고 후보를 띄운다
async function search(w, d) {
  const q = d.getElementById('peQ');
  q.value = 'CB-DEL';
  q.dispatchEvent(new w.Event('input', { bubbles: true }));
  await tick(420);                 // 디바운스 300ms
  return d.getElementById('peQList');
}

test('제품 영구 삭제 UI — jsdom', { skip: SKIP }, async (t) => {
  await t.test('① 디렉터에게 🗑 삭제 버튼이 보인다', async () => {
    const { w, d } = await boot();
    const box = await search(w, d);
    const btn = box.querySelector('.pe-del');
    assert.ok(btn, '삭제 버튼 렌더');
    assert.equal(btn.getAttribute('data-code'), 'CB-DEL');
    assert.ok(box.querySelector('.pe-edit') && box.querySelector('.pe-ref-new'), '기존 버튼 회귀');
  });

  await t.test('② 디렉터가 아니면 버튼이 없다', async () => {
    const { w, d } = await boot({ role: 'sales' });
    // 업로드 탭은 디렉터 전용이라 카드가 숨겨진다 — 검색 UI 자체가 노출되지 않는다.
    assert.ok(d.getElementById('upCard').classList.contains('hidden'), '업로드 카드 숨김');
    const box = d.getElementById('peQList');
    if (box && box.innerHTML) assert.equal(box.querySelectorAll('.pe-del').length, 0);
  });

  await t.test('③ 판매 이력이 있으면 이유만 보이고 PIN 칸이 없다', async () => {
    const { w, d, calls } = await boot({ blocked: true });
    const box = await search(w, d);
    box.querySelector('.pe-del').dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(80);
    const panel = d.getElementById('pdelBox');
    assert.ok(panel, '패널 열림');
    assert.ok(calls.some((c) => c.url.includes('/api/products/77/delete-check')), '점검 호출');
    assert.match(panel.textContent, /삭제할 수 없습니다/);
    assert.match(panel.textContent, /판매 이력이 있습니다 \(3건\)/);
    assert.match(panel.textContent, /판매\(인보이스\) 라인 — 3건/);
    assert.equal(d.getElementById('pdelPin'), null, 'PIN 칸 없음');
    assert.equal(d.getElementById('pdelGo'), null, '삭제 버튼 없음');
    assert.match(panel.textContent, /판매중단\(비활성\)/, '대안 안내');
  });

  await t.test('④ 삭제 가능하면 정리 목록 + PIN 칸이 나온다', async () => {
    const { w, d } = await boot();
    const box = await search(w, d);
    box.querySelector('.pe-del').dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(80);
    const panel = d.getElementById('pdelBox');
    assert.match(panel.textContent, /판매·구매 기록이 없습니다/);
    assert.match(panel.textContent, /SyD 코드 2건/);
    assert.match(panel.textContent, /연결만 끊습니다|연결만|기록은 남고/);
    assert.ok(d.getElementById('pdelPin'), 'PIN 칸');
    assert.ok(d.getElementById('pdelGo'), '삭제 버튼');
  });

  await t.test('⑤ PIN 없이 누르면 요청이 나가지 않는다', async () => {
    const { w, d, calls } = await boot();
    const box = await search(w, d);
    box.querySelector('.pe-del').dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(80);
    d.getElementById('pdelGo').dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(60);
    assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
    assert.match(d.getElementById('pdelMsg').textContent, /PIN을 입력하세요/);
  });

  await t.test('⑥ confirm 을 취소하면 요청이 나가지 않는다', async () => {
    const { w, d, calls } = await boot({ confirm: false });
    const box = await search(w, d);
    box.querySelector('.pe-del').dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(80);
    d.getElementById('pdelPin').value = '1234';
    d.getElementById('pdelGo').dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(60);
    assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
  });

  await t.test('⑦ PIN + confirm → DELETE 본문에 pin·code·reason 이 실린다', async () => {
    const { w, d, calls } = await boot();
    const box = await search(w, d);
    box.querySelector('.pe-del').dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(80);
    d.getElementById('pdelPin').value = '1234';
    d.getElementById('pdelReason').value = '코드 오등록';
    d.getElementById('pdelGo').dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(120);
    const del = calls.find((c) => c.method === 'DELETE');
    assert.ok(del, 'DELETE 호출');
    assert.match(del.url, /\/api\/products\/77$/);
    assert.deepEqual(del.body, { pin: '1234', code: 'CB-DEL', reason: '코드 오등록' });
    assert.equal(d.getElementById('pdelRow'), null, '패널 닫힘');
    assert.equal(d.querySelector('tr[data-prow="77"]'), null, '행 제거');
    assert.match(d.getElementById('peDelMsg').textContent, /삭제 완료 — CB-DEL/);
  });

  await t.test('⑧ PIN 이 틀리면 한국어 안내 — 행은 그대로', async () => {
    const { w, d } = await boot({ deleteError: 'bad_pin' });
    const box = await search(w, d);
    box.querySelector('.pe-del').dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(80);
    d.getElementById('pdelPin').value = '0000';
    d.getElementById('pdelGo').dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(120);
    assert.match(d.getElementById('pdelMsg').textContent, /PIN이 올바르지 않습니다/);
    assert.ok(d.querySelector('tr[data-prow="77"]'), '행 유지');
  });

  await t.test('⑨ 같은 버튼을 다시 누르면 패널이 접힌다', async () => {
    const { w, d } = await boot();
    const box = await search(w, d);
    const btn = box.querySelector('.pe-del');
    btn.dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(80);
    assert.ok(d.getElementById('pdelRow'));
    btn.dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(40);
    assert.equal(d.getElementById('pdelRow'), null);
  });

  await t.test('⑩ XSS — 서버가 준 문자열은 실행되지 않는다', async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    const { w, d } = await boot({
      found: { items: [{ id: 77, code: evil, name: evil, scode: evil }], total: 1 },
      blocked: true,
      check: null,
    });
    const box = await search(w, d);
    box.querySelector('.pe-del').dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(80);
    assert.equal(w.__pwned, undefined);
    assert.equal(d.querySelectorAll('#pdelBox img').length, 0);
  });
});
