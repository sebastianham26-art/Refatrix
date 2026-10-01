// =====================================================================
// 견적·매출 추적 — 상단 기간 요약 + 제품번호 검색 (jsdom, 2026-10-01 ql-1001sm1)
//   운영 HTML(refatrix-quotelist.html)을 그대로 띄우고 fetch 만 스텁한다.
//   실행: node --test test/quote_summary_front.test.mjs   (jsdom 필요)
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const L_HTML = resolve(here, '..', '..', 'refatrix-quotelist.html');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* 미설치 → skip */ }
const SKIP = !JSDOM || !existsSync(L_HTML);
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const SUM = {
  period: ['2026-10'], basis: 'ex_iva',
  quotes: { n: 12, amt: 250000, qty: 900, open: 3, converted: 7, expired: 2 },
  sales: { invoices: 7, amt: 150000, qty: 600, rate: 60 },
  lost: { n: 9, amt: 40000, qty: 120, converted_amt: 30000, expired_amt: 10000, open_short_amt: 5000, open_short_qty: 20 },
  gp: { sales: { gp: 60000, rev: 150000, cost: 90000, pct: 40, est: 2, nocost: 1 },
        lost: { gp: 15000, rev: 38000, cost: 23000, pct: 39.5, est: 0, nocost: 3 } },
};
const ROW = { id: 7, quote_no: 'Q-2026-0500', quote_date: '2026-10-01', status: 'confirmed', open: true, total_mxn: 1160, total_qty: 4, sku_count: 1,
  party_name: 'REFACCIONARIA SUR', cls: {}, code_hits: [{ ctr: 'CS1045', input: 'BW-77-12', qty: 4 }] };

function boot({ role = 'director', summary = SUM } = {}) {
  const calls = [];
  const dom = new JSDOM(readFileSync(L_HTML, 'utf-8'), {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-quotelist.html',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 'T', api: 'https://api.test', user: { name: 'U', role } }));
      w.alert = () => {}; w.confirm = () => true;
      w.requestAnimationFrame = (cb) => setTimeout(cb, 0);
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
      w.fetch = async (url) => {
        const u = String(url); calls.push(u);
        const json = (d) => ({ ok: true, status: 200, json: async () => d });
        if (u.includes('/api/quotes/summary')) { const s = JSON.parse(JSON.stringify(summary)); if (role !== 'director') delete s.gp; return json(s); }
        if (u.includes('/api/quotes/open-count')) return json({ open: 0, guest_pending: 0, delete_pending: 0 });
        if (u.includes('/api/quotes?')) return json({ items: u.includes('q=') ? [ROW] : [] });
        return json({ items: [] });
      };
    },
  });
  const w = dom.window;
  return { w, d: w.document, calls, close: () => w.close(),
    ready: new Promise((r) => { if (w.document.readyState === 'complete') r(); else w.addEventListener('load', r); }) };
}
const sumCalls = (c) => c.filter((u) => u.includes('/api/quotes/summary'));

test('견적·매출 추적 — 상단 요약 (jsdom)', { skip: SKIP && 'jsdom 또는 HTML 없음' }, async (t) => {
  await t.test('① 디렉터: 7칸 — 견적액·실매출·실기·견적수량·매출수량·이익·실현불가', async () => {
    const c = boot(); await c.ready; await tick(300);
    const box = c.d.getElementById('sumBox');
    const keys = [...box.querySelectorAll('.sumc .k')].map((e) => e.textContent);
    assert.deepEqual(keys, ['총 견적액', '실매출액', '재고부족 매출실기', '총 견적 수량', '매출 수량', '매출총이익 실현', '재고부족 이익 실현불가']);
    const txt = box.textContent;
    for (const s of ['250,000.00', '150,000.00', '40,000.00', '900', '600', '60,000.00', '15,000.00', '견적액 대비 60%', '이익률 40%',
      '미결 견적 현재 부족', 'FOB추정 2줄', '원가없음 3줄 제외', 'IVA 제외']) assert.ok(txt.includes(s), '없음: ' + s);
    assert.match(txt, /2026년 \d+월 요약/);
    c.close();
  });
  await t.test('② 디렉터가 아니면 이익 두 칸이 없다', async () => {
    const c = boot({ role: 'sales_support' }); await c.ready; await tick(300);
    assert.equal(c.d.querySelectorAll('#sumBox .sumc').length, 5);
    assert.ok(!c.d.getElementById('sumBox').textContent.includes('매출총이익'));
    c.close();
  });
  await t.test('③ 월을 바꾸면 그 달(yms)로 다시 부르고, 상태 칩은 다시 부르지 않는다', async () => {
    const c = boot(); await c.ready; await tick(300);
    const n0 = sumCalls(c.calls).length;
    assert.equal(n0, 1);
    const first = sumCalls(c.calls)[0];
    assert.match(first, /yms=\d{4}-\d{2}/);
    c.w.setFilter('converted'); await tick(200);
    assert.equal(sumCalls(c.calls).length, 1, '상태 칩 전환은 요약을 다시 부르지 않는다');
    const now = new c.w.Date(); const other = now.getMonth() + 1 === 1 ? 2 : 1;
    c.w.toggleMonth(other); await tick(250);
    const last = sumCalls(c.calls).at(-1);
    assert.equal(sumCalls(c.calls).length, 2);
    assert.ok(decodeURIComponent(last).split('yms=')[1].split(',').length === 2, '두 달 선택 → 두 달');
    c.w.clearPeriod(); await tick(250);
    assert.match(sumCalls(c.calls).at(-1), /all=1/);
    assert.match(c.d.getElementById('sumBox').textContent, /전체기간 요약/);
    c.close();
  });
  await t.test('④ 검색 중에는 「선택 기간 전체」라고 알려 주고, 해제하면 감춘다', async () => {
    const c = boot(); await c.ready; await tick(300);
    c.d.getElementById('qSearch').value = 'BW-77-12';
    c.d.getElementById('qSearchGo').click(); await tick(250);
    assert.equal(c.d.getElementById('sumSearchNote').style.display, '');
    c.d.getElementById('qSearchClear').click(); await tick(250);
    assert.equal(c.d.getElementById('sumSearchNote').style.display, 'none');
    c.close();
  });
});

test('견적·매출 추적 — 제품번호 검색 표시 (jsdom)', { skip: SKIP && 'jsdom 또는 HTML 없음' }, async (t) => {
  await t.test('① 검색칸 안내에 제품번호(CTR · 경쟁사)가 있다', async () => {
    const c = boot(); await c.ready; await tick(200);
    assert.match(c.d.body.innerHTML, /제품번호\(CTR · 경쟁사\)/);
    c.close();
  });
  await t.test('② 걸린 줄이 견적번호 밑에 「CS1045 ×4 ← BW-77-12」 로 보인다', async () => {
    const c = boot(); await c.ready; await tick(300);
    c.d.getElementById('qSearch').value = 'bw7712';
    c.d.getElementById('qSearchGo').click(); await tick(300);
    const q = c.calls.filter((u) => u.includes('/api/quotes?')).at(-1);
    assert.match(q, /q=bw7712/);
    const hit = c.d.querySelector('#listWrap .codehit');
    assert.ok(hit, 'codehit 없음');
    assert.match(hit.textContent, /CS1045 ×4/); assert.match(hit.textContent, /← BW-77-12/);
    assert.match(c.d.getElementById('qSearchNote').textContent, /제품번호/);
    c.close();
  });
  await t.test('③ codeHitSmall — 걸린 줄 없으면 빈 문자열, 입력이 CTR 과 같으면 화살표 없음, 4줄 이상은 「외 N줄」', async () => {
    const c = boot(); await c.ready; await tick(200);
    assert.equal(c.w.codeHitSmall({}), '');
    assert.equal(c.w.codeHitSmall({ code_hits: [] }), '');
    assert.ok(!c.w.codeHitSmall({ code_hits: [{ ctr: 'CS-1', input: 'cs1', qty: 2 }] }).includes('←'));
    const many = c.w.codeHitSmall({ code_hits: [1, 2, 3, 4, 5].map((i) => ({ ctr: 'C' + i, input: null, qty: 1 })) });
    assert.match(many, /외 2줄/);
    assert.ok(!c.w.codeHitSmall({ code_hits: [{ ctr: '<b>x', input: null, qty: 1 }] }).includes('<b>x'), '이스케이프');
    c.close();
  });
});
