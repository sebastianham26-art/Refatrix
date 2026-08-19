// =====================================================================
// 현장조사 소진분석 화면 (refatrix-fsanalysis.html, build fsa-0819a) — jsdom
//   실제 HTML 을 그대로 로드해 fetch 를 스텁하고 렌더·선택·오퍼 동작을 검증한다.
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = resolve(here, '..', '..', 'refatrix-fsanalysis.html');

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* 미설치 → skip */ }
const SKIP = !JSDOM || !existsSync(HTML);
if (SKIP) console.log('[skip] jsdom 또는 refatrix-fsanalysis.html 없음');

// ── 픽스처 (백엔드 응답 형태 그대로) ────────────────────────────────
const CUSTOMERS = { items: [{ id: 7, code: 'C-0007', name: '테스트고객', discount: 10 }] };

function row(o) {
  return Object.assign({
    product_id: 0, ctr_code: '', scode: null, name: '', app: '', is_active: true,
    purchased_qty: 0, first_purchase_at: null, last_purchase_at: null, order_days: 1,
    counted: true, onhand_qty: 0, counted_at: null,
    consumed_qty: 0, consumed_pct: null, status: 'kept',
    stock_qty: 100, avail_stock: 100, list_price: 100, offer_amount: 0,
  }, o);
}
const ITEMS = [
  row({ product_id: 1, ctr_code: 'CA0001', name: '로툴라', purchased_qty: 100, onhand_qty: 0, consumed_qty: 100, consumed_pct: 100, status: 'gone', offer_amount: 9000, last_purchase_at: '2026-05-20' }),
  row({ product_id: 2, ctr_code: 'CB0002', name: '터미널', purchased_qty: 80, onhand_qty: 20, consumed_qty: 60, consumed_pct: 75, status: 'partial', offer_amount: 5400 }),
  row({ product_id: 4, ctr_code: 'CD0004', name: '오르키야', purchased_qty: 40, onhand_qty: 0, counted: false, consumed_qty: 40, consumed_pct: 100, status: 'gone_uncounted', offer_amount: 3600 }),
  row({ product_id: 7, ctr_code: 'CG0007', name: '단종품', purchased_qty: 25, onhand_qty: 0, consumed_qty: 25, consumed_pct: 100, status: 'gone', is_active: false, offer_amount: 2250 }),
  row({ product_id: 3, ctr_code: 'CC0003', name: '부헤', purchased_qty: 50, onhand_qty: 50, consumed_qty: 0, consumed_pct: 0, status: 'kept' }),
  row({ product_id: 6, ctr_code: 'CF0006', name: '이상품', purchased_qty: 30, onhand_qty: 45, consumed_qty: 0, status: 'anomaly' }),
  row({ product_id: 5, ctr_code: 'CE0005', name: '타경로', purchased_qty: 0, onhand_qty: 12, consumed_qty: 0, status: 'no_purchase' }),
];
const CONSUMPTION = {
  survey: { id: 55, customer_id: 7, customer_name: '테스트고객', survey_date: '2026-08-15', status: 'completed', quote_id: null, creator_name: '영업A' },
  customer: { id: 7, code: 'C-0007', name: '테스트고객', discount: 10 },
  basis: '전체 누적 (게시·미삭제 인보이스 전량)',
  items: ITEMS,
  unmatched: [
    { line_id: 91, input_code: 'TRW-9911', observed_qty: 3, dev_request_id: 12, note: null },
    { line_id: 92, input_code: 'MOOG-77', observed_qty: 5, dev_request_id: null, note: null },
  ],
  totals: {
    purchased_sku: 6, purchased_qty: 325, onhand_sku: 4, onhand_qty: 127,
    consumed_sku: 4, consumed_qty: 225, consumed_pct: 69.2,
    counted_sku: 5, uncounted_sku: 1,
    gone: 2, gone_uncounted: 1, partial: 1, kept: 1, anomaly: 1, no_purchase: 1,
    unmatched: 2, unmatched_qty: 8, offer_amount: 20250, inactive_sku: 1,
  },
  surveys: [
    { id: 55, survey_date: '2026-08-15', status: 'completed', creator_name: '영업A', sku_count: 6, obs_qty: 127, unmatched_cnt: 2 },
    { id: 41, survey_date: '2026-03-01', status: 'completed', creator_name: '영업A', sku_count: 1, obs_qty: 55, unmatched_cnt: 0 },
  ],
};

async function boot(opts = {}) {
  const calls = [];
  const dom = new JSDOM(readFileSync(HTML, 'utf-8'), {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-fsanalysis.html',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({
        token: 'T', api: 'https://api.test', user: { name: '영업A', role: 'sales' },
      }));
      w.confirm = () => true;
      w.alert = () => {};
      w.fetch = async (url, o = {}) => {
        calls.push({ url: String(url), method: (o.method || 'GET'), body: o.body ? JSON.parse(o.body) : null });
        const u = String(url);
        const json = (d, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => d });
        if (u.includes('/api/field-surveys/customer-options')) return json(CUSTOMERS);
        if (u.includes('/api/field-surveys/consumption')) {
          if (opts.consumptionError) return json({ error: opts.consumptionError }, false);
          return json(CONSUMPTION);
        }
        if (u.includes('/api/field-surveys/history')) return json({ items: CONSUMPTION.surveys.map((s) => Object.assign({ customer_name: '테스트고객', counts: { imm: 3, short: 1, dev: 2 }, has_geo: true, geo_lat: 19.4, geo_lng: -99.1, quote_no: null, line_count: 9 }, s)) });
        if (u.includes('/api/quotes')) {
          if (opts.quoteError) return json({ error: opts.quoteError, items: [{ code: 'CG0007' }] }, false);
          return json({ id: 900, quote_no: 'Q-2026-0123', customer_id: 7 });
        }
        if (u.includes('/mark-quoted')) return json({ ok: true });
        return json({});
      };
    },
  });
  const w = dom.window;
  await new Promise((r) => { if (w.document.readyState === 'complete') r(); else w.addEventListener('load', r); });
  await new Promise((r) => setTimeout(r, 40));
  return { w, d: w.document, calls, dom };
}
const $ = (d, id) => d.getElementById(id);
const txt = (d, id) => ($(d, id) ? $(d, id).textContent : '');
async function tick(ms = 30) { await new Promise((r) => setTimeout(r, ms)); }

test('현장조사 소진분석 화면 — jsdom', { skip: SKIP }, async (t) => {

  await t.test('① 포털 세션으로 자동 진입 + 전체 조사 이력 표시', async () => {
    const { d, calls } = await boot();
    assert.ok($(d, 'loginCard').classList.contains('hidden'), '로그인 카드 숨김');
    assert.ok(!$(d, 'app').classList.contains('hidden'), '본문 노출');
    assert.ok(calls.some((c) => c.url.includes('/history')), '조사 이력 조회');
    assert.ok($(d, 'histBody').querySelectorAll('tr').length >= 2);
  });

  await t.test('② 고객 선택 → 소진분석 자동 실행', async () => {
    const { w, d, calls } = await boot();
    $(d, 'custSel').value = '7';
    $(d, 'custSel').dispatchEvent(new w.Event('change'));
    await tick(50);
    assert.ok(calls.some((c) => c.url.includes('consumption?customer_id=7')), 'customer_id 로 조회');
    assert.ok(!$(d, 'pRows').classList.contains('hidden'), '소진 내역 표시');
  });

  async function loaded() {
    const b = await boot();
    b.d.getElementById('custSel').value = '7';
    b.d.getElementById('custSel').dispatchEvent(new b.w.Event('change'));
    await tick(50);
    return b;
  }

  await t.test('③ 등식 박스: 누적구매 − 잔량 = 팔린 수량', async () => {
    const { d } = await loaded();
    const eq = txt(d, 'eqBox');
    assert.match(eq, /325/, '누적 구매 325');
    assert.match(eq, /127/, '현장 잔량 127');
    assert.match(eq, /225/, '소진 225');
    assert.match(eq, /69\.2%/, '소진율');
    assert.match(eq, /2026-08-15/, '기준 조사일 표기');
  });

  await t.test('④ KPI 카드 6종', async () => {
    const { d } = await loaded();
    const k = $(d, 'kpis');
    assert.equal(k.querySelectorAll('.kpi').length, 6);
    assert.match(k.textContent, /누적 구매/);
    assert.match(k.textContent, /고객창고 잔량/);
    assert.match(k.textContent, /소진\(팔림\)/);
    assert.match(k.textContent, /\$20,250\.00/, '예상 오퍼 금액');
  });

  await t.test('⑤ 기본 필터=소진분만, 기본 선택=소진>0 & 활성 SKU', async () => {
    const { d } = await loaded();
    const rows = $(d, 'rowsBody').querySelectorAll('tr');
    assert.equal(rows.length, 4, '소진분 4건 (CA0001·CB0002·CD0004·CG0007)');
    // 정렬 = 소진수량 내림차순
    assert.match(rows[0].textContent, /CA0001/);
    // 선택은 활성 3건만 — 판매중단 CG0007 제외
    assert.match(txt(d, 'actSum'), /선택 <b>3<\/b>|선택 3/);
    assert.match($(d, 'actSum').innerHTML, /선택 <b>3<\/b>/);
    assert.match($(d, 'actSum').innerHTML, /200/, '오퍼 수량 100+60+40=200');
  });

  await t.test('⑥ 판매중단 SKU 경고 + 미계수 안내', async () => {
    const { d } = await loaded();
    const w2 = $(d, 'warnBox').textContent;
    assert.match(w2, /판매중단\(비활성\) SKU/);
    assert.match(w2, /계수되지 않았습니다/);
    assert.match(w2, /타 경로 구매 또는 계수 오차/);
  });

  await t.test('⑦ 필터 칩 — 전체/미소진/이상/구매이력없음', async () => {
    const { w, d } = await loaded();
    const chips = [...$(d, 'chips').querySelectorAll('.chip')];
    const pick = (label) => chips.find((c) => c.textContent.startsWith(label));
    pick('전체').dispatchEvent(new w.Event('click'));
    assert.equal($(d, 'rowsBody').querySelectorAll('tr').length, 7, '전체 7건');
    pick('미소진').dispatchEvent(new w.Event('click'));
    assert.equal($(d, 'rowsBody').querySelectorAll('tr').length, 1);
    assert.match($(d, 'rowsBody').textContent, /CC0003/);
    pick('구매이력 없음').dispatchEvent(new w.Event('click'));
    assert.match($(d, 'rowsBody').textContent, /CE0005/);
    pick('조사 미계수').dispatchEvent(new w.Event('click'));
    assert.match($(d, 'rowsBody').textContent, /CD0004/);
  });

  await t.test('⑧ 상태 배지 문구', async () => {
    const { w, d } = await loaded();
    [...$(d, 'chips').querySelectorAll('.chip')].find((c) => c.textContent.startsWith('전체'))
      .dispatchEvent(new w.Event('click'));
    const body = $(d, 'rowsBody').textContent;
    for (const s of ['완전소진', '전량소진(미계수)', '부분소진', '미소진', '이상(잔량>구매)', '구매이력 없음']) {
      assert.ok(body.includes(s), '상태 배지 누락: ' + s);
    }
  });

  await t.test('⑨ 헤더 클릭 정렬 토글', async () => {
    const { w, d } = await loaded();
    const th = [...d.querySelectorAll('th[data-s]')].find((x) => x.dataset.s === 'consumed_qty');
    th.dispatchEvent(new w.Event('click'));   // 내림차순 → 오름차순
    const first = $(d, 'rowsBody').querySelector('tr').textContent;
    assert.match(first, /CG0007/, '오름차순이면 소진 25 가 맨 위');
    th.dispatchEvent(new w.Event('click'));
    assert.match($(d, 'rowsBody').querySelector('tr').textContent, /CA0001/);
  });

  await t.test('⑩ 체크 해제 시 합계 반영', async () => {
    const { w, d } = await loaded();
    const cb = $(d, 'rowsBody').querySelector('input[data-pid="1"]');
    cb.checked = false; cb.dispatchEvent(new w.Event('change'));
    assert.match($(d, 'actSum').innerHTML, /선택 <b>2<\/b>/);
    assert.match($(d, 'actSum').innerHTML, /100/, '60+40=100');
  });

  await t.test('⑪ 견적으로 오퍼 — 소진수량이 견적 수량으로', async () => {
    const { w, d, calls } = await loaded();
    $(d, 'btnQuote').dispatchEvent(new w.Event('click'));
    await tick(60);
    const q = calls.find((c) => c.method === 'POST' && c.url.includes('/api/quotes'));
    assert.ok(q, '견적 생성 호출');
    assert.equal(q.body.customer_id, 7);
    assert.equal(q.body.lines.length, 3, '판매중단 제외 3건');
    assert.deepEqual(q.body.lines.map((l) => l.qty).sort((a, b) => b - a), [100, 60, 40]);
    assert.ok(!q.body.lines.some((l) => l.product_id === 7), '판매중단 SKU 미포함');
    assert.match(q.body.memo, /소진분석/);
    // 조사에 quote_id 가 없었으므로 mark-quoted 로 연결
    assert.ok(calls.some((c) => c.url.includes('/mark-quoted')), '조사↔견적 연결');
  });

  await t.test('⑫ 이미 견적과 연결된 조사는 mark-quoted 를 다시 부르지 않음', async () => {
    CONSUMPTION.survey.quote_id = 777;
    const { w, d, calls } = await loaded();
    $(d, 'btnQuote').dispatchEvent(new w.Event('click'));
    await tick(60);
    assert.ok(calls.some((c) => c.url.includes('/api/quotes') && c.method === 'POST'));
    assert.ok(!calls.some((c) => c.url.includes('/mark-quoted')), '기존 연결 덮어쓰기 금지');
    CONSUMPTION.survey.quote_id = null;
  });

  await t.test('⑬ 견적 실패(판매중단) 안내', async () => {
    const b = await boot({ quoteError: 'inactive_product' });
    b.d.getElementById('custSel').value = '7';
    b.d.getElementById('custSel').dispatchEvent(new b.w.Event('change'));
    await tick(50);
    b.d.getElementById('btnQuote').dispatchEvent(new b.w.Event('click'));
    await tick(60);
    assert.match(txt(b.d, 'toastTxt'), /판매중단/);
    assert.equal(b.d.getElementById('btnQuote').disabled, false, '버튼 복구');
  });

  await t.test('⑭ 미등록 고객·조사 없음 오류 안내', async () => {
    for (const [err, msg] of [['guest_customer', /미등록/], ['no_survey', /조사 기록이 없습니다/], ['forbidden', /권한/]]) {
      const b = await boot({ consumptionError: err });
      b.d.getElementById('custSel').value = '7';
      b.d.getElementById('custSel').dispatchEvent(new b.w.Event('change'));
      await tick(50);
      assert.match(txt(b.d, 'runMsg'), msg, err);
      assert.ok(b.d.getElementById('pRows').classList.contains('hidden'), err + ' 시 표 숨김');
    }
  });

  await t.test('⑮ 경쟁사 코드 섹션 — 개발요청 등록 여부 표시', async () => {
    const { d } = await loaded();
    const u = $(d, 'unmBody').textContent;
    assert.match(u, /TRW-9911/); assert.match(u, /MOOG-77/);
    assert.match(u, /등록됨 #12/); assert.match(u, /미등록/);
    assert.ok(!$(d, 'rowsBody').textContent.includes('TRW-9911'), '소진표에 섞이면 안 됨');
  });

  await t.test('⑯ 기준 조사 전환(이력 행 클릭 → survey_id 조회)', async () => {
    const { w, d, calls } = await loaded();
    const tr = [...$(d, 'histBody').querySelectorAll('tr[data-sid]')].find((x) => x.dataset.sid === '41');
    tr.dispatchEvent(new w.Event('click'));
    await tick(50);
    assert.ok(calls.some((c) => c.url.includes('consumption?survey_id=41')), '과거 조사 기준 재계산');
  });

  await t.test('⑯-2 고객 분석 시 조사 이력을 /history 로 다시 채움 (3분류·견적번호·위치)', async () => {
    const { d, calls } = await loaded();
    assert.ok(calls.some((c) => c.url.includes('/history?customer_id=7')), '고객 기준 이력 재조회');
    const h = $(d, 'histBody').textContent;
    assert.match(h, /2026-08-15/);
    assert.match(h, /영업A/);
    assert.ok($(d, 'histBody').querySelectorAll('a[href*="google.com/maps"]').length > 0, '위치 링크');
  });

  await t.test('⑰ XSS 이스케이프', async () => {
    const bad = row({ product_id: 99, ctr_code: '<img src=x onerror=alert(1)>', name: '<script>bad</script>', purchased_qty: 10, onhand_qty: 0, consumed_qty: 10, status: 'gone' });
    ITEMS.push(bad);
    const { d } = await loaded();
    assert.equal($(d, 'rowsBody').querySelectorAll('img').length, 0, 'img 태그가 실제로 생기면 안 됨');
    assert.match($(d, 'rowsBody').innerHTML, /&lt;img/);
    ITEMS.pop();
  });

  await t.test('⑱ 소진분 전체 선택 버튼', async () => {
    const { w, d } = await loaded();
    $(d, 'rowsBody').querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.checked = false; cb.dispatchEvent(new w.Event('change')); });
    assert.match($(d, 'actSum').innerHTML, /선택 <b>0<\/b>/);
    assert.equal($(d, 'btnQuote').disabled, true, '선택 0이면 오퍼 버튼 비활성');
    $(d, 'btnPickAll').dispatchEvent(new w.Event('click'));
    assert.match($(d, 'actSum').innerHTML, /선택 <b>3<\/b>/);
  });
});
