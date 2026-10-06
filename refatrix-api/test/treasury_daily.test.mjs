// 일일 자금 · 월간실적 · WhatsApp 지정 수신자 (0240)
//
//   A. 순수 규칙(src/treasuryDaily.js) — DB 없이 · 유첨 엑셀(9/28~10/2) 숫자 재현
//   B. 배선(server.js 등록 · 마이그레이션 · nav.js 화면키 · 화면 build 토큰) — 파일 검사
//   C. E2E — TEST_PG_URL 이 있을 때 실제 PostgreSQL (0240 까지 migrate 된 빈 DB 권장)
//
//   실행: node --test test/treasury_daily.test.mjs
//         TEST_PG_URL=postgres://... node --test test/treasury_daily.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = join(HERE, '..');
const REPO = join(API, '..');
const read = (p) => readFileSync(p, 'utf8');

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
const T = await import('../src/treasuryDaily.js');

after(async () => {
  if (!PG) return;
  const { pool } = await import('../src/db.js');
  await pool.end().catch(() => {});
  setTimeout(() => process.exit(process.exitCode || 0), 300);
});

const fx18 = (from, to) => T.fxFill([{ rate_date: '2026-09-25', rate: 18 }], from, to, 18);

// ── A. 순수 규칙 ─────────────────────────────────────────────────────────
test('A1 buildDays — 기초·수금·지급·마감 연결, 누계, MXN 환산(유첨 9/28~9/29)', () => {
  const days = T.buildDays({
    from: '2026-09-28', to: '2026-09-30', base: { MXN: 2047.4, USD: 4894 }, fx: fx18('2026-09-28', '2026-09-30'),
    txns: [{ id: 1, d: '2026-09-29', direction: 'in', currency: 'MXN', amount: 6984.4, amount_mxn: 6984.4, customer_name: 'Luemi', sat_no: 'F-34' }],
  });
  // 유첨 엑셀은 센타보가 있는 값을 정수로 표시(2,047 + 6,984 = 9,032) — 화면과 같은 반올림으로 비교
  assert.deepEqual(days.map((d) => Math.round(d.close.MXN)), [2047, 9032, 9032]);
  assert.deepEqual(days.map((d) => Math.round(d.close_eq)), [90139, 97124, 97124], '유첨 맨 아래 줄 90,139 / 97,124');
  assert.equal(days[1].items[0].name, 'Luemi');
  assert.equal(days[2].cum.in_eq, 6984.4);
  assert.equal(days[0].moved, false);
});

test('A2 projectDays — 예정은 기록된 날짜에만 · 지난 날짜 미처리는 오늘로 옮기지 않고 overdue 로 분리 (10/1 Nom.Palomino)', () => {
  const nom = (id, d, a) => ({ id, d, direction: 'out', currency: 'MXN', amount: a, amount_mxn: a, rule_name: 'Nom.Palomino', recurring_rule_id: 9 });
  const days = T.projectDays({
    today: '2026-10-01', to: '2026-10-03', startOpen: { MXN: 9032, USD: 4894 }, fx: fx18('2026-10-01', '2026-10-03'),
    planIn: [
      { id: 25, d: '2026-10-02', direction: 'in', currency: 'MXN', amount: 25929, amount_mxn: 25929, customer_name: 'Luemi', sales_invoice_id: 25 },
      { id: 31, d: '2026-10-02', direction: 'in', currency: 'MXN', amount: 39206, amount_mxn: 39206, customer_name: 'Luemi', sales_invoice_id: 31 },
    ],
    planOut: [nom(901, '2026-09-15', 5000), nom(902, '2026-09-30', 5000),
      { id: 105, d: '2026-10-02', direction: 'out', currency: 'MXN', amount: 62179, amount_mxn: 62179, memo: 'SAT' }],
  });
  const today = days[0], fri = days.find((d) => d.date === '2026-10-02');
  assert.equal(today.items.length, 0, '지난 예정이 오늘 칸에 들어오지 않음');
  assert.equal(today.close.MXN, 9032);
  assert.deepEqual([today.overdue.n, today.overdue.out_mxn], [2, 10000]);
  assert.deepEqual(today.overdue.items.map((x) => [x.id, x.due, x.late_days]), [[901, '2026-09-15', 16], [902, '2026-09-30', 1]]);
  assert.equal(fri.in.MXN, 65135); assert.equal(fri.out.MXN, 62179); assert.equal(fri.close.MXN, 11988);
  assert.equal(fri.items.find((i) => i.dir === 'in').src, 'inv');
  const txt = T.buildDailyText(T.buildDays({ from: '2026-09-30', to: '2026-09-30', base: { MXN: 9032, USD: 0 } })[0], { plan: today, lang: 'ko' });
  assert.match(txt, /지난 날짜 예정 미처리 2건 · MXN 10,000/);
});

test('A3 summarizeMonth — 합계·상위·최저잔고·비공개 마스킹·계좌개설 조정', () => {
  const days = T.buildDays({
    from: '2026-09-01', to: '2026-09-03', base: { MXN: 1000, USD: 100 }, fx: T.fxFill([], '2026-09-01', '2026-09-03', 20),
    opens: [{ d: '2026-09-02', currency: 'MXN', amount: 500 }],
    pending: [{ d: '2026-09-03', n: 2, amount_mxn: 300 }],
    txns: [
      { id: 1, d: '2026-09-01', direction: 'out', currency: 'MXN', amount: 800, amount_mxn: 800, memo: '비밀', is_private: true, category_name: '기타경비' },
      { id: 2, d: '2026-09-02', direction: 'in', currency: 'USD', amount: 10, amount_mxn: 200, customer_name: 'Acme' },
      { id: 3, d: '2026-09-03', direction: 'in', currency: 'MXN', amount: 50, amount_mxn: 50, customer_name: 'Acme' },
    ],
  });
  const s = T.summarizeMonth(days, { mask: true });
  assert.deepEqual(s.close, { MXN: 750, USD: 110 });
  assert.deepEqual(s.adj, { MXN: 500, USD: 0 });
  assert.equal(s.in_eq, 250); assert.equal(s.out_eq, 800); assert.equal(s.net_eq, -550);
  assert.equal(s.top_in[0].name, 'Acme'); assert.equal(s.top_in[0].n, 2);
  assert.equal(s.top_out[0].name, '__private', '비공개는 이름 숨김');
  assert.equal(s.min.date, '2026-09-01');
  assert.deepEqual(s.pending, { n: 2, amount_mxn: 300 });
  assert.equal(T.summarizeMonth(days, { mask: false }).top_out[0].name, '비밀');
});

test('A4 WA 문구 — 언어별 · 비공개 · 항목 상한 · 템플릿 헤드라인 한 줄 · 길이 제한', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: i, d: '2026-09-29', direction: 'out', currency: 'MXN', amount: 100 + i, amount_mxn: 100 + i, memo: 'Gasto ' + i }));
  items.push({ id: 99, d: '2026-09-29', direction: 'out', currency: 'MXN', amount: 5000, amount_mxn: 5000, memo: 'Secreto', is_private: true });
  const [day] = T.buildDays({ from: '2026-09-29', to: '2026-09-29', base: { MXN: 10000, USD: 0 }, txns: items, fx: fx18('2026-09-29', '2026-09-29') });
  const es = T.buildDailyText(day, { lang: 'es' });
  const ko = T.buildDailyText(day, { lang: 'ko' });
  assert.match(es, /Resumen diario de caja/); assert.match(es, /mar 29\/09 2026/);
  assert.match(ko, /일일 자금 요약/); assert.match(ko, /9\/29\(화\)/);
  assert.ok(!es.includes('Secreto') && es.includes('Privado'), '비공개 이름 숨김');
  assert.match(es, /…y 5 más/);
  const h = T.buildDailyHeadline(day, 'es');
  assert.ok(!/\n/.test(h) && h.length < 1024);
  const long = T.buildMonthlyText({ ...T.summarizeMonth([day], { mask: true }), top_in: [], by_category_out: Array.from({ length: 12 }, (_, i) => ({ name: 'x'.repeat(900), amount_mxn: i, n: 1 })) }, { lang: 'es' });
  assert.ok(long.length <= 3802);
});

test('A5 날짜 도우미 — 주 시작(월)·월 경계·전월·MX 시각', () => {
  assert.equal(T.weekStart('2026-10-04'), '2026-09-28');   // 일요일 → 그 주 월요일
  assert.equal(T.weekStart('2026-09-28'), '2026-09-28');
  assert.deepEqual(T.monthBounds('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(T.prevMonth('2026-01'), '2025-12');
  const m = T.mxNow(Date.parse('2026-10-01T05:30:00Z'));   // MX 9/30 23:30
  assert.deepEqual(m, { ymd: '2026-09-30', hour: 23, day: 30 });
  assert.equal(T.isYmd('2026-9-1'), false); assert.equal(T.isYmd('2026-09-01'), true);
  assert.equal(T.isMonth('2026-13'), false);
});

test('A6 driftOf — 사후 수정 감지(0.5 미만 무시)', () => {
  assert.equal(T.driftOf({ close_mxn: 100, in_mxn: 0 }, { close_mxn: 100.3, in_mxn: 0 }), null);
  assert.deepEqual(T.driftOf({ close_mxn: 100 }, { close_mxn: 1100, in_mxn: 1000 }), { close_mxn: 1000, in_mxn: 1000 });
});

test('A7 집계 대상 계좌 — 불공제·금고 자동 제외, 수동 고정이 우선', () => {
  const f = (o) => T.accountScopeOf({ name: 'BBVA', type: '은행', non_deductible: false, treasury_exclude: null, ...o });
  assert.deepEqual(f({}), { included: true, reason: 'auto' });
  assert.deepEqual(f({ non_deductible: true }), { included: false, reason: 'non_deductible' });
  for (const n of ['금고', 'Caja fuerte', 'Efectivo oficina', 'Cash box']) assert.equal(f({ name: n }).reason, 'cash_box', n);
  assert.equal(f({ type: '현금' }).reason, 'cash_box');
  assert.deepEqual(f({ name: '금고', treasury_exclude: false }), { included: true, reason: 'manual_in' });
  assert.deepEqual(f({ treasury_exclude: true }), { included: false, reason: 'manual_out' });
});

test('A8 이미지 — 일일(유첨 양식)·월간 SVG 내용 · PNG 렌더(한글 폰트 동봉) · 비공개 숨김', async () => {
  const I = await import('../src/treasuryImage.js');
  const fx = fx18('2026-09-28', '2026-10-03');
  const act = T.buildDays({ from: '2026-09-28', to: '2026-09-29', base: { MXN: 2047.4, USD: 4894 }, fx,
    txns: [{ id: 1, d: '2026-09-29', direction: 'in', currency: 'MXN', amount: 6984.4, amount_mxn: 6984.4, customer_name: 'Luemi' },
      { id: 2, d: '2026-09-29', direction: 'out', currency: 'MXN', amount: 1, amount_mxn: 1, memo: 'Secreto', is_private: true }] });
  const plan = T.projectDays({ today: '2026-09-30', to: '2026-10-03', startOpen: act[1].close, fx,
    planIn: [{ id: 3, d: '2026-10-02', direction: 'in', currency: 'MXN', amount: 65135, amount_mxn: 65135, customer_name: 'Distrib. Yucatán', sales_invoice_id: 3 }] });
  for (const lang of ['ko', 'es']) {
    const svg = I.dailyImageSvg({ cols: [...act, ...plan.slice(0, 4)], reportDay: '2026-09-29', sendDay: '2026-09-30', lang });
    assert.match(svg, /^<svg /); assert.ok(svg.includes('9,031') || svg.includes('9,032'));
    assert.ok(svg.includes('97,123') && svg.includes('Luemi') && svg.includes('Yucatán'), '9,030.8 + 4,894×18');
    assert.ok(!svg.includes('Secreto'), '비공개 이름 숨김');
    assert.ok(svg.includes(lang === 'ko' ? '일일 자금 요약' : 'Resumen diario de caja'));
    const png = await I.svgToPng(svg);
    assert.ok(png && png.slice(1, 4).toString() === 'PNG', 'PNG 렌더');
  }
  const sum = T.summarizeMonth(act, { mask: true });
  const msvg = I.monthlyImageSvg({ sum, days: act, lang: 'ko', partial: true });
  assert.ok(msvg.includes('월간 자금실적') && msvg.includes('비공개') && !msvg.includes('Secreto'));
  assert.equal(I.fit('Nomina Luis Guzman Hernandez de la Garza', 12.5, 120).endsWith('…'), true);
  assert.ok(I.esc('<a&b>') === '&lt;a&amp;b&gt;');
});

// ── B. 배선 ─────────────────────────────────────────────────────────────
test('B1 server.js 등록 · 워커 기동 · 마이그레이션 · nav 화면키 · 화면 토큰', () => {
  const srv = read(join(API, 'src/server.js'));
  assert.match(srv, /import treasuryRoutes from '\.\/routes\/treasuryRoutes\.js'/);
  assert.match(srv, /app\.register\(treasuryRoutes\)/);
  assert.match(srv, /startTreasuryWorker\(app\)/);
  assert.match(read(join(API, 'migrations/0241_treasury_account_scope.sql')), /ADD COLUMN IF NOT EXISTS treasury_exclude BOOLEAN/);
  const mig = read(join(API, 'migrations/0240_treasury_daily.sql'));
  for (const t of ['treasury_daily_snapshots', 'treasury_wa_recipients', 'treasury_wa_sends']) assert.match(mig, new RegExp('CREATE TABLE IF NOT EXISTS ' + t));
  const nav = read(join(REPO, 'refatrix-nav.js'));
  assert.match(nav, /finDaily:\{file:'refatrix-cashdaily\.html'/);
  assert.match(nav, /finDaily:'__director__'/);
  assert.match(nav, /screens:\['finance','approval','finNew','finTxn','finPay','finFixed','finCash','finDaily'/);
  const page = read(join(REPO, 'refatrix-cashdaily.html'));
  assert.match(page, /build cashd-1006wh/);
  const ver = (/refatrix-nav\.js\?v=([0-9a-z]+)/.exec(page) || [])[1];
  assert.ok(ver, 'nav 버전');
  assert.ok(read(join(REPO, 'refatrix-finance.html')).includes('refatrix-nav.js?v=' + ver), '모든 화면 nav 버전 동일');
});

// ── C. E2E (실제 PostgreSQL) ────────────────────────────────────────────
const E = PG ? test : test.skip;
let S = {};
async function seed() {
  const { query } = await import('../src/db.js');
  const one = async (sql, a) => (await query(sql, a)).rows[0];
  await query(`DELETE FROM treasury_wa_sends; DELETE FROM treasury_wa_recipients; DELETE FROM treasury_daily_snapshots;`);
  const dir = (await one(`SELECT id FROM users WHERE login_id='tdir'`)) || await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ('T Director','director','x','tdir') RETURNING id`);
  const tre = (await one(`SELECT id FROM users WHERE login_id='ttre'`)) || await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ('T Treasury','treasury','x','ttre') RETURNING id`);
  const tag = 'TDAILY-' + Date.now();
  const mxn = await one(`INSERT INTO accounts (name, currency, open_balance) VALUES ($1,'MXN',0) RETURNING id`, [tag + ' MXN']);
  const usd = await one(`INSERT INTO accounts (name, currency, open_balance) VALUES ($1,'USD',4894) RETURNING id`, [tag + ' USD']);
  const later = await one(`INSERT INTO accounts (name, currency, open_balance, open_date) VALUES ($1,'MXN',777,'2026-10-15') RETURNING id`, [tag + ' later']);
  const safe = await one(`INSERT INTO accounts (name, type, currency, open_balance) VALUES ($1,'현금','MXN',50000) RETURNING id`, [tag + ' 금고']);
  const nd = await one(`INSERT INTO accounts (name, type, currency, open_balance, non_deductible) VALUES ($1,'은행','MXN',30000,true) RETURNING id`, [tag + ' 불공제']);
  const cust = await one(`INSERT INTO customers (code, name) VALUES ($1,'Luemi') RETURNING id`, [tag]);
  await query(`INSERT INTO fx_rates (rate_date, rate, source) VALUES ('2026-09-25',18,'test') ON CONFLICT (rate_date, base, quote) DO UPDATE SET rate=18`);
  // 9/27 이전 누적 = 2,047 (입금 12,047 − 지출 10,000)
  const tx = (acc, d, dir_, amt, extra = {}) => one(
    `INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, memo, sales_invoice_id, is_private, recurring_rule_id, plan_date, plan_amount)
     VALUES ($1,$2,$3,$4,'MXN',1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [acc, d, dir_, amt, extra.cat || (dir_ === 'in' ? '4010' : '6130'), extra.status || 'actual', extra.kind || 'general',
      extra.approved !== false, extra.memo || null, extra.inv || null, extra.priv === true, extra.rule || null, extra.plan_date || null, extra.plan_amount || null]);
  await tx(mxn.id, '2026-09-10', 'in', 12047.4, { memo: 'Deposito inicial' });
  // 금고·불공제 계좌 활동 — 전부 제외돼야 유첨 숫자가 유지된다
  await tx(safe.id, '2026-09-29', 'out', 1500, { memo: 'Caja chica gasolina' });
  await tx(safe.id, '2026-10-02', 'out', 700, { status: 'plan', memo: 'Caja plan', plan_date: '2026-10-02', plan_amount: 700 });
  await tx(nd.id, '2026-09-29', 'in', 8000, { memo: 'ND deposito' });
  await tx(nd.id, '2026-09-30', 'out', 999, { memo: 'ND pendiente', approved: false });
  await tx(mxn.id, '2026-09-15', 'out', 10000, { memo: 'Renta', priv: true });
  await tx(mxn.id, '2026-09-29', 'out', 999, { memo: 'Pendiente aprob', approved: false });       // 승인 대기 → 잔고 제외
  // folio 34 · 9/29 수금 6,984 (반제)
  const inv34 = await one(`INSERT INTO sales_invoices (customer_id, inv_date, due_date, sat_no, total_mxn, status) VALUES ($1,'2026-09-01','2026-09-29','F-34',6984.4,'posted') RETURNING id`, [cust.id]);
  const pay = await one(`INSERT INTO sales_payments (customer_id, pay_date, account_id, amount) VALUES ($1,'2026-09-29',$2,6984.4) RETURNING id`, [cust.id, mxn.id]);
  const t34 = await tx(mxn.id, '2026-09-29', 'in', 6984.4, { kind: 'payment', inv: inv34.id, memo: '입금 반제 (인보이스 #x)' });
  await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount, txn_id) VALUES ($1,$2,6984.4,$3)`, [pay.id, inv34.id, t34.id]);
  // 10/2 만기 미수 2건
  // 인보이스 발행 시 ERP 가 만드는 「매출 입금예정」 예정 거래(계좌 미지정) — 일일 자금 AR 의 원천
  for (const [sat, amt] of [['F-25', 25929], ['F-31', 39206]]) {
    const iv = await one(`INSERT INTO sales_invoices (customer_id, inv_date, due_date, sat_no, total_mxn, status) VALUES ($1,'2026-09-02','2026-10-02',$2,$3,'posted') RETURNING id`, [cust.id, sat, amt]);
    await query(`INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, sales_invoice_id, memo)
                 VALUES (NULL,'2026-10-02','in',$1,'MXN',1,$1,'4010','plan','invoice',true,$2,'매출 입금예정')`, [amt, iv.id]);
  }

  // 10/2 예정 지급: 고정비 4건 + SAT, 비활성 고정비 1건(제외돼야)
  const rule = async (name, active = true) => one(`INSERT INTO recurring_rules (name, amount, direction, freq, day_or_wday, active) VALUES ($1,1,'out','month',2,$2) RETURNING id`, [name, active]);
  for (const [n, a] of [['Nomina Maria', 4804], ['Nomina Oscar', 10180], ['Nomina Luis Mendez', 4281], ['Nomina Luis Guzman', 2914]]) {
    const r = await rule(n);
    await tx(mxn.id, '2026-10-02', 'out', a, { status: 'plan', rule: r.id, plan_date: '2026-10-02', plan_amount: a, memo: '[고정비] ' + n });
  }
  const off = await rule('Old rent', false);
  await tx(mxn.id, '2026-10-02', 'out', 5555, { status: 'plan', rule: off.id, plan_date: '2026-10-02', plan_amount: 5555 });
  await tx(mxn.id, '2026-10-02', 'out', 40000, { status: 'plan', memo: 'SAT', plan_date: '2026-10-02', plan_amount: 40000 });
  // 지난 날짜 미처리 예정(Nom.Palomino 9/15·9/29) — 오늘 칸에 나오면 안 됨
  const pal = await rule('Nom.Palomino');
  for (const d of ['2026-09-15', '2026-09-29']) await tx(mxn.id, d, 'out', 5000, { status: 'plan', rule: pal.id, plan_date: d, plan_amount: 5000, memo: '[고정비] Nom.Palomino' });
  // 삭제된 예정 — 거래목록에 없으므로 안 나와야 함
  await query(`INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, status, approved, memo, deleted_at) VALUES ($1,'2026-10-01','out',777,'MXN',1,777,'plan',true,'Borrado',now())`, [mxn.id]);
  S = { dir: Number(dir.id), tre: Number(tre.id), tag, mxn: Number(mxn.id), usd: Number(usd.id), later: Number(later.id), safe: Number(safe.id), nd: Number(nd.id), cust: Number(cust.id) };
}
async function cleanup() {
  if (!S.tag) return;
  const { query } = await import('../src/db.js');
  const accs = [S.mxn, S.usd, S.later, S.safe, S.nd];
  await query(`DELETE FROM sales_payment_allocations WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE customer_id=$1)`, [S.cust]);
  await query(`DELETE FROM sales_payments WHERE customer_id=$1`, [S.cust]);
  await query(`DELETE FROM transactions WHERE account_id = ANY($1)`, [accs]);
  await query(`DELETE FROM transactions WHERE sales_invoice_id IN (SELECT id FROM sales_invoices WHERE customer_id=$1)`, [S.cust]);
  await query(`DELETE FROM sales_invoices WHERE customer_id=$1`, [S.cust]);
  await query(`DELETE FROM recurring_rules WHERE name IN ('Nomina Maria','Nomina Oscar','Nomina Luis Mendez','Nomina Luis Guzman','Old rent','Nom.Palomino')`);
  await query(`DELETE FROM customers WHERE id=$1`, [S.cust]);
  await query(`DELETE FROM treasury_wa_sends; DELETE FROM treasury_wa_recipients; DELETE FROM treasury_daily_snapshots;`);
  await query(`DELETE FROM accounts WHERE id = ANY($1)`, [accs]);
}

E('C1 주간(유첨 양식) — 9/28~10/2 숫자가 유첨 엑셀과 일치 · 비활성 고정비·승인대기 제외', async () => {
  await seed();
  const w = await T.computeWeek('2026-09-30', '2026-09-30');
  assert.equal(w.from, '2026-09-28'); assert.equal(w.to, '2026-10-04'); assert.equal(w.days.length, 7);
  const by = Object.fromEntries(w.days.map((d) => [d.date, d]));
  assert.deepEqual([by['2026-09-28'].open.MXN, by['2026-09-28'].open.USD], [2047.4, 4894]);
  assert.equal(by['2026-09-29'].in.MXN, 6984.4);
  assert.equal(by['2026-09-29'].items[0].name, 'Luemi');
  assert.equal(by['2026-09-29'].pending.n, 1, '승인 대기 1건 표시');
  assert.deepEqual(w.days.slice(0, 5).map((d) => Math.round(d.close.MXN)), [2047, 9032, 9032, 9032, 11988]);
  assert.deepEqual(w.days.slice(0, 5).map((d) => Math.round(d.close_eq)), [90139, 97124, 97124, 97124, 100080]);
  assert.equal(by['2026-10-02'].in.MXN, 65135);
  assert.equal(by['2026-10-02'].out.MXN, 62179, '비활성 고정비 5,555 제외');
  assert.ok(!w.days.some((d) => d.items.some((i) => /Caja|ND /.test(i.name))), '금고·불공제 항목 없음');
  assert.ok(!by['2026-09-30'].items.some((i) => /Palomino|Borrado/.test(i.name)), '지난 예정·삭제 예정은 오늘 칸에 없음');
  assert.deepEqual([by['2026-09-30'].overdue.n, by['2026-09-30'].overdue.out_mxn], [2, 10000], '9/15·9/29 미처리는 별도 알림');
  assert.deepEqual(by['2026-09-30'].overdue.items.map((i) => i.name), ['Nom.Palomino', 'Nom.Palomino']);
  const rc = by['2026-09-30'].reconcile;
  assert.equal(rc.excluded.inactive_rule.n, 1); assert.equal(rc.excluded.account.n, 1, '금고 예정 1건');
  assert.equal(rc.list_n - rc.shown_n, 2);
  assert.equal(by['2026-09-30'].pending.n, 0);
  assert.equal(by['2026-09-30'].kind, 'today'); assert.equal(by['2026-10-01'].kind, 'plan'); assert.equal(by['2026-09-28'].kind, 'actual');
});

E('C2 계좌 개설일 — 개설 전 날짜엔 없고, 그날 「계좌 개설」 조정으로 들어온다', async () => {
  const d = await T.computeActualDays('2026-10-14', '2026-10-16');
  assert.equal(d[0].close.MXN, 9031.8);
  assert.equal(d[1].adj.MXN, 777); assert.equal(d[1].close.MXN, 9808.8);
});

E('C3 월간 + 스냅샷 최초본 보존 + 사후 수정 감지', async () => {
  const { query } = await import('../src/db.js');
  const days = await T.computeActualDays('2026-09-01', '2026-09-29');
  await T.upsertSnapshots(days);
  const s = T.summarizeMonth(days);
  assert.equal(s.in_eq, 19031.8); assert.equal(s.out_eq, 10000); assert.equal(s.close.MXN, 9031.8);
  // 소급 등록: 9/20 입금 1,000 → 재계산 시 data 는 갱신, first_data 는 그대로
  await query(`INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, status, approved) VALUES ($1,'2026-09-20','in',1000,'MXN',1,1000,'actual',true)`, [S.mxn]);
  const live = await T.computeActualDays('2026-09-01', '2026-09-29');
  const meta = await T.loadSnapshotMeta('2026-09-01', '2026-09-29');
  const d29 = live.find((d) => d.date === '2026-09-29');
  assert.deepEqual(T.driftOf(meta.get('2026-09-29').first, T.flatOf(d29)), { close_mxn: 1000 });
  await T.upsertSnapshots(live);
  const again = await T.loadSnapshotMeta('2026-09-29', '2026-09-29');
  assert.equal(again.get('2026-09-29').first.close_mxn, 9031.8, '최초본 보존');
  const cur = (await query(`SELECT close_mxn FROM treasury_daily_snapshots WHERE snap_date='2026-09-29'`)).rows[0];
  assert.equal(Number(cur.close_mxn), 10031.8, '최신본 갱신');
  await query(`DELETE FROM transactions WHERE account_id=$1 AND txn_date='2026-09-20'`, [S.mxn]);
});

E('C4 스케줄 — 10/1 07시: 일일(9/30)·월간(9월) 발송 · 1회 가드 · 실패 5회 상한 · 창 밖 시간 무발송', async () => {
  const { query } = await import('../src/db.js');
  const r1 = (await query(`INSERT INTO treasury_wa_recipients (name, phone, lang) VALUES ('Jang','5218110000001','ko') RETURNING id`)).rows[0];
  const r2 = (await query(`INSERT INTO treasury_wa_recipients (name, phone, lang, get_daily) VALUES ('Christopher','5218110000002','es',false) RETURNING id`)).rows[0];
  await query(`INSERT INTO treasury_wa_recipients (name, phone, lang, active) VALUES ('Off','5218110000003','es',false)`);
  const sent = [];
  const ok = async (m) => { sent.push(m); return { ok: true, mode: 'text', message_id: 'wamid.' + sent.length }; };
  const at = (iso) => Date.parse(iso);
  const res = await T.runTreasuryJob({ nowMs: at('2026-10-01T13:00:00Z'), sender: ok });   // MX 07:00
  assert.equal(res.yday, '2026-09-30');
  assert.equal(res.daily.length, 1, '일일은 get_daily 수신자만(비활성·월간전용 제외)');
  assert.equal(res.monthly.length, 2);
  const jangDaily = sent.find((m) => m.to === '5218110000001' && /일일 자금 요약/.test(m.text));
  assert.ok(jangDaily, '한국어 수신자는 한국어');
  assert.ok(!/오늘 예정/.test(jangDaily.text), '10/1 은 예정 없음 → 섹션 생략');
  const p2 = await T.prepareDaily('2026-10-01', '2026-10-02');
  const k2 = p2.build('ko').text;
  assert.match(k2, /오늘 예정 \(10\/2\(금\)\)/);
  assert.match(k2, /수금 2 · MXN 65,135  \|  지급 5 · MXN 62,179/);
  const chrisMonthly = sent.find((m) => m.to === '5218110000002');
  assert.match(chrisMonthly.text, /Resultado mensual de caja/);
  assert.match(chrisMonthly.text, /septiembre 2026/);
  assert.ok(!/Renta/.test(chrisMonthly.text), '비공개 지출 이름 숨김');
  assert.match(chrisMonthly.text, /refatrix-cashdaily\.html/);
  // 2회차: 성공 이력 → 재발송 없음
  const again = await T.runTreasuryJob({ nowMs: at('2026-10-01T13:05:00Z'), sender: ok });
  assert.ok(again.daily.every((x) => x.skipped === 'already_sent') && again.monthly.every((x) => x.skipped === 'already_sent'));
  // 스냅샷 누적
  const n = Number((await query(`SELECT COUNT(*) AS n FROM treasury_daily_snapshots WHERE snap_date BETWEEN '2026-09-01' AND '2026-09-30'`)).rows[0].n);
  assert.equal(n, 30);
  // 실패: 10/2 일일 → 5회 후 중단
  const bad = async () => ({ ok: false, error: 'Re-engagement message', code: 131047 });
  for (let i = 0; i < 7; i++) await T.runTreasuryJob({ nowMs: at('2026-10-02T13:00:00Z') + i * 300000, sender: bad });
  const row = (await query(`SELECT attempts, status, error, sent_at FROM treasury_wa_sends WHERE kind='daily' AND period='2026-10-01' AND recipient_id=$1`, [r1.id])).rows[0];
  assert.equal(Number(row.attempts), 5); assert.equal(row.status, 'failed'); assert.equal(row.sent_at, null);
  // 정오 이후 / 06시 전 → 일일 없음
  const late = await T.runTreasuryJob({ nowMs: at('2026-10-03T19:00:00Z'), sender: ok });   // MX 13:00
  assert.equal(late.daily.length, 0);
  assert.equal((await T.runTreasuryJob({ nowMs: at('2026-10-03T11:00:00Z'), sender: ok })).skipped, 'early');
  // 4일 → 월간 캐치업 종료
  const d4 = await T.runTreasuryJob({ nowMs: at('2026-10-04T13:00:00Z'), sender: ok });
  assert.equal(d4.monthly.length, 0);
  // 일요일 무거래는 일일 생략 (10/4 일 → 10/5 발송분)
  const mon = await T.runTreasuryJob({ nowMs: at('2026-10-05T13:00:00Z'), sender: ok });
  assert.equal(mon.yday, '2026-10-04'); assert.equal(mon.daily.length, 0);
  assert.ok(r2.id);
});

E('C6 이미지 발송 — 업로드 1회 재사용 · 이미지 실패 시 이미지 템플릿 → 텍스트 대체 · 원장 상태', async () => {
  const { query } = await import('../src/db.js');
  await query(`DELETE FROM treasury_wa_sends; DELETE FROM treasury_wa_recipients;`);
  await query(`INSERT INTO treasury_wa_recipients (name, phone, lang) VALUES ('A','5218110000011','ko'),('B','5218110000012','ko'),('C','5218110000013','es')`);
  const log = [];
  const img = (mode) => ({
    upload: async (buf) => { log.push(['upload', buf.slice(1, 4).toString()]); return { ok: true, id: 'mid' + log.filter((x) => x[0] === 'upload').length }; },
    image: async (o) => { log.push(['image', o.to, o.mediaId, o.caption]); return mode === 'ok' ? { ok: true, message_id: 'wamid.i' } : { ok: false, error: 'Re-engagement message' }; },
    imageTemplate: async (o) => { log.push(['itpl', o.to, o.name]); return mode === 'tpl' ? { ok: true, message_id: 'wamid.t' } : { ok: false, error: 'no' }; },
  });
  const text = async (m) => { log.push(['text', m.to]); return { ok: true, mode: 'text', message_id: 'wamid.x' }; };
  // ① 이미지 성공: 한국어 2명은 업로드 1회 공유, 스페인어 1회
  const prepared = await T.prepareDaily('2026-09-29', '2026-09-30');
  assert.equal(prepared.cols.map((d) => d.kind).join(','), 'actual,actual,today,plan,plan,plan');
  let rc = (await query(`SELECT id, name, phone, lang FROM treasury_wa_recipients ORDER BY id`)).rows;
  let r = await T.sendReport({ kind: 'daily', period: '2026-09-29', recipients: rc, prepared, sender: text, imgApi: img('ok') }, query);
  assert.deepEqual(r.map((x) => x.status), ['sent_image', 'sent_image', 'sent_image']);
  assert.equal(log.filter((x) => x[0] === 'upload').length, 2, '언어별 업로드 1회');
  assert.ok(log.every((x) => x[0] !== 'upload' || x[1] === 'PNG'));
  assert.match(log.find((x) => x[0] === 'image')[3], /일일 자금 요약.*9,032/);
  // ② 이미지 실패 + 이미지 템플릿 설정 → 이미지 템플릿
  log.length = 0; process.env.TREASURY_WA_IMAGE_TEMPLATE = 'resumen_caja_img';
  r = await T.sendReport({ kind: 'daily', period: '2026-09-28', recipients: rc.slice(0, 1), prepared, force: true, sender: text, imgApi: img('tpl') }, query);
  assert.equal(r[0].status, 'sent_image_template');
  // ③ 둘 다 실패 → 텍스트, 원장 error 에 이미지 실패 사유 보존
  log.length = 0;
  r = await T.sendReport({ kind: 'daily', period: '2026-09-27', recipients: rc.slice(0, 1), prepared, force: true, sender: text, imgApi: img('bad') }, query);
  assert.equal(r[0].status, 'sent_text');
  const row = (await query(`SELECT status, error FROM treasury_wa_sends WHERE period='2026-09-27'`)).rows[0];
  assert.match(row.error, /image: Re-engagement/);
  delete process.env.TREASURY_WA_IMAGE_TEMPLATE;
  // ④ TREASURY_WA_FORMAT=text → 업로드 없이 텍스트
  log.length = 0; process.env.TREASURY_WA_FORMAT = 'text';
  r = await T.sendReport({ kind: 'daily', period: '2026-09-26', recipients: rc.slice(0, 1), prepared, force: true, sender: text, imgApi: img('ok') }, query);
  assert.equal(r[0].status, 'sent_text'); assert.equal(log.filter((x) => x[0] === 'upload').length, 0);
  delete process.env.TREASURY_WA_FORMAT;
  // 월간 이미지 준비
  const pm = await T.prepareMonthly('2026-09', '2026-10-01');
  assert.match(pm.build('es').svg, /Resultado mensual de caja/);
  await query(`DELETE FROM treasury_wa_sends; DELETE FROM treasury_wa_recipients;`);
});

E('C5 API — 디렉터 전용 · 수신자 CRUD(번호 정규화·중복) · 월간 · 미리보기 · 미설정 발송 503', async () => {
  const { buildApp } = await import('../src/server.js');
  const { query } = await import('../src/db.js');
  await query(`DELETE FROM treasury_wa_sends; DELETE FROM treasury_wa_recipients;`);
  const app = buildApp(); await app.ready();
  const tok = (id, role) => app.jwt.sign({ sub: id, role });
  const call = (who, method, url, payload) => app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + who } });
  const D = tok(S.dir, 'director'), X = tok(S.tre, 'treasury');
  assert.equal((await call(X, 'GET', '/api/treasury/month?month=2026-09')).statusCode, 403, '재무담당도 화면은 디렉터 전용');
  const c = await call(D, 'POST', '/api/treasury/recipients', { name: 'Jang', phone: '81 1234 5678', lang: 'ko' });
  assert.equal(c.statusCode, 200); const rc = c.json();
  assert.equal(rc.phone, '528112345678'); assert.equal(rc.phone_masked, '528****5678');
  assert.equal((await call(D, 'POST', '/api/treasury/recipients', { name: 'Dup', phone: '+52 1 81 1234 5678' })).statusCode, 409);
  assert.equal((await call(D, 'POST', '/api/treasury/recipients', { name: 'Bad', phone: '123' })).json().error, 'bad_phone');
  const p = await call(D, 'PATCH', '/api/treasury/recipients/' + rc.id, { get_daily: false, lang: 'es' });
  assert.equal(p.json().get_daily, false); assert.equal(p.json().lang, 'es');
  assert.equal((await call(D, 'GET', '/api/treasury/recipients')).json().items.length, 1);
  const m = await call(D, 'GET', '/api/treasury/month?month=2026-09');
  assert.equal(m.statusCode, 200);
  const mj = m.json();
  assert.ok(mj.days.length >= 29 && mj.summary.close.MXN === 9031.8);
  assert.equal((await call(D, 'GET', '/api/treasury/month?month=2099-01')).statusCode, 400);
  const w = (await call(D, 'GET', '/api/treasury/week?date=2026-09-28')).json();
  assert.equal(w.from, '2026-09-28');
  const pv = await call(D, 'GET', '/api/treasury/wa/preview?kind=monthly&period=2026-09&lang=ko');
  assert.match(pv.json().text, /월간 자금실적/);
  assert.equal((await call(D, 'GET', '/api/treasury/wa/preview?kind=daily&period=2099-01-01')).json().error, 'not_closed');
  const tokenBak = process.env.WHATSAPP_TOKEN; delete process.env.WHATSAPP_TOKEN;
  assert.equal((await call(D, 'POST', '/api/treasury/wa/send', { kind: 'daily' })).statusCode, 503);
  if (tokenBak) process.env.WHATSAPP_TOKEN = tokenBak;
  const im = await call(D, 'GET', '/api/treasury/wa/image?kind=daily&period=2026-09-29&lang=ko');
  assert.equal(im.statusCode, 200); assert.equal(im.headers['content-type'], 'image/png');
  assert.equal(im.rawPayload.slice(1, 4).toString(), 'PNG');
  const st = (await call(D, 'GET', '/api/treasury/wa/status')).json();
  assert.equal(st.format, 'image'); assert.equal(st.image_ready, true);
  assert.equal(st.api_ready, false); assert.equal(st.schedule.send_hour_mx, 6);
  const acc = (await call(D, 'GET', '/api/treasury/accounts')).json();
  const rs = Object.fromEntries(acc.accounts.map((a) => [a.id, a.reason]));
  assert.equal(rs[S.safe], 'cash_box'); assert.equal(rs[S.nd], 'non_deductible'); assert.equal(rs[S.mxn], 'auto');
  assert.deepEqual(mj.scope.excluded.map((x) => x.reason).sort(), ['cash_box', 'non_deductible']);
  assert.equal((await call(D, 'PATCH', '/api/treasury/accounts/' + S.safe, { mode: 'x' })).statusCode, 400);
  await call(D, 'PATCH', '/api/treasury/accounts/' + S.safe, { mode: 'include' });
  const m2 = (await call(D, 'GET', '/api/treasury/month?month=2026-09')).json();
  assert.equal(m2.summary.close.MXN, 9031.8 + 50000 - 1500, '금고 강제 포함 → 금고 잔고·지출 반영');
  await call(D, 'PATCH', '/api/treasury/accounts/' + S.safe, { mode: 'auto' });
  assert.equal((await call(D, 'GET', '/api/treasury/month?month=2026-09')).json().summary.close.MXN, 9031.8);
  assert.equal((await call(D, 'DELETE', '/api/treasury/recipients/' + rc.id)).json().ok, true);
  assert.equal((await call(D, 'GET', '/api/treasury/recipients')).json().items.length, 0);
  await cleanup();
});
