// =====================================================================
// 마케팅 지출계획 「집행 처리」 종단 검증 — 실 PostgreSQL(0001~0196) + 실 라우트
//
//   핵심은 "예정 거래 동기화" 다. 집행 처리가 현금흐름에서 실제로 빠지는지,
//   부분 집행이 잔액만 남기는지, 되돌리기가 원상복구하는지, 이중 소진이 막히는지.
//   현금흐름·예정 내역·거래목록은 전부 `deleted_at IS NULL` + `plan_amount` 를 보므로
//   transactions 행을 직접 확인하는 것이 곧 그 화면들을 확인하는 것이다.
//
//   실행: TEST_PG_URL=postgres://... node --test test/mktspend_exec_e2e.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, mktRoutes, Fastify, jwt, app;
const tok = {}; const ID = {};
const TAG = 'MKEXEC';
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function boot() {
  ({ query } = await import('../src/db.js'));
  mktRoutes = (await import('../src/routes/marketingSpendRoutes.js')).default;
  Fastify = (await import('fastify')).default;
  jwt = (await import('@fastify/jwt')).default;

  const PLANS = `SELECT id FROM marketing_spend_plans WHERE title LIKE '${TAG}%'`;
  await query(`DELETE FROM marketing_spend_executions WHERE plan_id IN (${PLANS})`);
  await query(`DELETE FROM marketing_spend_revisions WHERE plan_id IN (${PLANS})`);
  await query(`DELETE FROM calendar_event_targets WHERE event_id IN (SELECT id FROM calendar_events WHERE src_plan_id IN (${PLANS}))`);
  await query(`DELETE FROM calendar_events WHERE src_plan_id IN (${PLANS})`);
  // 라인이 거래를 FK 로 물고 있으므로 반드시 "라인 → 거래" 순서로 지운다(거래 먼저 지우면 23503).
  const oldTxns = (await query(`SELECT txn_id FROM marketing_spend_lines WHERE plan_id IN (${PLANS}) AND txn_id IS NOT NULL`))
    .rows.map((r) => Number(r.txn_id));
  await query(`DELETE FROM marketing_spend_lines WHERE plan_id IN (${PLANS})`);
  if (oldTxns.length) await query(`DELETE FROM transactions WHERE id = ANY($1)`, [oldTxns]);
  await query(`DELETE FROM marketing_spend_items WHERE plan_id IN (${PLANS})`);
  await query(`DELETE FROM marketing_spend_targets WHERE plan_id IN (${PLANS})`);
  await query(`DELETE FROM marketing_spend_files WHERE plan_id IN (${PLANS})`);
  await query(`DELETE FROM marketing_spend_plans WHERE title LIKE '${TAG}%'`);
  await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'mkexec%')`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'mkexec%')`);
  await query(`DELETE FROM users WHERE login_id LIKE 'mkexec%'`);

  const mkUser = async (name, role, login) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name, role, login])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'mkexec_dir');
  ID.mkt = await mkUser(`${TAG}마케팅`, 'marketing', 'mkexec_mkt');
  ID.fin = await mkUser(`${TAG}재무`, 'treasury', 'mkexec_fin');
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'marketing','anywhere','edit')`, [ID.mkt]);
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'finance','anywhere','edit')`, [ID.fin]);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(mktRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.mkt = app.jwt.sign({ sub: ID.mkt });
  tok.fin = app.jwt.sign({ sub: ID.fin });
}
const get = (who, url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok[who] } });
const post = (who, url, body) => app.inject({ method: 'POST', url, payload: body || {}, headers: { authorization: 'Bearer ' + tok[who] } });
const patch = (who, url, body) => app.inject({ method: 'PATCH', url, payload: body, headers: { authorization: 'Bearer ' + tok[who] } });
const del = (who, url) => app.inject({ method: 'DELETE', url, headers: { authorization: 'Bearer ' + tok[who] } });

// 예정 거래의 "현금흐름에 잡히는" 상태 — alive(=deleted_at IS NULL) + 금액
async function txnState(lineId) {
  const r = (await query(
    `SELECT t.deleted_at, t.status, t.amount_mxn, t.plan_amount
       FROM marketing_spend_lines l JOIN transactions t ON t.id=l.txn_id WHERE l.id=$1`, [lineId])).rows[0];
  if (!r) return null;
  return { alive: r.deleted_at == null, status: r.status,
    amount: r2(Number(r.amount_mxn)), plan_amount: r2(Number(r.plan_amount)) };
}
// 그 계획의 "앞으로 나갈 돈" = 살아있는 예정 거래의 plan_amount 합 (현금흐름이 보는 값)
async function planOutstanding(planId) {
  const r = (await query(
    `SELECT COALESCE(SUM(t.plan_amount),0) AS s
       FROM marketing_spend_lines l JOIN transactions t ON t.id=l.txn_id
      WHERE l.plan_id=$1 AND t.deleted_at IS NULL AND t.status='plan'`, [planId])).rows[0];
  return r2(Number(r.s));
}
const detail = async (who, id) => (await get(who, '/api/mktspend/plans/' + id)).json();
const flatLines = (d) => { const o = []; (d.items || []).forEach((it) => (it.lines || []).forEach((l) => o.push(l))); return o; };

const PLAN_BODY = {
  title: `${TAG} 몬테레이 전시회`, category: '전시회', event_date: '2026-10-10', purpose: '신규 고객 확보',
  items: [
    { name: '장소 대관', memo: 'Cintermex', lines: [
      { kind: 'adv', due_date: '2026-09-15', amount: 30000, memo: '계약금' },
      { kind: 'fin', due_date: '2026-10-15', amount: 30000, memo: '잔금' }] },
    { name: '케이터링', memo: null, lines: [{ kind: 'one', due_date: '2026-10-10', amount: 25000, memo: null }] },
    { name: '판촉물', memo: null, lines: [{ kind: 'one', due_date: '2026-09-30', amount: 15000, memo: null }] },
  ],
  targets: [],
};

let P = 0, L = {};

test('boot', { skip: SKIP }, async () => { await boot(); });

test('① 계획 작성 → 제출 → 승인 : 지급 줄 수만큼 예정 지출이 생긴다', { skip: SKIP }, async () => {
  const c = await post('mkt', '/api/mktspend/plans', PLAN_BODY);
  assert.equal(c.statusCode, 200, c.body);
  P = c.json().id;
  assert.equal((await post('mkt', `/api/mktspend/plans/${P}/submit`)).statusCode, 200);
  const a = await post('dir', `/api/mktspend/plans/${P}/approve`);
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(a.json().txn_ids.length, 4, '지급 줄 4건 → 예정 지출 4건');

  const d = await detail('dir', P);
  const ls = flatLines(d);
  assert.equal(ls.length, 4);
  L.adv = ls.find((l) => l.kind === 'adv').id;                        // 30,000 (장소 선지급)
  L.fin = ls.find((l) => l.kind === 'fin').id;                        // 30,000 (장소 잔금)
  L.cat = ls.find((l) => l.due_date === '2026-10-10').id;             // 25,000 (케이터링)
  L.promo = ls.find((l) => l.due_date === '2026-09-30').id;           // 15,000 (판촉물)
  assert.equal(await planOutstanding(P), 100000, '승인 직후 앞으로 나갈 돈 = 계획 총액');
  ls.forEach((l) => { assert.equal(l.exec_state, 'none'); assert.equal(l.exec_total, 0); });
});

test('② 권한 — 마케팅 담당은 집행 처리 불가(403), 재무·디렉터만 가능', { skip: SKIP }, async () => {
  const r = await post('mkt', `/api/mktspend/plans/${P}/executions`,
    { exec_date: '2026-09-14', lines: [{ line_id: L.adv, amount: 30000 }] });
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().error, 'exec_forbidden');
  assert.equal((await detail('mkt', P)).can_execute, false);
  assert.equal((await detail('fin', P)).can_execute, true, '재무는 이 화면을 보고 집행할 수 있어야 한다');
});

test('③ 한 번의 송금으로 두 줄 완결 → 예정에서 통째로 사라진다 (이번 작업의 핵심)', { skip: SKIP }, async () => {
  const r = await post('fin', `/api/mktspend/plans/${P}/executions`, {
    exec_date: '2026-09-14', note: 'SPEI 88213', close: true,
    lines: [{ line_id: L.adv, amount: 30000 }, { line_id: L.promo, amount: 15000 }],
  });
  assert.equal(r.statusCode, 200, r.body);

  const sa = await txnState(L.adv), sp = await txnState(L.promo);
  assert.equal(sa.alive, false, '선지급 예정 거래가 현금흐름에서 빠져야 한다');
  assert.equal(sp.alive, false, '판촉물 예정 거래가 현금흐름에서 빠져야 한다');
  assert.equal(await planOutstanding(P), 55000, '100,000 − 45,000 = 55,000');

  const d = await detail('fin', P);
  const byId = new Map(flatLines(d).map((l) => [l.id, l]));
  assert.equal(byId.get(L.adv).exec_state, 'closed');
  assert.equal(byId.get(L.adv).exec_total, 30000);
  assert.equal(byId.get(L.adv).exec_last_date, '2026-09-14');
  assert.equal(byId.get(L.adv).executions.length, 1);
  assert.equal(byId.get(L.adv).executions[0].note, 'SPEI 88213');
  assert.equal(byId.get(L.fin).exec_state, 'none', '건드리지 않은 줄은 그대로');
  assert.equal((await txnState(L.fin)).alive, true);
});

test('④ 계획 삭제 후에도 재생성되지 않는다 — 저장해도 되살아나지 않음', { skip: SKIP }, async () => {
  // 디렉터가 계획을 그대로 다시 저장해도 집행 완결 줄의 예정은 되살아나면 안 된다.
  const d = await detail('dir', P);
  const body = { title: d.plan.title, category: d.plan.category, event_date: d.plan.event_date, purpose: d.plan.purpose,
    items: d.items.map((it) => ({ id: it.id, name: it.name, memo: it.memo,
      lines: it.lines.map((l) => ({ id: l.id, kind: l.kind, due_date: l.due_date, amount: l.amount, memo: l.memo })) })),
    targets: [] };
  const r = await patch('dir', `/api/mktspend/plans/${P}`, body);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await txnState(L.adv)).alive, false, '재저장으로 되살아나면 안 된다');
  assert.equal(await planOutstanding(P), 55000);
});

test('⑤ 부분 집행 → 예정이 "잔액" 으로 줄어든다', { skip: SKIP }, async () => {
  const r = await post('fin', `/api/mktspend/plans/${P}/executions`, {
    exec_date: '2026-09-20', close: false, lines: [{ line_id: L.fin, amount: 20000 }],
  });
  assert.equal(r.statusCode, 200, r.body);
  const s = await txnState(L.fin);
  assert.equal(s.alive, true, '부분 집행은 예정이 남아야 한다');
  assert.equal(s.amount, 10000, '30,000 − 20,000 = 잔액 10,000');
  assert.equal(s.plan_amount, 10000, '현금흐름은 plan_amount 를 보므로 여기도 잔액이어야 한다');
  assert.equal(await planOutstanding(P), 35000, '55,000 − 20,000');

  const l = flatLines(await detail('fin', P)).find((x) => x.id === L.fin);
  assert.equal(l.exec_state, 'partial');
  assert.equal(l.exec_total, 20000);
  assert.equal(l.exec_balance, 10000);
  assert.equal(l.exec_closed, false);
});

test('⑥ 부분 집행의 잔액을 마저 집행하면 자동으로 완결된다', { skip: SKIP }, async () => {
  const r = await post('fin', `/api/mktspend/plans/${P}/executions`, {
    exec_date: '2026-10-16', close: false, lines: [{ line_id: L.fin, amount: 10000 }],
  });
  assert.equal(r.statusCode, 200, r.body);
  const l = flatLines(await detail('fin', P)).find((x) => x.id === L.fin);
  assert.equal(l.exec_state, 'closed', '잔액이 0이면 완결로 넘어간다');
  assert.equal(l.exec_total, 30000);
  assert.equal((await txnState(L.fin)).alive, false);
  assert.equal(await planOutstanding(P), 25000, '케이터링 25,000 만 남는다');
});

test('⑦ 계획액과 실지급액이 다르면 계획액은 그대로, 차이만 기록', { skip: SKIP }, async () => {
  const r = await post('fin', `/api/mktspend/plans/${P}/executions`, {
    exec_date: '2026-10-09', close: true, lines: [{ line_id: L.cat, amount: 23800 }],
  });
  assert.equal(r.statusCode, 200, r.body);
  const l = flatLines(await detail('fin', P)).find((x) => x.id === L.cat);
  assert.equal(l.amount, 25000, '계획액은 건드리지 않는다');
  assert.equal(l.exec_total, 23800);
  assert.equal(l.exec_diff, -1200, '계획대비 차이 −1,200');
  assert.equal(l.exec_state, 'closed');
  assert.equal(await planOutstanding(P), 0, '모두 소진 — 현금예측에 남는 게 없다');
});

test('⑧ 되돌리기 → 예정 거래가 복원되고 현금흐름에 다시 잡힌다', { skip: SKIP }, async () => {
  const l = flatLines(await detail('fin', P)).find((x) => x.id === L.cat);
  const ex = l.executions[0].id;
  const r = await post('fin', `/api/mktspend/executions/${ex}/revert`, { reason: '송금 취소' });
  assert.equal(r.statusCode, 200, r.body);
  const s = await txnState(L.cat);
  assert.equal(s.alive, true, '예정이 복원되어야 한다');
  assert.equal(s.amount, 25000, '계획액으로 원복');
  assert.equal(s.plan_amount, 25000);
  assert.equal(await planOutstanding(P), 25000);
  const l2 = flatLines(await detail('fin', P)).find((x) => x.id === L.cat);
  assert.equal(l2.exec_state, 'none');
  assert.equal(l2.exec_total, 0);
  assert.equal(l2.exec_closed, false);
  // 같은 집행을 두 번 되돌릴 수 없다(멱등 가드)
  assert.equal((await post('fin', `/api/mktspend/executions/${ex}/revert`, {})).statusCode, 409);
});

test('⑨ 이중 소진 방지 — 재무 실적처리된 줄은 집행 불가', { skip: SKIP }, async () => {
  // 재무 [실적 처리] 를 그대로 재현: 예정 거래를 actual 로 확정
  await query(`UPDATE transactions SET status='actual', txn_date='2026-10-09'
                WHERE id=(SELECT txn_id FROM marketing_spend_lines WHERE id=$1)`, [L.cat]);
  const r = await post('fin', `/api/mktspend/plans/${P}/executions`, {
    exec_date: '2026-10-10', lines: [{ line_id: L.cat, amount: 25000 }] });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'already_paid');
  const l = flatLines(await detail('fin', P)).find((x) => x.id === L.cat);
  assert.equal(l.exec_state, 'paid', '화면에는 지급완료로 보인다');
});

test('⑩ 이미 완결한 줄은 다시 집행할 수 없다', { skip: SKIP }, async () => {
  const r = await post('fin', `/api/mktspend/plans/${P}/executions`, {
    exec_date: '2026-10-20', lines: [{ line_id: L.adv, amount: 1000 }] });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'already_closed');
});

test('⑪ 집행 완결 줄은 수정·삭제가 잠긴다 (되돌린 뒤에 고칠 것)', { skip: SKIP }, async () => {
  const d = await detail('dir', P);
  const body = { title: d.plan.title, category: d.plan.category, event_date: d.plan.event_date, purpose: d.plan.purpose,
    items: d.items.map((it) => ({ id: it.id, name: it.name, memo: it.memo,
      lines: it.lines.map((l) => ({ id: l.id, kind: l.kind, due_date: l.due_date,
        amount: l.id === L.adv ? 31000 : l.amount, memo: l.memo })) })),   // ← 완결 줄 금액 변경 시도
    targets: [] };
  const r = await patch('dir', `/api/mktspend/plans/${P}`, body);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'line_locked');
  assert.equal(r.json().reason, 'executed');
  const l = flatLines(await detail('dir', P)).find((x) => x.id === L.adv);
  assert.equal(l.amount, 30000, '거부됐으므로 금액은 그대로');
});

test('⑫ 집행 기록이 있는 계획은 삭제할 수 없다', { skip: SKIP }, async () => {
  const r = await del('dir', `/api/mktspend/plans/${P}`);
  assert.equal(r.statusCode, 409);
  assert.ok(['has_executed_lines', 'has_paid_lines'].includes(r.json().error), r.body);
});

test('⑬ 대사 — ② 마케팅 집행과 ③−① 원장 미연결분을 비교한다', { skip: SKIP }, async () => {
  const r = await get('fin', '/api/mktspend/reconcile?ym=2026-09');
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  // 9월 집행: 선지급 30,000 + 판촉물 15,000 + 잔금 부분 20,000 = 65,000
  assert.equal(d.marketing_exec.amount, 65000);
  assert.equal(d.marketing_exec.count, 3);
  assert.ok(d.exec_items.length >= 3);
  // 재무 등록을 전혀 안 했으므로 원장에는 아무것도 없다 → gap = 65,000 (등록 누락 경고)
  assert.equal(d.gap, r2(d.marketing_exec.amount - d.unlinked_ledger.amount));
  assert.ok(d.gap > 0, '집행만 하고 원장에 없으면 양수 gap 으로 경고되어야 한다');
  // 권한: 마케팅 담당은 대사를 볼 수 없다
  assert.equal((await get('mkt', '/api/mktspend/reconcile?ym=2026-09')).statusCode, 403);
  assert.equal((await get('fin', '/api/mktspend/reconcile?ym=xxxx')).statusCode, 400);
});

test('⑭ 개정 스냅샷 — 제출·승인·디렉터수정 시점이 기준선으로 쌓인다', { skip: SKIP }, async () => {
  const rv = await get('dir', `/api/mktspend/plans/${P}/revisions`);
  assert.equal(rv.statusCode, 200);
  const evs = rv.json().items.map((x) => x.event);
  assert.ok(evs.includes('submitted'), '제출 스냅샷');
  assert.ok(evs.includes('approved'), '승인 스냅샷');
  assert.ok(evs.includes('director_edit'), '디렉터 수정 스냅샷(④에서 저장했다)');
  const top = rv.json().items[0];
  assert.equal(top.line_count, 4);
  assert.equal(top.total_amount, 100000);

  const d = await detail('dir', P);
  assert.ok(Array.isArray(d.revisions_recent) && d.revisions_recent.length >= 1, '상세가 기준선을 함께 내려준다');
  const snap = d.revisions_recent[0].snapshot;
  assert.equal(snap.title, PLAN_BODY.title);
  assert.equal(snap.items.length, 3);
  assert.equal(snap.items[0].lines.length, 2);
  assert.ok(snap.items[0].lines[0].amount != null);
});

test('⑮ 잘못된 입력 방어', { skip: SKIP }, async () => {
  const bad = (b) => post('fin', `/api/mktspend/plans/${P}/executions`, b);
  assert.equal((await bad({ exec_date: '2026-9-1', lines: [{ line_id: L.fin, amount: 1 }] })).statusCode, 400);
  assert.equal((await bad({ exec_date: '2026-09-01', lines: [] })).statusCode, 400);
  assert.equal((await bad({ exec_date: '2026-09-01', lines: [{ line_id: L.fin, amount: 0 }] })).statusCode, 400);
  assert.equal((await bad({ exec_date: '2026-09-01', lines: [{ line_id: 999999999, amount: 10 }] })).statusCode, 409);
  assert.equal((await post('fin', '/api/mktspend/executions/999999999/revert', {})).statusCode, 404);
});

// =====================================================================
// 항목별 증빙(0197) — 견적서(계획 근거) / 영수증(집행 근거)
// =====================================================================
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
let P2 = 0, IT = {};
const up = (who, planId, body) => post(who, `/api/mktspend/plans/${planId}/files`, body);

test('⑯ 항목별 증빙 — 견적서·영수증이 항목에 붙는다', { skip: SKIP }, async () => {
  const d = await detail('dir', P);
  IT.venue = d.items[0].id; IT.cater = d.items[1].id;
  const q = await up('mkt', P, { file_name: 'cotizacion_cintermex.pdf', data: PNG, item_id: IT.venue, doc_kind: 'quote' });
  assert.equal(q.statusCode, 200, q.body);
  assert.equal(q.json().item_id, IT.venue);
  assert.equal(q.json().doc_kind, 'quote');
  const r = await up('fin', P, { file_name: 'spei_88213.pdf', data: PNG, item_id: IT.venue, doc_kind: 'receipt' });
  assert.equal(r.statusCode, 200, r.body);

  const files = (await detail('dir', P)).files;
  const byId = new Map(files.map((f) => [f.id, f]));
  assert.equal(byId.get(q.json().id).item_id, IT.venue);
  assert.equal(byId.get(q.json().id).doc_kind, 'quote');
  assert.equal(byId.get(r.json().id).doc_kind, 'receipt');
});

test('⑰ 증빙 권한 — 재무는 영수증만, 마케팅 담당은 둘 다', { skip: SKIP }, async () => {
  const bad = await up('fin', P, { file_name: 'q.pdf', data: PNG, item_id: IT.cater, doc_kind: 'quote' });
  assert.equal(bad.statusCode, 403, '재무가 견적서를 올릴 수 있으면 안 된다');
  const ok1 = await up('fin', P, { file_name: 'r.pdf', data: PNG, item_id: IT.cater, doc_kind: 'receipt' });
  assert.equal(ok1.statusCode, 200, ok1.body);
  const ok2 = await up('mkt', P, { file_name: 'q2.pdf', data: PNG, item_id: IT.cater, doc_kind: 'quote' });
  assert.equal(ok2.statusCode, 200, ok2.body);
  // 재무는 자기가 올린 영수증은 지울 수 있고, 마케팅의 견적서는 못 지운다
  assert.equal((await del('fin', `/api/mktspend/files/${ok2.json().id}`)).statusCode, 403);
  assert.equal((await del('fin', `/api/mktspend/files/${ok1.json().id}`)).statusCode, 200);
});

test('⑱ 잘못된 입력 — 다른 계획의 항목·알 수 없는 종류', { skip: SKIP }, async () => {
  assert.equal((await up('mkt', P, { file_name: 'x.pdf', data: PNG, item_id: 999999999, doc_kind: 'quote' })).statusCode, 400);
  assert.equal((await up('mkt', P, { file_name: 'x.pdf', data: PNG, doc_kind: 'nope' })).statusCode, 400);
  // 하위호환: item_id·doc_kind 없이 올리면 계획 공통
  const c = await up('mkt', P, { file_name: 'common.pdf', data: PNG });
  assert.equal(c.statusCode, 200);
  assert.equal(c.json().item_id, null);
  assert.equal(c.json().doc_kind, 'other');
});

test('⑲ 초안을 여러 번 저장해도 항목 id 가 유지된다 (증빙 연결 보존 — 이번 수정의 핵심)', { skip: SKIP }, async () => {
  const c = await post('mkt', '/api/mktspend/plans', {
    title: `${TAG} 초안 증빙`, category: '판촉물', event_date: '2026-12-01', purpose: 'x',
    items: [{ name: '인쇄물', memo: null, lines: [{ kind: 'one', due_date: '2026-11-20', amount: 5000, memo: null }] }],
    targets: [] });
  assert.equal(c.statusCode, 200, c.body);
  P2 = c.json().id;
  const it1 = (await detail('mkt', P2)).items[0].id;
  const f = await up('mkt', P2, { file_name: 'quote_print.pdf', data: PNG, item_id: it1, doc_kind: 'quote' });
  assert.equal(f.statusCode, 200);

  // 초안 저장을 두 번 반복(금액·항목명 수정) — 예전 구현은 여기서 항목을 지우고 다시 만들어
  // 증빙의 item_id 가 NULL 로 떨어졌다.
  for (const amt of [6000, 7000]) {
    const d = await detail('mkt', P2);
    const r = await patch('mkt', `/api/mktspend/plans/${P2}`, {
      title: d.plan.title, category: d.plan.category, event_date: d.plan.event_date, purpose: d.plan.purpose,
      items: d.items.map((it) => ({ id: it.id, name: it.name + '', memo: it.memo,
        lines: it.lines.map((l) => ({ id: l.id, kind: l.kind, due_date: l.due_date, amount: amt, memo: l.memo })) })),
      targets: [] });
    assert.equal(r.statusCode, 200, r.body);
  }
  const after = await detail('mkt', P2);
  assert.equal(after.items[0].id, it1, '항목 id 가 저장 때마다 바뀌면 안 된다');
  assert.equal(after.files.length, 1);
  assert.equal(after.files[0].item_id, it1, '증빙이 항목에 계속 붙어 있어야 한다');
  assert.equal(after.items[0].lines[0].amount, 7000, '내용 수정은 정상 반영');
});

test('⑳ 항목을 지워도 증빙은 사라지지 않고 "계획 공통" 으로 남는다', { skip: SKIP }, async () => {
  const d = await detail('mkt', P2);
  const r = await patch('mkt', `/api/mktspend/plans/${P2}`, {
    title: d.plan.title, category: d.plan.category, event_date: d.plan.event_date, purpose: d.plan.purpose,
    items: [{ id: null, name: '다른 항목', memo: null, lines: [{ id: null, kind: 'one', due_date: '2026-11-25', amount: 3000, memo: null }] }],
    targets: [] });
  assert.equal(r.statusCode, 200, r.body);
  const after = await detail('mkt', P2);
  assert.equal(after.items.length, 1);
  assert.notEqual(after.items[0].id, d.items[0].id, '항목이 교체됐다');
  assert.equal(after.files.length, 1, '증빙은 유실되지 않는다');
  assert.equal(after.files[0].item_id, null, '계획 공통으로 내려앉는다');
});

test('cleanup', { skip: SKIP }, async () => {
  const { pool } = await import('../src/db.js');
  await pool.end();
});
