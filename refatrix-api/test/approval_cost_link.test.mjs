// 0332 전자결재 원가·운반비 연결 — 실제 PostgreSQL E2E
//   실행: TEST_PG_URL=postgres://... node --test test/approval_cost_link.test.mjs
//   (사전 조건: 전체 migrate · login_id sebastian/christopher/jang/maria)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = join(HERE, '..');
const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
const C = await import('../src/approvalCostLink.js');

after(async () => {
  if (!PG) return;
  const { pool } = await import('../src/db.js');
  await pool.end().catch(() => {});
  setTimeout(() => process.exit(process.exitCode || 0), 300);
});

test('L1 규칙 — 과목 분류 · 입력 정규화', () => {
  assert.equal(C.linkKind('5030'), 'import');
  assert.equal(C.linkKind('5040'), 'import');
  assert.equal(C.linkKind('6160'), 'freight');
  assert.equal(C.linkKind('5010'), null);
  assert.equal(C.linkKind(null), null);
  assert.equal(C.normCostLink({}), undefined, 'cost_link 키 없음 = 유지');
  assert.deepEqual(C.normCostLink({ cost_link: { import_shipment_ids: ['3', 3, 0, -1, 'x'], freight_customer_id: '7', freight_common: 'yes' } }),
    { import_shipment_ids: [3], import_batch_ids: [], freight_customer_id: 7, freight_invoice_ids: [], freight_common: false });
});

test('L2 배선 — 전자결재 라우트는 거래 테이블을 직접 다루지 않는다 · 마이그레이션 멱등', () => {
  const r = readFileSync(join(API, 'src/routes/approvalRoutes.js'), 'utf8');
  assert.doesNotMatch(r.replace(/\/\/[^\n]*/g, ''), /\btransactions\b|cashflow/i);
  for (const k of ["'/api/approvals/:id/meta'", "'/api/approvals/import-invoices'", "'/api/approvals/freight-customers'", 'costLinkMissing(q, id)', 'copyCostLink(q, id, nid)']) assert.ok(r.includes(k), k);
  const m = readFileSync(join(API, 'migrations/0332_approval_cost_links.sql'), 'utf8');
  assert.equal((m.match(/ADD COLUMN IF NOT EXISTS/g) || []).length, 5);
  assert.doesNotMatch(m, /ADD COLUMN (?!IF NOT EXISTS)/);
});

test('L3 E2E — 수입 인보이스 필수 → 분배 후보 자동 배치 · 운반비 태그 · 디렉터 카테고리/제목 수정 · 실적 계정 변경 · 재기안 복사', { skip: !PG }, async () => {
  const { buildApp } = await import('../src/server.js');
  const { pool } = await import('../src/db.js');
  const q = (t, p) => pool.query(t, p);
  const app = buildApp();
  await app.ready();
  const U = {};
  for (const r of (await q(`SELECT id, login_id, role FROM users WHERE login_id = ANY($1)`, [['sebastian', 'christopher', 'jang', 'maria']])).rows) {
    U[r.login_id] = { id: Number(r.id), tok: app.jwt.sign({ sub: Number(r.id), role: r.role }) };
  }
  await q(`UPDATE approval_settings SET director_user_id=$1, ceo_user_id=$2, finance_user_id=$3, ceo_pre_threshold=100000 WHERE id=1`,
    [U.sebastian.id, U.jang.id, U.christopher.id]);
  const call = async (who, method, url, payload) => {
    const res = await app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + U[who].tok } });
    let body = null; try { body = res.json(); } catch { body = res.body; }
    return { code: res.statusCode, body };
  };
  const ok = async (...a) => { const r = await call(...a); assert.ok(r.code < 300, `${a[1]} ${a[2]} → ${r.code} ${JSON.stringify(r.body)}`); return r.body; };
  const T = `CL${Date.now() % 100000}`;

  // ── 고정 데이터: 재무 과목 · 결재 카테고리 · 선적/배치 · 고객/매출 인보이스 · 계좌
  for (const [code, name] of [['5030', '수입부대비용'], ['5040', '수입운송비'], ['6160', '운반비(매출출고)'], ['6130', '기타경비']]) {
    await q(`INSERT INTO categories(code, name, group_name) VALUES ($1,$2,'테스트') ON CONFLICT (code) DO NOTHING`, [code, name]);
  }
  const mkCat = async (name, code) => {
    const id = Number((await q(`INSERT INTO approval_categories(name, active, fin_category_code, sort_order) VALUES ($1,true,$2,9990) RETURNING id`, [name, code])).rows[0].id);
    return id;
  };
  const catImp = await mkCat(`${T} 통관비`, '5030'), catFr = await mkCat(`${T} 배송비`, '6160'), catEtc = await mkCat(`${T} 기타`, '6130');
  const ship = Number((await q(`INSERT INTO inbound_shipments(invoice_no, status) VALUES ($1,'closed') RETURNING id`, [`${T}-INV1`])).rows[0].id);
  const ship2 = Number((await q(`INSERT INTO inbound_shipments(invoice_no, status) VALUES ($1,'incoming') RETURNING id`, [`${T}-INV2`])).rows[0].id);
  const batch = Number((await q(`INSERT INTO import_batches(batch_no, import_date, fx_rate, status, inbound_shipment_id) VALUES ($1, CURRENT_DATE, 18, 'approved', $2) RETURNING id`, [`${T}-INV1`, ship])).rows[0].id);
  const cu1 = Number((await q(`INSERT INTO customers(code, name) VALUES ($1,$2) RETURNING id`, [`${T}A`, `${T} Refacciones A`])).rows[0].id);
  const cu2 = Number((await q(`INSERT INTO customers(code, name) VALUES ($1,$2) RETURNING id`, [`${T}B`, `${T} Refacciones B`])).rows[0].id);
  const inv = async (cid, tot) => Number((await q(`INSERT INTO sales_invoices(customer_id, inv_date, status, total_mxn) VALUES ($1, CURRENT_DATE, 'posted', $2) RETURNING id`, [cid, tot])).rows[0].id);
  const i1 = await inv(cu1, 5000), i2 = await inv(cu2, 3000);
  const acc = Number((await q(`INSERT INTO accounts(name, currency) VALUES ($1,'MXN') RETURNING id`, [`${T} Banco`])).rows[0].id);

  // ── 작성 화면 목록
  const opts = await ok('maria', 'GET', `/api/approvals/import-invoices?q=${T}`);
  assert.equal(opts.ready, true);
  const o1 = opts.items.find((x) => x.key === `S${ship}`), o2 = opts.items.find((x) => x.key === `S${ship2}`);
  assert.ok(o1 && o1.cost_ready === true && o1.state === '원가 승인됨', JSON.stringify(o1));
  assert.ok(o2 && o2.cost_ready === false && o2.state === '도착 전');
  assert.ok(!('stock_value_mxn' in o1), '원가 금액 없음');
  const custs = await ok('maria', 'GET', `/api/approvals/freight-customers?q=${T}`);
  assert.deepEqual(custs.items.map((c) => c.id).sort(), [cu1, cu2].sort());
  const invs = await ok('maria', 'GET', `/api/approvals/freight-invoices?customer_id=${cu1}`);
  assert.deepEqual(invs.items.map((x) => x.id), [i1]);

  const base = { currency: 'MXN', payment_type: 'once', iva_applied: false, pay_due: '2026-12-01', pay_method: '계좌이체', custom_steps: [] };
  const planOf = async (docId) => (await q(
    `SELECT t.id, t.status, t.category_code, t.customer_id, t.amount_mxn,
            COALESCE((SELECT array_agg(a.sales_invoice_id ORDER BY a.id) FROM transaction_freight_allocations a WHERE a.transaction_id=t.id),'{}') AS inv,
            COALESCE((SELECT sum(a.amount_mxn) FROM transaction_freight_allocations a WHERE a.transaction_id=t.id),0) AS alloc_sum
       FROM approval_payments p JOIN transactions t ON t.id=p.txn_id AND t.deleted_at IS NULL WHERE p.document_id=$1`, [docId])).rows[0];

  // ── ① 수입부대비용: 인보이스 없이 상신 → 거부 · 고르면 상신 · 상세 표시
  const d1 = (await ok('sebastian', 'POST', '/api/approvals', { ...base, category_id: catImp, title: `${T} 관세`, orig_sub: 1000 })).id;
  let r = await call('sebastian', 'POST', `/api/approvals/${d1}/submit`);
  assert.equal(r.code, 400); assert.equal(r.body.detail, 'import_invoice_required');
  r = await call('sebastian', 'PUT', `/api/approvals/${d1}`, { ...base, category_id: catImp, title: `${T} 관세`, orig_sub: 1000, cost_link: { import_shipment_ids: [999999999] } });
  assert.equal(r.code, 400); assert.equal(r.body.detail, 'bad_import_invoice');
  await ok('sebastian', 'PUT', `/api/approvals/${d1}`, { ...base, category_id: catImp, title: `${T} 관세`, orig_sub: 1000, cost_link: { import_shipment_ids: [ship, ship2] } });
  await ok('sebastian', 'POST', `/api/approvals/${d1}/submit`);
  let det = await ok('sebastian', 'GET', `/api/approvals/${d1}`);
  assert.equal(det.doc.status, 'approved');
  assert.equal(det.cost_link.kind, 'import');
  assert.deepEqual(det.cost_link.imports.map((x) => [x.invoice_no, x.cost_ready]), [[`${T}-INV1`, true], [`${T}-INV2`, false]]);
  assert.equal(det.can_edit_meta, true);
  assert.equal((await ok('maria', 'GET', `/api/approvals/${d1}`).catch(() => ({ can_edit_meta: false }))).can_edit_meta ?? false, false);
  // 거래등록 실적으로 집행(예정 → 실적) → 분배 후보에 결재 인보이스·승인 배치가 붙는다
  const p1 = await planOf(d1);
  assert.equal(p1.status, 'plan'); assert.equal(p1.category_code, '5030');
  await q(`UPDATE transactions SET status='actual', account_id=$2 WHERE id=$1`, [p1.id, acc]);
  const F = await import('../src/approvalFinance.js');
  await F.syncApprovalByTxn(q, Number(p1.id), U.christopher.id);
  const cand = await ok('sebastian', 'GET', `/api/import-costs/finance-candidates?q=${T}`);
  const ci = cand.items.find((x) => x.id === Number(p1.id));
  assert.ok(ci && ci.approval, JSON.stringify(ci));
  assert.deepEqual(ci.approval.batch_ids, [batch]);
  assert.deepEqual(ci.approval.pending, [`${T}-INV2`]);

  // ── ② 운반비: 고객 2곳 인보이스 → 예정 거래에 균등 배분 · 혼적이라 고객 NULL
  const d2 = (await ok('sebastian', 'POST', '/api/approvals', { ...base, category_id: catFr, title: `${T} 배송`, orig_sub: 901 })).id;
  r = await call('sebastian', 'POST', `/api/approvals/${d2}/submit`);
  assert.equal(r.body.detail, 'freight_link_required');
  await ok('sebastian', 'PUT', `/api/approvals/${d2}`, { ...base, category_id: catFr, title: `${T} 배송`, orig_sub: 901, cost_link: { freight_invoice_ids: [i1, i2] } });
  await ok('sebastian', 'POST', `/api/approvals/${d2}/submit`);
  let p2 = await planOf(d2);
  assert.equal(p2.category_code, '6160');
  assert.equal(p2.customer_id, null);
  assert.deepEqual(p2.inv.map(Number), [i1, i2]);
  assert.equal(Number(p2.alloc_sum), 901);
  // 디렉터 수정: 공통 운반비로 → 태그 제거
  let m = await ok('sebastian', 'PUT', `/api/approvals/${d2}/meta`, { cost_link: { freight_common: true }, reason: '공통으로' });
  assert.deepEqual(m.changes.map((c) => c.field), ['cost_link']);
  p2 = await planOf(d2);
  assert.deepEqual(p2.inv, []); assert.equal(p2.customer_id, null);
  // 한 고객 인보이스로 → 고객 확정 + 배분 1행
  await ok('sebastian', 'PUT', `/api/approvals/${d2}/meta`, { cost_link: { freight_invoice_ids: [i1] } });
  p2 = await planOf(d2);
  assert.equal(Number(p2.customer_id), cu1); assert.deepEqual(p2.inv.map(Number), [i1]);
  // 실적이 된 뒤 거래등록에서 다른 태그(고객 B)를 달았다면 결재 동기화가 덮어쓰지 않는다
  await q(`UPDATE transactions SET status='actual', account_id=$2, customer_id=$3 WHERE id=$1`, [p2.id, acc, cu2]);
  await q(`DELETE FROM transaction_freight_allocations WHERE transaction_id=$1`, [p2.id]);
  await F.syncApprovalByTxn(q, Number(p2.id), U.christopher.id);
  p2 = await planOf(d2);
  assert.equal(p2.status, 'actual'); assert.equal(Number(p2.customer_id), cu2, '실적 태그 보존');

  // ── ③ 완료 문서 카테고리·제목 수정(디렉터) → 실적 계정과목도 변경 · 운반비 태그 정리 · 수정 이력
  r = await call('maria', 'PUT', `/api/approvals/${d2}/meta`, { title: 'x' });
  assert.ok([403, 404].includes(r.code), String(r.code));
  r = await call('sebastian', 'PUT', `/api/approvals/${d2}/meta`, { category_id: catImp, title: `${T} 배송(관세 정정)`, reason: '오분류' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.changes.map((c) => c.field).sort(), ['category', 'cost_link', 'title']);
  assert.equal(r.body.recategorized, 1);
  p2 = await planOf(d2);
  assert.equal(p2.category_code, '5030'); assert.equal(p2.customer_id, null); assert.deepEqual(p2.inv, []);
  det = await ok('sebastian', 'GET', `/api/approvals/${d2}`);
  assert.equal(det.doc.title, `${T} 배송(관세 정정)`);
  assert.equal(det.cost_link.kind, 'import'); assert.equal(det.cost_link.freight, null);
  assert.equal(det.revisions.length, 3, '연결 2회 + 카테고리·제목 1회');
  assert.ok(det.events.some((e) => e.action === 'fin_recat'));
  // 거래등록에서 따로 고친 실적(옛 과목과 다름)은 건드리지 않는다
  await q(`UPDATE transactions SET category_code='6130' WHERE id=$1`, [p2.id]);
  r = await ok('sebastian', 'PUT', `/api/approvals/${d2}/meta`, { category_id: catFr });
  assert.equal(r.recategorized, 0);
  assert.equal((await planOf(d2)).category_code, '6130');

  // ── ④ 임시저장은 meta 불가 · 재기안이 연결을 복사
  const d3 = (await ok('sebastian', 'POST', '/api/approvals', { ...base, category_id: catImp, title: `${T} 재기안`, orig_sub: 50, cost_link: { import_shipment_ids: [ship] } })).id;
  r = await call('sebastian', 'PUT', `/api/approvals/${d3}/meta`, { title: 'x' });
  assert.equal(r.code, 409);
  // 카테고리를 기타로 바꿔 저장하면 수입 인보이스 선택은 정리된다
  await ok('sebastian', 'PUT', `/api/approvals/${d3}`, { ...base, category_id: catEtc, title: `${T} 재기안`, orig_sub: 50 });
  assert.equal((await ok('sebastian', 'GET', `/api/approvals/${d3}`)).cost_link.imports.length, 0);
  await q(`UPDATE approval_documents SET category_id=$2, import_shipment_ids=$3, status='rejected' WHERE id=$1`, [d3, catImp, [ship]]);
  const nd = (await ok('sebastian', 'POST', `/api/approvals/${d3}/resubmit`)).id;
  assert.deepEqual((await ok('sebastian', 'GET', `/api/approvals/${nd}`)).cost_link.import_shipment_ids, [ship]);
  // 다른 테스트가 categories[0] 을 쓰므로 고정 카테고리는 끝나면 비활성
  await q(`UPDATE approval_categories SET active=false WHERE name LIKE $1`, [`${T} %`]);
  await app.close();
});
