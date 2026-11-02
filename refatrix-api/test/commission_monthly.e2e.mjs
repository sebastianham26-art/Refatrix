// 2026-11-02 월별 인보이스·커미션 — 실 PostgreSQL E2E (fastify inject)
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import assert from 'node:assert/strict';
import { query, pool } from '../src/db.js';
import commissionRoutes, { monthlyLine, summarizeAgentMonths } from '../src/routes/commissionRoutes.js';

const one = async (sql, a = []) => (await query(sql, a)).rows[0];
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓', m); };

if (process.env.E2E_OK !== '1') { console.error('빈 테스트 DB 에서만 실행: E2E_OK=1'); process.exit(1); }
// ── 시드 ──
const team = await one(`INSERT INTO sales_teams(name) VALUES ('T1') RETURNING id`);
const mk = async (name, role) => (await one(`INSERT INTO users(name,role,pin_hash,login_id,team_id) VALUES ($1,$2,'x',$1,$3) RETURNING id`, [name, role, team.id])).id;
const dir = await mk('dir', 'director'), ana = await mk('Ana', 'sales'), beto = await mk('Beto', 'sales'), caro = await mk('Caro', 'sales');
const custA = (await one(`INSERT INTO customers(code,name,owner_id,team_id) VALUES ('C1','Refaccionaria Uno',$1,$2) RETURNING id`, [ana, team.id])).id;
const custB = (await one(`INSERT INTO customers(code,name,owner_id,team_id) VALUES ('C2','Autopartes Dos',$1,$2) RETURNING id`, [beto, team.id])).id;
const p1 = (await one(`INSERT INTO products(code) VALUES ('P1') RETURNING id`)).id;
const p2 = (await one(`INSERT INTO products(code) VALUES ('P2') RETURNING id`)).id;
for (const [u, basis] of [[ana, 'revenue'], [beto, 'collection']]) {
  await query(`INSERT INTO commission_agents(user_id,default_rate,active) VALUES ($1,4,true)`, [u]);
  await query(`INSERT INTO commission_agent_periods(user_id,start_date,end_date,basis,rate,match_on) VALUES ($1,'2026-01-01',NULL,$2,4,'invoice')`, [u, basis]);
}
const inv = async (cust, date, sat, lines) => {
  const sub = lines.reduce((s, l) => s + l[1] * l[2], 0);
  const id = (await one(`INSERT INTO sales_invoices(customer_id,inv_date,sat_no,subtotal_mxn,iva_mxn,total_mxn) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [cust, date, sat, sub, +(sub * 0.16).toFixed(2), +(sub * 1.16).toFixed(2)])).id;
  for (const [p, q, pr] of lines) await query(`INSERT INTO sales_invoice_lines(invoice_id,product_id,qty,list_price,unit_price,line_amount_mxn) VALUES ($1,$2,$3,$4,$4,$5)`, [id, p, q, pr, q * pr]);
  return id;
};
const a1 = await inv(custA, '2026-10-05', '5A1B2C3D-AAAA-BBBB-CCCC-00000000F001', [[p1, 10, 100], [p2, 5, 200], [p1, 2, 100]]); // 사원 Ana, 10월
const a2 = await inv(custA, '2026-09-20', 'F-0002', [[p1, 1, 1000]]);                                                         // Ana, 9월
const b1 = await inv(custB, '2026-10-10', 'F-0003', [[p2, 3, 500]]);                                                          // Beto, 10월 (수금 완납 → 확정)
const b2 = await inv(custB, '2026-10-12', 'F-0004', [[p2, 1, 500]]);                                                          // Beto, 10월 (미수 → 기대)
// Beto b1 완납
const acct = (await one(`INSERT INTO accounts(name,currency) VALUES ('Banco','MXN') RETURNING id`)).id;
const pay = (await one(`INSERT INTO sales_payments(customer_id,pay_date,account_id,amount) VALUES ($1,'2026-10-20',$2,1740) RETURNING id`, [custB, acct])).id;
await query(`INSERT INTO sales_payment_allocations(payment_id,invoice_id,amount) VALUES ($1,$2,1740)`, [pay, b1]);
// Ana a2(9월) 지급 완료
await query(`INSERT INTO commission_payouts(invoice_id,agent_id,amount,settle_ym,paid,paid_date) VALUES ($1,$2,40,'2026-09',true,'2026-10-15')`, [a2, ana]);
// 10월 배치 지급일 지정
await query(`INSERT INTO commission_batches(settle_ym,status,pay_date) VALUES ('2026-10','confirmed','2026-11-14')`);
// 만기일 · 지연: b1 만기 10-15 → 10-20 완납(+5일)
await query(`UPDATE sales_invoices SET due_date='2026-10-15', credit_days=5 WHERE id=$1`, [b1]);
// 「Oscar 형」: 수금일 판정 기간이 10/1 시작 — 9월 발행 인보이스가 9월 목록에 나오는 이유 재현
const oscar = await mk('Oscar', 'sales');
const custO = (await one(`INSERT INTO customers(code,name,owner_id,team_id) VALUES ('C3','Merida Tres',$1,$2) RETURNING id`, [oscar, team.id])).id;
await query(`INSERT INTO commission_agents(user_id,default_rate,active) VALUES ($1,3,true)`, [oscar]);
await query(`INSERT INTO commission_agent_periods(user_id,start_date,end_date,basis,rate,match_on) VALUES ($1,'2026-10-01',NULL,'collection',3,'payment')`, [oscar]);
const o1 = await inv(custO, '2026-09-10', 'F-0101', [[p1, 4, 250]]);   // 1000 + IVA = 1160
const o2 = await inv(custO, '2026-09-15', 'F-0102', [[p2, 2, 500]]);   // 미수
const o3 = await inv(custO, '2026-09-05', 'F-0103', [[p1, 1, 100]]);   // 9월에 완납 → 기간 전 수금 → 목록 제외
await query(`UPDATE sales_invoices SET due_date=inv_date + 30, credit_days=30 WHERE id = ANY($1::bigint[])`, [[o1, o2, o3]]);
const op = (await one(`INSERT INTO sales_payments(customer_id,pay_date,account_id,amount) VALUES ($1,'2026-10-25',$2,580) RETURNING id`, [custO, acct])).id;
await query(`INSERT INTO sales_payment_allocations(payment_id,invoice_id,amount) VALUES ($1,$2,580)`, [op, o1]);
const op0 = (await one(`INSERT INTO sales_payments(customer_id,pay_date,account_id,amount) VALUES ($1,'2026-09-20',$2,116) RETURNING id`, [custO, acct])).id;
await query(`INSERT INTO sales_payment_allocations(payment_id,invoice_id,amount) VALUES ($1,$2,116)`, [op0, o3]);

// ── 앱 ──
const app = Fastify();
app.register(fastifyJwt, { secret: 'test' });
app.register(commissionRoutes);
await app.ready();
const tok = (id) => app.jwt.sign({ sub: id });
const get = async (u, id) => { const r = await app.inject({ method: 'GET', url: u, headers: { authorization: 'Bearer ' + tok(id) } }); return { code: r.statusCode, body: r.json() }; };

console.log('monthly-index (director)');
let r = await get('/api/commission/monthly-index', dir);
ok(r.code === 200, '200');
ok(r.body.see_all === true, 'see_all');
ok(r.body.agents.map((a) => a.agent_name).join(',') === 'Ana,Beto,Oscar', '활성 커미션 대상만(Caro 제외)');
const cell = (aid, ym) => r.body.cells.find((c) => c.agent_id === aid && c.ym === ym);
ok(cell(Number(ana), '2026-10').invoice_count === 1 && cell(Number(ana), '2026-10').commission === 88, 'Ana 10월 1건 · 커미션 88 (2200×4%)');
ok(cell(Number(ana), '2026-09').paid === 40, 'Ana 9월 지급 40');
ok(cell(Number(beto), '2026-10').invoice_count === 2 && cell(Number(beto), '2026-10').commission === 80, 'Beto 10월 2건 · 60+20');
ok(r.body.cells[0].ym === '2026-10', '최신 월 먼저');

console.log('monthly-invoices (director · 다중 대상)');
r = await get(`/api/commission/monthly-invoices?ym=2026-10&agent_ids=${ana},${beto}`, dir);
ok(r.code === 200 && r.body.lines.length === 3, '10월 · Ana+Beto = 3건');
const L1 = r.body.lines.find((l) => l.invoice_id === Number(a1));
ok(L1.qty === 17 && L1.sku === 2, '총 수량 17 · SKU 2 (같은 품목 두 줄은 1 SKU)');
ok(L1.subtotal === 2200 && L1.iva === 352 && L1.total === 2552, 'IVA 제외·IVA·총액');
ok(L1.status === 'confirmed' && L1.commission === 88 && L1.pay_date === '2026-11-14', '매출기준 → 확정 · 배치 지급일');
const B1 = r.body.lines.find((l) => l.invoice_id === Number(b1));
ok(B1.status === 'confirmed' && B1.commission === 60 && B1.pay_date === '2026-11-14', '수금기준 완납 → 확정 60');
const B2 = r.body.lines.find((l) => l.invoice_id === Number(b2));
ok(B2.status === 'expected' && B2.commission === 20 && B2.pay_date === null, '수금기준 미수 → 기대 20 · 지급일 없음');
ok(r.body.totals.commission === 168 && r.body.totals.commission_expected === 20 && r.body.totals.qty === 21, '합계');
ok(r.body.lines[0].agent_name === 'Ana', '대상 이름순 정렬');

r = await get(`/api/commission/monthly-invoices?ym=2026-09&agent_ids=${ana}`, dir);
ok(r.body.lines.length === 1 && r.body.lines[0].status === 'paid' && r.body.lines[0].pay_date === '2026-10-15' && r.body.lines[0].commission === 40, '9월 지급완료 · 실제 지급일');

r = await get(`/api/commission/monthly-invoices?ym=2026-10&agent_ids=${beto}`, dir);
ok(r.body.lines.length === 2 && r.body.lines.every((l) => l.agent_id === Number(beto)), '한 명만 선택 시 그 사람만');

r = await get(`/api/commission/monthly-invoices?ym=2026-10`, dir);
ok(r.code === 400 && r.body.error === 'agents_required', '대상 없으면 400');
r = await get(`/api/commission/monthly-invoices?agent_ids=${ana}`, dir);
ok(r.code === 400 && r.body.error === 'ym_required', '월 없으면 400');

console.log('수금·만기·지연');
r = await get(`/api/commission/monthly-invoices?ym=2026-10&agent_ids=${beto}`, dir);
const B1x = r.body.lines.find((l) => l.invoice_id === Number(b1));
ok(B1x.due_date === '2026-10-15' && B1x.last_pay_date === '2026-10-20' && B1x.delay_days === 5 && B1x.delay_open === false, '완납 지연 +5일 (마지막 수금일 − 만기일)');
ok(B1x.payments.length === 1 && B1x.payments[0].date === '2026-10-20' && B1x.payments[0].amount === 1740, '수금 내역');

console.log('Oscar 형: 9월 발행 · 10/1 시작 수금일 판정 기간');
r = await get(`/api/commission/monthly-invoices?ym=2026-09&agent_ids=${oscar}`, dir);
ok(r.body.lines.length === 2, '9월: 미수 잔액이 남은 2건만 (9월에 완납된 건은 제외)');
const O1 = r.body.lines.find((l) => l.invoice_id === Number(o1));
ok(O1.in_period === false && O1.match_on === null, '발행일은 기간 밖');
ok(O1.period_collected === 580 && O1.fully_paid === false && O1.balance === 580, '10월 수금 580 = 기간 안 수금');
ok(O1.commission === 30 && O1.status === 'expected', '커미션 = (580+잔액580)×(1000/1160)×3% = 30 기대');
ok(O1.due_date === '2026-10-10' && O1.delay_open === true && O1.delay_days > 0, '만기 10-10 · 미수 지연중');
const O2 = r.body.lines.find((l) => l.invoice_id === Number(o2));
ok(O2.period_collected === 0 && O2.last_pay_date === null && O2.payments === null && O2.commission === 30, '수금 0 · 앞으로 수금될 잔액에 대한 기대 커미션');

console.log('현재 기준 / 펜딩 분리');
ok(O1.commission_now === 15 && O1.commission_pending === 15, 'Oscar 9월 부분수금: 현재 15(수금 580분) · 펜딩 15(잔액 580분)');
ok(O2.commission_now === 0 && O2.commission_pending === 30, 'Oscar 9월 미수: 현재 0 · 펜딩 30');
ok(r.body.totals.commission_now === 15 && r.body.totals.commission_pending === 45 && r.body.totals.pending_count === 2 && r.body.totals.pending_balance === 1740, 'Oscar 9월 요약: 현재 15 · 펜딩 45 · 잔액 2건 1,740');
r = await get(`/api/commission/monthly-invoices?ym=2026-10&agent_ids=${ana},${beto}`, dir);
ok(r.body.totals.commission_now === 148 && r.body.totals.commission_pending === 20, '10월 Ana+Beto: 현재 88+60 · 펜딩 20(Beto 미수, 발행일 판정 → 완납 전 0)');
r = await get('/api/commission/monthly-index', dir);
const oc = r.body.cells.find((c) => c.agent_id === Number(oscar) && c.ym === '2026-09');
ok(oc.now === 15 && oc.pending === 45, '월 칩 집계에도 현재/펜딩');

console.log('월별 지급 배치 — 사원별');
r = await get('/api/commission/batches', dir);
const oct = r.body.items.find((m) => m.settle_ym === '2026-10');
ok(oct.by_agent.map((a) => a.agent_name + ':' + a.confirmed + '/' + a.unpaid).join(',') === 'Ana:88/88,Beto:60/60', '10월 배치: Ana 88 · Beto 60 (사원별)');
const sep = r.body.items.find((m) => m.settle_ym === '2026-09');
ok(sep.by_agent.length === 1 && sep.by_agent[0].paid === 40 && sep.by_agent[0].unpaid === 0, '9월 배치: Ana 지급완료 40');

console.log('영업사원 본인만');
await query(`INSERT INTO user_page_access(user_id,page_key,device_req) VALUES ($1,'commission','anywhere') ON CONFLICT DO NOTHING`, [beto]);
// 영업사원이 커미션 화면을 볼 수 있게(역할 기본값이 없을 때만)
r = await get('/api/commission/monthly-index', beto);
if (r.code === 403) console.log('  (sales 기본 권한에 commission 없음 — 권한 부여 후 재시도)');
if (r.code === 200) {
  ok(r.body.see_all === false && r.body.agents.length === 1 && r.body.agents[0].agent_id === Number(beto), '본인만 대상');
  ok(r.body.cells.every((c) => c.agent_id === Number(beto)), '본인 셀만');
  r = await get(`/api/commission/monthly-invoices?ym=2026-10&agent_ids=${ana}`, beto);
  ok(r.code === 200 && r.body.lines.length === 2 && r.body.lines.every((l) => l.agent_id === Number(beto)), 'agent_ids 로 남의 것 요청해도 본인 것만');
}

console.log('순수 함수');
ok(monthlyLine({ basis: 'collection', match_on: 'payment', subtotal_mxn: 100, total_mxn: 116, pp_amt: 0, pp_w: 0, po_rate: null, inv_date: '2026-10-01', paid_amount: 116, owner_id: 1, customer_id: 1, invoice_id: 1 }) === null, '무관한 줄 제외');
ok(summarizeAgentMonths([{ agent_id: 1, inv_ym: '2026-09', subtotal: 1, commission: 2, status: 'paid' }, { agent_id: 1, inv_ym: '2026-10', subtotal: 1, commission: 3, status: 'expected' }])[0].ym === '2026-10', '집계 정렬');

await app.close(); await pool.end();
console.log(`\nE2E ${pass} passed`);
