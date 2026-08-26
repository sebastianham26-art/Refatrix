// =====================================================================
// 거래목록 엑셀 — **진짜 ExcelJS 로 렌더해서 다시 읽어** 파일이 정상인지 검증 (build fin-0826d).
//   앞의 txn_export_front.test.mjs 는 스텁으로 "무엇을 쓰려 했는지"를 본다.
//   이 파일은 운영과 같은 ExcelJS 로 실제 .xlsx 바이트를 만들고, 그 바이트를 다시 파싱해
//   셀 값·서식·틀고정·자동필터·수식이 살아있는지 확인한다(엑셀에서 열리는지의 대리 검증).
//   실행 조건: exceljs 설치 필요(없으면 skip).
// =====================================================================
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import assert from 'node:assert';

const HTML = readFileSync(new URL('../../refatrix-finance.html', import.meta.url), 'utf8');
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

let ExcelJS = null;
try { ExcelJS = (await import('exceljs')).default; } catch { /* not installed */ }
const SKIP = !ExcelJS;
if (SKIP) console.log('[skip] exceljs 미설치 — 실 렌더 검증 생략');

const ACCOUNTS = [{ id: 1, name: 'BBVA', currency: 'MXN', disabled: false, can_detail: true }];
const b = { kind: 'general', approved: true, change_count: 0, edit_count: 0, editable: true, fx_rate: 1,
  sales_invoice_id: null, recurring_rule_id: null, customer_name: null, receipt_no: null,
  plan_amount: null, plan_date: null, created_by_name: '디렉터', created_at: '2026-04-25 10:00' };
const ITEMS = [
  { ...b, id: 401, txn_date: '2026-04-25', direction: 'out', amount: 500, currency: 'USD', fx_rate: 18,
    amount_mxn: 9000, category_code: '6030', category_name: '기타', status: 'actual',
    memo: 'Pago proveedor — "comillas" & <tags>', account_id: 1, account_name: 'BBVA', source: 'manual',
    receipt_no: 'F-999' },
  { ...b, id: 402, txn_date: '2026-04-15', direction: 'out', amount: 10000, currency: 'MXN',
    amount_mxn: 10000, category_code: '6020', category_name: '임차료', status: 'plan',
    memo: '[고정비] renta bodega', account_id: 1, account_name: 'BBVA', source: 'recurring',
    recurring_rule_id: 5, plan_amount: 10000, plan_date: '2026-04-15' },
  { ...b, id: 403, txn_date: '2026-04-28', direction: 'in', amount: 7000, currency: 'MXN',
    amount_mxn: 7000, category_code: '4020', category_name: '기타 수익', status: 'actual',
    memo: '기타수입', account_id: 1, account_name: 'BBVA', source: 'manual' },
];

async function renderReal() {
  const dom = new JSDOM(HTML.replace(/<script src=[^>]*><\/script>/g, ''), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/',
  });
  const w = dom.window;
  const j = (o) => ({ ok: true, status: 200, json: async () => o });
  w.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/transactions/export')) {
      return j({ count: ITEMS.length, truncated: false, cap: 20000, items: JSON.parse(JSON.stringify(ITEMS)) });
    }
    if (u.includes('/api/accounts')) return j({ items: JSON.parse(JSON.stringify(ACCOUNTS)) });
    return j({ items: [] });
  };
  w.alert = () => {};
  // 운영과 같은 ExcelJS 를 window 에 심는다 → loadExcelJS() 가 CDN 을 받지 않고 이걸 쓴다
  w.ExcelJS = ExcelJS;
  let buf = null;
  w.Blob = class { constructor(parts) { buf = parts[0]; } };
  w.URL.createObjectURL = () => 'blob:stub';
  w.URL.revokeObjectURL = () => {};
  w.eval(`session={token:'t',user:{id:1,name:'Dir',role:'director'},api:''}; accounts=${JSON.stringify(ACCOUNTS)}; fxRate=18;`);
  w.document.getElementById('f-from').value = '2026-04-01';
  w.document.getElementById('f-to').value = '2026-04-30';
  w.document.getElementById('txn-xls').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  for (let i = 0; i < 40 && !buf; i++) await tick(10);
  assert.ok(buf, '.xlsx 버퍼가 만들어져야 한다');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(buf));
  return wb;
}

let WB = null;
test('boot — 실제 .xlsx 렌더 후 다시 읽기', { skip: SKIP }, async () => { WB = await renderReal(); });

test('① 시트가 하나, 이름이 맞다', { skip: SKIP }, async () => {
  assert.equal(WB.worksheets.length, 1);
  assert.equal(WB.worksheets[0].name, '거래목록 Transacciones');
});

test('② 헤더 20열이 그대로 저장된다', { skip: SKIP }, async () => {
  const ws = WB.worksheets[0];
  assert.equal(ws.getCell(5, 1).value, '일자\nFecha');
  assert.equal(ws.getCell(5, 9).value, 'MXN 환산\nConv. MXN');
  assert.equal(ws.getCell(5, 20).value, '등록일시\nCreado');
  assert.equal(ws.getCell(5, 21).value, null);
});

test('③ 데이터 행의 값·타입이 보존된다 (숫자는 숫자, 일자는 텍스트)', { skip: SKIP }, async () => {
  const ws = WB.worksheets[0];
  const R = 6; // USD 실적이 첫 행(최신순)
  assert.equal(ws.getCell(R, 1).value, '2026-04-25');
  assert.equal(typeof ws.getCell(R, 1).value, 'string', '일자는 문자열이어야 한다');
  assert.equal(ws.getCell(R, 1).numFmt, '@');
  assert.equal(ws.getCell(R, 6).value, 'USD');
  assert.strictEqual(ws.getCell(R, 7).value, 500);
  assert.strictEqual(ws.getCell(R, 8).value, 18);
  assert.strictEqual(ws.getCell(R, 9).value, 9000);
  assert.equal(ws.getCell(R, 7).numFmt, '#,##0.00');
  assert.equal(ws.getCell(R, 14).value, 'F-999');
});

test('④ 특수문자가 들어간 메모가 깨지지 않는다', { skip: SKIP }, async () => {
  assert.equal(WB.worksheets[0].getCell(6, 15).value, 'Pago proveedor — "comillas" & <tags>');
});

test('⑤ 합계 셀이 수식으로 저장된다', { skip: SKIP }, async () => {
  const ws = WB.worksheets[0];
  const totalRow = 6 + ITEMS.length;
  assert.equal(ws.getCell(totalRow, 5).value, '합계 / Total (MXN)');
  const c = ws.getCell(totalRow, 9);
  assert.equal(c.formula, 'SUM(I6:I8)');
  assert.equal(c.result, 26000, '재계산 전에도 값이 보이도록 캐시 결과 포함');
});

test('⑥ 요약 블록의 실적/예정 구분이 맞다', { skip: SKIP }, async () => {
  const ws = WB.worksheets[0];
  const sr = 6 + ITEMS.length + 2;
  assert.equal(ws.getCell(sr, 5).value, '요약 / Resumen (MXN)');
  assert.equal(ws.getCell(sr + 1, 9).value, 7000, '실적 수입');
  assert.equal(ws.getCell(sr + 2, 9).value, 9000, '실적 지출');
  assert.equal(ws.getCell(sr + 3, 9).value, 0, '예정 수입');
  assert.equal(ws.getCell(sr + 4, 9).value, 10000, '예정 지출');
});

test('⑦ 틀고정·자동필터·열너비가 저장된다', { skip: SKIP }, async () => {
  const ws = WB.worksheets[0];
  const v = ws.views && ws.views[0];
  assert.equal(v.state, 'frozen');
  assert.equal(v.ySplit, 5);
  assert.equal(v.xSplit, 1);
  assert.ok(ws.autoFilter, '자동필터');
  assert.ok(ws.getColumn(15).width >= 40, '메모 열이 넓다');
});

test('⑧ 조건·생성 안내 줄이 저장된다', { skip: SKIP }, async () => {
  const ws = WB.worksheets[0];
  assert.match(String(ws.getCell(1, 1).value), /거래 목록/);
  assert.match(String(ws.getCell(2, 2).value), /2026-04-01 ~ 2026-04-30/);
  assert.match(String(ws.getCell(3, 2).value), /3건/);
});
