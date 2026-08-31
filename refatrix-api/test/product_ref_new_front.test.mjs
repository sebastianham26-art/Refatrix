// =====================================================================
// 제품 마스터 업로드 — 「📄 참조 코드로 신규 등록」 (refatrix-products.html, build pr-0831b)
//   운영 HTML 을 그대로 로드하고 fetch 만 스텁해서
//   참조 검색 · 불러오기 · 비우는 항목 · 하이라이트 · 저장(POST→PATCH 전환) 을 검증한다.
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

// 참조로 쓸 기존 제품 — 마스터 전체 필드
const MASTER = {
  id: 77, code: 'CQ0445L', name: 'ROTULA SUPERIOR', scode: 'SYD-9001 // SYD-9002',
  app: 'NISSAN TSURU 92-17 // NISSAN SENTRA 95-99',
  sat_code: '25172504', origin: 'CHINA', ean: '7501234567890',
  list_price: 1250.5, iva_rate: 16, list_price_syd: 1400,
  price_customer_syd: 980, price_customer_ctr: 890,
  material: 'acero', location: 'FM-01', rack_location: 'A-03-2',
  stock_qty: 42, avg_cost: 310.25,
};

const MASTER78 = {
  id: 78, code: 'CQ0446L', name: 'ROTULA INFERIOR', scode: 'SYD-9003', app: 'FORD FIESTA 02-10',
  sat_code: '25172505', origin: 'COREA', ean: '7509999999999',
  list_price: 700, iva_rate: 16, list_price_syd: 800,
  price_customer_syd: 600, price_customer_ctr: 550,
  material: 'plastico', location: 'FM-09', rack_location: 'B-01-1',
  stock_qty: 5, avg_cost: 100,
};
const MASTERS = { 77: MASTER, 78: MASTER78 };

const LIST = {
  items: [
    { id: 77, code: 'CQ0445L', name: 'ROTULA SUPERIOR', scode: 'SYD-9001 // SYD-9002', is_active: true },
    { id: 78, code: 'CQ0446L', name: 'ROTULA INFERIOR', scode: 'SYD-9003', is_active: true },
  ],
  total: 2,
};

const DRILL = {
  product: { id: 77, code: 'CQ0445L', name: 'ROTULA SUPERIOR', stock_qty: 42, is_active: true },
  cost: { formula: '이동평균', note: '', lines: [] },
  sales: { lines: [] }, totals: {},
};

async function boot(opts = {}) {
  const calls = [];
  const confirms = [];
  const held = [];               // 보류 중인 응답을 테스트가 원하는 시점에 풀어준다
  const state = { confirm: opts.confirmNo ? false : true };
  const dom = new JSDOM(readFileSync(HTML, 'utf-8'), {
    runScripts: 'dangerously',
    url: 'https://example.test/refatrix-products.html#tab=' + (opts.tab || 'upload'),
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({
        token: 'T', api: 'https://api.test',
        user: { name: '테스트디렉터', role: opts.role || 'director' },
      }));
      w.alert = () => {};
      w.confirm = (msg) => { confirms.push(String(msg || '')); return state.confirm; };
      w.fetch = async (url, o = {}) => {
        const u = String(url);
        const body = o.body ? JSON.parse(o.body) : null;
        calls.push({ url: u, method: o.method || 'GET', body });
        const json = (d, ok = true, status = 200) => ({ ok, status, json: async () => d });
        // 응답을 붙잡아 두는 스위치 — 느린 회선에서의 경합을 그대로 재현한다
        const hold = (resp) => new Promise((res) => held.push(() => res(resp)));
        const mm = u.match(/\/api\/products\/(\d+)\/master/);
        if (mm) {
          if (opts.masterError) return json({ error: opts.masterError }, false, 404);
          const d = MASTERS[mm[1]] || opts.master || MASTER;
          const resp = json(opts.master && mm[1] === '77' ? opts.master : d);
          return opts.deferMaster ? hold(resp) : resp;
        }
        if (/\/api\/products\/\d+\/drilldown/.test(u)) return json(DRILL);
        if (/\/api\/products\/changelog/.test(u)) return json({ items: [], total: 0 });
        if (/\/api\/products\/\d+$/.test(u) && (o.method === 'PATCH')) {
          return json({ ok: true, changed: ['name'] });
        }
        if (/\/api\/products$/.test(u) && o.method === 'POST') {
          if (opts.dupCode) return json({ error: 'code_exists', detail: '이미 존재하는 제품코드입니다.' }, false, 409);
          const resp = json({ ok: true, id: 999, code: body && body.code });
          return opts.deferPost ? hold(resp) : resp;
        }
        if (/\/api\/products\?/.test(u)) return json(opts.list || LIST);
        return json({ items: [], total: 0 });
      };
    },
  });
  const w = dom.window;
  await new Promise((r) => { if (w.document.readyState === 'complete') r(); else w.addEventListener('load', r); });
  await new Promise((r) => setTimeout(r, 80));
  const release = async (i = 0) => { const f = held[i]; if (f) { held[i] = null; f(); } await new Promise((r) => setTimeout(r, 60)); };
  return { w, d: w.document, calls, confirms, held, dom, release, setConfirm: (v) => { state.confirm = v; } };
}

const $ = (d, id) => d.getElementById(id);
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const type = (w, el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };

// 신규 모달을 열고 참조 CQ0445L 을 불러온 상태까지 만든다.
async function openWithRef(ctx) {
  const { w, d } = ctx;
  $(d, 'peNewBtn').dispatchEvent(new w.Event('click'));
  type(w, $(d, 'pe_ref'), 'CQ04');
  await tick(360);
  const pick = d.querySelector('#peRefList .pe-ref-pick');
  pick.dispatchEvent(new w.Event('click'));
  await tick(60);
}

test('참조 코드로 신규 등록 — jsdom', { skip: SKIP }, async (t) => {
  await t.test('① 신규 모달에는 참조 바가 있고, 수정 모달에는 없다', async () => {
    const ctx = await boot();
    const { w, d } = ctx;
    $(d, 'peNewBtn').dispatchEvent(new w.Event('click'));
    assert.ok($(d, 'peRefBar'), '신규 모달 — 참조 바 있음');
    assert.ok($(d, 'pe_ref'), '참조 검색창 있음');
    // 수정 모달
    w.openProductEditor(77);
    await tick(60);
    assert.equal($(d, 'peRefBar'), null, '수정 모달 — 참조 바 없음(다른 제품 내용으로 덮어쓰기 방지)');
    assert.equal($(d, 'pe_code').value, 'CQ0445L', '수정 모달은 기존대로 값이 채워짐');
  });

  await t.test('② 참조 검색은 2자 이상부터 · 후보에 [불러오기] 버튼', async () => {
    const ctx = await boot();
    const { w, d, calls } = ctx;
    $(d, 'peNewBtn').dispatchEvent(new w.Event('click'));
    const ref = (n) => calls.filter((c) => /\/api\/products\?q=[^&]+&limit=8/.test(c.url)).length === n;
    type(w, $(d, 'pe_ref'), 'C');
    await tick(360);
    assert.ok(ref(0), '1자면 조회 안 함');
    assert.equal(d.querySelector('#peRefList .pe-ref-pick'), null);
    type(w, $(d, 'pe_ref'), 'CQ04');
    await tick(360);
    assert.ok(calls.some((c) => /\/api\/products\?q=CQ04/.test(c.url)), '2자 이상이면 후보 조회');
    assert.equal(d.querySelectorAll('#peRefList .pe-ref-pick').length, 2, '후보 2건');
  });

  await t.test('③ 불러오기 — 값이 채워지고 code·ean·location·rack_location 은 비어 있다', async () => {
    const ctx = await boot();
    const { d, calls } = ctx;
    await openWithRef(ctx);
    assert.ok(calls.some((c) => c.url.includes('/api/products/77/master')), 'master 조회');
    assert.equal($(d, 'pe_name').value, 'ROTULA SUPERIOR');
    assert.equal($(d, 'pe_scode').value, 'SYD-9001 // SYD-9002');
    assert.equal($(d, 'pe_app').value, 'NISSAN TSURU 92-17 // NISSAN SENTRA 95-99');
    assert.equal($(d, 'pe_sat_code').value, '25172504');
    assert.equal($(d, 'pe_origin').value, 'CHINA');
    assert.equal($(d, 'pe_list_price').value, '1250.5');
    assert.equal($(d, 'pe_iva_rate').value, '16');
    assert.equal($(d, 'pe_list_price_syd').value, '1400');
    assert.equal($(d, 'pe_price_customer_syd').value, '980');
    assert.equal($(d, 'pe_price_customer_ctr').value, '890');
    // 비우는 항목 4개
    assert.equal($(d, 'pe_code').value, '', '제품코드는 비움 — 새 코드를 직접 지정');
    assert.equal($(d, 'pe_ean').value, '', 'Barcode(EAN)는 비움');
    assert.equal($(d, 'pe_location').value, '', 'Fast Movement Location 비움');
    assert.equal($(d, 'pe_rack_location').value, '', 'Rack 위치 비움');
    assert.match($(d, 'peRefInfo').textContent, /CQ0445L/, '어느 코드에서 불러왔는지 표시');
  });

  await t.test('④ 목록에 없는 소재값도 옵션으로 추가되어 선택된다', async () => {
    const ctx = await boot();
    const { d } = ctx;
    await openWithRef(ctx);
    assert.equal($(d, 'pe_material').value, 'acero');
    assert.equal([...$(d, 'pe_material').options].filter((o) => o.value === 'acero').length, 1, '중복 옵션 없음');
  });

  await t.test('⑤ 불러온 칸은 노란 표시 · 직접 고치면 표시가 사라진다', async () => {
    const ctx = await boot();
    const { w, d } = ctx;
    await openWithRef(ctx);
    assert.ok($(d, 'pe_name').classList.contains('reffill'), '불러온 칸 표시');
    assert.ok(!$(d, 'pe_code').classList.contains('reffill'), '비운 칸은 표시 없음');
    type(w, $(d, 'pe_name'), 'ROTULA SUPERIOR REFORZADA');
    assert.ok(!$(d, 'pe_name').classList.contains('reffill'), '직접 고치면 표시 제거');
  });

  await t.test('⑥ [↺ 전부 비우기] — 모든 칸이 비고 안내가 원래대로', async () => {
    const ctx = await boot();
    const { w, d } = ctx;
    await openWithRef(ctx);
    $(d, 'peRefClear').dispatchEvent(new w.Event('click'));
    ['pe_name', 'pe_scode', 'pe_app', 'pe_sat_code', 'pe_origin', 'pe_list_price', 'pe_iva_rate',
      'pe_list_price_syd', 'pe_price_customer_syd', 'pe_price_customer_ctr'].forEach((id) => {
      assert.equal($(d, id).value, '', id + ' 비워짐');
    });
    assert.equal(d.querySelectorAll('#peOv .reffill').length, 0, '노란 표시 전부 제거');
  });

  await t.test('⑦ 코드 없이 저장하면 막힌다', async () => {
    const ctx = await boot();
    const { w, d, calls } = ctx;
    await openWithRef(ctx);
    $(d, 'peSave').dispatchEvent(new w.Event('click'));
    await tick(60);
    assert.match($(d, 'peMsg').textContent, /제품코드/);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'POST 안 감');
  });

  await t.test('⑧ 새 코드로 저장 — POST 본문에 참조값이 실리고 비운 항목은 빈 문자열', async () => {
    const ctx = await boot();
    const { w, d, calls } = ctx;
    await openWithRef(ctx);
    type(w, $(d, 'pe_code'), 'CQ0999L');
    $(d, 'peSave').dispatchEvent(new w.Event('click'));
    await tick(80);
    const post = calls.find((c) => c.method === 'POST' && /\/api\/products$/.test(c.url));
    assert.ok(post, 'POST /api/products');
    assert.equal(post.body.code, 'CQ0999L');
    assert.equal(post.body.name, 'ROTULA SUPERIOR');
    assert.equal(post.body.scode, 'SYD-9001 // SYD-9002');
    assert.equal(post.body.iva_rate, '16');
    assert.equal(post.body.material, 'acero');
    assert.equal(post.body.ean, '', 'EAN 은 참조에서 복사되지 않음');
    assert.equal(post.body.rack_location, '', 'Rack 위치는 참조에서 복사되지 않음');
    assert.equal(post.body.location, '');
    assert.match($(d, 'peMsg').textContent, /추가 완료/);
    assert.match($(d, 'peMsg').textContent, /참조: CQ0445L/, '어느 코드를 참조했는지 메시지에 남김');
  });

  await t.test('⑨ 저장 후 참조 바가 사라지고 수정 모드로 전환 — 두 번째 저장은 PATCH', async () => {
    const ctx = await boot();
    const { w, d, calls } = ctx;
    await openWithRef(ctx);
    type(w, $(d, 'pe_code'), 'CQ0999L');
    $(d, 'peSave').dispatchEvent(new w.Event('click'));
    await tick(80);
    assert.equal($(d, 'peRefBar'), null, '참조 바 제거 — 방금 만든 제품을 덮어쓸 수 없음');
    assert.equal(d.querySelector('#peOv .pm-head .t').textContent, '✎ 제품 수정');
    assert.equal(d.querySelectorAll('#peOv .reffill').length, 0);
    type(w, $(d, 'pe_name'), '이름 수정');
    $(d, 'peSave').dispatchEvent(new w.Event('click'));
    await tick(80);
    assert.ok(calls.some((c) => c.method === 'PATCH' && /\/api\/products\/999$/.test(c.url)), '두 번째는 PATCH — 중복 생성 없음');
    assert.equal(calls.filter((c) => c.method === 'POST' && /\/api\/products$/.test(c.url)).length, 1, 'POST 는 1회뿐');
  });

  await t.test('⑩ 중복 코드는 서버 409 메시지를 그대로 보여준다', async () => {
    const ctx = await boot({ dupCode: true });
    const { w, d } = ctx;
    await openWithRef(ctx);
    type(w, $(d, 'pe_code'), 'CQ0445L');
    $(d, 'peSave').dispatchEvent(new w.Event('click'));
    await tick(80);
    assert.match($(d, 'peMsg').textContent, /이미 존재하는 제품코드/);
    assert.ok($(d, 'peRefBar'), '실패했으니 참조 바는 그대로 남는다');
  });

  await t.test('⑪ 업로드 탭 검색 결과 행의 [📄 이 코드로 신규] → 자동 불러오기', async () => {
    const ctx = await boot();
    const { w, d } = ctx;
    type(w, $(d, 'peQ'), 'CQ04');
    await tick(360);
    const btn = d.querySelector('#peQList .pe-ref-new');
    assert.ok(btn, '행에 신규 버튼');
    btn.dispatchEvent(new w.Event('click'));
    await tick(80);
    assert.ok($(d, 'peRefBar'), '신규 모달');
    assert.equal($(d, 'pe_name').value, 'ROTULA SUPERIOR', '바로 불러와짐');
    assert.equal($(d, 'pe_code').value, '', '코드는 비어 있음');
  });

  await t.test('⑫ 제품검색 드릴다운의 [📄 이 코드로 신규] — 디렉터만 보인다', async () => {
    const ctx = await boot({ tab: 'find' });
    const { w, d } = ctx;
    await tick(60);
    const row = d.querySelector('#result tr.prow');
    assert.ok(row, '검색 결과 행');
    row.dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(80);
    const icon = d.querySelector('.pdrill .refnewicon');
    assert.ok(icon, '드릴다운에 신규 아이콘');
    icon.dispatchEvent(new w.Event('click', { bubbles: true }));
    await tick(80);
    assert.ok($(d, 'peRefBar'));
    assert.equal($(d, 'pe_name').value, 'ROTULA SUPERIOR');

    const ctx2 = await boot({ tab: 'find', role: 'sales' });
    await tick(60);
    const row2 = ctx2.d.querySelector('#result tr.prow');
    if (row2) {
      row2.dispatchEvent(new ctx2.w.Event('click', { bubbles: true }));
      await tick(80);
      assert.equal(ctx2.d.querySelector('.pdrill .refnewicon'), null, '비디렉터에겐 안 보임');
    }
  });

  await t.test('⑬ 수정 모드에서는 참조 적용이 무시된다(가드)', async () => {
    const ctx = await boot();
    const { w, d } = ctx;
    w.openProductEditor(77);
    await tick(60);
    $(d, 'pe_name').value = '내가 고친 이름';
    await w.peApplyRef(78);
    await tick(60);
    assert.equal($(d, 'pe_name').value, '내가 고친 이름', '수정 중인 값이 덮이지 않음');
  });

  await t.test('⑭ 참조 데이터의 HTML 은 실행되지 않는다(XSS)', async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    const ctx = await boot({
      list: { items: [{ id: 77, code: evil, name: evil, scode: evil, is_active: true }], total: 1 },
      master: Object.assign({}, MASTER, { code: evil, name: evil }),
    });
    const { w, d } = ctx;
    await openWithRef(ctx);
    assert.equal(w.__pwned, undefined, '스크립트 미실행');
    assert.equal($(d, 'pe_name').value, evil, '값은 텍스트로 그대로');
    assert.equal(d.querySelector('#peRefInfo img'), null, '안내문에도 태그로 안 들어감');
  });

  await t.test('⑮ 참조 조회 실패해도 폼이 깨지지 않는다', async () => {
    const ctx = await boot({ masterError: 'not_found' });
    const { w, d } = ctx;
    $(d, 'peNewBtn').dispatchEvent(new w.Event('click'));
    type(w, $(d, 'pe_ref'), 'CQ04');
    await tick(360);
    d.querySelector('#peRefList .pe-ref-pick').dispatchEvent(new w.Event('click'));
    await tick(60);
    assert.match($(d, 'peRefInfo').textContent, /불러오지 못했습니다/);
    assert.equal($(d, 'pe_name').value, '', '값이 반쯤 채워지지 않음');
    assert.ok($(d, 'peSave'), '저장 버튼 살아 있음');
  });

  // ── 경합·데이터 보존 (2026-08-31 리뷰 지적분) ──

  await t.test('⑯ 느린 참조 응답이 그 사이 열린 ✎수정 모달을 덮지 않는다', async () => {
    const ctx = await boot({ deferMaster: true });
    const { w, d, calls } = ctx;
    // ① CQ0445L(77) 을 참조로 신규 시작 — 응답은 붙잡아 둔다
    type(w, $(d, 'peQ'), 'CQ04');
    await tick(360);
    d.querySelectorAll('#peQList .pe-ref-new')[0].dispatchEvent(new w.Event('click'));
    await tick(40);
    // ② 기다리다 말고 다른 제품(78)을 ✎수정 으로 연다
    w.openProductEditor(78);
    await tick(20);
    await ctx.release(1);              // 78 의 peLoad 응답
    assert.equal(d.querySelector('#peOv .pm-head .t').textContent, '✎ 제품 수정');
    assert.equal($(d, 'pe_code').value, 'CQ0446L');
    // ③ 이제 늦은 77 응답이 도착한다
    await ctx.release(0);
    assert.equal($(d, 'pe_code').value, 'CQ0446L', '수정 중인 제품코드가 지워지지 않음');
    assert.equal($(d, 'pe_name').value, 'ROTULA INFERIOR', '77 의 이름으로 바뀌지 않음');
    assert.equal($(d, 'pe_ean').value, '7509999999999', 'EAN 이 날아가지 않음');
    assert.equal($(d, 'pe_rack_location').value, 'B-01-1', 'Rack 위치가 날아가지 않음');
    assert.equal($(d, 'pe_price_customer_ctr').value, '550', '가격이 77 것으로 바뀌지 않음');
    // ④ 그대로 저장해도 78 의 값이 그대로 나간다
    $(d, 'peSave').dispatchEvent(new w.Event('click'));
    await tick(80);
    const patch = calls.filter((c) => c.method === 'PATCH').pop();
    assert.ok(patch && /\/api\/products\/78$/.test(patch.url));
    assert.equal(patch.body.name, 'ROTULA INFERIOR');
    assert.equal(patch.body.ean, '7509999999999');
  });

  await t.test('⑰ 느린 참조 응답이 새로 연 ➕신규 모달의 입력을 지우지 않는다', async () => {
    const ctx = await boot({ deferMaster: true });
    const { w, d } = ctx;
    type(w, $(d, 'peQ'), 'CQ04');
    await tick(360);
    d.querySelectorAll('#peQList .pe-ref-new')[0].dispatchEvent(new w.Event('click'));
    await tick(40);
    $(d, 'peNewBtn').dispatchEvent(new w.Event('click'));   // 새로 시작
    type(w, $(d, 'pe_code'), 'BRAND-NEW-001');
    type(w, $(d, 'pe_name'), '내가 직접 입력한 이름');
    await ctx.release(0);
    assert.equal($(d, 'pe_code').value, 'BRAND-NEW-001', '입력한 코드 보존');
    assert.equal($(d, 'pe_name').value, '내가 직접 입력한 이름', '입력한 이름 보존');
  });

  await t.test('⑱ 이미 입력한 내용이 있으면 확인을 묻고, 취소하면 그대로 둔다', async () => {
    const ctx = await boot({ confirmNo: true });
    const { w, d, confirms } = ctx;
    $(d, 'peNewBtn').dispatchEvent(new w.Event('click'));
    type(w, $(d, 'pe_name'), '손으로 쓴 이름');
    type(w, $(d, 'pe_ref'), 'CQ04');
    await tick(360);
    d.querySelector('#peRefList .pe-ref-pick').dispatchEvent(new w.Event('click'));
    await tick(60);
    assert.equal(confirms.length, 1, '덮어쓰기 전 확인');
    assert.match(confirms[0], /덮어쓸까요/);
    assert.equal($(d, 'pe_name').value, '손으로 쓴 이름', '취소하면 입력 그대로');
    assert.equal(d.querySelectorAll('#peOv .reffill').length, 0, '아무것도 채워지지 않음');
    // 확인을 누르면 덮어쓴다
    ctx.setConfirm(true);
    d.querySelector('#peRefList .pe-ref-pick').dispatchEvent(new w.Event('click'));
    await tick(60);
    assert.equal($(d, 'pe_name').value, 'ROTULA SUPERIOR');
  });

  await t.test('⑲ 먼저 입력해 둔 제품코드·EAN·Rack 은 참조 불러오기로 지워지지 않는다', async () => {
    const ctx = await boot();
    const { w, d } = ctx;
    $(d, 'peNewBtn').dispatchEvent(new w.Event('click'));
    type(w, $(d, 'pe_code'), 'MY-NEW-CODE');
    type(w, $(d, 'pe_ean'), '7509999999999');
    type(w, $(d, 'pe_rack_location'), 'B-01-1');
    type(w, $(d, 'pe_ref'), 'CQ04');
    await tick(360);
    d.querySelector('#peRefList .pe-ref-pick').dispatchEvent(new w.Event('click'));
    await tick(60);
    assert.equal($(d, 'pe_code').value, 'MY-NEW-CODE', '내가 친 새 코드는 남는다');
    assert.equal($(d, 'pe_ean').value, '7509999999999', '내가 친 EAN 은 남는다');
    assert.equal($(d, 'pe_rack_location').value, 'B-01-1', '내가 친 Rack 은 남는다');
    assert.equal($(d, 'pe_name').value, 'ROTULA SUPERIOR', '복사 항목은 참조값으로');
    // 참조에서 온 값이 아니므로 노란 표시는 없다
    assert.ok(!$(d, 'pe_code').classList.contains('reffill'));
    assert.ok(!$(d, 'pe_ean').classList.contains('reffill'));
  });

  await t.test('⑳ 참조를 바꿔 여러 번 불러도 소재 옵션이 쌓이지 않는다', async () => {
    const ctx = await boot();
    const { w, d } = ctx;
    await openWithRef(ctx);                       // 77 → acero
    assert.equal($(d, 'pe_material').value, 'acero');
    type(w, $(d, 'pe_ref'), 'CQ04');
    await tick(360);
    d.querySelectorAll('#peRefList .pe-ref-pick')[1].dispatchEvent(new w.Event('click'));  // 78 → plastico
    await tick(60);
    assert.equal($(d, 'pe_material').value, 'plastico');
    const vals = [...$(d, 'pe_material').options].map((o) => o.value);
    assert.deepEqual(vals, ['', 'aluminio', 'plastico'], '이전 참조의 acero 는 남지 않는다');
  });

  await t.test('㉑ 참조 두 건을 연달아 눌러도 늦게 온 첫 응답이 두 번째를 덮지 않는다', async () => {
    const ctx = await boot({ deferMaster: true });
    const { w, d } = ctx;
    $(d, 'peNewBtn').dispatchEvent(new w.Event('click'));
    type(w, $(d, 'pe_ref'), 'CQ04');
    await tick(360);
    const picks = [...d.querySelectorAll('#peRefList .pe-ref-pick')];
    picks[0].dispatchEvent(new w.Event('click'));   // 77 (느림)
    picks[1].dispatchEvent(new w.Event('click'));   // 78
    await ctx.release(1);                           // 78 먼저 도착
    assert.equal($(d, 'pe_name').value, 'ROTULA INFERIOR');
    await ctx.release(0);                           // 77 늦게 도착
    assert.equal($(d, 'pe_name').value, 'ROTULA INFERIOR', '마지막에 고른 참조가 유지된다');
    assert.match($(d, 'peRefInfo').textContent, /CQ0446L/);
  });

  await t.test('㉒ 저장 응답이 늦게 와도 그 사이 연 신규 모달이 PATCH 로 새지 않는다', async () => {
    const ctx = await boot({ deferPost: true });
    const { w, d, calls } = ctx;
    await openWithRef(ctx);
    type(w, $(d, 'pe_code'), 'CQ0999L');
    $(d, 'peSave').dispatchEvent(new w.Event('click'));
    await tick(40);
    $(d, 'peNewBtn').dispatchEvent(new w.Event('click'));   // 저장 도는 동안 새 신규 모달
    await ctx.release(0);                                   // 늦은 저장 성공 응답
    assert.ok($(d, 'peRefBar'), '새 모달은 여전히 신규(참조 바 있음)');
    assert.equal(d.querySelector('#peOv .pm-head .t').textContent, '➕ 신규 제품 추가');
    type(w, $(d, 'pe_code'), 'OTHER-001');
    type(w, $(d, 'pe_name'), '다른 제품');
    $(d, 'peSave').dispatchEvent(new w.Event('click'));
    await ctx.release(1);
    const posts = calls.filter((c) => c.method === 'POST' && /\/api\/products$/.test(c.url));
    assert.equal(posts.length, 2, '두 번 다 POST — 방금 만든 제품을 덮는 PATCH 가 없다');
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
    assert.equal(posts[1].body.code, 'OTHER-001');
  });

  await t.test('㉓ 참조값이 비어 있는 항목도 「참조 기준 비어 있음」으로 표시된다', async () => {
    const ctx = await boot({ master: Object.assign({}, MASTER, { origin: null, sat_code: '' }) });
    const { d } = ctx;
    await openWithRef(ctx);
    assert.equal($(d, 'pe_origin').value, '');
    assert.ok($(d, 'pe_origin').classList.contains('reffill'), '빈 값도 참조에서 온 것으로 표시');
    assert.ok($(d, 'pe_sat_code').classList.contains('reffill'));
  });

  await t.test('㉔ 안내문이 Clave SyD 는 복사된다는 사실을 알려준다', async () => {
    const ctx = await boot();
    const { w, d } = ctx;
    $(d, 'peNewBtn').dispatchEvent(new w.Event('click'));
    assert.match($(d, 'peRefInfo').textContent, /Clave SyD 는 복사됩니다/);
    await openWithRef(ctx);
    assert.match($(d, 'peRefInfo').textContent, /Clave SyD 는 복사되었으니/);
  });
});
