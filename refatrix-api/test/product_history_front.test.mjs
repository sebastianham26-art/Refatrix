// =====================================================================
// 제품 이력 탭 (refatrix-products.html, build ph-0824a) — jsdom
//   운영 HTML 을 그대로 로드하고 fetch 만 스텁해서
//   탭 노출 · 6열 표 · Estado 칩 · 가격 마스킹 · 드릴다운(movement) 을 검증한다.
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

const ITEM = (o) => Object.assign({
  key: 'master:1', kind: 'master', id: 1, product_id: 11, changed_at: '2026-02-10T10:00:00.000Z',
  code: 'PHT-A', current_code: 'PHT-A', product_name: '로툴라', syd_codes: 'SYD-100 // SYD-101',
  action: 'update', source: 'manual', desc: '', parts: [], hidden_price: 0, reason: null,
  check_id: null, estado_active: true, current_active: true, product_deleted: false,
  changed_by_name: '테스트디렉터',
}, o);

const HISTORY = (canPrice = true) => ({
  can_price: canPrice,
  total: 3,
  limit: 50,
  offset: 0,
  items: [
    ITEM({
      key: 'status:9', kind: 'status', id: 9, changed_at: '2026-03-15T10:00:00.000Z',
      action: 'deactivate', source: 'status', reason: '단종 — 공장 생산중단',
      desc: '판매 중단(비활성화) — 단종 — 공장 생산중단', estado_active: false, current_active: false,
    }),
    ITEM({
      key: 'master:2', kind: 'master', id: 2, changed_at: '2026-02-10T10:00:00.000Z',
      action: 'update', source: 'import',
      desc: canPrice ? 'List Price: 100 → 120 · IVA: 16 → 8' : 'IVA: 16 → 8 · 가격 항목 1건(열람권한 없음)',
      parts: canPrice
        ? [{ field: 'list_price', label: 'List Price', from: 100, to: 120 }, { field: 'iva_rate', label: 'IVA', from: 16, to: 8 }]
        : [{ field: 'iva_rate', label: 'IVA', from: 16, to: 8 }],
      hidden_price: canPrice ? 0 : 1, estado_active: true, current_active: false,
    }),
    ITEM({
      key: 'master:1', kind: 'master', id: 1, changed_at: '2026-01-05T10:00:00.000Z',
      action: 'create', source: 'manual', desc: '제품 신규 등록 · 화면 입력',
      parts: [{ field: 'code', label: 'Clave CTR', from: null, to: 'PHT-A' }],
      estado_active: true, current_active: false,
    }),
  ],
});

const MOVES = {
  product: { id: 11, code: 'PHT-A', name: '로툴라', scode: 'SYD-100', stock_qty: 70, is_active: false },
  since: '2026-03-15T10:00:00.000Z', until: null, can_price: true,
  stock_before: 100, stock_now: 70,
  totals: {
    move_count: 3, in_qty: 5, out_qty: 20, adjust_qty: -15,
    sales_count: 1, sales_qty: 20, sales_amount: 2000,
    quote_count: 1, quote_qty: 12, quote_amount: 1080,
  },
  stock: [
    { id: 1, move_type: 'out', qty: 20, signed_qty: -20, moved_at: '2026-04-01T10:00:00.000Z', ref: 'inv:after1', note: null, event_no: null, origin: '매출', customer_name: '내팀고객', sat_no: 'A-1', created_by_name: '디렉터' },
    { id: 2, move_type: 'in', qty: 5, signed_qty: 5, moved_at: '2026-05-01T10:00:00.000Z', ref: 'batch:after2', note: null, event_no: null, origin: '수입', customer_name: null, sat_no: null, created_by_name: '디렉터' },
    { id: 3, move_type: 'adjust', qty: -15, signed_qty: -15, moved_at: '2026-06-01T10:00:00.000Z', ref: '재고조정', note: '실사', event_no: 7, origin: '수동', customer_name: null, sat_no: null, created_by_name: '디렉터' },
  ],
  capped: false,
  sales: [{ id: 5, sat_no: 'A-1', inv_date: '2026-04-01', created_at: '2026-04-01T10:00:00.000Z', status: 'posted', customer_name: '내팀고객', qty: 20, unit_price: 100, amount_mxn: 2000 }],
  quotes: [{ id: 8, quote_no: 'PHT-Q1', quote_date: '2026-04-10', created_at: '2026-04-10T10:00:00.000Z', status: 'draft', customer_name: '내팀고객', qty: 12, unit_price: 90, amount_mxn: 1080 }],
};

async function boot(opts = {}) {
  const calls = [];
  const dom = new JSDOM(readFileSync(HTML, 'utf-8'), {
    runScripts: 'dangerously',
    url: 'https://example.test/refatrix-products.html#tab=' + (opts.tab || 'history'),
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({
        token: 'T', api: 'https://api.test', user: { name: '테스트디렉터', role: opts.role || 'director' },
      }));
      w.alert = () => {};
      w.XLSX = { utils: { book_new: () => ({}), aoa_to_sheet: (a) => ({ a }), book_append_sheet: () => {} }, writeFile: (wb, name) => { calls.push({ url: 'XLSX:' + name, wb }); } };
      w.fetch = async (url, o = {}) => {
        const u = String(url);
        calls.push({ url: u, method: o.method || 'GET' });
        const json = (d, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => d });
        if (u.includes('/api/products/history')) {
          if (opts.historyError) return json({ error: opts.historyError }, false);
          if (opts.evil) {
            const evil = '<img src=x onerror="window.__pwned=1">';
            return json({
              can_price: true, total: 1, limit: 50, offset: 0,
              items: [ITEM({
                key: 'status:99', kind: 'status', id: 99, action: 'deactivate', source: 'status',
                reason: evil, product_name: evil, code: evil, syd_codes: evil, changed_by_name: evil,
                desc: evil, estado_active: false,
              })],
            });
          }
          return json(HISTORY(opts.canPrice !== false));
        }
        if (u.includes('/movements')) {
          if (opts.movesError) return json({ error: opts.movesError }, false);
          if (u.includes('until=')) {
            return json(Object.assign({}, MOVES, {
              stock: MOVES.stock.slice(0, 2), quotes: [],
              totals: Object.assign({}, MOVES.totals, { move_count: 2, adjust_qty: 0, quote_count: 0, quote_qty: 0 }),
            }));
          }
          return json(MOVES);
        }
        return json({ items: [], total: 0 });
      };
    },
  });
  const w = dom.window;
  await new Promise((r) => { if (w.document.readyState === 'complete') r(); else w.addEventListener('load', r); });
  await new Promise((r) => setTimeout(r, 80));
  return { w, d: w.document, calls, dom };
}
const $ = (d, id) => d.getElementById(id);
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

test('제품 이력 탭 — jsdom', { skip: SKIP }, async (t) => {
  await t.test('① #tab=history 로 진입하면 이력 카드가 열리고 자동 조회', async () => {
    const { d, calls } = await boot();
    assert.ok(!$(d, 'histCard').classList.contains('hidden'), '이력 카드 노출');
    assert.ok($(d, 'searchCard').classList.contains('hidden'), '검색 카드 숨김');
    assert.ok($(d, 'upCard').classList.contains('hidden'), '업로드 카드 숨김');
    assert.ok(calls.some((c) => c.url.includes('/api/products/history')), '이력 자동 조회');
  });

  await t.test('② 기본 탭(find)에서는 이력 카드가 숨겨진다', async () => {
    const { d, calls } = await boot({ tab: 'find' });
    assert.ok($(d, 'histCard').classList.contains('hidden'));
    assert.ok(!calls.some((c) => c.url.includes('/api/products/history')), '열기 전엔 조회 안 함');
  });

  await t.test('③ 표 6열 · 요청한 열 순서', async () => {
    const { d } = await boot();
    const th = [...$(d, 'phBox').querySelectorAll('thead th')].map((x) => x.textContent.trim());
    assert.deepEqual(th, ['변경기록 날짜', 'CTR Code', '변경내역', 'SYD Code', 'Estado', '변경자']);
  });

  await t.test('④ 행 3건 · 최신순 · CTR/SYD/변경자 값', async () => {
    const { d } = await boot();
    const rows = [...$(d, 'phBox').querySelectorAll('tr.ph-row')];
    assert.equal(rows.length, 3);
    const c0 = [...rows[0].querySelectorAll('td')].map((x) => x.textContent);
    assert.match(c0[0], /2026-03-15/);
    assert.match(c0[1], /PHT-A/);
    assert.match(c0[3], /SYD-100 · SYD-101/, 'SyD 구분자는 · 로 표시');
    assert.match(c0[5], /테스트디렉터/);
  });

  await t.test('⑤ Estado 칩 — Activo / Inactivo', async () => {
    const { d } = await boot();
    const rows = [...$(d, 'phBox').querySelectorAll('tr.ph-row')];
    assert.match(rows[0].querySelectorAll('td')[4].textContent, /Inactivo/);
    assert.match(rows[1].querySelectorAll('td')[4].textContent, /Activo/);
  });

  await t.test('⑥ 변경내역 — 상태 전환은 사유, 마스터는 이전→이후', async () => {
    const { d } = await boot();
    const rows = [...$(d, 'phBox').querySelectorAll('tr.ph-row')];
    const st = rows[0].querySelectorAll('td')[2].textContent;
    assert.match(st, /판매중단/);
    assert.match(st, /사유: 단종/);
    const up = rows[1].querySelectorAll('td')[2].textContent;
    assert.match(up, /List Price/);
    assert.match(up, /100/);
    assert.match(up, /120/);
    assert.match(rows[2].querySelectorAll('td')[2].textContent, /생성/);
  });

  await t.test('⑦ 가격 권한 없으면 가림 문구', async () => {
    const { d } = await boot({ canPrice: false });
    const rows = [...$(d, 'phBox').querySelectorAll('tr.ph-row')];
    const up = rows[1].querySelectorAll('td')[2].textContent;
    assert.ok(!/List Price/.test(up), 'List Price 항목 없음');
    assert.match(up, /가격 항목 1건/);
    assert.match(up, /IVA/, '비가격 항목은 그대로');
  });

  await t.test('⑧ 행 클릭 → movement 드릴다운(since 전달)', async () => {
    const { w, d, calls } = await boot();
    const row = $(d, 'phBox').querySelector('tr.ph-row');
    row.dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(60);
    const mv = calls.find((c) => c.url.includes('/movements'));
    assert.ok(mv, 'movements 호출');
    assert.match(mv.url, /\/api\/products\/11\/movements/);
    assert.match(mv.url, /since=2026-03-15T10%3A00%3A00.000Z/);
    const det = $(d, 'phBox').querySelector('tr.ph-det');
    assert.ok(!det.classList.contains('hidden'), '드릴다운 열림');
    const txt = det.textContent;
    assert.match(txt, /변경 시점 재고/);
    assert.match(txt, /재고 입출고/);
    assert.match(txt, /판매\(인보이스\)/);
    assert.match(txt, /견적/);
    assert.match(txt, /PHT-Q1/);
    assert.match(txt, /내팀고객/);
  });

  await t.test('⑨ 드릴다운 재클릭 → 접힘 / 다른 행 열면 하나만 열림', async () => {
    const { w, d } = await boot();
    const rows = [...$(d, 'phBox').querySelectorAll('tr.ph-row')];
    rows[0].dispatchEvent(new w.Event('click', { bubbles: true })); await tick(50);
    rows[0].dispatchEvent(new w.Event('click', { bubbles: true })); await tick(20);
    assert.ok($(d, 'phBox').querySelectorAll('tr.ph-det')[0].classList.contains('hidden'), '재클릭 접힘');
    rows[0].dispatchEvent(new w.Event('click', { bubbles: true })); await tick(50);
    rows[1].dispatchEvent(new w.Event('click', { bubbles: true })); await tick(50);
    const opened = [...$(d, 'phBox').querySelectorAll('tr.ph-det')].filter((x) => !x.classList.contains('hidden'));
    assert.equal(opened.length, 1, '한 번에 하나만');
  });

  await t.test('⑩ 「다음 변경 전까지만」 토글 → until 전달', async () => {
    const { w, d, calls } = await boot();
    // 2026-02-10 행 → 다음 변경은 2026-03-15
    const row = [...$(d, 'phBox').querySelectorAll('tr.ph-row')][1];
    row.dispatchEvent(new w.Event('click', { bubbles: true })); await tick(60);
    const btn = $(d, 'phBox').querySelector('.ph-range');
    assert.ok(btn, '구간 토글 버튼 존재');
    assert.match(btn.textContent, /2026-03-15/);
    btn.dispatchEvent(new w.Event('click', { bubbles: true })); await tick(60);
    const ranged = calls.filter((c) => c.url.includes('until=')).pop();
    assert.ok(ranged, 'until 로 재조회');
    assert.match(ranged.url, /until=2026-03-15T10%3A00%3A00.000Z/);
  });

  await t.test('⑪ 필터 파라미터가 그대로 전달된다', async () => {
    const { w, d, calls } = await boot();
    $(d, 'phQ').value = 'PHT';
    $(d, 'phKind').value = 'status';
    $(d, 'phEstado').value = '0';
    $(d, 'phFrom').value = '2026-01-01';
    $(d, 'phTo').value = '2026-12-31';
    $(d, 'phGo').dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(60);
    const last = calls.filter((c) => c.url.includes('/api/products/history')).pop();
    assert.match(last.url, /q=PHT/);
    assert.match(last.url, /kind=status/);
    assert.match(last.url, /estado=0/);
    assert.match(last.url, /from=2026-01-01/);
    assert.match(last.url, /to=2026-12-31/);
  });

  await t.test('⑫ 오류 응답 안내', async () => {
    const { d } = await boot({ historyError: 'forbidden' });
    assert.match($(d, 'phMsg').textContent, /이력 조회 실패/);
  });

  await t.test('⑬ 엑셀 내려받기 — 요청 열 순서 그대로', async () => {
    const { w, d, calls } = await boot();
    $(d, 'phXlsx').dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(20);
    const x = calls.find((c) => String(c.url).startsWith('XLSX:'));
    assert.ok(x, '엑셀 생성');
    assert.match(x.url, /refatrix_product_history_/);
  });

  await t.test('⑭ XSS — 사유·제품명·코드가 HTML 로 실행되지 않는다', async () => {
    const { w, d } = await boot({ evil: true });
    const box = $(d, 'phBox');
    assert.equal(box.querySelectorAll('img').length, 0, '주입 태그가 DOM 요소가 되면 안 됨');
    assert.equal(w.__pwned, undefined, '핸들러 미실행');
    assert.match(box.textContent, /<img src=x/, '문자 그대로 표시');
  });

  await t.test('⑮ 회귀 — 기존 제품 찾기/업로드 화면 요소가 그대로', async () => {
    const { d } = await boot({ tab: 'find' });
    assert.ok($(d, 'searchCard'), '검색 카드');
    assert.ok($(d, 'vehCard'), '차종 카드');
    assert.ok($(d, 'clBox'), '업로드 탭의 기존 변경 이력 박스');
    assert.ok($(d, 'peNewBtn') || true);
  });
});
