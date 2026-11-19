// =====================================================================
// 구매 화면 · 「구매내역 엑셀 (금액 제외)」 버튼 — jsdom 화면 동작 검증 · 2026-11-19
//   ① 원가 권한 없는 직원도 버튼이 보이고 다운로드된다
//   ② 열은 구매일자 · 오더번호 · 제품번호 · 수량 4개뿐 (디렉터도 금액 없음)
//   ③ 검색어 · 기간 조건 + export=1 을 서버에 보낸다 · 미입고 체크와 무관
//   실행: node --test test/purchase_history_front.test.mjs   (jsdom · xlsx 필요)
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let JSDOM, XLSX;
try { ({ JSDOM } = await import('jsdom')); XLSX = require('xlsx'); } catch { /* skip */ }
const SKIP = !JSDOM || !XLSX;
const here = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(here, '..', '..', 'refatrix-purchase.html');

const ITEMS = [
  { id: 1, ref_no: 'PO-2607-01', order_date: '2026-07-03T00:00:00.000Z', od: '2026-07-03', input_code: 'ca0032', matched: true, matched_code: 'CA0032', qty: 100, received_qty: 0, backorder: 100, unit_cost_usd: 4.2, amount_usd: 420 },
  { id: 2, ref_no: 'PO-2607-01', order_date: '2026-07-03T00:00:00.000Z', od: '2026-07-03', input_code: 'XX999', matched: false, matched_code: null, qty: 7, received_qty: 7, backorder: 0, unit_cost_usd: 1.5, amount_usd: 10.5 },
  { id: 3, ref_no: 'PO-2611-02', order_date: '2026-11-01T00:00:00.000Z', od: '2026-11-01', input_code: 'CB0089', matched: true, matched_code: 'CB0089', qty: 40, received_qty: 0, backorder: 40, unit_cost_usd: 3, amount_usd: 120 },
];

async function open(role) {
  const calls = []; const files = [];
  const html = fs.readFileSync(HTML, 'utf8').replace(/<script src="[^"]*"><\/script>/g, '');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://erp.refatrix.com/refatrix-purchase.html',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { name: 'U', role } }));
      const X = Object.assign({}, XLSX, { utils: XLSX.utils, writeFile: (wb, name) => { files.push({ wb, name }); } });
      w.XLSX = X;
      w.alert = (m) => calls.push({ alert: m });
      w.fetch = async (url) => {
        calls.push({ url: String(url) });
        const u = new URL(String(url));
        const seeCost = role === 'director';
        let body;
        if (u.pathname === '/api/purchases/lines') {
          body = { cost_visible: seeCost, items: ITEMS.map((x) => ({ ...x, unit_cost_usd: seeCost ? x.unit_cost_usd : null, amount_usd: seeCost ? x.amount_usd : null })), summary: { line_count: 3, total_backorder: 140, sku_count: 3, total_usd: null }, limit: 50000, truncated: false };
        } else if (u.pathname === '/api/purchases') body = { cost_visible: seeCost, items: [], summary: {} };
        else if (u.pathname === '/api/purchases/incoming') body = { groups: [], items: [], summary: {} };
        else body = {};
        return { ok: true, status: 200, json: async () => body };
      };
    },
  });
  await new Promise((r) => setTimeout(r, 30));
  return { dom, w: dom.window, d: dom.window.document, calls, files };
}
const sheetRows = (f) => XLSX.utils.sheet_to_json(f.wb.Sheets[f.wb.SheetNames[0]], { header: 1 });

test('① 직원(원가 권한 없음) — 버튼 보임 · 4열만 · 날짜 최신순', { skip: SKIP }, async () => {
  const { w, d, calls, files } = await open('sales_support');
  assert.ok(!d.getElementById('listCard').classList.contains('hidden'));
  const btn = d.getElementById('histXlsxBtn');
  assert.ok(btn, '버튼 존재');
  d.getElementById('q').value = 'PO-26';
  d.getElementById('from').value = '2026-07-01';
  d.getElementById('to').value = '2026-11-30';
  d.getElementById('boOnly').checked = true;   // 무관해야 함
  btn.dispatchEvent(new w.Event('click'));
  await new Promise((r) => setTimeout(r, 30));
  const call = calls.filter((c) => c.url && c.url.includes('/api/purchases/lines')).pop();
  const u = new URL(call.url);
  assert.equal(u.searchParams.get('export'), '1');
  assert.equal(u.searchParams.get('q'), 'PO-26');
  assert.equal(u.searchParams.get('from'), '2026-07-01');
  assert.equal(u.searchParams.get('to'), '2026-11-30');
  assert.equal(u.searchParams.get('backorder_only'), null);
  assert.equal(files.length, 1);
  assert.match(files[0].name, /^refatrix_purchase_history_20260701-20261130_\d{8}\.xlsx$/);
  assert.deepEqual(sheetRows(files[0]), [
    ['구매일자', '오더번호', '제품번호', '수량'],
    ['2026-11-01', 'PO-2611-02', 'CB0089', 40],
    ['2026-07-03', 'PO-2607-01', 'CA0032', 100],
    ['2026-07-03', 'PO-2607-01', 'XX999', 7],      // 미매칭 → 입력 코드
  ]);
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, '구매내역 엑셀 (금액 제외)');
});

test('② 디렉터도 금액 열 없음', { skip: SKIP }, async () => {
  const { w, d, files } = await open('director');
  d.getElementById('histXlsxBtn').dispatchEvent(new w.Event('click'));
  await new Promise((r) => setTimeout(r, 30));
  const rows = sheetRows(files[0]);
  assert.deepEqual(rows[0], ['구매일자', '오더번호', '제품번호', '수량']);
  assert.ok(rows.every((r) => r.length === 4));
  assert.match(files[0].name, /^refatrix_purchase_history_\d{8}\.xlsx$/);
});

test('③ od 없는 옛 서버 응답 — order_date 앞 10자리 사용(하루 밀림 없음)', { skip: SKIP }, async () => {
  const { w } = await open('sales_support');
  const rows = w.buildHistRows([{ id: 9, ref_no: 'R', order_date: '2026-07-03T00:00:00.000Z', matched: false, input_code: 'Z1', qty: 2 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [{ '구매일자': '2026-07-03', '오더번호': 'R', '제품번호': 'Z1', '수량': 2 }]);
});
