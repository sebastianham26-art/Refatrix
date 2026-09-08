// =====================================================================
// 고객 상세(「열기」)의 미수/연체 인보이스 표 — 완납 판정 통일 (2026-09-08)
//
// 배경: LUEMI 인보이스 C7064C12…(2026-07-15 / 만기 08-14, 총액 6,798.95 · 입금 6,798.94)
//   수금 화면은 「완납」인데 고객 상세에서는 「연체」로 보였다.
//   원인 = 고객 상세만 SQL·화면 모두 `잔액 > 0` 으로 세고 있어서(0.01 센타보 잔여),
//          2026-09-02 에 통일한 AR_PAID_EPS(0.5) 를 안 타고 있었다.
//   해결 = 서버가 open 플래그를 내려주고(ar.js 한 곳에서 정의), 화면은 그걸 따른다.
//
//   실행: node --test test/customer_ar_eps_front.test.mjs
// =====================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { arOpenCondSql, arOpenBalSql, AR_PAID_EPS } from '../src/ar.js';

const html = readFileSync(new URL('../../refatrix-customers.html', import.meta.url), 'utf8');
const routes = readFileSync(new URL('../src/routes/customerRoutes.js', import.meta.url), 'utf8');

const CUST = { id: 7, code: 'C-0007', name: 'LUEMI', rfc: 'LUE900101AB1', discount: 0, credit_days: 30,
  approval_status: 'approved', rfc_claimed: true };

// 실제 사례 그대로: ① 센타보 잔여(만기 지남) ② 진짜 미수 ③ 정상 완납
const INVOICES = [
  { id: 25, inv_date: '2026-07-15', due_date: '2026-08-14', total_mxn: 6798.95, paid: 6798.94,
    outstanding: 0.01, open: false, overdue: false },
  { id: 31, inv_date: '2026-08-26', due_date: '2026-09-25', total_mxn: 6984.36, paid: 0,
    outstanding: 6984.36, open: true, overdue: false },
  { id: 18, inv_date: '2026-06-22', due_date: '2026-07-22', total_mxn: 3037.34, paid: 3037.34,
    outstanding: 0, open: false, overdue: false },
];

let win;
function boot(invoices) {
  const dom = new JSDOM(html, { url: 'https://example.test/refatrix-customers.html', runScripts: 'dangerously',
    beforeParse(w) {
      w.fetch = async (url) => {
        const u = String(url);
        const d = /\/api\/customers\/\d+$/.test(u.split('?')[0])
          ? { customer: CUST, invoices, important_skus: [], reorder_summary: {}, sku_stats: {}, summary: {} }
          : { items: [] };
        return { ok: true, status: 200, json: async () => d };
      };
      w.alert = () => {};
    } });
  win = dom.window;
  win.eval("session = { token:'tok', user:{ id:1, name:'Ana', role:'director' }, api:'' };");
  win.eval('loadDocs=async()=>{};loadDetailApproval=async()=>{};loadCustVisits=async()=>{};txLoad=async()=>{};loadTermsHistory=async()=>{};loadStageSummary=async()=>{};');
}
beforeEach(() => boot(INVOICES));

const invHtml = () => win.document.getElementById('d-invoices').innerHTML;
const infoHtml = () => win.document.getElementById('d-info').innerHTML;

test('센타보 잔여(0.01)는 연체가 아니라 완납이다 — LUEMI 재현', async () => {
  await win.openCustomer(7);
  const rows = [...win.document.querySelectorAll('#d-invoices tbody tr')];
  const luemi = rows.find((r) => r.textContent.includes('2026-07-15'));
  assert.ok(luemi, '해당 인보이스 행');
  assert.match(luemi.textContent, /완납/);
  assert.ok(!luemi.textContent.includes('연체'), '연체로 찍히면 수금 화면과 어긋난다');
  // 잔여를 숨기지는 않는다 — 툴팁으로 드러낸다(정산 화면 arStatusChip 과 같은 태도)
  assert.match(luemi.innerHTML, /0\.01/);
});

test('진짜 미수는 그대로 미수로 남는다', async () => {
  await win.openCustomer(7);
  const rows = [...win.document.querySelectorAll('#d-invoices tbody tr')];
  const open = rows.find((r) => r.textContent.includes('2026-08-26'));
  assert.match(open.textContent, /미수/);
  assert.ok(!open.textContent.includes('완납'));
});

test('미수·연체 합계에 센타보 잔여가 섞이지 않는다', async () => {
  await win.openCustomer(7);
  const info = infoHtml();
  // 미수 합계 = 6,984.36 (0.01 은 빠진다) · 연체 합계 = 0
  assert.match(info, /6,984\.36/);
  assert.ok(!/6,984\.37/.test(info), '0.01 이 합계에 섞였다');
  const overCell = [...win.document.querySelectorAll('#d-info tr')]
    .find((r) => r.textContent.includes('연체 합계'));
  assert.match(overCell.textContent, /0\.00/);
});

test('서버가 open 을 아직 안 주는 배포 중간 상태 — 종전 규칙으로 떨어진다', async () => {
  boot(INVOICES.map(({ open, ...rest }) => rest));   // open 없는 옛 응답
  await win.openCustomer(7);
  const rows = [...win.document.querySelectorAll('#d-invoices tbody tr')];
  const luemi = rows.find((r) => r.textContent.includes('2026-07-15'));
  assert.match(luemi.textContent, /미수/);      // 옛 동작(잔액>0) — 화면이 죽지는 않는다
  assert.ok(invHtml().includes('완납'), '완납 건은 그대로');
});

test('서버 SQL — 고객 목록·상세가 AR_PAID_EPS 를 탄다', () => {
  assert.equal(AR_PAID_EPS, 0.5);
  assert.match(arOpenCondSql('i.total_mxn', 'p.paid'), /> ?=\s*0\.5/);
  assert.ok(arOpenBalSql('i.total_mxn', 'p.paid').includes('CASE WHEN'));
  // 옛 판정(`잔액 > 0`)이 고객 화면 SQL 에 남아 있지 않아야 한다
  assert.equal(/COALESCE\(p\.paid,0\)\)\s*>\s*0\)/.test(routes), false, '고객 SQL 에 `> 0` 잔존');
  assert.ok(routes.includes('arOpenCondSql'), '상세 인보이스 목록이 공통 판정을 쓴다');
  assert.ok(routes.includes('arOpenBalSql'), '미수/연체 합계가 공통 판정을 쓴다');
});
