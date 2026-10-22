// 0293 · 견적 화면: 키트(K0001) 를 담으면 서버가 돌려준 input_lines 로 줄 목록이 구성 부품 줄로 바뀐다(jsdom)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'refatrix-quote.html'), 'utf8');
let JSDOM; try { ({ JSDOM } = await import('jsdom')); } catch {}
const opts = JSDOM ? {} : { skip: 'jsdom 미설치' };

const L = (code, pid, qty, kit) => ({ input_code: code, matched: true, product_id: pid, ctr_code: code, product_name: 'TERMINAL', qty, list_price: 100, discount_rate: 10, final_price: 90, line_subtotal: 90 * qty, line_iva: 0, line_total: 90 * qty, avail_stock: 9, stock_flag: 'ok', kit_no: kit || null });

test('키트 K0001 → 부품 3줄 · 안내 · 🧰 표시 · 삭제 번호 맞음 · 자동완성 KIT 배지', opts, async () => {
  const bodies = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-quote.html',
    beforeParse(win) {
      win.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 'x.eyJleHAiOjk5OTk5OTk5OTl9.y', api: 'https://api.test', user: { name: 'dir', role: 'director' } }));
      win.alert = () => {}; win.confirm = () => true;
      win.fetch = async (url, init) => {
        const u = String(url); const json = (o) => ({ ok: true, status: 200, json: async () => o });
        if (/\/api\/quotes\/preview/.test(u)) {
          const b = JSON.parse(init.body); bodies.push(b);
          if (b.lines.some((l) => l.code === 'K0001')) {
            const inl = [{ code: 'CE0342L', product_id: 11, qty: 2, kit_no: 'K0001' }, { code: 'CE0342R', product_id: 12, qty: 2, kit_no: 'K0001' }, { code: 'CR0297', product_id: 13, qty: 2, kit_no: 'K0001' }];
            return json({ discountRate: 10, lines: inl.map((l) => L(l.code, l.product_id, l.qty, 'K0001')), totals: { totalQty: 6, subtotal: 540, total: 540 }, input_lines: inl });
          }
          return json({ discountRate: 10, lines: b.lines.map((l) => L(l.code, l.product_id, l.qty, l.kit_no)), totals: {} });
        }
        if (/search-code/.test(u)) return json({ items: [{ product_id: 99, ctr_code: 'K0001', name: 'KIT T SPORTAGE 2016-2022_CE0342L_CE0342R_CR0297', list_price: 1582.5, syd_codes: [], is_active: true, kit: { promo_no: 'K0001', items: [{}, {}, {}] } }] });
        if (/\/api\/customers/.test(u)) return json({ items: [] });
        return json({ items: [] });
      };
    },
  });
  await new Promise((r) => dom.window.addEventListener('load', r));
  const w = dom.window, d = w.document;
  const sel = d.getElementById('custSel'); const o = d.createElement('option'); o.value = '5'; o.textContent = 'Cliente'; sel.appendChild(o); sel.value = '5';
  w.eval("lines=[{code:'K0001',product_id:99,qty:2}]");
  await w.recalc();
  assert.equal(bodies[0].lines[0].code, 'K0001');
  const ls = w.eval('lines');
  assert.deepEqual(JSON.parse(JSON.stringify(ls)), [{ code: 'CE0342L', qty: 2, product_id: 11, kit_no: 'K0001' }, { code: 'CE0342R', qty: 2, product_id: 12, kit_no: 'K0001' }, { code: 'CR0297', qty: 2, product_id: 13, kit_no: 'K0001' }]);
  assert.match(d.getElementById('lineMsg').textContent, /키트 K0001 → 구성 부품 줄/);
  assert.equal((d.getElementById('linesWrap').innerHTML.match(/🧰 K0001/g) || []).length, 3);
  // 두 번째 계산(부품 줄 그대로) — 다시 풀지 않음
  w.removeLine(1); await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(JSON.parse(JSON.stringify(w.eval('lines'))).map((l) => l.code), ['CE0342L', 'CR0297']);
  // 자동완성 배지
  d.getElementById('inCode').value = 'K0001'; w.onCodeInput();
  await new Promise((r) => setTimeout(r, 300));
  assert.match(d.getElementById('acBox').innerHTML, /🧰 KIT · 부품 3종/);
});
