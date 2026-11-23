// =====================================================================
// 재무 > 거래등록 > 「예정 내역(실적 처리)」 ⬇ 엑셀 (build fin-1123pp)
//   디렉터: "월을 선택하면 내역을 볼 수 있는데 엑셀로 다운받을 수 있게 해줘"
//   · 화면에 보이는 그대로 — 연·월 필터·경과 포함·찾기·정렬
//   · USD 예정은 오늘 환율로 MXN 환산(수식), 하단 수입·지출·순액 요약(SUMIFS)
//   refatrix-finance.html 인라인 JS 를 jsdom 으로 구동 + 실 ExcelJS 로 xlsx 바이트를 만들어 다시 파싱한다.
// =====================================================================
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');
const HTML = readFileSync(new URL('../../refatrix-finance.html', import.meta.url), 'utf8');
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const base = { kind: 'general', can_delete: true, sales_invoice_id: null, recurring_rule_id: null, source: 'manual', overdue: false };
const ITEMS = [
  { ...base, id: 21, plan_date: '2026-10-20', direction: 'out', amount: 10000, plan_amount: 10000, currency: 'MXN',
    category_code: '6020', category_name: '임차료', memo: '[고정비] renta', account_name: 'BBVA', recurring_rule_id: 5, source: 'recurring', overdue: true },
  { ...base, id: 22, plan_date: '2026-11-10', direction: 'out', amount: 200, plan_amount: 200, currency: 'USD',
    category_code: '6010', category_name: '출장비', memo: 'hotel', account_name: '금고' },
  { ...base, id: 23, plan_date: '2026-11-25', direction: 'in', amount: 11600, plan_amount: 11600, currency: 'MXN',
    category_code: '4010', category_name: '제품 매출', sat_no: 'A-1', customer_name: 'Cliente A', sales_invoice_id: 77,
    source: 'sales', can_delete: false, account_name: null },
  { ...base, id: 24, plan_date: '2026-12-05', direction: 'out', amount: 999, plan_amount: 999, currency: 'MXN',
    category_code: '6030', category_name: '통신비', memo: 'Telcel', account_name: 'BBVA' },
];

function boot() {
  const alerts = []; let blobPart = null; let fname = null;
  const dom = new JSDOM(HTML.replace(/<script src=[^>]*><\/script>/g, ''), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/',
  });
  const w = dom.window;
  const j = (o) => ({ ok: true, status: 200, json: async () => o });
  w.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/transactions/pending-plans')) return j({ items: JSON.parse(JSON.stringify(ITEMS)) });
    if (u.includes('/api/fx/usd-mxn')) return j({ rate: 18.5, asOf: '2026-11-23', stale: false });
    return j({ items: [] });
  };
  w.alert = (m) => alerts.push(String(m));
  w.ExcelJS = ExcelJS;
  w.Blob = class { constructor(p) { blobPart = p[0]; } };
  w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
  const origCreate = w.document.createElement.bind(w.document);
  w.document.createElement = (tag) => { const el = origCreate(tag); if (tag === 'a') el.click = () => { fname = el.download; }; return el; };
  w.eval(`session={token:'t',user:{id:1,name:'Dir',role:'director'},api:''};`);
  return { w, alerts, get blob() { return blobPart; }, get fname() { return fname; } };
}
async function setup(ctx, { years = [2026], months = [11], overdue = true, q = '' } = {}) {
  await ctx.w.loadPendingPlans(); await tick();
  ctx.w.eval(`fxRate=18.5; ppSelYears=new Set(${JSON.stringify(years)}); ppSelMonths=new Set(${JSON.stringify(months)}); ppShowOverdue=${overdue}; ppQuery=${JSON.stringify(q)}; renderPendingPlans();`);
}
async function download(ctx) {
  ctx.w.document.getElementById('pp-excel').click();
  for (let i = 0; i < 100 && !ctx.blob; i++) await tick(10);
  assert.ok(ctx.blob, '엑셀이 만들어졌다');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(ctx.blob);
  return wb.worksheets[0];
}
const val = (c) => { const v = c.value; return v && typeof v === 'object' && 'result' in v ? v.result : v; };
const dataRows = (ws) => { const out = []; for (let r = 6; r <= ws.rowCount; r++) { const d = ws.getCell(r, 1).value; if (d && /^\d{4}-/.test(String(d))) out.push(r); } return out; };

test('① 버튼이 있고, 화면에 보이는 그대로(11월 + 경과) 3건이 엑셀에 담긴다 — 12월은 제외', async () => {
  const ctx = boot(); await setup(ctx);
  assert.ok(ctx.w.document.getElementById('pp-excel'), '⬇ 엑셀 버튼');
  const shown = ctx.w.document.querySelectorAll('#ppBody tbody tr[data-id]').length;
  const ws = await download(ctx);
  const rows = dataRows(ws);
  assert.equal(rows.length, shown, '화면 행 수 = 엑셀 행 수');
  assert.deepEqual(rows.map((r) => ws.getCell(r, 1).value), ['2026-10-20', '2026-11-10', '2026-11-25']);
  assert.match(String(ws.getCell(2, 1).value), /2026.*11월.*경과/);
  assert.match(ctx.fname, /^refatrix_pendientes_\d{8}\.xlsx$/);
});

test('② 열 값: 경과 표시·구분·출처·고객·SAT·계좌·통화, USD 는 환율 × 계획액 수식', async () => {
  const ctx = boot(); await setup(ctx);
  const ws = await download(ctx);
  const [r1, r2, r3] = dataRows(ws);
  assert.equal(ws.getCell(r1, 2).value, '경과');
  assert.equal(ws.getCell(r1, 4).value, '고정비 / Fijo');
  assert.equal(ws.getCell(r1, 7).value, 'renta', '[고정비] 접두사 제거');
  assert.equal(ws.getCell(r1, 1).numFmt, '@', '일자 텍스트 고정');
  assert.equal(ws.getCell(r2, 9).value, 'USD');
  assert.equal(ws.getCell(r2, 10).value, 200);
  assert.equal(ws.getCell(r2, 11).value, 18.5);
  assert.equal(ws.getCell(r2, 12).value.formula, `J${r2}*K${r2}`);
  assert.equal(val(ws.getCell(r2, 12)), 3700);
  assert.equal(ws.getCell(r2, 8).value, '금고');
  assert.equal(ws.getCell(r3, 3).value, '수입 / Ingreso');
  assert.equal(ws.getCell(r3, 4).value, '매출 / Venta');
  assert.equal(ws.getCell(r3, 5).value, 'Cliente A');
  assert.equal(ws.getCell(r3, 7).value, 'A-1');
  assert.equal(ws.getCell(r3, 8).value, '(미지정)');
});

test('③ 요약: 수입 11,600 · 지출 13,700 · 순액 −2,100 (MXN 환산, 수식)', async () => {
  const ctx = boot(); await setup(ctx);
  const ws = await download(ctx);
  const sums = {};
  for (let r = 6; r <= ws.rowCount; r++) { const l = ws.getCell(r, 11).value; if (typeof l === 'string' && /\//.test(l)) sums[l.split(' ')[0]] = ws.getCell(r, 12); }
  assert.equal(val(sums['수입']), 11600);
  assert.equal(val(sums['지출']), 13700);
  assert.equal(val(sums['순액']), -2100);
  assert.match(sums['수입'].value.formula, /^SUMIFS\(L\d+:L\d+,C\d+:C\d+,"수입\*"\)$/);
});

test('④ 월 여러 개 선택(11·12월, 경과 제외) → 3건, 찾기 입력 시 필터 무시', async () => {
  let ctx = boot(); await setup(ctx, { months: [11, 12], overdue: false });
  let ws = await download(ctx);
  assert.deepEqual(dataRows(ws).map((r) => ws.getCell(r, 1).value), ['2026-11-10', '2026-11-25', '2026-12-05']);
  ctx = boot(); await setup(ctx, { months: [1], overdue: false, q: 'telcel' });
  ws = await download(ctx);
  assert.deepEqual(dataRows(ws).map((r) => ws.getCell(r, 1).value), ['2026-12-05']);
  assert.match(String(ws.getCell(2, 1).value), /telcel/);
});

test('⑤ 화면 정렬(계획액 내림) 순서 그대로', async () => {
  const ctx = boot(); await setup(ctx);
  ctx.w.eval(`ppHeadClick('amt')`);
  const ws = await download(ctx);
  assert.deepEqual(dataRows(ws).map((r) => ws.getCell(r, 1).value), ['2026-11-25', '2026-10-20', '2026-11-10']);
});

test('⑥ 0건이면 파일을 만들지 않고 안내', async () => {
  const ctx = boot(); await setup(ctx, { months: [3], overdue: false });
  ctx.w.document.getElementById('pp-excel').click(); await tick(30);
  assert.equal(ctx.blob, null);
  assert.match(ctx.alerts.join(' '), /내려받을 예정 내역이 없습니다/);
});

test('⑦ 빌드 마커', () => { assert.match(HTML, /build fin-1123pp/); });
