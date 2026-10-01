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
  quotes: { n: 12, amt: 250000, qty: 900, sku: 38, lines: 112, open: 3, converted: 7, expired: 2 },
  sales: { invoices: 7, amt: 150000, qty: 600, sku: 25, rate: 60 },
  lost: { n: 9, amt: 40000, qty: 120, sku: 9, converted_amt: 30000, expired_amt: 10000, open_short_amt: 5000, open_short_qty: 20 },
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
        if (u.includes('by=month')) { if (role !== 'director' && role !== 'socio') return { ok: false, status: 403, json: async () => ({}) };
          const yms = decodeURIComponent(u.split('yms=')[1] || '').split(',').filter(Boolean);
          return json({ months: yms.map((ym, i) => ({ ym, ...JSON.parse(JSON.stringify(summary)), quotes: { ...summary.quotes, amt: 1000 * (i + 1) } })), total: summary }); }
        if (u.includes('/api/quotes/summary')) { if (role !== 'director' && role !== 'socio') return { ok: false, status: 403, json: async () => ({ error: 'director_or_socio_only' }) }; return json(JSON.parse(JSON.stringify(summary))); }
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
    for (const s of ['250,000.00', '150,000.00', '40,000.00', '900', '600', '견적 줄 112', '부족 9 SKU / 120 pzs', '60,000.00', '15,000.00', '견적액 대비 60%', '이익률 40%',
      '미결 견적 현재 부족', 'FOB추정 2줄', '원가없음 3줄 제외', 'IVA 제외']) assert.ok(txt.includes(s), '없음: ' + s);
    assert.match(txt, /2026년 \d+월 요약/);
    c.close();
  });
  await t.test('② 디렉터 · 소시오 외에는 요약을 그리지도, 부르지도 않는다', async () => {
    for (const role of ['sales_support', 'sales', 'finance']) {
      const c = boot({ role }); await c.ready; await tick(300);
      assert.equal(c.d.getElementById('sumBox').innerHTML, '', role);
      assert.equal(sumCalls(c.calls).length, 0, role + ' 이 요약 API 를 불렀다');
      c.close();
    }
    const s = boot({ role: 'socio' }); await s.ready; await tick(300);
    assert.equal(s.d.querySelectorAll('#sumBox .sumc').length, 7, '소시오는 7칸');
    s.close();
  });
  await t.test('②-b 수량 칸은 SKU 와 Pieza 를 나눠 보인다', async () => {
    const c = boot(); await c.ready; await tick(300);
    const cards = [...c.d.querySelectorAll('#sumBox .sumc')];
    const q = cards.find((e) => e.querySelector('.k').textContent === '총 견적 수량');
    const v = [...q.querySelectorAll('.v2 > div')].map((e) => e.textContent);
    assert.deepEqual(v, ['SKU38', 'Pieza900']);
    const sl = cards.find((e) => e.querySelector('.k').textContent === '매출 수량');
    assert.deepEqual([...sl.querySelectorAll('.v2 > div')].map((e) => e.textContent), ['SKU25', 'Pieza600']);
    c.close();
  });
  await t.test('②-c 접기/펼치기 — 접으면 한 줄 요약만, 상태는 다시 열어도 유지', async () => {
    const c = boot(); await c.ready; await tick(300);
    const box = c.d.getElementById('sumBox'); const tog = c.d.getElementById('sumTog');
    assert.equal(box.classList.contains('collapsed'), false); assert.match(tog.textContent, /접기/);
    tog.click();
    assert.equal(box.classList.contains('collapsed'), true); assert.match(c.d.getElementById('sumTog').textContent, /펼치기/);
    assert.match(box.querySelector('.summini').textContent, /견적 \$250,000\.00 · 실매출 \$150,000\.00 \(60%\) · 재고부족 실기 \$40,000\.00/);
    c.w.toggleMonth(3); await tick(250);                       // 다시 그려도 접힌 채
    assert.equal(c.d.getElementById('sumBox').classList.contains('collapsed'), true);
    c.d.getElementById('sumTog').click();
    assert.equal(c.d.getElementById('sumBox').classList.contains('collapsed'), false);
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

test('견적·매출 추적 — 수주 흐름 그래프 팝업 (jsdom)', { skip: SKIP && 'jsdom 또는 HTML 없음' }, async (t) => {
  const open = async () => { const c = boot(); await c.ready; await tick(300); c.d.getElementById('sumGraph').click(); await tick(300); return c; };
  const lastCall = (c) => decodeURIComponent(c.calls.filter((u) => u.includes('by=month')).at(-1) || '');
  await t.test('① 화면이 한 달만 골라져 있으면 올해 1월~이번 달 추이로 연다 · 흐름 2개 + 번 돈/놓친 돈', async () => {
    const c = await open();
    assert.equal(c.d.getElementById('grModal').style.display, 'flex');
    const now = new c.w.Date(); const n = now.getMonth() + 1;
    const yms = lastCall(c).split('yms=')[1].split(',');
    assert.equal(yms.length, n); assert.equal(yms[0], now.getFullYear() + '-01');
    const titles = [...c.d.querySelectorAll('#grBody .grcard .grhead > b')].map((e) => e.textContent);
    assert.match(titles[0], /수주 흐름 — 금액/); assert.match(titles[1], /수주 흐름 — 수량 — Pieza/); assert.match(titles[2], /번 돈 vs 놓친 돈/);
    for (const k of ['견적 (받은 수요)', '실매출', '재고부족 실기', '기타 미전환', '번 돈 (이익)', '놓친 돈 (이익)']) assert.ok(c.d.querySelector('#grBody .grkpis').textContent.includes(k), k);
    c.close();
  });
  await t.test('② 12개월 전체 → 달마다 hover 영역 12개, 표는 12달 + 합계', async () => {
    const c = await open();
    c.d.querySelector('#grMonths [data-gr=mall]').click(); await tick(300);
    assert.equal(lastCall(c).split('yms=')[1].split(',').length, 12);
    assert.equal(c.d.querySelectorAll('#grBody svg[data-kind=amt] .grhit').length, 12);
    assert.equal(c.d.querySelectorAll('#grBody tbody tr').length, 13);
    c.close();
  });
  await t.test('③ 수주 흐름 = 견적 선 + 실매출 · 재고부족 음영(쌓기) + 기타 미전환 빗금', async () => {
    const c = await open();
    const svg = c.d.querySelector('#grBody svg[data-kind=amt]');
    const fills = [...svg.querySelectorAll('path')].map((p) => p.getAttribute('fill'));
    assert.ok(fills.includes('#1baf7a') && fills.includes('#eb6834'), '음영 두 겹');
    assert.ok(fills.some((f) => /url\(#grHatch/.test(f || '')), '기타 미전환 빗금');
    assert.ok([...svg.querySelectorAll('path')].some((p) => p.getAttribute('stroke') === '#2a78d6'), '견적 선');
    c.close();
  });
  await t.test('④ 금액만 / 수량만 — 둘 다 끄지는 못한다 · 이익 그래프는 늘 아래', async () => {
    const c = await open();
    c.d.querySelector('#grView [data-gr=qty]').click(); await tick(50);
    let t2 = [...c.d.querySelectorAll('#grBody .grcard .grhead > b')].map((e) => e.textContent);
    assert.equal(t2.length, 2); assert.match(t2[0], /금액/);
    c.d.querySelector('#grView [data-gr=amt]').click(); await tick(50);
    t2 = [...c.d.querySelectorAll('#grBody .grcard .grhead > b')].map((e) => e.textContent);
    assert.match(t2[0], /수량/, '금액을 끄면 수량이 다시 켜진다');
    c.close();
  });
  await t.test('⑤ SKU 는 쌓지 않고 겹친 선 + 안내', async () => {
    const c = await open();
    c.d.querySelector('#grView [data-gr=unit][data-v=sku]').click(); await tick(50);
    const svg = c.d.querySelector('#grBody svg[data-kind=sku]'); assert.ok(svg);
    assert.ok(![...svg.querySelectorAll('path')].some((p) => /url\(#grHatch/.test(p.getAttribute('fill') || '')), 'SKU 에 기타 빗금이 있으면 안 된다');
    assert.match(c.d.getElementById('grBody').textContent, /쌓지 않고 겹쳐/);
    c.close();
  });
  await t.test('⑥ 마우스를 올리면 세로선 + 그 달 툴팁(견적 · 실매출 · 재고부족 · 기타)', async () => {
    const c = await open();
    const hit = c.d.querySelector('#grBody svg[data-kind=amt] .grhit');
    hit.dispatchEvent(new c.w.MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 }));
    const tip = c.d.getElementById('grTip');
    assert.equal(tip.style.display, 'block');
    for (const k of ['견적', '실매출', '재고부족', '기타 미전환']) assert.ok(tip.textContent.includes(k), k);
    c.close();
  });
  await t.test('⑦ 한 달만 고르면 추이 대신 구성 막대', async () => {
    const c = await open();
    c.d.querySelector('#grMonths [data-gr=mnone]').click(); await tick(100);
    assert.match(c.d.getElementById('grBody').textContent, /하나 이상 선택/);
    c.d.querySelector('#grMonths [data-gr=m][data-v="3"]').click(); await tick(300);
    assert.equal(c.d.querySelectorAll('#grBody svg[data-kind=amt] .grx').length, 0, '한 달이면 세로선 없음');
    assert.equal(c.d.querySelectorAll('#grBody svg[data-kind=amt] .grhit').length, 1);
    c.d.dispatchEvent(new c.w.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(c.d.getElementById('grModal').style.display, 'none');
    c.close();
  });
  await t.test('⑧ 디렉터·소시오가 아니면 그래프 버튼도 없다', async () => {
    const c = boot({ role: 'sales' }); await c.ready; await tick(300);
    assert.equal(c.d.getElementById('sumGraph'), null);
    c.close();
  });
});
