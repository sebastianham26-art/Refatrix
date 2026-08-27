// =====================================================================
// 거래목록 「⬇ 엑셀」 버튼 — refatrix-finance.html 을 jsdom 에서 구동해 검증 (build fin-0826e).
//   요구(디렉터): 거래목록을 엑셀로 받게. 나만 받으면 된다.
//   ExcelJS 는 CDN 이라 jsdom 에서 못 받으므로, 워크북 스텁을 window.ExcelJS 로 심어
//   **실제로 어떤 셀에 무엇을 쓰는지**를 그대로 캡처해 검증한다.
// =====================================================================
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import assert from 'node:assert';

const HTML = readFileSync(new URL('../../refatrix-finance.html', import.meta.url), 'utf8');
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const ACCOUNTS = [{ id: 1, name: 'BBVA', currency: 'MXN', disabled: false, can_detail: true }];
const base = { kind: 'general', approved: true, change_count: 0, edit_count: 0, editable: true, fx_rate: 1 };
const EXPORT_ITEMS = [
  { ...base, id: 301, txn_date: '2026-04-25', direction: 'out', amount: 500, currency: 'USD', fx_rate: 18,
    amount_mxn: 9000, category_code: '6030', category_name: '기타', status: 'actual', memo: 'USD 지출',
    account_id: 1, account_name: 'BBVA', source: 'manual', receipt_no: 'F-999', sales_invoice_id: null,
    recurring_rule_id: null, plan_amount: null, plan_date: null, created_by_name: '디렉터',
    created_at: '2026-04-25 10:00', customer_name: null },
  { ...base, id: 302, txn_date: '2026-04-15', direction: 'out', amount: 10000, currency: 'MXN',
    amount_mxn: 10000, category_code: '6020', category_name: '임차료', status: 'plan', memo: '[고정비] renta',
    account_id: 1, account_name: 'BBVA', source: 'recurring', receipt_no: null, sales_invoice_id: null,
    recurring_rule_id: 5, plan_amount: 10000, plan_date: '2026-04-15', created_by_name: '디렉터',
    created_at: '2026-04-01 09:00', customer_name: null },
  { ...base, id: 303, txn_date: '2026-04-20', direction: 'out', amount: 3000, currency: 'MXN',
    amount_mxn: 3000, category_code: '6070', category_name: '마케팅비', status: 'plan', memo: '[마케팅] Expo',
    account_id: null, account_name: null, source: 'marketing', receipt_no: null, sales_invoice_id: null,
    recurring_rule_id: null, plan_amount: 3000, plan_date: '2026-04-20', created_by_name: '마케팅담당',
    created_at: '2026-04-02 09:00', customer_name: null },
  { ...base, id: 304, txn_date: '2026-04-28', direction: 'in', amount: 7000, currency: 'MXN',
    amount_mxn: 7000, category_code: '4020', category_name: '기타 수익', status: 'actual', memo: '기타수입',
    account_id: 1, account_name: 'BBVA', source: 'manual', receipt_no: null, sales_invoice_id: null,
    recurring_rule_id: null, plan_amount: null, plan_date: null, created_by_name: '디렉터',
    created_at: '2026-04-28 11:00', customer_name: null },
];

// ── ExcelJS 스텁: 셀 값/서식·다운로드 이름을 캡처 ─────────────────────
function installExcelStub(w, capture) {
  class Cell {
    constructor(sheet, r, c) { this.r = r; this.c = c; this._s = sheet; }
    get value() { return this._s.cells[`${this.r},${this.c}`]; }
    set value(v) { this._s.cells[`${this.r},${this.c}`] = v; }
    set numFmt(v) { this._s.fmt[`${this.r},${this.c}`] = v; }
    get numFmt() { return this._s.fmt[`${this.r},${this.c}`]; }
    set font(v) { this._s.font[`${this.r},${this.c}`] = v; }
    get font() { return this._s.font[`${this.r},${this.c}`]; }
    set fill(v) { this._s.fill[`${this.r},${this.c}`] = v; }
    get fill() { return this._s.fill[`${this.r},${this.c}`]; }
    set border(v) {} set alignment(v) {}
  }
  class Row {
    constructor(sheet, r) { this._s = sheet; this.r = r; }
    getCell(c) { return new Cell(this._s, this.r, c); }
    eachCell(fn) { for (let c = 1; c <= 40; c++) { if (this._s.cells[`${this.r},${c}`] !== undefined) fn(new Cell(this._s, this.r, c)); } }
    set height(v) {}
  }
  class Sheet {
    constructor(name) { this.name = name; this.cells = {}; this.fmt = {}; this.font = {}; this.fill = {}; this.widths = {}; }
    getCell(r, c) { return new Cell(this, r, c); }
    getRow(r) { return new Row(this, r); }
    getColumn(c) { const s = this; return { set width(v) { s.widths[c] = v; }, set alignment(v) {} }; }
    mergeCells() {}
    set views(v) { this._views = v; } get views() { return this._views; }
    set autoFilter(v) { this._auto = v; } get autoFilter() { return this._auto; }
  }
  w.ExcelJS = { Workbook: class { constructor() { this.sheets = []; this.xlsx = { writeBuffer: async () => new Uint8Array([1, 2, 3]) }; }
    addWorksheet(n) { const s = new Sheet(n); this.sheets.push(s); capture.wb = this; capture.ws = s; return s; } } };
  w.URL.createObjectURL = () => 'blob:stub';
  w.URL.revokeObjectURL = () => {};
}

function boot({ director = true, exportBody = null, exportStatus = 200 } = {}) {
  const calls = []; const alerts = []; const capture = {};
  const dom = new JSDOM(HTML.replace(/<script src=[^>]*><\/script>/g, ''), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/',
  });
  const w = dom.window;
  const j = (o, ok = true, status = 200) => ({ ok, status, json: async () => o });
  w.fetch = async (url, opt = {}) => {
    const u = String(url);
    calls.push({ url: u, method: (opt.method || 'GET').toUpperCase() });
    if (u.includes('/api/transactions/export')) {
      return j(exportBody || { count: EXPORT_ITEMS.length, truncated: false, cap: 20000,
        generated_at: '2026-08-26T12:00:00.000Z', items: JSON.parse(JSON.stringify(EXPORT_ITEMS)) },
      exportStatus === 200, exportStatus);
    }
    if (u.includes('/api/transactions?') || u.split('?')[0].endsWith('/api/transactions')) return j({ items: [] });
    if (u.includes('/api/accounts')) return j({ items: JSON.parse(JSON.stringify(ACCOUNTS)) });
    return j({ items: [] });
  };
  w.alert = (m) => alerts.push(String(m));
  // 다운로드 앵커 캡처
  const origCreate = w.document.createElement.bind(w.document);
  w.document.createElement = (tag) => {
    const el = origCreate(tag);
    if (String(tag).toLowerCase() === 'a') { const oc = el.click.bind(el); el.click = () => { capture.download = el.download; oc(); }; }
    return el;
  };
  installExcelStub(w, capture);
  w.eval(`session={token:'t',user:{id:1,name:'Dir',role:'${director ? 'director' : 'treasury'}'},api:''}; accounts=${JSON.stringify(ACCOUNTS)}; fxRate=18;`);
  return { w, calls, alerts, capture };
}

const cell = (cap, r, c) => cap.ws.cells[`${r},${c}`];
const HR = 5; // 헤더 행

test('① 디렉터에게만 「⬇ 엑셀」 버튼이 보인다', async () => {
  const dir = boot(); await dir.w.loadTxns(); await tick();
  assert.equal(dir.w.document.getElementById('txn-xls').style.display, '');

  const fin = boot({ director: false }); await fin.w.loadTxns(); await tick();
  assert.equal(fin.w.document.getElementById('txn-xls').style.display, 'none');
});

test('② 클릭하면 지금 필터 그대로 export 엔드포인트를 부른다', async () => {
  const ctx = boot();
  await ctx.w.loadAccounts(); await tick();
  ctx.w.document.getElementById('f-status').value = 'plan';
  ctx.w.document.getElementById('f-dir').value = 'out';
  ctx.w.document.getElementById('f-acc').value = 'none';
  ctx.w.document.getElementById('f-from').value = '2026-04-01';
  ctx.w.document.getElementById('f-to').value = '2026-04-30';
  ctx.w.document.getElementById('txn-xls').dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(30);
  const req = ctx.calls.find((c) => c.url.includes('/api/transactions/export'));
  assert.ok(req, 'export 호출');
  assert.match(req.url, /status=plan/);
  assert.match(req.url, /direction=out/);
  assert.match(req.url, /account_id=none/);
  assert.match(req.url, /from=2026-04-01/);
  assert.match(req.url, /to=2026-04-30/);
});

test('③ 시트 헤더가 20열 · 한/스 병기로 만들어진다', async () => {
  const ctx = boot();
  ctx.w.document.getElementById('txn-xls').dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(30);
  const ws = ctx.capture.ws;
  assert.ok(ws, '워크시트 생성');
  assert.equal(ws.name, '거래목록 Transacciones');
  assert.equal(cell(ctx.capture, HR, 1), '일자\nFecha');
  assert.equal(cell(ctx.capture, HR, 4), '출처\nOrigen');
  assert.equal(cell(ctx.capture, HR, 9), 'MXN 환산\nConv. MXN');
  assert.equal(cell(ctx.capture, HR, 20), '등록일시\nCreado');
  assert.equal(cell(ctx.capture, HR, 21), undefined, '21번째 열은 없다');
  assert.deepEqual(ws.autoFilter, { from: { row: HR, column: 1 }, to: { row: HR, column: 20 } });
  assert.deepEqual(ws.views, [{ state: 'frozen', ySplit: HR, xSplit: 1 }]);
});

test('④ 첫 행(USD 실적)의 값·서식이 정확하다', async () => {
  const ctx = boot();
  ctx.w.document.getElementById('txn-xls').dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(30);
  const R = HR + 1;
  assert.equal(cell(ctx.capture, R, 1), '2026-04-25');
  assert.equal(ctx.capture.ws.fmt[`${R},1`], '@', '일자는 텍스트 고정(dd/mm 자동변환 방지)');
  assert.equal(cell(ctx.capture, R, 2), '지출 Egreso');
  assert.equal(cell(ctx.capture, R, 3), 'BBVA');
  assert.equal(cell(ctx.capture, R, 4), '수동 Manual');
  assert.equal(cell(ctx.capture, R, 6), 'USD');
  assert.equal(cell(ctx.capture, R, 7), 500);
  assert.equal(cell(ctx.capture, R, 8), 18, '환율');
  assert.equal(cell(ctx.capture, R, 9), 9000, 'MXN 환산');
  assert.equal(cell(ctx.capture, R, 10), '실제 Real');
  assert.equal(cell(ctx.capture, R, 11), '승인 Sí');
  assert.equal(cell(ctx.capture, R, 14), 'F-999');
  assert.equal(cell(ctx.capture, R, 19), '디렉터');
  assert.equal(cell(ctx.capture, R, 20), '2026-04-25 10:00');
});

test('⑤ 출처·계좌미지정·계획 열이 행마다 맞는다', async () => {
  const ctx = boot();
  ctx.w.document.getElementById('txn-xls').dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(30);
  assert.equal(cell(ctx.capture, HR + 2, 4), '고정비 Fijo');
  assert.equal(cell(ctx.capture, HR + 2, 16), '2026-04-15', '계획일');
  assert.equal(cell(ctx.capture, HR + 2, 17), 10000, '계획금액');
  assert.equal(cell(ctx.capture, HR + 3, 4), '마케팅 Marketing');
  assert.equal(cell(ctx.capture, HR + 3, 3), '(미지정)', '계좌 없는 마케팅 계획');
  assert.equal(cell(ctx.capture, HR + 4, 2), '수입 Ingreso');
});

test('⑥ 합계·요약 블록이 실적/예정 × 수입/지출로 나뉘어 계산된다', async () => {
  const ctx = boot();
  ctx.w.document.getElementById('txn-xls').dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(30);
  const totalRow = HR + 1 + EXPORT_ITEMS.length;
  assert.equal(cell(ctx.capture, totalRow, 5), '합계 / Total (MXN)');
  assert.equal(cell(ctx.capture, totalRow, 9).formula, `SUM(I${HR + 1}:I${totalRow - 1})`);
  const sr = totalRow + 2;
  assert.equal(cell(ctx.capture, sr, 5), '요약 / Resumen (MXN)');
  assert.equal(cell(ctx.capture, sr + 1, 9), 7000, '실적 수입');
  assert.equal(cell(ctx.capture, sr + 2, 9), 9000, '실적 지출(USD 9,000)');
  assert.equal(cell(ctx.capture, sr + 3, 9), 0, '예정 수입 없음');
  assert.equal(cell(ctx.capture, sr + 4, 9), 13000, '예정 지출 10,000+3,000');
});

test('⑦ 조건 줄에 지금 필터가 사람 말로 적힌다', async () => {
  const ctx = boot();
  await ctx.w.loadAccounts(); await tick();
  ctx.w.document.getElementById('f-acc').value = '1';
  ctx.w.document.getElementById('f-status').value = 'actual';
  ctx.w.document.getElementById('f-from').value = '2026-04-01';
  ctx.w.document.getElementById('txn-xls').dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(30);
  const line = String(cell(ctx.capture, 2, 2));
  assert.match(line, /계좌 BBVA/);
  assert.match(line, /상태 실제/);
  assert.match(line, /구분 전체/);
  assert.match(line, /2026-04-01 ~ 전체/);
});

test('⑧ 파일명이 날짜로 만들어지고 다운로드가 트리거된다', async () => {
  const ctx = boot();
  ctx.w.document.getElementById('txn-xls').dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(30);
  assert.match(String(ctx.capture.download), /^refatrix_transacciones_\d{8}\.xlsx$/);
});

test('⑨ 결과 0건이면 파일을 만들지 않고 안내만 한다', async () => {
  const ctx = boot({ exportBody: { count: 0, truncated: false, cap: 20000, items: [] } });
  ctx.w.document.getElementById('txn-xls').dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(30);
  assert.match(ctx.alerts.join('\n'), /내보낼 거래가 없습니다/);
  assert.equal(ctx.capture.ws, undefined, '워크북 생성 안 함');
});

test('⑩ 상한 초과(truncated)면 시트와 알림 양쪽에서 경고한다', async () => {
  const ctx = boot({ exportBody: { count: 4, truncated: true, cap: 20000,
    items: JSON.parse(JSON.stringify(EXPORT_ITEMS)) } });
  ctx.w.document.getElementById('txn-xls').dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(30);
  assert.match(String(cell(ctx.capture, 3, 2)), /상한 20000행 초과분은 제외/);
  assert.match(ctx.alerts.join('\n'), /기간을 좁혀 나눠 받으세요/);
});

test('⑪ 403 / 404 는 사람 말로 안내하고 파일을 만들지 않는다', async () => {
  const forb = boot({ exportStatus: 403, exportBody: { error: 'forbidden' } });
  forb.w.document.getElementById('txn-xls').dispatchEvent(new forb.w.MouseEvent('click', { bubbles: true }));
  await tick(30);
  assert.match(forb.alerts.join('\n'), /디렉터만 내려받을 수 있습니다/);
  assert.equal(forb.capture.ws, undefined);

  const old = boot({ exportStatus: 404, exportBody: { error: 'not_found' } });
  old.w.document.getElementById('txn-xls').dispatchEvent(new old.w.MouseEvent('click', { bubbles: true }));
  await tick(30);
  assert.match(old.alerts.join('\n'), /아직 배포되지 않았습니다/);
});

test('⑫ 만드는 동안 버튼이 잠겼다가 원래대로 돌아온다', async () => {
  const ctx = boot();
  const btn = ctx.w.document.getElementById('txn-xls');
  btn.dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  assert.equal(btn.disabled, true, '즉시 비활성');
  await tick(30);
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, '⬇ 엑셀');
});

test('⑬ 빌드 마커', () => {
  assert.match(HTML, /build fin-0826e/);
});
