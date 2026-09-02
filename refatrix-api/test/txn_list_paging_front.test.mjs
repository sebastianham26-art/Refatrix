// =====================================================================
// 재무 > 거래목록 「더 보기」 페이지네이션 — refatrix-finance.html 을 jsdom 에서
// 실제로 구동해 검증한다 (build fin-0902a).
//
//   디렉터 신고(2026-09-02): "거래목록에서 7월 1일 이전 내역이 안 보인다.
//     계좌를 금고로 고르면 6월도 나오는데, 전체 계좌로 하면 7월 1일부터만 보인다."
//   원인: 서버가 `ORDER BY txn_date DESC ... LIMIT 200` 고정이라, 전체 계좌처럼 건수가
//     많은 조건에서는 7월 이후 거래만으로 200건이 차서 6월이 잘려 나갔다. 계좌를 좁히면
//     200건 안에 6월이 들어와 보였던 것 — 날짜 필터 버그가 아니라 표시 상한이었다.
//   대응: limit/offset 을 받도록 하고 프런트에 [더 보기] 를 달아 이어받게 했다.
//
// 픽스처는 그 상황을 그대로 재현한다 — 1페이지(200건)는 전부 7월 이후, 6월 거래는
// 2페이지에만 있다. 즉 ④번 테스트가 이번 신고의 회귀 테스트다.
// =====================================================================
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import assert from 'node:assert';

const HTML = readFileSync(new URL('../../refatrix-finance.html', import.meta.url), 'utf8');
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const ACCOUNTS = [
  { id: 1, name: 'BBVA', currency: 'MXN', balance: 0, balance_mxn: 0, can_detail: true },
  { id: 2, name: '금고', currency: 'MXN', balance: 0, balance_mxn: 0, can_detail: true },
];

// id 를 날짜 역순으로 매기면 서버 정렬(txn_date DESC, id DESC)과 같은 순서가 된다.
function txn(id, date, amount = 1000, extra = {}) {
  return {
    id, txn_date: date, direction: 'out', amount, amount_mxn: amount, fx_rate: 1, currency: 'MXN',
    category_code: '6030', category_name: '기타', status: 'actual', kind: 'general', approved: true,
    memo: 'row ' + id, account_id: 1, account_name: 'BBVA', recurring_rule_id: null,
    sales_invoice_id: null, source: 'manual', change_count: 0, edit_count: 0, editable: true, ...extra,
  };
}

// 1페이지 200건 = 전부 7월 이후 / 2페이지 50건 = 전부 6월  ← 신고 상황 그대로
const PAGE1 = Array.from({ length: 200 }, (_, i) => txn(1000 - i, '2026-07-0' + ((i % 9) + 1)));
const PAGE2 = Array.from({ length: 50 }, (_, i) => txn(800 - i, '2026-06-1' + ((i % 9) + 1)));
const ALL = PAGE1.concat(PAGE2);

// limit/offset 을 실제로 적용하는 최신 백엔드 흉내
function serve(rows, { legacy = false } = {}) {
  return (u) => {
    const qs = new URLSearchParams(u.split('?')[1] || '');
    if (legacy) return { items: JSON.parse(JSON.stringify(rows.slice(0, 200))) };   // offset 무시 · has_more 없음
    const limit = Number(qs.get('limit') || 200);
    const offset = Number(qs.get('offset') || 0);
    const slice = rows.slice(offset, offset + limit);
    return { limit, offset, has_more: offset + slice.length < rows.length, items: JSON.parse(JSON.stringify(slice)) };
  };
}

function boot({ director = true, rows = ALL, legacy = false } = {}) {
  const calls = [];
  const handler = serve(rows, { legacy });
  const dom = new JSDOM(HTML.replace(/<script src=[^>]*><\/script>/g, ''), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/',
  });
  const w = dom.window;
  const j = (o) => ({ ok: true, status: 200, json: async () => o });
  w.fetch = async (url, opt = {}) => {
    const u = String(url);
    calls.push({ url: u, method: (opt.method || 'GET').toUpperCase() });
    if (u.includes('/api/transactions?') && !u.includes('pending') && !u.includes('export')) return j(handler(u));
    if (u.includes('/api/accounts')) return j({ items: JSON.parse(JSON.stringify(ACCOUNTS)) });
    return j({ items: [] });
  };
  w.alert = () => {};
  w.eval(`session={token:'t',user:{id:1,name:'Dir',role:'${director ? 'director' : 'treasury'}'},api:''}; accounts=${JSON.stringify(ACCOUNTS)};`);
  return { w, calls };
}

const rowIds = (w) => Array.from(w.document.querySelectorAll('#txnBody tbody tr.txn-row')).map((r) => Number(r.dataset.id));
const dates = (w) => Array.from(w.document.querySelectorAll('#txnBody tbody tr.txn-row'))
  .map((r) => r.textContent.match(/20\d\d-\d\d-\d\d/)[0]);
const moreBtn = (w) => w.document.getElementById('txn-more');
const txnQs = (calls) => calls.filter((c) => c.url.includes('/api/transactions?')).map((c) => c.url);

test('① 첫 조회는 limit=200 · offset=0 으로 부르고 200건만 그린다', async () => {
  const { w, calls } = boot(); await w.loadTxns(); await tick();
  const urls = txnQs(calls);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /limit=200/);
  assert.match(urls[0], /offset=0/);
  assert.equal(rowIds(w).length, 200);
});

test('② 더 받을 게 있으면 [더 보기] 버튼이 뜬다', async () => {
  const { w } = boot(); await w.loadTxns(); await tick();
  const b = moreBtn(w);
  assert.ok(b, '더 보기 버튼');
  assert.match(b.textContent, /더 보기/);
  assert.match(w.document.getElementById('txnMore').textContent, /200건/);
});

test('③ 마지막 페이지까지 받으면 버튼이 사라진다', async () => {
  const { w } = boot(); await w.loadTxns(); await tick();
  moreBtn(w).click(); await tick(20);
  assert.equal(rowIds(w).length, 250, '200 + 50');
  assert.equal(moreBtn(w), null, '더 이상 없으면 버튼 없음');
});

test('④ ★ 신고 재현 — 1페이지엔 없던 6월 거래가 [더 보기] 후 나타난다', async () => {
  const { w } = boot(); await w.loadTxns(); await tick();
  assert.equal(dates(w).filter((d) => d.startsWith('2026-06')).length, 0, '처음엔 6월이 안 보인다(신고 상황)');
  assert.ok(dates(w).every((d) => d >= '2026-07-01'), '7월 1일부터만 보인다');

  moreBtn(w).click(); await tick(20);
  assert.equal(dates(w).filter((d) => d.startsWith('2026-06')).length, 50, '6월 50건이 모두 나온다');
});

test('⑤ 두 번째 요청은 offset=200 이고, 앞 페이지를 지우지 않고 이어붙인다', async () => {
  const { w, calls } = boot(); await w.loadTxns(); await tick();
  const first = rowIds(w);
  moreBtn(w).click(); await tick(20);
  const urls = txnQs(calls);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /offset=200/);
  assert.deepEqual(rowIds(w).slice(0, 200), first, '앞 200건 유지');
  assert.equal(new Set(rowIds(w)).size, 250, '중복 행 없음');
});

test('⑥ 요약 합계·건수가 불러온 전체 범위로 누적된다', async () => {
  const { w } = boot(); await w.loadTxns(); await tick();
  const s1 = w.document.getElementById('txnSummary').textContent;
  assert.match(s1, /200건/);
  assert.match(s1, /더 있습니다/);
  moreBtn(w).click(); await tick(20);
  const s2 = w.document.getElementById('txnSummary').textContent;
  assert.match(s2, /250건/);
  assert.match(s2, /전부 표시/);
  // 실적 지출 250건 × 1,000 = 250,000
  assert.match(s2.replace(/\s+/g, ''), /250,000/);
});

test('⑦ 필터를 바꾸면 offset 이 0 으로 초기화되고 목록도 갈아엎는다', async () => {
  const ctx = boot(); await ctx.w.loadTxns(); await tick();
  moreBtn(ctx.w).click(); await tick(20);
  assert.equal(rowIds(ctx.w).length, 250);

  const sel = ctx.w.document.getElementById('f-acc');
  sel.value = '2';
  sel.dispatchEvent(new ctx.w.Event('change', { bubbles: true }));
  await tick(20);
  const urls = txnQs(ctx.calls);
  assert.match(urls[urls.length - 1], /offset=0/, '필터 변경은 항상 첫 페이지부터');
  assert.equal(rowIds(ctx.w).length, 200, '이전 250건이 남아 있지 않다');
});

test('⑧ 조회 버튼(f-go)도 이어붙이기가 아니라 새로 조회한다 (이벤트 객체 오전달 방지)', async () => {
  const ctx = boot(); await ctx.w.loadTxns(); await tick();
  ctx.w.document.getElementById('f-go').click(); await tick(20);
  const urls = txnQs(ctx.calls);
  assert.match(urls[urls.length - 1], /offset=0/);
  assert.equal(rowIds(ctx.w).length, 200, '중복 누적 없음');
});

test('⑨ 구백엔드(has_more 미제공)면 더보기를 감추고 기간 필터를 안내한다', async () => {
  const { w } = boot({ legacy: true }); await w.loadTxns(); await tick();
  assert.equal(rowIds(w).length, 200);
  assert.equal(moreBtn(w), null, '무한 중복을 부르는 더보기는 노출하지 않는다');
  assert.match(w.document.getElementById('txnMore').textContent, /기간/);
});

test('⑩ 결과가 한 페이지에 다 들어오면 더보기도 안내도 없다', async () => {
  const { w } = boot({ rows: PAGE2 }); await w.loadTxns(); await tick();
  assert.equal(rowIds(w).length, 50);
  assert.equal(moreBtn(w), null);
  assert.equal(w.document.getElementById('txnMore').textContent.trim(), '');
  assert.match(w.document.getElementById('txnSummary').textContent, /50건/);
});

test('⑪ 0건이면 빈 안내만 뜨고 더보기는 없다', async () => {
  const { w } = boot({ rows: [] }); await w.loadTxns(); await tick();
  assert.match(w.document.getElementById('txnBody').textContent, /거래가 없습니다/);
  assert.equal(moreBtn(w), null);
});

test('⑫ 이어받은 행도 예정 삭제 선택 대상에 들어간다 (디렉터)', async () => {
  const plans = PAGE2.map((t) => ({ ...t, status: 'plan' }));
  const { w } = boot({ rows: PAGE1.concat(plans) }); await w.loadTxns(); await tick();
  assert.equal(w.document.getElementById('txn-selall'), null, '1페이지엔 예정이 없어 선택 열 없음');
  moreBtn(w).click(); await tick(20);
  assert.ok(w.document.getElementById('txn-selall'), '2페이지의 예정이 들어오면 선택 열이 생긴다');
  w.txnSelectVisible(true, false); await tick();
  assert.match(w.document.getElementById('txn-selinfo').textContent, /선택 50건/);
});

test('⑬ 빌드 마커', () => {
  assert.match(HTML, /build fin-0902a/);
});
