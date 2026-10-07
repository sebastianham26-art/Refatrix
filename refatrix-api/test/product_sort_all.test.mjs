// =====================================================================
// 2026-10-07 · 제품찾기 목록 — 모든 열 제목 클릭 정렬  refatrix-products.html ps-1007srt1
//   A) 서버: productRoutes 의 SORTS 키가 모두 실제 ORDER BY 로 쓰이고(pg-mem 실행), 권한 없는 원가/가격 정렬은 폴백.
//   B) 화면: 코드·상태·SyD·적용차종·바코드·랙·소재·재고·Backorder·누적판매·List Price·원가 헤더가 모두 sortable,
//      첫 클릭 방향(텍스트 asc / 숫자 desc), 재클릭 토글, 요청 URL 에 sort/dir.
//   실행: node --test test/product_sort_all.test.mjs   (jsdom · pg-mem 필요)
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const P_HTML = resolve(here, '..', '..', 'refatrix-products.html');
const ROUTES = resolve(here, '..', 'src', 'routes', 'productRoutes.js');
let JSDOM = null, newDb = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* skip */ }
try { ({ newDb } = await import('pg-mem')); } catch { /* skip */ }
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

// ── A) 서버 정렬식 ──────────────────────────────────────────────────
// 운영 소스에서 SORTS 블록을 그대로 떼어 와 평가한다(복붙 사본 금지).
function loadSorts(dir, { canCost = true, canPrice = true } = {}) {
  const src = readFileSync(ROUTES, 'utf-8');
  const a = src.indexOf('const txt = (col)');
  const b = src.indexOf('};', src.indexOf('const SORTS = {')) + 2;
  assert.ok(a > 0 && b > a, 'SORTS 블록을 찾지 못함');
  // eslint-disable-next-line no-new-func
  return new Function('dir', 'canCost', 'canPrice', src.slice(a, b) + '\nreturn SORTS;')(dir, canCost, canPrice);
}

test('A · 서버 정렬 키', { skip: !newDb }, async (t) => {
  const db = newDb();
  // pg-mem 은 btrim 미구현(운영 PostgreSQL 내장) — 테스트에서만 등록
  db.public.registerFunction({ name: 'btrim', args: ['text'], returns: 'text', implementation: (x) => (x == null ? null : String(x).trim()) });
  db.public.registerFunction({ name: 'nullif', args: ['text', 'text'], returns: 'text', implementation: (a, b) => (a === b ? null : a) });
  db.public.none(`CREATE TABLE products(id int primary key, code text, scode text, app text, ean text, material text,
                    list_price numeric, stock_qty numeric, avg_cost numeric, rack_location text, is_active boolean);
    INSERT INTO products VALUES
      (1,'B200','zz-1','VERSA 2012','750111',NULL, 300, 5, 10,'A-01',true),
      (2,'A100',NULL,'aveo 2010', NULL,'aluminio', 100, 0, 20, NULL, false),
      (3,'C300','AA-9','',        '750000','aluminio', NULL, 9, NULL,'B-02',true);`);
  const run = (order) => db.public.many(`SELECT p.id FROM products p
       LEFT JOIN (SELECT 1 AS product_id, 2 AS backorder_qty) bo ON bo.product_id=p.id
       LEFT JOIN (SELECT 1 AS product_id, 0 AS incoming_qty) inc ON inc.product_id=p.id
       LEFT JOIN (SELECT 3 AS product_id, 7 AS qty) sold ON sold.product_id=p.id
       ORDER BY ${order}`).map((r) => r.id);

  await t.test('새 키 7개가 모두 존재·실행된다(ASC/DESC)', () => {
    for (const d of ['ASC', 'DESC']) {
      const S = loadSorts(d);
      for (const k of ['code', 'active', 'syd', 'app', 'ean', 'material', 'listprice', 'stock', 'rack', 'backorder', 'sold', 'avgcost', 'stockval']) {
        assert.ok(S[k], k + ' 키'); assert.equal(run(S[k]).length, 3, k + ' ' + d);
      }
    }
  });
  await t.test('텍스트 정렬 — 대소문자 무시, 빈 값은 방향과 무관하게 맨 뒤', () => {
    assert.deepEqual(run(loadSorts('ASC').app), [2, 1, 3]);   // AVEO, VERSA, (빈)
    assert.deepEqual(run(loadSorts('DESC').app), [1, 2, 3]);  // VERSA, AVEO, (빈)
    assert.deepEqual(run(loadSorts('ASC').syd), [3, 1, 2]);   // AA-9, ZZ-1, (NULL)
    assert.deepEqual(run(loadSorts('DESC').ean), [1, 3, 2]);
    assert.deepEqual(run(loadSorts('ASC').material), [2, 3, 1], '같은 소재는 코드순(A100 < C300)');
  });
  await t.test('상태 · List Price', () => {
    assert.deepEqual(run(loadSorts('DESC').active)[2], 2, 'DESC = 활성 먼저, 비활성 뒤');
    assert.deepEqual(run(loadSorts('DESC').listprice), [1, 2, 3], '가격 없는 제품은 맨 뒤');
  });
  await t.test('권한 없음 → 원가·가격 정렬 키 없음(코드순 폴백)', () => {
    const S = loadSorts('DESC', { canCost: false, canPrice: false });
    assert.equal(S.listprice, null); assert.equal(S.avgcost, null); assert.equal(S.stockval, null);
  });
});

// ── B) 화면 ─────────────────────────────────────────────────────────
async function boot() {
  const calls = [];
  const dom = new JSDOM(readFileSync(P_HTML, 'utf-8'), {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-products.html#tab=search',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 'T', api: 'https://api.test', user: { name: 'D', role: 'director' } }));
      w.alert = () => {}; w.confirm = () => true;
      w.fetch = async (url) => {
        const u = String(url); calls.push(u);
        const d = /\/api\/products\?/.test(u)
          ? { items: [{ id: 1, code: 'A1', scode: 'S', app: 'X', ean: '7', stock_qty: 1, list_price: 10, avg_cost: 5, is_active: true }], total: 1 }
          : { items: [], total: 0 };
        return { ok: true, status: 200, json: async () => d };
      };
    },
  });
  const w = dom.window;
  await new Promise((r) => { if (w.document.readyState === 'complete') r(); else w.addEventListener('load', r); });
  await tick(100);
  w.document.getElementById('q').value = 'A1'; w.doSearch(); await tick(120);
  return { w, d: w.document, calls };
}

test('B · 화면 헤더 정렬 (jsdom)', { skip: !JSDOM || !existsSync(P_HTML) }, async (t) => {
  const c = await boot();
  const lastUrl = () => [...c.calls].reverse().find((u) => /\/api\/products\?/.test(u));
  const th = (k) => c.d.querySelector('#result th.sortable[data-sort="' + k + '"]');
  const click = async (k) => { th(k).dispatchEvent(new c.w.Event('click')); await tick(120); };

  await t.test('모든 열 제목이 정렬 가능(체크박스 열 제외)', () => {
    const keys = [...c.d.querySelectorAll('#result thead th.sortable')].map((x) => x.getAttribute('data-sort'));
    assert.deepEqual(keys, ['code', 'active', 'syd', 'app', 'ean', 'rack', 'material', 'stock', 'backorder', 'sold', 'listprice', 'avgcost', 'stockval']);
    const non = [...c.d.querySelectorAll('#result thead th:not(.sortable)')];
    assert.equal(non.length, 1); assert.ok(non[0].classList.contains('selc'));
    assert.match(th('active').getAttribute('title'), /비활성/, '상태 설명 툴팁 유지');
    assert.match(th('syd').getAttribute('title'), /OE/, 'OE 툴팁 유지');
  });
  await t.test('텍스트 열 첫 클릭 = asc, 재클릭 = desc · 화살표 표시', async () => {
    await click('app');
    assert.match(lastUrl(), /sort=app&dir=asc/); assert.match(lastUrl(), /offset=0/);
    assert.match(th('app').textContent, /▲/); assert.ok(th('app').classList.contains('active'));
    await click('app'); assert.match(lastUrl(), /sort=app&dir=desc/); assert.match(th('app').textContent, /▼/);
    await click('code'); assert.match(lastUrl(), /sort=code&dir=asc/);
    assert.ok(!th('app').classList.contains('active'), '이전 열 표시 해제');
  });
  await t.test('숫자 열 첫 클릭 = desc · 상태 첫 클릭 = desc(활성 먼저)', async () => {
    await click('listprice'); assert.match(lastUrl(), /sort=listprice&dir=desc/);
    await click('active'); assert.match(lastUrl(), /sort=active&dir=desc/);
    await click('stock'); assert.match(lastUrl(), /sort=stock&dir=desc/);
  });
  await t.test('정렬 헤더 클릭은 행 드릴다운을 열지 않는다', () => {
    assert.equal(c.calls.some((u) => /drilldown/.test(u)), false);
  });
});
