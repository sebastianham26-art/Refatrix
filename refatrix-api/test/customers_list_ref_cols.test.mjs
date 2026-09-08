// =====================================================================
// refatrix-customers.html 고객 목록 — 경쟁사(SYD) 단가 · 제안할인 · 기본할인 컬럼
//   (2026-09-08) 등록 때 박제한 근거가 목록에서 빠져 있던 것을 채운 뒤의 회귀 테스트.
//   ① 헤더에 세 컬럼이 있고 ② 값이 상세와 같은 표기로 찍히고
//   ③ 값이 없는 고객(웹카달록 등록)은 '—' 로 안전하게 빠지고
//   ④ 컬럼 헤더 정렬이 숫자 기준으로 동작하며 값 없는 건이 뒤로 가는지.
// =====================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../../refatrix-customers.html', import.meta.url), 'utf8');

const ITEMS = [
  { id: 1, code: 'C-0001', name: 'FRENOS NORTE', customer_type: 'Refaccionaria', branch_count: 2,
    owner_name: 'Oscar', stage_name: 'cliente', discount: 52, credit_days: 30,
    approval_status: 'approved', sales_total: 1000, overdue: 0, doc_count: 0,
    syd_ref_code: '1516049', syd_ref_buy_price: 650, syd_ref_list_price: 1000, syd_ref_discount: 35,
    ctr_ref_code: 'CB0336', ctr_ref_list_price: 1400, suggested_discount: 55.89 },
  // 웹카달록(CRM) 등록 — 단가가 안 온 건. 화면이 깨지지 않고 '—' 로 빠져야 한다.
  { id: 2, code: 'P-0002', name: 'AUTOPARTES SUR', owner_name: null, stage_name: 'lead',
    discount: 0, credit_days: 0, approval_status: 'pending', from_crm: true,
    sales_total: 0, overdue: 0, doc_count: 0,
    syd_ref_code: null, syd_ref_buy_price: null, syd_ref_list_price: null, syd_ref_discount: null,
    ctr_ref_code: null, ctr_ref_list_price: null, suggested_discount: null },
];

let dom, win;
beforeEach(() => {
  dom = new JSDOM(html, {
    url: 'https://example.test/refatrix-customers.html',
    runScripts: 'dangerously',
    beforeParse(w) {
      w.fetch = async (url) => {
        const u = String(url);
        const payload = u.includes('/api/customers?') || /\/api\/customers$/.test(u)
          ? { items: ITEMS } : {};
        return { ok: true, status: 200, json: async () => payload };
      };
      w.alert = () => {}; w.confirm = () => true;
    },
  });
  win = dom.window;
  win.eval("session = { token:'tok', user:{ id:2, name:'Ana', role:'director' }, api:'' };");
  win.eval('loadStageSummary = async () => {};');
});

const listHtml = () => win.document.getElementById('custList').innerHTML;

test('헤더에 경쟁사(SYD) 단가·제안할인·기본할인 컬럼이 있다', async () => {
  await win.loadCustomers();
  const h = listHtml();
  assert.match(h, /경쟁사\(SYD\) 단가/);
  assert.match(h, /제안할인/);
  assert.match(h, /기본할인/);
});

test('등록 때 박제한 값이 상세와 같은 표기로 찍힌다', async () => {
  await win.loadCustomers();
  const h = listHtml();
  assert.ok(h.includes('$650.00'), '경쟁사 구매단가');
  assert.match(h, /SYD −35\.0%/, '고객이 SYD 에서 받는 할인율');
  assert.match(h, /55\.9%/, '제안 할인율');
  assert.match(h, /52\.0%/, '적용 기본할인');
  // 제안 55.89 → 적용 52 는 우리에게 유리한 쪽(덜 깎아 줌)이라 −3.89%p
  assert.match(h, /제안 -3\.89%p/);
  // 툴팁에 근거 전체(기준품목·SYD 정가·CTR 정가)가 남아야 한다
  assert.match(h, /기준품목 1516049/);
  assert.match(h, /우리 CB0336 정가/);
});

test('단가가 없는 CRM 등록 건은 깨지지 않고 — 로 빠진다', async () => {
  await win.loadCustomers();
  const rows = win.document.querySelectorAll('#custList tbody tr');
  assert.equal(rows.length, 2);
  const crm = [...rows].find((r) => r.textContent.includes('P-0002'));
  assert.ok(crm, 'CRM 고객 행');
  assert.match(crm.innerHTML, /—/);
  assert.ok(!crm.innerHTML.includes('NaN'));
  assert.ok(!crm.innerHTML.includes('$null'));
});

test('경쟁사 단가 정렬 — 값 없는 건은 뒤로 간다', async () => {
  await win.loadCustomers();
  win.sortCust('syd_ref_buy_price');                 // 오름차순: 값 없음(-1) 이 앞
  let codes = [...win.document.querySelectorAll('#custList tbody tr td.code')].map((t) => t.textContent);
  assert.deepEqual(codes, ['P-0002', 'C-0001']);
  win.sortCust('syd_ref_buy_price');                 // 내림차순: 값 있는 건이 앞
  codes = [...win.document.querySelectorAll('#custList tbody tr td.code')].map((t) => t.textContent);
  assert.deepEqual(codes, ['C-0001', 'P-0002']);
});

test('상세 — 단가 없이 할인율만 있어도 산출 근거 줄이 남는다', async () => {
  // 목록에서 뽑은 고객이 아니라 상세 API 응답 기준(단가 미기록·할인율만 온 CRM 건)
  win.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/customers/2')) {
      return { ok: true, status: 200, json: async () => ({
        customer: { id: 2, code: 'P-0002', name: 'AUTOPARTES SUR', rfc: 'AAS900101AB1',
          discount: 30, credit_days: 0, approval_status: 'pending', rfc_claimed: true,
          syd_ref_code: '1516049', syd_ref_buy_price: null, syd_ref_list_price: null,
          syd_ref_discount: 28, ctr_ref_code: null, ctr_ref_list_price: null, suggested_discount: null },
        invoices: [], important_skus: [], reorder_summary: {}, sku_stats: {}, summary: {} }) };
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };
  win.eval('loadDocs=async()=>{};loadDetailApproval=async()=>{};loadCustVisits=async()=>{};txLoad=async()=>{};loadTermsHistory=async()=>{};');
  await win.openCustomer(2);
  const info = win.document.getElementById('d-info').innerHTML;
  assert.match(info, /할인율 산출 근거/);
  assert.match(info, /28\.0%/);
});
