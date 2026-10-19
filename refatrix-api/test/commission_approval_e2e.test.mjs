// =====================================================================
// 0287 커미션 지급승인 전자결재 → 현금 지급 → 서명 수령증 업로드로 마감 — 순수 규칙 + 실제 PostgreSQL 종단 검증
//   실행: TEST_PG_URL=postgres://... node --test test/commission_approval_e2e.test.mjs   (전체 migrate 후)
//   흐름: 월 확정 → 지급 대상 목록 → 「전자문서 생성」(임시저장 · 내용 자동) → 디렉터 상신 → 승인
//         → 수령증 업로드(지급 전표 반제 + 문서 집행 · 증빙 '수령증') → 사후승인 대기
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
const SKIP = !PG;

const CA = await import('../src/commissionApproval.js');

after(async () => {
  if (!PG) return;
  const { pool } = await import('../src/db.js');
  await pool.end().catch(() => {});
  setTimeout(() => process.exit(process.exitCode || 0), 300);
});

// ── 순수 규칙 ──────────────────────────────────────────────────────────
const L1 = { invoice_id: 11, sat_no: 'A-1', inv_date: '2026-09-05', customer_name: 'Cliente A', basis: 'collection', mode: 'invoice', rate: 4, base: 10000, collected_base: 10000, paid_amount: 11600, last_pay_date: '2026-09-20', expected: 400 };
const L2 = { invoice_id: 12, sat_no: 'B-1', inv_date: '2026-09-10', customer_name: 'Cliente B', basis: 'revenue', mode: 'revenue', rate: 3, base: 5000, collected_base: 5000, paid_amount: 0, last_pay_date: null, expected: 150 };

test('R1 스냅샷 — 합계·기간·커미션 기준액(수금일 판정은 기간 안 수금분)', () => {
  const s = CA.buildSnapshot({ agentId: 7, agentName: 'Oscar', settleYm: '2026-09', payDate: '2026-10-15', lines: [L1, L2, { ...L1, invoice_id: 13, sat_no: 'C-1', mode: 'payment', base: 8000, collected_base: 3000, expected: 120, inv_date: '2026-08-01', last_pay_date: '2026-09-28' }],
    bonus: { id: 5, amount: 1000, basis: 'revenue', achieved_rate: 104 }, adjustments: [{ invoice_id: 9, amount: -50, paid_base: 2000, new_base: 1000, paid_amount: 100, reason: 'nota_credito' }] });
  assert.equal(s.commission_total, 670);
  assert.equal(s.bonus_total, 1000);
  assert.equal(s.adjustment_total, -50);
  assert.equal(s.total, 1620);
  assert.equal(s.invoice_count, 3);
  assert.deepEqual(s.period, { inv_from: '2026-08-01', inv_to: '2026-09-10', pay_from: '2026-09-20', pay_to: '2026-09-28' });
  assert.equal(s.lines.find((l) => l.invoice_id === 13).commission_base, 3000, '수금일 판정 = 기간 안 수금분');
  assert.equal(s.lines.find((l) => l.invoice_id === 11).commission_base, 10000);
  assert.match(CA.docTitle(s), /커미션 지급 승인 · Oscar · 2026년 9월 반제분/);
  const body = CA.bodyNodes(s).map((x) => x.v).join('\n');
  for (const k of ['지급 대상: Oscar', '2026년 9월', '인보이스 3건', '성과급', '지급 후 조정', 'MXN 1,620.00', '수령증']) assert.ok(body.includes(k), k);
});

test('R2 비교 — 같은 내역 ok · 추가/제외/금액변경/성과급/조정 차이는 문장으로', () => {
  const a = CA.buildSnapshot({ agentId: 1, agentName: 'x', settleYm: '2026-09', lines: [L1, L2] });
  assert.deepEqual(CA.compareSnapshot(a, CA.buildSnapshot({ agentId: 1, agentName: 'x', settleYm: '2026-09', lines: [L2, L1] })), { ok: true, diffs: [] });
  const added = CA.compareSnapshot(a, CA.buildSnapshot({ agentId: 1, settleYm: '2026-09', lines: [L1, L2, { ...L2, invoice_id: 99, sat_no: 'Z-9' }] }));
  assert.equal(added.ok, false); assert.match(added.diffs[0], /Z-9.*추가/);
  const gone = CA.compareSnapshot(a, CA.buildSnapshot({ agentId: 1, settleYm: '2026-09', lines: [L1] }));
  assert.match(gone.diffs[0], /B-1.*없습니다/);
  const amt = CA.compareSnapshot(a, CA.buildSnapshot({ agentId: 1, settleYm: '2026-09', lines: [L1, { ...L2, expected: 140 }] }));
  assert.match(amt.diffs[0], /B-1 커미션 150 → 140/);
  const bon = CA.compareSnapshot(a, CA.buildSnapshot({ agentId: 1, settleYm: '2026-09', lines: [L1, L2], bonus: { id: 1, amount: 500 } }));
  assert.match(bon.diffs[0], /성과급 0 → 500/);
  assert.equal(CA.compareSnapshot(null, a).ok, false);
});

test('R3 단계·재생성 가능 여부', () => {
  assert.equal(CA.docPhase(null, null), 'none');
  assert.equal(CA.docPhase({ status: 'draft' }, {}), 'draft');
  assert.equal(CA.docPhase({ status: 'progress' }, {}), 'progress');
  assert.equal(CA.docPhase({ status: 'approved' }, {}), 'approved');
  assert.equal(CA.docPhase({ status: 'approved' }, { commission_payment_id: 3 }), 'settled');
  assert.equal(CA.docPhase({ status: 'approved', deleted_at: new Date() }, {}), 'deleted');
  assert.equal(CA.docPhase({ status: 'rejected' }, {}), 'rejected');
  for (const p of ['none', 'deleted', 'rejected', 'settled']) assert.equal(CA.canCreateAgain(p), true, p);
  for (const p of ['draft', 'progress', 'approved']) assert.equal(CA.canCreateAgain(p), false, p);
  assert.equal(CA.ymLabel('2026-10'), '2026년 10월');
});

// ── 실제 PostgreSQL 종단 ───────────────────────────────────────────────
const TAG = 'CAPTEST';
let app, pool, query;
const ID = {}; const T = {};
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function call(who, method, url, payload) {
  const res = await app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + T[who] } });
  let body = null; try { body = res.json(); } catch { body = res.body; }
  return { code: res.statusCode, body };
}
async function ok(...a) { const r = await call(...a); assert.ok(r.code < 300, `${a[1]} ${a[2]} → ${r.code} ${JSON.stringify(r.body)}`); return r.body; }

// 문서의 회차에 달린 현금흐름 행(살아 있는 것) + 그 문서 회차 메모로 남은 예정(고아 검사)
async function finOf(docId) {
  return (await query(`SELECT t.id, t.status, to_char(t.txn_date,'YYYY-MM-DD') AS d, t.amount, t.category_code, t.account_id
                         FROM approval_payments p JOIN transactions t ON t.id=p.txn_id AND t.deleted_at IS NULL WHERE p.document_id=$1`, [docId])).rows
    .map((r) => ({ id: Number(r.id), status: r.status, d: r.d, amount: Number(r.amount), cat: r.category_code, acc: r.account_id == null ? null : Number(r.account_id) }));
}
async function livePlansByMemo(likeTitle) {
  return Number((await query(`SELECT count(*) FROM transactions WHERE status='plan' AND deleted_at IS NULL AND memo LIKE $1`, [`%${likeTitle}%`])).rows[0].count);
}

async function cleanup() {
  const U = `(SELECT id FROM users WHERE login_id LIKE 'captest%')`;
  const D = `(SELECT id FROM approval_documents WHERE drafter_id IN ${U})`;
  await query(`DELETE FROM commission_approval_docs WHERE agent_id IN ${U} OR created_by IN ${U}`);
  await query(`UPDATE approval_payments SET txn_id=NULL WHERE document_id IN ${D}`);
  await query(`DELETE FROM transactions WHERE created_by IN ${U} OR owner_id IN ${U}`);
  for (const t of ['approval_files', 'approval_events', 'approval_notifications', 'approval_lines', 'approval_viewers', 'approval_payments', 'approval_revisions', 'approval_addenda', 'approval_comments', 'approval_links']) {
    await query(`DELETE FROM ${t} WHERE document_id IN ${D}`);
  }
  await query(`UPDATE approval_documents SET parent_id=NULL WHERE drafter_id IN ${U}`);
  await query(`DELETE FROM approval_documents WHERE drafter_id IN ${U}`);
  await query(`DELETE FROM commission_payment_allocations WHERE payment_id IN (SELECT id FROM commission_payments WHERE agent_id IN ${U})`);
  await query(`DELETE FROM commission_payouts WHERE agent_id IN ${U}`);
  await query(`DELETE FROM commission_payments WHERE agent_id IN ${U}`);
  await query(`DELETE FROM commission_agent_periods WHERE user_id IN ${U}`);
  await query(`DELETE FROM commission_agents WHERE user_id IN ${U}`);
  await query(`DELETE FROM sales_payment_allocations WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE memo LIKE '%${TAG}%')`);
  await query(`DELETE FROM sales_payments WHERE memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM sales_invoices WHERE memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM bonus_payouts WHERE user_id IN ${U} OR confirmed_by IN ${U} OR updated_by IN ${U}`);
  await query(`DELETE FROM commission_batches WHERE settle_ym IN ('2026-07','2026-08') OR confirmed_by IN ${U}`);
  await query(`DELETE FROM audit_log WHERE user_id IN ${U}`);
  await query(`DELETE FROM user_page_access WHERE user_id IN ${U}`);
  await query(`DELETE FROM customers WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM accounts WHERE name LIKE '${TAG}%'`);
  await query(`UPDATE approval_settings SET director_user_id=NULL, ceo_user_id=NULL, finance_user_id=NULL WHERE director_user_id IN ${U} OR ceo_user_id IN ${U} OR finance_user_id IN ${U}`);
  await query(`DELETE FROM users WHERE login_id LIKE 'captest%'`);
}

test('E0 준비 — 사용자·고객·인보이스·수금·커미션 기간·7월 확정', { skip: SKIP }, async () => {
  ({ pool, query } = await import('../src/db.js'));
  const { buildApp } = await import('../src/server.js');
  app = buildApp(); await app.ready();
  await cleanup();
  const mk = async (name, role, login) => Number((await query(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name, role, login])).rows[0].id);
  ID.dir = await mk(`${TAG}Sebastian`, 'director', 'captest_dir');
  ID.fin = await mk(`${TAG}Christopher`, 'treasury', 'captest_fin');
  ID.ceo = await mk(`${TAG}Jang`, 'socio', 'captest_ceo');
  ID.rep = await mk(`${TAG}Oscar`, 'sales', 'captest_rep');
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'commission','anywhere','edit') ON CONFLICT DO NOTHING`, [ID.fin]);
  await query(`UPDATE approval_settings SET director_user_id=$1, ceo_user_id=$2, finance_user_id=$3, ceo_pre_threshold=100000 WHERE id=1`, [ID.dir, ID.ceo, ID.fin]);
  for (const k of ['dir', 'fin', 'ceo', 'rep']) T[k] = app.jwt.sign({ sub: ID[k] });
  ID.acc = Number((await query(`INSERT INTO accounts (name, type, currency, open_balance, created_by) VALUES ($1,'bank','MXN',0,$2) RETURNING id`, [`${TAG}은행`, ID.dir])).rows[0].id);
  ID.cash = Number((await query(`INSERT INTO accounts (name, type, currency, open_balance, created_by) VALUES ($1,'현금','MXN',5000,$2) RETURNING id`, [`${TAG}Caja`, ID.dir])).rows[0].id);
  ID.cust = Number((await query(`INSERT INTO customers (name, code, credit_days, owner_id, phone, created_by) VALUES ($1,$2,30,$3,'+52 81 0000 0000',$4) RETURNING id`, [`${TAG}고객`, `${TAG}-1`, ID.rep, ID.dir])).rows[0].id);
  await query(`INSERT INTO commission_agents (user_id, default_rate, active, created_by, updated_by) VALUES ($1,4,true,$2,$2)`, [ID.rep, ID.dir]);
  await query(`INSERT INTO commission_agent_periods (user_id, start_date, end_date, basis, rate, match_on, created_by, updated_by) VALUES ($1,'2026-06-01',NULL,'collection',4,'invoice',$2,$2)`, [ID.rep, ID.dir]);
  const inv = async (sat, date, sub) => Number((await query(
    `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn, status, owner_id, memo, created_by)
     VALUES ($1,$2,$3,30,$3::date+30,$4,$5,$6,'posted',$7,$8,$7) RETURNING id`, [sat, ID.cust, date, sub, sub * 0.16, sub * 1.16, ID.dir, `${TAG} ${sat}`])).rows[0].id);
  ID.payIds = [];
  const pay = async (date, invId, amt) => {
    const p = Number((await query(`INSERT INTO sales_payments (customer_id, pay_date, account_id, amount, memo, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [ID.cust, date, ID.acc, amt, `${TAG} ${date}`, ID.dir])).rows[0].id);
    await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount) VALUES ($1,$2,$3)`, [p, invId, amt]);
    return p;
  };
  ID.A = await inv('CAP-A', '2026-06-05', 10000); await pay('2026-07-10', ID.A, 11600);   // 400
  ID.B = await inv('CAP-B', '2026-06-20', 5000); await pay('2026-07-20', ID.B, 5800);     // 200
  ID.C = await inv('CAP-C', '2026-07-01', 3000);                                          // 미수 → 대상 아님
  await ok('dir', 'POST', '/api/commission/batches/2026-07/confirm');
  const p = await ok('dir', 'GET', `/api/commission/payable?agent_id=${ID.rep}&settle_ym=2026-07`);
  assert.equal(p.total, 600);
  assert.deepEqual(p.lines.map((l) => l.sat_no), ['CAP-A', 'CAP-B']);
  assert.equal(p.lines[0].last_pay_date, '2026-07-10');
  assert.equal(p.lines[0].paid_amount, 11600);
});

test('E1 문서 생성 — 디렉터만 · 내용 자동 · 임시저장 · 중복 생성/일반 지급 차단', { skip: SKIP }, async () => {
  const s0 = await ok('dir', 'GET', `/api/commission/approval-docs?agent_id=${ID.rep}&settle_ym=2026-07`);
  assert.equal(s0.phase, 'none'); assert.equal(s0.can_create, true);
  const sf = await ok('fin', 'GET', `/api/commission/approval-docs?agent_id=${ID.rep}&settle_ym=2026-07`);
  assert.equal(sf.can_create, false, '재무는 생성 버튼 없음');
  assert.equal((await call('fin', 'POST', '/api/commission/approval-docs', { agent_id: ID.rep, settle_ym: '2026-07' })).code, 403);
  assert.equal((await call('dir', 'POST', '/api/commission/approval-docs', { agent_id: ID.rep, settle_ym: '2026-06' })).body.error, 'not_confirmed');
  const c = await ok('dir', 'POST', '/api/commission/approval-docs', { agent_id: ID.rep, settle_ym: '2026-07' });
  ID.doc = c.document_id;
  assert.equal(c.total, 600); assert.equal(c.invoice_count, 2); assert.equal(c.url, `refatrix-approval.html#doc=${ID.doc}`);
  const d = (await query(`SELECT d.*, c.name AS cat FROM approval_documents d LEFT JOIN approval_categories c ON c.id=d.category_id WHERE d.id=$1`, [ID.doc])).rows[0];
  assert.equal(d.status, 'draft'); assert.equal(Number(d.drafter_id), ID.dir);
  assert.equal(d.cat, '영업 커미션'); assert.equal(d.pay_method, '현금'); assert.equal(d.iva_applied, false);
  assert.equal(Number(d.planned_total), 600); assert.equal(d.vendor, `${TAG}Oscar`);
  assert.match(d.title, /커미션 지급 승인 · CAPTESTOscar · 2026년 7월 반제분/);
  assert.match(d.body, /지급 대상: CAPTESTOscar/);
  assert.equal(d.custom_steps, null, '결재선은 디렉터가 작성');
  const pays = (await query(`SELECT * FROM approval_payments WHERE document_id=$1`, [ID.doc])).rows;
  assert.equal(pays.length, 1); assert.equal(Number(pays[0].planned_amount), 600);
  const det = await ok('dir', 'GET', `/api/approvals/${ID.doc}`);
  assert.equal(det.commission.snapshot.lines.length, 2);
  assert.equal(det.commission.snapshot.lines[0].customer_name, `${TAG}고객`);
  assert.ok(det.events.some((e) => e.action === 'auto_draft'));
  // 중복 생성 · 일반 송금 지급 막힘
  assert.equal((await call('dir', 'POST', '/api/commission/approval-docs', { agent_id: ID.rep, settle_ym: '2026-07' })).body.error, 'approval_doc_active');
  const leg = await call('fin', 'POST', '/api/commission/payments', { agent_id: ID.rep, settle_ym: '2026-07', amount: 600, evidence: PNG });
  assert.equal(leg.code, 409); assert.equal(leg.body.error, 'approval_doc_active');
  // 0287c 생성(임시저장) 즉시 미래자금계획 지출 예정 — 지급예정일 · 6030 · 계좌 없음
  const f1 = await finOf(ID.doc);
  assert.deepEqual(f1.map((x) => [x.status, x.d, x.amount, x.cat, x.acc]), [['plan', '2026-08-15', 600, '6030', null]]);
  ID.planId = f1[0].id;
  // 승인 전 지급 불가
  assert.equal((await call('fin', 'POST', `/api/commission/approval-docs/${ID.doc}/settle`, { paid_date: '2026-08-15', evidence: PNG })).body.error, 'not_approved');
});

test('E2 상신 → 승인 — 직접 집행 버튼(API) 막힘', { skip: SKIP }, async () => {
  await ok('dir', 'POST', `/api/approvals/${ID.doc}/submit`, {});
  let det = await ok('dir', 'GET', `/api/approvals/${ID.doc}`);
  for (let i = 0; i < 4 && det.doc.status === 'progress'; i++) {
    const pend = det.lines.find((l) => l.status === 'pending');
    const who = Object.keys(ID).find((k) => ['dir', 'fin', 'ceo'].includes(k) && ID[k] === pend.user_id);
    await ok(who, 'POST', `/api/approvals/${ID.doc}/act`, { action: 'approve' });
    det = await ok('dir', 'GET', `/api/approvals/${ID.doc}`);
  }
  assert.equal(det.doc.status, 'approved'); assert.equal(det.doc.exec_status, 'pending');
  const f2 = await finOf(ID.doc);
  assert.deepEqual(f2.map((x) => [x.id, x.status, x.d, x.amount]), [[ID.planId, 'plan', '2026-08-15', 600]], '상신·승인 후에도 같은 예정 1행');
  const s = await ok('fin', 'GET', `/api/commission/approval-docs?agent_id=${ID.rep}&settle_ym=2026-07`);
  assert.equal(s.phase, 'approved');
  assert.equal(s.payment.fin, 'plan'); assert.equal(s.payment.txn_date, '2026-08-15'); assert.ok(s.doc.doc_no); assert.ok(s.lines.some((l) => l.step_type === 'director' && l.status === 'done'));
  const pid = det.payments[0].id;
  const ex = await call('fin', 'POST', `/api/approvals/${ID.doc}/execute`, { payment_id: pid, actual_amount: 600, exec_date: '2026-08-15', pay_method: '현금' });
  assert.equal(ex.code, 409); assert.equal(ex.body.detail, 'commission_doc');
});

test('E3 승인 후 지급 대상이 바뀌면 막힘 · 되돌리면 통과 가능', { skip: SKIP }, async () => {
  ID.D = Number((await query(`INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn, status, owner_id, memo, created_by)
    VALUES ('CAP-D',$1,'2026-06-25',30,'2026-07-25',1000,160,1160,'posted',$2,$3,$2) RETURNING id`, [ID.cust, ID.dir, `${TAG} CAP-D`])).rows[0].id);
  const p = Number((await query(`INSERT INTO sales_payments (customer_id, pay_date, account_id, amount, memo, created_by) VALUES ($1,'2026-07-28',$2,1160,$3,$4) RETURNING id`, [ID.cust, ID.acc, `${TAG} D`, ID.dir])).rows[0].id);
  await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount) VALUES ($1,$2,1160)`, [p, ID.D]);
  const r = await call('fin', 'POST', `/api/commission/approval-docs/${ID.doc}/settle`, { paid_date: '2026-08-15', evidence: PNG });
  assert.equal(r.code, 409); assert.equal(r.body.error, 'payable_changed');
  assert.ok(r.body.diffs.some((x) => /CAP-D.*추가/.test(x)), JSON.stringify(r.body.diffs));
  await query(`DELETE FROM sales_payment_allocations WHERE payment_id=$1`, [p]);
  await query(`DELETE FROM sales_payments WHERE id=$1`, [p]);
  assert.equal((await call('fin', 'POST', `/api/commission/approval-docs/${ID.doc}/settle`, { paid_date: '2026-08-15' })).body.error, 'evidence_required');
  assert.equal((await call('fin', 'POST', `/api/commission/approval-docs/${ID.doc}/settle`, { evidence: PNG })).body.error, 'paid_date_required');
  assert.equal((await call('rep', 'POST', `/api/commission/approval-docs/${ID.doc}/settle`, { paid_date: '2026-08-15', evidence: PNG })).code, 403);
});

test('E4 원자성 — 문서 마감 단계에서 실패하면 지급 전표도 남지 않는다', { skip: SKIP }, async () => {
  await query(`CREATE OR REPLACE FUNCTION captest_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'captest forced failure'; END $$ LANGUAGE plpgsql`);
  await query(`CREATE TRIGGER captest_fail_trg BEFORE INSERT ON approval_files FOR EACH ROW WHEN (NEW.kind = '수령증') EXECUTE FUNCTION captest_fail()`);
  try {
    const r = await call('fin', 'POST', `/api/commission/approval-docs/${ID.doc}/settle`, { paid_date: '2026-08-15', evidence: PNG });
    assert.equal(r.code, 500);
  } finally {
    await query(`DROP TRIGGER IF EXISTS captest_fail_trg ON approval_files`);
    await query(`DROP FUNCTION IF EXISTS captest_fail()`);
  }
  assert.equal(Number((await query(`SELECT count(*) FROM commission_payments WHERE agent_id=$1`, [ID.rep])).rows[0].count), 0);
  assert.equal(Number((await query(`SELECT count(*) FROM commission_payouts WHERE agent_id=$1 AND paid`, [ID.rep])).rows[0].count), 0);
  const d = (await query(`SELECT exec_status FROM approval_documents WHERE id=$1`, [ID.doc])).rows[0];
  assert.equal(d.exec_status, 'pending');
});

test('E5 수령증 업로드 → 지급 전표(반제) + 문서 집행완료(현금 · 증빙 수령증) → 사후승인 대기', { skip: SKIP }, async () => {
  const r = await ok('fin', 'POST', `/api/commission/approval-docs/${ID.doc}/settle`, { paid_date: '2026-08-15', evi_name: 'recibo.png', evidence: PNG });
  assert.equal(r.settled_count, 2); assert.equal(r.commission_settled, 600); assert.equal(r.total_paid_amount, 600);
  assert.equal(r.approval_executed, true); assert.equal(r.approval_finished, true); assert.ok(r.receipt_file_id);
  const cp = (await query(`SELECT * FROM commission_payments WHERE id=$1`, [r.payment_id])).rows[0];
  assert.equal(Number(cp.amount), 600); assert.equal(cp.evi_mime, 'image/png'); assert.match(cp.note, /현금 지급/);
  assert.equal(cp.paid_date instanceof Date ? cp.paid_date.getDate() : null, 15);
  const po = (await query(`SELECT invoice_id, amount, paid FROM commission_payouts WHERE agent_id=$1 ORDER BY invoice_id`, [ID.rep])).rows;
  assert.deepEqual(po.map((x) => [Number(x.invoice_id), Number(x.amount), x.paid]), [[ID.A, 400, true], [ID.B, 200, true]]);
  const d = (await query(`SELECT status, exec_status, post_status, actual_total, exec_pay_method FROM approval_documents WHERE id=$1`, [ID.doc])).rows[0];
  assert.deepEqual([d.status, d.exec_status, d.post_status, Number(d.actual_total), d.exec_pay_method], ['approved', 'done', 'pending', 600, '현금']);
  const ap = (await query(`SELECT status, pay_method, actual_mxn, exec_source, to_char(exec_date,'YYYY-MM-DD') AS ed FROM approval_payments WHERE document_id=$1`, [ID.doc])).rows[0];
  assert.deepEqual([ap.status, ap.pay_method, Number(ap.actual_mxn), ap.exec_source, ap.ed], ['done', '현금', 600, 'approval', '2026-08-15']);
  const f = (await query(`SELECT kind, stage, payment_id, mime_type, file_name FROM approval_files WHERE id=$1`, [r.receipt_file_id])).rows[0];
  assert.equal(f.kind, '수령증'); assert.equal(f.stage, 'exec'); assert.ok(f.payment_id); assert.match(f.file_name, /^수령증_.*_2026-08-15\.png$/);
  const post = (await query(`SELECT status FROM approval_lines WHERE document_id=$1 AND step_type='post_ceo'`, [ID.doc])).rows[0];
  assert.equal(post.status, 'pending', '대표이사 사후승인 대기');
  const l = (await query(`SELECT * FROM commission_approval_docs WHERE document_id=$1`, [ID.doc])).rows[0];
  assert.equal(Number(l.commission_payment_id), r.payment_id); assert.equal(Number(l.settled_document_id), ID.doc); assert.ok(l.settled_at);
  // 재시도 막힘 · 상태 settled · 지급 대상 비었음
  assert.equal((await call('fin', 'POST', `/api/commission/approval-docs/${ID.doc}/settle`, { paid_date: '2026-08-15', evidence: PNG })).body.error, 'already_settled');
  const s = await ok('dir', 'GET', `/api/commission/approval-docs?agent_id=${ID.rep}&settle_ym=2026-07`);
  assert.equal(s.phase, 'settled'); assert.equal(s.link.commission_payment_id, r.payment_id);
  const p = await ok('dir', 'GET', `/api/commission/payable?agent_id=${ID.rep}&settle_ym=2026-07`);
  assert.equal(p.lines.length, 0);
  // 전표 목록 · 증빙 열람(수령증 스캔)
  const v = await ok('dir', 'GET', `/api/commission/payments?agent_id=${ID.rep}`);
  assert.equal(v.items[0].has_evidence, true);
  const ev = await app.inject({ method: 'GET', url: `/api/commission/payments/${r.payment_id}/evidence`, headers: { authorization: 'Bearer ' + T.dir } });
  assert.equal(ev.statusCode, 200); assert.equal(ev.headers['content-type'], 'image/png');
  // 상세 — 커미션 블록에 지급 표시
  const det = await ok('dir', 'GET', `/api/approvals/${ID.doc}`);
  assert.equal(det.commission.commission_payment_id, r.payment_id);
  assert.ok(det.events.some((e) => e.action === 'execute' && /현금/.test(e.detail)));
  // 0287c 실적은 수동 — 업로드 후에도 예정 1행(지급일·실적 금액으로) · 실적 없음
  const f5 = await finOf(ID.doc);
  assert.deepEqual(f5.map((x) => [x.status, x.d, x.amount, x.acc]), [['plan', '2026-08-15', 600, null]]);
  const s5 = await ok('dir', 'GET', `/api/commission/approval-docs?agent_id=${ID.rep}&settle_ym=2026-07`);
  assert.equal(s5.payment.fin, 'plan');
  // 재무 › 거래등록에서 이 문서 회차를 골라 현금 출금 실적 등록(디렉터) → 예정 행이 그대로 실적
  const apPay = det.payments[0].id;
  const t = await ok('dir', 'POST', '/api/transactions', { direction: 'out', currency: 'MXN', amount: 600, txn_date: '2026-08-16', status: 'actual', account_id: ID.cash, category_code: '6030', approval_payment_id: apPay, memo: '커미션 현금' });
  const f5b = await finOf(ID.doc);
  assert.deepEqual(f5b.map((x) => [x.id, x.status, x.d, x.acc]), [[ID.planId, 'actual', '2026-08-16', ID.cash]]);
  assert.equal(Number(t.id), ID.planId);
  assert.equal((await ok('dir', 'GET', `/api/commission/approval-docs?agent_id=${ID.rep}&settle_ym=2026-07`)).payment.fin, 'actual');
  // 대표이사 사후승인 → 완결
  await ok('ceo', 'POST', `/api/approvals/${ID.doc}/act`, { action: 'approve' });
  assert.equal((await query(`SELECT post_status FROM approval_documents WHERE id=$1`, [ID.doc])).rows[0].post_status, 'confirmed');
});

test('E6 반려되면 새 문서 생성 가능 · 결재 금액을 바꾸면 지급 막힘', { skip: SKIP }, async () => {
  // 8월분: 새 인보이스 완납 → 확정 → 문서 → 상신 → 디렉터 반려
  ID.E = Number((await query(`INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn, status, owner_id, memo, created_by)
    VALUES ('CAP-E',$1,'2026-07-05',30,'2026-08-04',2500,400,2900,'posted',$2,$3,$2) RETURNING id`, [ID.cust, ID.dir, `${TAG} CAP-E`])).rows[0].id);
  const p = Number((await query(`INSERT INTO sales_payments (customer_id, pay_date, account_id, amount, memo, created_by) VALUES ($1,'2026-08-03',$2,2900,$3,$4) RETURNING id`, [ID.cust, ID.acc, `${TAG} E`, ID.dir])).rows[0].id);
  await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount) VALUES ($1,$2,2900)`, [p, ID.E]);
  await query(`DELETE FROM commission_batches WHERE settle_ym='2026-08'`);
  await ok('dir', 'POST', '/api/commission/batches/2026-08/confirm');
  const c = await ok('dir', 'POST', '/api/commission/approval-docs', { agent_id: ID.rep, settle_ym: '2026-08' });
  assert.equal(c.total, 100);
  await ok('dir', 'POST', `/api/approvals/${c.document_id}/submit`, {});
  let det = await ok('dir', 'GET', `/api/approvals/${c.document_id}`);
  const pend = det.lines.find((l) => l.status === 'pending');
  if (pend) {
    const who = ['dir', 'fin', 'ceo'].find((k) => ID[k] === pend.user_id);
    await ok(who, 'POST', `/api/approvals/${c.document_id}/act`, { action: 'reject', comment: '재확인' });
    const s = await ok('dir', 'GET', `/api/commission/approval-docs?agent_id=${ID.rep}&settle_ym=2026-08`);
    assert.equal(s.phase, 'rejected'); assert.equal(s.can_create, true);
    assert.deepEqual(await finOf(c.document_id), [], '반려 → 예정 빠짐');
  }
  // 새 문서 → 승인 → 결재 금액 임의 변경 → 지급 막힘
  const c2 = await ok('dir', 'POST', '/api/commission/approval-docs', { agent_id: ID.rep, settle_ym: '2026-08' });
  assert.deepEqual((await finOf(c2.document_id)).map((x) => [x.status, x.d, x.amount]), [['plan', '2026-09-15', 100]]);
  // 임시저장 수정(금액) → 예정도 따라감 · 고아 예정 없음
  const d2 = (await ok('dir', 'GET', `/api/approvals/${c2.document_id}`)).doc;
  const body = (sub) => ({ title: d2.title, vendor: d2.vendor, category_id: d2.category_id, orig_sub: sub, iva_applied: false, pay_method: '현금', payment_type: 'once', pay_due: '2026-09-15', currency: 'MXN' });
  await ok('dir', 'PUT', `/api/approvals/${c2.document_id}`, body(120));
  assert.deepEqual((await finOf(c2.document_id)).map((x) => [x.status, x.amount]), [['plan', 120]]);
  await ok('dir', 'PUT', `/api/approvals/${c2.document_id}`, body(100));
  assert.deepEqual((await finOf(c2.document_id)).map((x) => [x.status, x.amount]), [['plan', 100]]);
  assert.equal(await livePlansByMemo(d2.title), 1, '회차 교체 후 고아 예정 없음');
  await ok('dir', 'POST', `/api/approvals/${c2.document_id}/submit`, {});
  det = await ok('dir', 'GET', `/api/approvals/${c2.document_id}`);
  for (let i = 0; i < 4 && det.doc.status === 'progress'; i++) {
    const pd = det.lines.find((l) => l.status === 'pending');
    const who = ['dir', 'fin', 'ceo'].find((k) => ID[k] === pd.user_id);
    await ok(who, 'POST', `/api/approvals/${c2.document_id}/act`, { action: 'approve' });
    det = await ok('dir', 'GET', `/api/approvals/${c2.document_id}`);
  }
  assert.equal(det.doc.status, 'approved');
  await query(`UPDATE approval_documents SET planned_total=150 WHERE id=$1`, [c2.document_id]);
  assert.equal((await call('fin', 'POST', `/api/commission/approval-docs/${c2.document_id}/settle`, { paid_date: '2026-09-15', evidence: PNG })).body.error, 'amount_mismatch');
  await query(`UPDATE approval_documents SET planned_total=100 WHERE id=$1`, [c2.document_id]);
  // 반려된 옛 문서 id 로는 마감 불가(연결이 다름) · 새 문서로 정상 마감
  if (pend) assert.notEqual((await call('fin', 'POST', `/api/commission/approval-docs/${c.document_id}/settle`, { paid_date: '2026-09-15', evidence: PNG })).code, 200);
  const r = await ok('dir', 'POST', `/api/commission/approval-docs/${c2.document_id}/settle`, { paid_date: '2026-09-15', evidence: PNG });
  assert.equal(r.commission_settled, 100);
});

test('E9 정리', { skip: SKIP }, async () => { await cleanup(); });
