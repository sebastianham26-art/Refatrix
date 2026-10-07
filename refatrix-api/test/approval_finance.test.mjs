// 0258 전자결재 ↔ 자금(미래자금계획 · 거래등록) 연동 — 규칙 · 배선 · 실제 PostgreSQL E2E
//   실행: TEST_PG_URL=postgres://... node --test test/approval_finance.test.mjs
//   (사전 조건: 전체 migrate · login_id sebastian/christopher/jang/maria/oscar/jose/luis)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = join(HERE, '..');
const read = (p) => readFileSync(p, 'utf8');
const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

const F = await import('../src/approvalFinance.js');

after(async () => {
  if (!PG) return;
  const { pool } = await import('../src/db.js');
  await pool.end().catch(() => {});
  setTimeout(() => process.exit(process.exitCode || 0), 500);
});

test('F1 규칙 — 메모 · 실적 환산(문서/거래 통화 다름)', () => {
  assert.equal(F.planMemo({ doc_no: 'EA-2026-0007', title: '창고 소모품', vendor: 'Empaques' }, 2, 3), '[전자결재] EA-2026-0007 창고 소모품 (2/3) · Empaques');
  assert.equal(F.planMemo({ doc_no: 'EA-1', title: '단건' }, 1, 1), '[전자결재] EA-1 단건');
  assert.deepEqual(F.actualFromTxn({ currency: 'MXN', fx_rate: 1 }, { currency: 'MXN', amount: 1200, amount_mxn: 1200, fx_rate: 1 }), { amount: 1200, mxn: 1200, fx: 1 });
  assert.deepEqual(F.actualFromTxn({ currency: 'USD', fx_rate: 18 }, { currency: 'USD', amount: 100, amount_mxn: 1850, fx_rate: 18.5 }), { amount: 100, mxn: 1850, fx: 18.5 });
  assert.deepEqual(F.actualFromTxn({ currency: 'USD', fx_rate: 18 }, { currency: 'MXN', amount: 1800, amount_mxn: 1800, fx_rate: 1 }), { amount: 100, mxn: 1800, fx: 18 });
  assert.deepEqual(F.actualFromTxn({ currency: 'MXN', fx_rate: 1 }, { currency: 'USD', amount: 100, amount_mxn: 1850, fx_rate: 18.5 }), { amount: 1850, mxn: 1850, fx: 18.5 });
});

test('F2 배선 — 전자결재 라우트는 거래 테이블을 직접 다루지 않고 연동 모듈만 부른다 · 마이그레이션 멱등 구문', () => {
  const r = read(join(API, 'src/routes/approvalRoutes.js'));
  assert.doesNotMatch(r.replace(/\/\/[^\n]*/g, ''), /\btransactions\b|cashflow/i);
  assert.match(r, /syncApprovalDoc\(q, id, ctx\.uid\)/);
  const f = read(join(API, 'src/routes/financeRoutes.js'));
  for (const k of ['approval-options', 'approval-link', 'afterTxnChange(id', 'approvalCloseLock', 'approval_payment_id']) assert.ok(f.includes(k), k);
  const m = read(join(API, 'migrations/0258_e_approval_finance_link.sql'));
  assert.match(m, /ADD COLUMN IF NOT EXISTS txn_id/); assert.match(m, /CREATE UNIQUE INDEX IF NOT EXISTS/);
  assert.match(m, /NOT EXISTS \(SELECT 1 FROM transactions t WHERE t\.plan_memo = 'approval_payment:' \|\| p\.id\)/, '백필 재실행 안전');
});

test('F3 E2E — 승인 → 미래자금계획 · 실적 처리/거래등록/기존 거래 연결 → 집행완료 · 되돌림 · 재결재·삭제·복구·중단', { skip: !PG }, async () => {
  const { buildApp } = await import('../src/server.js');
  const { pool } = await import('../src/db.js');
  const app = buildApp();
  await app.ready();
  const U = {};
  for (const r of (await pool.query(`SELECT id, login_id, role FROM users WHERE login_id = ANY($1)`,
    [['sebastian', 'christopher', 'jang', 'maria', 'oscar', 'luis', 'jose']])).rows) U[r.login_id] = { id: Number(r.id), tok: app.jwt.sign({ sub: Number(r.id), role: r.role }) };
  const call = async (who, method, url, payload) => {
    const res = await app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + U[who].tok } });
    let body = null; try { body = res.json(); } catch { body = res.body; }
    return { code: res.statusCode, body };
  };
  const ok = async (...a) => { const r = await call(...a); assert.ok(r.code < 300, `${a[1]} ${a[2]} → ${r.code} ${JSON.stringify(r.body)}`); return r.body; };
  const dataUrl = (buf, mime) => `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
  const plansOf = async (docId) => (await pool.query(
    `SELECT t.id, t.status, t.amount::float AS amount, t.amount_mxn::float AS mxn, t.currency, t.category_code, t.account_id, t.memo,
            to_char(t.txn_date,'YYYY-MM-DD') AS d, (t.deleted_at IS NOT NULL) AS del, p.seq, p.status AS pay_status, p.exec_source
       FROM approval_payments p LEFT JOIN transactions t ON t.id=p.txn_id WHERE p.document_id=$1 ORDER BY p.seq`, [docId])).rows
    .map((x) => ({ ...x, id: x.id == null ? null : Number(x.id), account_id: x.account_id == null ? null : Number(x.account_id) }));
  const today = new Date().toISOString().slice(0, 10);
  try {
    await pool.query(`UPDATE approval_settings SET ceo_pre_threshold=100000, threshold_basis='total', ceo_user_id=$1, director_user_id=$2, finance_user_id=$3 WHERE id=1`,
      [U.jang.id, U.sebastian.id, U.christopher.id]);
    const acc = Number((await pool.query(`INSERT INTO accounts(name, type, currency) VALUES ('BBVA 운영','bank','MXN') RETURNING id`)).rows[0].id);
    await pool.query(`INSERT INTO user_account_access(user_id, account_id, can_operate, can_detail) VALUES ($1,$2,true,true) ON CONFLICT DO NOTHING`, [U.christopher.id, acc]);
    await pool.query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'transactions','anywhere','edit') ON CONFLICT DO NOTHING`, [U.christopher.id]);
    const boot = await ok('maria', 'GET', '/api/approvals/bootstrap');
    assert.equal(boot.fin_link, true);
    const sobo = boot.categories.find((c) => c.name === '소모품');
    assert.equal(sobo.fin_category_code, '6050', '기본 카테고리 → 계정과목 매핑');
    assert.ok(boot.fin_categories.some((c) => c.code === '6050'));
    await pool.query(`DELETE FROM approval_category_steps WHERE category_id=$1`, [sobo.id]);
    await ok('sebastian', 'POST', `/api/approvals/categories/${sobo.id}/steps`, { step_type: 'approve', user_id: U.maria.id });

    // ① 정기 3회(회당 1,160) 결재 → 승인되는 순간 예정 3행
    const form = { category_id: sobo.id, title: '포장재 정기 구매', vendor: 'Empaques', payment_type: 'recurring', iva_applied: true,
      payment_plan: { freq: 'monthly', count: 3, start: '2026-11-05', per_sub: 1000 } };
    const d1 = (await ok('oscar', 'POST', '/api/approvals', form)).id;
    await ok('oscar', 'POST', `/api/approvals/${d1}/submit`);
    assert.equal((await plansOf(d1)).filter((x) => x.id).length, 0, '결재 중에는 예정 없음');
    await ok('maria', 'POST', `/api/approvals/${d1}/act`, { action: 'approve' });
    await ok('sebastian', 'POST', `/api/approvals/${d1}/act`, { action: 'approve' });
    let P = await plansOf(d1);
    const docNo = (await ok('sebastian', 'GET', `/api/approvals/${d1}`)).doc.doc_no;
    assert.deepEqual(P.map((x) => [x.status, x.amount, x.d, x.category_code, x.account_id, x.del]),
      [['plan', 1160, '2026-11-05', '6050', null, false], ['plan', 1160, '2026-12-05', '6050', null, false], ['plan', 1160, '2027-01-05', '6050', null, false]]);
    assert.equal(P[1].memo, `[전자결재] ${docNo} 포장재 정기 구매 (2/3) · Empaques`);
    const pp = await ok('christopher', 'GET', '/api/transactions/pending-plans?all=1');
    const ppA = pp.items.filter((x) => x.approval && x.approval.doc_id === d1);
    assert.equal(ppA.length, 3); assert.ok(ppA.every((x) => x.source === 'approval' && x.can_delete === false));
    assert.equal(ppA[0].approval.doc_no, docNo);
    // 상세 화면: 회차별 자금 상태
    let det = await ok('oscar', 'GET', `/api/approvals/${d1}`);
    assert.deepEqual(det.payments.map((p) => p.fin), ['plan', 'plan', 'plan']);

    // ② 예정 수정/삭제 보호 — 금액·날짜 불가, 계좌 지정은 가능 · 계획 삭제·직접 삭제 불가
    assert.equal((await call('sebastian', 'PATCH', `/api/transactions/${P[0].id}/plan`, { amount: 999 })).body.error, 'approval_linked');
    await ok('sebastian', 'PATCH', `/api/transactions/${P[0].id}/plan`, { account_id: acc });
    assert.equal((await ok('sebastian', 'POST', '/api/transactions/plans/delete', { ids: [P[1].id] })).skipped[0].error, 'approval_linked');
    assert.equal((await call('sebastian', 'DELETE', `/api/transactions/${P[1].id}`)).body.error, 'approval_linked');

    // ③ 재무: 예정 내역 → 실적 처리(1회차) → 회차 집행완료(거래등록)
    await ok('christopher', 'POST', `/api/transactions/${P[0].id}/confirm-pay`, { account_id: acc, pay_date: '2026-11-04', amount: 1160 });
    P = await plansOf(d1);
    assert.deepEqual([P[0].status, P[0].pay_status, P[0].exec_source], ['actual', 'done', 'finance']);
    det = await ok('sebastian', 'GET', `/api/approvals/${d1}`);
    assert.equal(det.doc.exec_status, 'pending'); assert.equal(det.payments[0].exec_date, '2026-11-04');
    assert.ok(det.events.some((e) => e.action === 'fin_exec'));

    // ④ 거래등록에서 전자결재 회차를 골라 실적 등록(2회차) → 같은 예정 행이 실적
    const opts = (await ok('christopher', 'GET', '/api/transactions/approval-options')).items.filter((o) => o.doc_id === d1);
    assert.deepEqual(opts.map((o) => o.seq), [2, 3], '처리된 회차는 목록에서 빠짐');
    assert.equal(opts[0].plan_txn_id, P[1].id); assert.equal(opts[0].category_code, '6050');
    assert.equal((await call('christopher', 'POST', '/api/transactions', { approval_payment_id: opts[0].payment_id, status: 'plan', direction: 'out', account_id: acc, amount: 1, txn_date: today })).body.error, 'approval_needs_actual_out');
    const t2 = await ok('christopher', 'POST', '/api/transactions', { approval_payment_id: opts[0].payment_id, status: 'actual', direction: 'out',
      account_id: acc, txn_date: '2026-12-03', amount: 1200, currency: 'MXN', category_code: '6050', memo: '12월분' });
    assert.equal(Number(t2.id), P[1].id, '예정 행을 실적으로 전환'); assert.equal(t2.approval_doc_id, d1); assert.equal(t2.approved, false, '재무 지출은 디렉터 승인 대기');
    P = await plansOf(d1);
    assert.deepEqual([P[1].status, P[1].amount, P[1].pay_status], ['actual', 1200, 'done']);
    const tp = (await pool.query(`SELECT plan_amount::float AS pa, change_count FROM transactions WHERE id=$1`, [t2.id])).rows[0];
    assert.equal(tp.pa, 1160, '계획 금액 보존(계획대비실적)'); assert.equal(tp.change_count, 1);
    assert.equal((await call('christopher', 'POST', '/api/transactions', { approval_payment_id: opts[0].payment_id, status: 'actual', direction: 'out', account_id: acc, txn_date: today, amount: 5 })).body.error, 'approval_payment_already_linked');

    // ⑤ 이미 등록한 실적에 3회차 연결 → 예정 빠지고 전 회차 완료 → 사후승인 요청
    const t3 = Number((await ok('christopher', 'POST', '/api/transactions', { status: 'actual', direction: 'out', account_id: acc, txn_date: '2027-01-04', amount: 1160, currency: 'MXN' })).id);
    await ok('christopher', 'POST', `/api/transactions/${t3}/files`, { file_name: 'spei.pdf', data: dataUrl('%PDF-1.4 spei', 'application/pdf') });
    const lk = await ok('christopher', 'POST', `/api/transactions/${t3}/approval-link`, { payment_id: opts[1].payment_id });
    assert.equal(Number(lk.plan_removed), P[2].id);
    P = await plansOf(d1);
    assert.deepEqual([P[2].id, P[2].status, P[2].pay_status], [t3, 'actual', 'done']);
    assert.equal((await pool.query(`SELECT deleted_at IS NOT NULL AS del FROM transactions WHERE id=$1`, [lk.plan_removed])).rows[0].del, true);
    det = await ok('sebastian', 'GET', `/api/approvals/${d1}`);
    assert.equal(det.doc.exec_status, 'done'); assert.equal(det.doc.post_status, 'pending'); assert.equal(det.doc.actual_total, 3520);
    assert.equal(det.lines.find((l) => l.step_type === 'post_ceo').status, 'pending');
    assert.ok((await ok('jang', 'GET', '/api/approvals/notifications')).items.some((x) => x.document_id === d1 && x.kind === '사후승인 요청'));
    assert.equal((await call('christopher', 'POST', `/api/transactions/${t3}/approval-link`, { payment_id: opts[0].payment_id })).body.error, 'txn_already_linked');
    // 거래목록·파일 상세에 전자결재 증빙
    const list = await ok('sebastian', 'GET', `/api/transactions?account_id=${acc}`);
    const row3 = list.items.find((x) => Number(x.id) === t3);
    assert.equal(row3.approval.doc_id, d1); assert.equal(row3.approval.seq, 3); assert.equal(row3.source, 'approval');
    const fl = await ok('christopher', 'GET', `/api/transactions/${t3}/files`);
    assert.equal(fl.approval.doc_no, docNo); assert.equal(fl.can_unlink_approval, true); assert.equal(fl.items.length, 1);

    // ⑥ 연결 해제 → 3회차 미집행 · 예정 재생성 · 사후승인 대기 해제
    await ok('christopher', 'DELETE', `/api/transactions/${t3}/approval-link`);
    P = await plansOf(d1);
    assert.deepEqual([P[2].status, P[2].pay_status, P[2].del], ['plan', 'planned', false]);
    det = await ok('sebastian', 'GET', `/api/approvals/${d1}`);
    assert.equal(det.doc.exec_status, 'pending'); assert.equal(det.doc.post_status, 'none');
    assert.equal(det.lines.find((l) => l.step_type === 'post_ceo').status, 'waiting');
    assert.ok(!(await ok('jang', 'GET', '/api/approvals/notifications')).items.some((x) => x.document_id === d1 && x.kind === '사후승인 요청' && !x.read_at));
    // 다시 연결 → 사후승인 완료 → 거래 삭제는 막힘
    const opt3 = (await ok('christopher', 'GET', '/api/transactions/approval-options')).items.find((o) => o.doc_id === d1);
    await ok('christopher', 'POST', `/api/transactions/${t3}/approval-link`, { payment_id: opt3.payment_id });
    await ok('jang', 'POST', `/api/approvals/${d1}/act`, { action: 'approve' });
    assert.equal((await ok('sebastian', 'GET', `/api/approvals/${d1}`)).doc.post_status, 'confirmed');
    assert.equal((await call('sebastian', 'DELETE', `/api/transactions/${t3}`)).body.error, 'approval_closed');
    assert.equal((await call('christopher', 'DELETE', `/api/transactions/${t3}/approval-link`)).body.error, 'approval_closed');

    // ⑦ 디렉터가 미승인 실적을 반려 → 회차 미집행으로 · 예정 재생성
    const d2 = (await ok('oscar', 'POST', '/api/approvals', { category_id: sobo.id, title: '공구 구매', orig_sub: 500, pay_due: '2026-11-20' })).id;
    await ok('oscar', 'POST', `/api/approvals/${d2}/submit`);
    await ok('maria', 'POST', `/api/approvals/${d2}/act`, { action: 'approve' });
    await ok('sebastian', 'POST', `/api/approvals/${d2}/act`, { action: 'approve' });
    let P2 = await plansOf(d2);
    assert.deepEqual([P2[0].status, P2[0].amount, P2[0].d], ['plan', 580, '2026-11-20']);
    const o2 = (await ok('christopher', 'GET', '/api/transactions/approval-options?q=공구')).items;
    assert.equal(o2.length, 1);
    const tx2 = await ok('christopher', 'POST', '/api/transactions', { approval_payment_id: o2[0].payment_id, status: 'actual', direction: 'out', account_id: acc, txn_date: '2026-11-19', amount: 580 });
    assert.equal((await ok('sebastian', 'GET', `/api/approvals/${d2}`)).doc.exec_status, 'done');
    await ok('sebastian', 'POST', `/api/transactions/${tx2.id}/reject`);
    P2 = await plansOf(d2);
    assert.equal(P2[0].pay_status, 'planned'); assert.equal(P2[0].status, 'plan'); assert.equal(P2[0].del, false);
    assert.notEqual(P2[0].id, Number(tx2.id), '반려된 실적 대신 새 예정');
    det = await ok('sebastian', 'GET', `/api/approvals/${d2}`);
    assert.equal(det.doc.exec_status, 'pending'); assert.ok(det.events.some((e) => e.action === 'fin_revert'));

    // ⑧ 재결재(승인 후 단계 추가) → 예정 빠짐 → 다시 승인 → 같은 행 복귀
    const planId = P2[0].id;
    const steps = det.lines.filter((l) => !['draft', 'post_ceo'].includes(l.step_type)).map((l) => ({ step_type: l.step_type, user_id: l.user_id }));
    await ok('sebastian', 'PUT', `/api/approvals/${d2}/lines`, { steps: [{ step_type: 'agree', user_id: U.luis.id }], post_user_id: U.jang.id });
    assert.equal((await plansOf(d2))[0].del, true, '다시 결재중 → 예정 숨김');
    await ok('luis', 'POST', `/api/approvals/${d2}/act`, { action: 'approve' });
    P2 = await plansOf(d2);
    assert.deepEqual([P2[0].id, P2[0].del, P2[0].status], [planId, false, 'plan'], '재승인 → 같은 예정 행 복귀');
    void steps;

    // ⑨ 문서 삭제 → 예정 숨김 · 복구 → 다시 · 회차 중단 → 숨김
    const { hashPin } = await import('../src/auth.js');
    await pool.query(`UPDATE users SET pin_hash=$2 WHERE id=$1`, [U.sebastian.id, hashPin('2468')]);
    await ok('sebastian', 'POST', `/api/approvals/${d2}/delete`, { reason: '테스트', pin: '2468' });
    assert.equal((await plansOf(d2))[0].del, true);
    assert.ok(!(await ok('christopher', 'GET', '/api/transactions/approval-options')).items.some((o) => o.doc_id === d2));
    await ok('sebastian', 'POST', `/api/approvals/${d2}/restore`);
    assert.equal((await plansOf(d2))[0].del, false);
    const pid2 = (await ok('sebastian', 'GET', `/api/approvals/${d2}`)).payments[0].id;
    await ok('christopher', 'POST', `/api/approvals/${d2}/payments/${pid2}/skip`, { reason: '계약 취소' });
    assert.equal((await plansOf(d2))[0].del, true, '회차 중단 → 예정 숨김');

    // ⑩ 전자결재 화면에서 집행(기존 방식) → 예정 정리 · 집행 생략 문서는 예정 없이 바로 집행완료 · 거래등록 연결은 가능
    const d3 = (await ok('sebastian', 'POST', '/api/approvals', { category_id: sobo.id, title: '디렉터 소액', orig_sub: 100, custom_steps: [] })).id;
    await ok('sebastian', 'POST', `/api/approvals/${d3}/submit`);
    assert.equal((await plansOf(d3))[0].status, 'plan');
    await ok('christopher', 'POST', `/api/approvals/${d3}/files`, { file_name: 'f.pdf', kind: '송금증', data_url: dataUrl('spei-d3-' + Date.now(), 'application/pdf') });
    await ok('christopher', 'POST', `/api/approvals/${d3}/execute`, { actual_total: 116, exec_date: today, pay_method: '계좌이체' });
    let P3 = await plansOf(d3);
    assert.deepEqual([P3[0].pay_status, P3[0].exec_source, P3[0].del], ['done', 'approval', true]);
    const d4 = (await ok('sebastian', 'POST', '/api/approvals', { category_id: sobo.id, title: '카드 결제분', orig_sub: 200, custom_steps: [], exec_required: false })).id;
    await ok('sebastian', 'POST', `/api/approvals/${d4}/submit`);
    const P4 = await plansOf(d4);
    assert.equal(P4[0].id, null, '집행 생략 문서는 예정 없음'); assert.equal(P4[0].pay_status, 'done');
    const o4 = (await ok('sebastian', 'GET', '/api/transactions/approval-options')).items.find((o) => o.doc_id === d4);
    assert.ok(o4, '집행 생략 문서도 증빙으로 연결 가능');
    const t4 = Number((await ok('sebastian', 'POST', '/api/transactions', { status: 'actual', direction: 'out', account_id: acc, txn_date: today, amount: 232 })).id);
    await ok('sebastian', 'POST', `/api/transactions/${t4}/approval-link`, { payment_id: o4.payment_id });
    const P4b = await plansOf(d4);
    assert.deepEqual([P4b[0].id, P4b[0].exec_source], [t4, 'approval'], '전자결재 집행 실적은 유지, 증빙 연결만');

    // ⑪ 카테고리 재무 과목 변경 → 남은 예정 과목도 변경
    const d5 = (await ok('oscar', 'POST', '/api/approvals', { category_id: sobo.id, title: '과목 변경 확인', orig_sub: 300 })).id;
    await ok('oscar', 'POST', `/api/approvals/${d5}/submit`);
    await ok('maria', 'POST', `/api/approvals/${d5}/act`, { action: 'approve' });
    await ok('sebastian', 'POST', `/api/approvals/${d5}/act`, { action: 'approve' });
    await ok('sebastian', 'PUT', `/api/approvals/categories/${sobo.id}`, { fin_category_code: '6120' });
    assert.equal((await plansOf(d5))[0].category_code, '6120');
    assert.equal((await call('sebastian', 'PUT', `/api/approvals/categories/${sobo.id}`, { fin_category_code: 'ZZZ' })).body.detail, 'bad_fin_category');

    // ⑫ USD 문서 — 예정은 USD · 문서 고정 환율 · MXN = 회차 MXN
    const setRate = (d, r) => pool.query(`INSERT INTO fx_rates(rate_date, base, quote, rate, source) VALUES ($1,'USD','MXN',$2,'test')
      ON CONFLICT (rate_date, base, quote) DO UPDATE SET rate=EXCLUDED.rate, source='test'`, [d, r]);
    await setRate(today, 18.5);
    const d6 = (await ok('sebastian', 'POST', '/api/approvals', { category_id: sobo.id, title: 'USD 장비', currency: 'USD', orig_sub: 1000, pay_due: '2026-12-01', custom_steps: [] })).id;
    await ok('sebastian', 'POST', `/api/approvals/${d6}/submit`);
    const P6 = await plansOf(d6);
    assert.deepEqual([P6[0].currency, P6[0].amount, P6[0].mxn], ['USD', 1160, 21460]);

    // ⑬ 마이그레이션 백필: 연결이 비어 있는 승인 문서 회차 → 다시 채움(재실행 안전)
    await pool.query(`UPDATE transactions SET deleted_at=now(), plan_memo=NULL WHERE id=$1`, [P6[0].id]);
    await pool.query(`UPDATE approval_payments SET txn_id=NULL WHERE document_id=$1`, [d6]);
    const mig = read(join(API, 'migrations/0258_e_approval_finance_link.sql'));
    await pool.query(mig); await pool.query(mig);
    const P6b = await plansOf(d6);
    assert.equal(P6b[0].status, 'plan'); assert.equal(P6b[0].del, false); assert.notEqual(P6b[0].id, P6[0].id);
    assert.equal((await pool.query(`SELECT count(*)::int c FROM transactions WHERE plan_memo=$1 AND deleted_at IS NULL`, ['approval_payment:' + (await ok('sebastian', 'GET', `/api/approvals/${d6}`)).payments[0].id])).rows[0].c, 1);
  } finally {
    await app.close();
  }
});
