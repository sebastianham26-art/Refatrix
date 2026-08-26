// =====================================================================
// 견적 상세 「🔄 재고 재검증」 버튼 — 화면(jsdom) 검증
//   · 실제 refatrix-quotelist.html 을 파싱해 openDetail → renderDetail 을 그대로 돌린다.
//   · fetch 는 스텁. 버튼 노출 조건 / 클릭 흐름 / 결과 배너를 확인.
//   실행: node --test test/quote_revalidate_front.test.mjs   (jsdom 필요)
// =====================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, '..', '..', 'refatrix-quotelist.html');
const html = fs.readFileSync(HTML, 'utf8');

let JSDOM;
try { ({ JSDOM } = await import('jsdom')); } catch { /* jsdom 없으면 skip */ }
const opts = JSDOM ? {} : { skip: 'jsdom 미설치 — skip (npm i -D jsdom)' };

const LINES = [
  { id: 11, line_no: 1, product_id: 5, ctr_code: 'CE0536R', product_name: 'Filtro', qty: 5,
    reserved_qty: 0, cur_stock: 5, live_flag: 'low_stock', stock_flag: 'low_stock',
    list_price: 100, discount_rate: 0, final_price: 100, line_subtotal: 500, line_iva: 80, line_total: 580 },
];
const QUOTE = (over = {}) => ({
  id: 7, quote_no: 'Q-2026-0007', status: 'draft', quote_date: '2026-08-26', party_name: 'Cliente X',
  is_guest: false, subtotal_mxn: 500, iva_mxn: 80, total_mxn: 580, total_qty: 5,
  reserve_expires_at: new Date(Date.now() + 6 * 3600e3).toISOString(), packing_printed_at: null,
  cls: { ok: 0, short: 1, dev: 0, ok_qty: 0, short_qty: 5, dev_qty: 0, ok_amt: 0, short_amt: 580 },
  ...over,
});

// 화면을 띄우고 window 를 돌려준다. postResult = 재검증 POST 응답(또는 {status,body})
async function boot({ quote = QUOTE(), lines = LINES, postResult = null } = {}) {
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-quotelist.html',
    beforeParse(win) {
      win.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { name: 'dir', role: 'director' } }));
      win.alert = () => {}; win.confirm = () => true;
      win.fetch = async (url, init) => {
        const method = (init && init.method) || 'GET';
        calls.push({ url: String(url), method });
        const u = String(url);
        const json = (o) => ({ ok: true, status: 200, json: async () => o });
        if (/\/revalidate-stock$/.test(u)) {
          if (postResult && postResult.status && postResult.status >= 400)
            return { ok: false, status: postResult.status, json: async () => postResult.body };
          return json(postResult || { ok: true });
        }
        if (/\/api\/quotes\/\d+$/.test(u)) return json({ quote: dom.__quote, lines: dom.__lines });
        if (/\/api\/quotes\?/.test(u)) return json({ items: [], summary: {} });
        if (/\/api\/quotes\/counts/.test(u)) return json({ open: 0, guest_pending: 0, delete_pending: 0 });
        if (/\/api\/company/.test(u)) return json({});
        if (/\/api\/auth\/(login|me)/.test(u)) return json({ token: 't', user: { name: 'dir', role: 'director' }, perm: {} });
        return json({});
      };
    },
  });
  dom.__quote = quote; dom.__lines = lines; dom.__calls = calls;
  await new Promise((r) => dom.window.addEventListener('load', r));
  const w = dom.window;
  w.session = { token: 't', user: { name: 'dir', role: 'director' }, api: 'https://api.test' };
  w.isDirector = true;
  await w.openDetail(7);
  return dom;
}
const body = (dom) => dom.window.document.getElementById('dtBody').innerHTML;

test('① 미결 견적 상세에 「재고 재검증」 버튼이 보인다', opts, async () => {
  const dom = await boot();
  const btn = dom.window.document.getElementById('revalBtn');
  assert.ok(btn, '버튼이 렌더되어야 한다');
  assert.match(btn.textContent, /재고 재검증/);
  assert.match(btn.getAttribute('onclick'), /revalidateStock\(\)/);
  assert.match(body(dom), /✎ SKU·수량 편집/, '기존 버튼도 그대로');
});

test('② 전환·취소·만료 견적에는 버튼이 없다', opts, async () => {
  for (const q of [QUOTE({ status: 'converted' }), QUOTE({ status: 'cancelled' }),
    QUOTE({ status: 'expired' }), QUOTE({ status: 'delete_pending' }),
    QUOTE({ reserve_expires_at: new Date(Date.now() - 60e3).toISOString() })]) {
    const dom = await boot({ quote: q });
    assert.equal(dom.window.document.getElementById('revalBtn'), null, `${q.status} 에는 버튼이 없어야 한다`);
  }
});

test('③ 포장작업지시서 출력분에는 버튼이 없다(재고 확정)', opts, async () => {
  const dom = await boot({ quote: QUOTE({ packing_printed_at: new Date().toISOString() }) });
  assert.equal(dom.window.document.getElementById('revalBtn'), null);
  assert.match(body(dom), /포장작업지시서 출력/);
});

test('④ 클릭 → POST 호출 → 상세 재조회 → "부족→즉시" 배너', opts, async () => {
  const dom = await boot({
    postResult: {
      ok: true, changed: 1, upgraded: 1, downgraded: 0, ok_lines: 1, short_lines: 0,
      changes: [{ line_id: 11, ctr_code: 'CE0536R', product_name: 'Filtro', qty: 5, before: 0, after: 5, before_flag: 'low_stock', after_flag: 'ok', cur_stock: 5 }],
    },
  });
  // 서버가 재배분한 뒤의 상세 응답으로 교체(즉시매출가능)
  dom.__lines = [{ ...LINES[0], reserved_qty: 5, live_flag: 'ok' }];
  dom.__quote = QUOTE({ cls: { ok: 1, short: 0, dev: 0, ok_qty: 5, short_qty: 0, dev_qty: 0, ok_amt: 580, short_amt: 0 } });

  await dom.window.revalidateStock();
  const posted = dom.__calls.filter((c) => /revalidate-stock/.test(c.url));
  assert.equal(posted.length, 1); assert.equal(posted[0].method, 'POST');

  const h = body(dom);
  assert.match(h, /재고부족 1 SKU 가 즉시매출가능으로 회복/);
  assert.match(h, /CE0536R/);
  assert.match(h, /확보 0 → 5/);
  assert.match(h, /예약 만료시각\(24시간\)은 연장되지 않습니다/);
  assert.match(h, /즉시매출가능 <b[^>]*>1<\/b> SKU/, '요약 박스가 갱신되어야 한다');
  await new Promise((r) => setTimeout(r, 60));   // load() 는 await 하지 않고 띄운다(배너 먼저 표시)
  assert.ok(dom.__calls.some((c) => /\/api\/quotes\?/.test(c.url)), '목록도 갱신 호출');
});

test('⑤ 변동 없음 · 하향 · 실패 메시지', opts, async () => {
  const none = await boot({ postResult: { ok: true, changed: 0, upgraded: 0, downgraded: 0, ok_lines: 0, short_lines: 1, changes: [] } });
  await none.window.revalidateStock();
  assert.match(body(none), /변동 없음/);
  assert.match(body(none), /여전히 재고를 선점|실물재고가 부족/);

  const down = await boot({
    postResult: {
      ok: true, changed: 1, upgraded: 0, downgraded: 1, ok_lines: 0, short_lines: 1,
      changes: [{ line_id: 11, ctr_code: 'CE0536R', product_name: 'Filtro', qty: 5, before: 5, after: 2, before_flag: 'ok', after_flag: 'low_stock', cur_stock: 2 }],
    },
  });
  await down.window.revalidateStock();
  assert.match(body(down), /즉시매출가능 1 SKU 가 재고부족으로 하향/);
  assert.match(body(down), /확보 5 → 2/);

  const err = await boot({ postResult: { status: 409, body: { error: 'quote_expired', note: '예약 24시간이 지나 만료된 견적입니다. 「복제해서 새로 진행」을 사용하세요.' } } });
  await err.window.revalidateStock();
  assert.match(body(err), /재검증 실패/);
  assert.match(body(err), /복제해서 새로 진행/);
});

test('⑥ 배너는 상세를 새로 열면 사라진다', opts, async () => {
  const dom = await boot({ postResult: { ok: true, changed: 0, upgraded: 0, downgraded: 0, changes: [] } });
  await dom.window.revalidateStock();
  assert.match(body(dom), /재검증 완료/);
  await dom.window.openDetail(7);
  assert.doesNotMatch(body(dom), /재검증 완료/, '다른 견적을 열면 이전 결과가 남으면 안 된다');
});
