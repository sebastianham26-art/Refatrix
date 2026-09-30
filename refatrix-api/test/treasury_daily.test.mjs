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

test('A2 projectDays — 오늘부터 예정, 지난 미실현은 오늘로 이월(유첨 10/2 = 65,135 / 62,179 / 11,988 / 100,080)', () => {
  const days = T.projectDays({
    today: '2026-09-30', to: '2026-10-03', startOpen: { MXN: 9032, USD: 4894 }, fx: fx18('2026-09-30', '2026-10-03'),
    invoices: [
      { id: 25, due: '2026-10-02', outstanding: 25929, customer_name: 'Luemi', sat_no: 'F-25' },
      { id: 31, due: '2026-10-02', outstanding: 39206, customer_name: 'Luemi', sat_no: 'F-31' },
      { id: 9, due: '2026-09-20', outstanding: 0.3, customer_name: 'Dust' },                // 반올림 잔여 — 제외
      { id: 7, due: '2026-09-25', outstanding: 1000, customer_name: 'Late SA' },           // 연체 → 오늘로
    ],
    planOut: [
      { id: 101, d: '2026-10-02', direction: 'out', currency: 'MXN', amount: 4804, amount_mxn: 4804, rule_name: 'Nomina Maria', recurring_rule_id: 1 },
      { id: 102, d: '2026-10-02', direction: 'out', currency: 'MXN', amount: 10180, amount_mxn: 10180, rule_name: 'Nomina Oscar', recurring_rule_id: 2 },
      { id: 103, d: '2026-10-02', direction: 'out', currency: 'MXN', amount: 4281, amount_mxn: 4281, rule_name: 'Nomina Luis Mendez', recurring_rule_id: 3 },
      { id: 104, d: '2026-10-02', direction: 'out', currency: 'MXN', amount: 2914, amount_mxn: 2914, rule_name: 'Nomina Luis Guzman', recurring_rule_id: 4 },
      { id: 105, d: '2026-10-02', direction: 'out', currency: 'MXN', amount: 40000, amount_mxn: 40000, memo: 'SAT' },
    ],
  });
  const today = days[0], fri = days.find((d) => d.date === '2026-10-02');
  assert.equal(today.kind, 'today');
  assert.equal(today.in.MXN, 1000); assert.equal(today.items[0].late_days, 5);
  assert.equal(fri.in.MXN, 65135); assert.equal(fri.out.MXN, 62179);
  assert.equal(fri.close.MXN, 11988 + 1000);          // 연체 1,000 이 오늘 이월돼 뒤로 이어짐
  assert.equal(fri.items.find((i) => i.src === 'fix').name, 'Nomina Oscar');
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

// ── B. 배선 ─────────────────────────────────────────────────────────────
test('B1 server.js 등록 · 워커 기동 · 마이그레이션 · nav 화면키 · 화면 토큰', () => {
  const srv = read(join(API, 'src/server.js'));
  assert.match(srv, /import treasuryRoutes from '\.\/routes\/treasuryRoutes\.js'/);
  assert.match(srv, /app\.register\(treasuryRoutes\)/);
  assert.match(srv, /startTreasuryWorker\(app\)/);
  const mig = read(join(API, 'migrations/0240_treasury_daily.sql'));
  for (const t of ['treasury_daily_snapshots', 'treasury_wa_recipients', 'treasury_wa_sends']) assert.match(mig, new RegExp('CREATE TABLE IF NOT EXISTS ' + t));
  const nav = read(join(REPO, 'refatrix-nav.js'));
  assert.match(nav, /finDaily:\{file:'refatrix-cashdaily\.html'/);
  assert.match(nav, /finDaily:'__director__'/);
  assert.match(nav, /screens:\['finance','approval','finNew','finTxn','finPay','finFixed','finCash','finDaily'/);
  const page = read(join(REPO, 'refatrix-cashdaily.html'));
  assert.match(page, /build cashd-0930a/);
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
  const cust = await one(`INSERT INTO customers (code, name) VALUES ($1,'Luemi') RETURNING id`, [tag]);
  await query(`INSERT INTO fx_rates (rate_date, rate, source) VALUES ('2026-09-25',18,'test') ON CONFLICT (rate_date, base, quote) DO UPDATE SET rate=18`);
  // 9/27 이전 누적 = 2,047 (입금 12,047 − 지출 10,000)
  const tx = (acc, d, dir_, amt, extra = {}) => one(
    `INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, memo, sales_invoice_id, is_private, recurring_rule_id, plan_date, plan_amount)
     VALUES ($1,$2,$3,$4,'MXN',1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [acc, d, dir_, amt, extra.cat || (dir_ === 'in' ? '4010' : '6130'), extra.status || 'actual', extra.kind || 'general',
      extra.approved !== false, extra.memo || null, extra.inv || null, extra.priv === true, extra.rule || null, extra.plan_date || null, extra.plan_amount || null]);
  await tx(mxn.id, '2026-09-10', 'in', 12047.4, { memo: 'Deposito inicial' });
  await tx(mxn.id, '2026-09-15', 'out', 10000, { memo: 'Renta', priv: true });
  await tx(mxn.id, '2026-09-29', 'out', 999, { memo: 'Pendiente aprob', approved: false });       // 승인 대기 → 잔고 제외
  // folio 34 · 9/29 수금 6,984 (반제)
  const inv34 = await one(`INSERT INTO sales_invoices (customer_id, inv_date, due_date, sat_no, total_mxn, status) VALUES ($1,'2026-09-01','2026-09-29','F-34',6984.4,'posted') RETURNING id`, [cust.id]);
  const pay = await one(`INSERT INTO sales_payments (customer_id, pay_date, account_id, amount) VALUES ($1,'2026-09-29',$2,6984.4) RETURNING id`, [cust.id, mxn.id]);
  const t34 = await tx(mxn.id, '2026-09-29', 'in', 6984.4, { kind: 'payment', inv: inv34.id, memo: '입금 반제 (인보이스 #x)' });
  await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount, txn_id) VALUES ($1,$2,6984.4,$3)`, [pay.id, inv34.id, t34.id]);
  // 10/2 만기 미수 2건
  await query(`INSERT INTO sales_invoices (customer_id, inv_date, due_date, sat_no, total_mxn, status) VALUES ($1,'2026-09-02','2026-10-02','F-25',25929,'posted'),($1,'2026-09-05','2026-10-02','F-31',39206,'posted')`, [cust.id]);
  // 10/2 예정 지급: 고정비 4건 + SAT, 비활성 고정비 1건(제외돼야)
  const rule = async (name, active = true) => one(`INSERT INTO recurring_rules (name, amount, direction, freq, day_or_wday, active) VALUES ($1,1,'out','month',2,$2) RETURNING id`, [name, active]);
  for (const [n, a] of [['Nomina Maria', 4804], ['Nomina Oscar', 10180], ['Nomina Luis Mendez', 4281], ['Nomina Luis Guzman', 2914]]) {
    const r = await rule(n);
    await tx(mxn.id, '2026-10-02', 'out', a, { status: 'plan', rule: r.id, plan_date: '2026-10-02', plan_amount: a, memo: '[고정비] ' + n });
  }
  const off = await rule('Old rent', false);
  await tx(mxn.id, '2026-10-02', 'out', 5555, { status: 'plan', rule: off.id, plan_date: '2026-10-02', plan_amount: 5555 });
  await tx(mxn.id, '2026-10-02', 'out', 40000, { status: 'plan', memo: 'SAT', plan_date: '2026-10-02', plan_amount: 40000 });
  S = { dir: Number(dir.id), tre: Number(tre.id), tag, mxn: Number(mxn.id), usd: Number(usd.id), later: Number(later.id), cust: Number(cust.id) };
}
async function cleanup() {
  if (!S.tag) return;
  const { query } = await import('../src/db.js');
  const accs = [S.mxn, S.usd, S.later];
  await query(`DELETE FROM sales_payment_allocations WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE customer_id=$1)`, [S.cust]);
  await query(`DELETE FROM sales_payments WHERE customer_id=$1`, [S.cust]);
  await query(`DELETE FROM transactions WHERE account_id = ANY($1)`, [accs]);
  await query(`DELETE FROM sales_invoices WHERE customer_id=$1`, [S.cust]);
  await query(`DELETE FROM recurring_rules WHERE name IN ('Nomina Maria','Nomina Oscar','Nomina Luis Mendez','Nomina Luis Guzman','Old rent')`);
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
  assert.equal(rc.phone, '5218112345678'); assert.equal(rc.phone_masked, '521****5678');
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
  const st = (await call(D, 'GET', '/api/treasury/wa/status')).json();
  assert.equal(st.api_ready, false); assert.equal(st.schedule.send_hour_mx, 6);
  assert.equal((await call(D, 'DELETE', '/api/treasury/recipients/' + rc.id)).json().ok, true);
  assert.equal((await call(D, 'GET', '/api/treasury/recipients')).json().items.length, 0);
  await cleanup();
});
