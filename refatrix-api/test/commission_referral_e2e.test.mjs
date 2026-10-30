// =====================================================================
// 0307 소개(Referencia) 커미션 — 순수 규칙 + 실제 PostgreSQL 종단 검증
//   실행: TEST_PG_URL=postgres://... node --test test/commission_referral_e2e.test.mjs   (전체 migrate 후)
//   흐름: 디렉터 계약 등록 → 서류 업로드(완비일) → A 손서명+PIN → B 매출 완납 → A 실적 화면
//         → 월 확정 → 지급(A 본인 커미션 + 소개 커미션 한 전표) → B 매출 NC → 다음 달 차감
//         → 전자결재 문서(스냅샷에 소개 커미션) → 승인 → 수령증 → 마감
//   날짜: 효력일이 「오늘」(서류 완비·서명) 이후이므로 수금일은 오늘 기준 다음 달·다다음 달로 만든다.
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
const SKIP = !PG;

const RF = await import('../src/commissionReferral.js');
const CA = await import('../src/commissionApproval.js');

after(async () => {
  if (!PG) return;
  const { pool } = await import('../src/db.js');
  await pool.end().catch(() => {});
  setTimeout(() => process.exit(process.exitCode || 0), 300);
});

// ── 순수 규칙 ──────────────────────────────────────────────────────────
test('P1 필수 서류 · 완비일 · 기한 경고', () => {
  assert.equal(RF.requiredDocs('fisica').length, 7);
  assert.equal(RF.requiredDocs('moral').length, 9);
  const base = [
    { id: 1, party: 'referred', doc_type: 'csf', issued_date: '2026-10-01', uploaded_on: '2026-10-20' },
    { id: 2, party: 'referred', doc_type: 'domicilio', issued_date: '2026-05-01', uploaded_on: '2026-10-21' },   // 3개월 초과 → stale
    { id: 3, party: 'referred', doc_type: 'ine', uploaded_on: '2026-10-21' },
    { id: 4, party: 'referrer', doc_type: 'csf', uploaded_on: '2026-10-22' },
    { id: 5, party: 'referrer', doc_type: 'domicilio', uploaded_on: '2026-10-22' },
    { id: 6, party: 'referrer', doc_type: 'ine', uploaded_on: '2026-10-22' },
  ];
  let s = RF.docsStatus(base, 'fisica');
  assert.equal(s.complete, false); assert.equal(s.missing, 1); assert.equal(s.complete_on, null);
  assert.equal(s.items.find((x) => x.type === 'domicilio' && x.party === 'referred').stale, true);
  assert.equal(s.items.find((x) => x.type === 'csf' && x.party === 'referred').stale, false);
  s = RF.docsStatus([...base, { id: 7, party: 'referrer', doc_type: 'banco', uploaded_on: '2026-10-25' }], 'fisica');
  assert.equal(s.complete, true); assert.equal(s.complete_on, '2026-10-25');
  assert.equal(RF.docsStatus([...base, { id: 7, party: 'referrer', doc_type: 'banco', uploaded_on: '2026-10-25' }], 'moral').missing, 2, '법인은 정관·위임장 추가');
});

test('P2 효력일 = max(시작일, 서류 완비일, 첫 서명일) · 하나라도 없으면 null', () => {
  assert.equal(RF.effectiveFrom({ start_date: '2026-11-01', docs_complete_on: '2026-10-25', first_signed_on: '2026-10-29' }), '2026-11-01');
  assert.equal(RF.effectiveFrom({ start_date: '2026-10-01', docs_complete_on: '2026-10-25', first_signed_on: '2026-10-29' }), '2026-10-29');
  assert.equal(RF.effectiveFrom({ start_date: '2026-10-01', docs_complete_on: null, first_signed_on: '2026-10-29' }), null);
  assert.equal(RF.effectiveFrom({ start_date: '2026-10-01', docs_complete_on: '2026-10-25', first_signed_on: null }), null);
});

test('P3 인보이스별 판정 — B 커미션 있음 + 완납 + 효력 기간 안 = 1%', () => {
  const ctx = { rate: 1, effective: '2026-11-01', end: null };
  const full = { mode: 'invoice', expected: 400, base: 10000, collected_base: 10000, fullyPaid: true, accrued: 400, potential: 0 };
  assert.deepEqual(RF.computeReferralLine(full, { last_pay_date: '2026-11-05' }, ctx), { status: 'confirmed', base: 10000, amount: 100, settleYm: '2026-11', b_earns: true });
  assert.equal(RF.computeReferralLine(full, { last_pay_date: '2026-10-31' }, ctx).status, 'before');
  assert.equal(RF.computeReferralLine(full, { last_pay_date: '2027-02-01' }, { ...ctx, end: '2027-01-31' }).status, 'after_end');
  assert.equal(RF.computeReferralLine(full, { last_pay_date: '2026-11-05' }, { ...ctx, effective: null }).status, 'inactive');
  assert.equal(RF.computeReferralLine({ ...full, expected: 0 }, { last_pay_date: '2026-11-05' }, ctx).status, 'none', 'B 가 커미션을 못 받으면 A 도 없음');
  const open = RF.computeReferralLine({ ...full, fullyPaid: false }, { last_pay_date: null }, ctx);
  assert.equal(open.status, 'pending'); assert.equal(open.potential, 100);
  // 수금일 판정: 기간 안 수금분이 기준
  const pm = RF.computeReferralLine({ mode: 'payment', expected: 160, base: 8000, collected_base: 4000, fullyPaid: true, accrued: 160, potential: 0 }, { last_pay_date: '2026-11-20' }, ctx);
  assert.equal(pm.base, 4000); assert.equal(pm.amount, 40);
  // 지급분은 동결
  assert.deepEqual(RF.computeReferralLine(full, { last_pay_date: '2026-11-05', rp_paid: true, rp_amount: '99.5', rp_settle_ym: '2026-11' }, { ...ctx, rate: 2 }).amount, 99.5);
});

test('P4 지급 후 차감 — 매출 감소만 · 지급 당시 실효율', () => {
  assert.deepEqual(RF.computeReferralAdjustment({ paid_amount: 100, paid_base: 10000, cur_base: 8000, nc_base: 2000 }),
    { amount: -20, new_amount: 80, new_base: 8000, paid_amount: 100, paid_base: 10000, reason: 'nota_credito' });
  assert.equal(RF.computeReferralAdjustment({ paid_amount: 100, paid_base: 10000, cur_base: 0, deleted: true }).amount, -100);
  assert.equal(RF.computeReferralAdjustment({ paid_amount: 100, paid_base: 10000, cur_base: 12000 }), null, '증가는 추가 지급 없음');
  assert.equal(RF.computeReferralAdjustment({ paid_amount: 100, paid_base: 10000, cur_base: 10000 }), null);
});

test('P5 계약서 — 15개 조항 · B 정보 · 율 · 시작일 · 조건이 바뀌면 버전이 바뀜', () => {
  const ref = { id: 9, referrer_id: 1, referred_id: 2, rate: 1, start_date: '2026-11-01', end_date: null,
    referred_info: { name: 'Ricardo Gómez', rfc: 'gotr850312ab1', address: 'Av. Constitución 1234, Monterrey', phone: '+52 81 1234 5678', email: 'r@x.mx', persona: 'fisica' } };
  const t = RF.buildReferralTerms(ref, { referrerName: 'Juan Pérez', company: { emisor: 'REFATRIX SA DE CV', rfc: 'RFX010101AAA' } });
  const d = RF.buildReferralDoc(t);
  assert.equal(d.sections.filter((x) => /^(Primera|Segunda|Tercera|Cuarta|Quinta|Sexta|Séptima|Octava|Novena|Décima)/.test(x.title)).length, 15);
  const all = JSON.stringify(d);
  for (const k of ['Ricardo Gómez', 'GOTR850312AB1', 'Av. Constitución 1234', '+52 81 1234 5678', '1% (uno por ciento)', '1 de noviembre de 2026', 'Juan Pérez', 'REFATRIX SA DE CV', 'día 15', 'CFDI', 'artículos 89', 'Monterrey']) assert.ok(all.includes(k), k);
  assert.ok(d.declaration.includes(d.version));
  const t2 = RF.buildReferralTerms({ ...ref, rate: 1.5 }, { referrerName: 'Juan Pérez', company: { emisor: 'REFATRIX SA DE CV', rfc: 'RFX010101AAA' } });
  assert.notEqual(RF.referralHash(t2), d.version);
  assert.equal(RF.referralHash(RF.buildReferralTerms(ref, { referrerName: 'Juan Pérez', company: { emisor: 'REFATRIX SA DE CV', rfc: 'RFX010101AAA' } })), d.version, '같은 조건 = 같은 버전');
});

test('P6 입력·서명 검증', () => {
  assert.equal(RF.validateReferral({ referrer_id: 1, referred_id: 1, start_date: '2026-11-01', referred_info: { name: 'x' } }).error, 'same_user');
  assert.equal(RF.validateReferral({ referrer_id: 1, referred_id: 2, start_date: '2026-11-01', referred_info: {} }).error, 'name_required');
  assert.equal(RF.validateReferral({ referrer_id: 1, referred_id: 2, start_date: '2026-11-01', end_date: '2026-10-01', referred_info: { name: 'x' } }).error, 'end_before_start');
  const v = RF.validateReferral({ referrer_id: 1, referred_id: 2, start_date: '2026-11-01', referred_info: { name: ' B ', rfc: 'abc' } });
  assert.equal(v.ok, true); assert.equal(v.value.rate, 1, '기본 1%'); assert.equal(v.value.referred_info.rfc, 'ABC');
  assert.equal(RF.decodeSignature('').error, 'signature_required');
  assert.equal(RF.decodeSignature('data:image/png;base64,' + Buffer.alloc(50).toString('base64')).error, 'signature_empty');
  assert.equal(RF.decodeSignature('data:image/png;base64,' + Buffer.alloc(300, 1).toString('base64')).error, 'signature_bad');
});

test('P7 결재 스냅샷 — 소개 커미션 합계·비교 · 이전 스냅샷 호환', () => {
  const L1 = { invoice_id: 11, sat_no: 'A-1', inv_date: '2026-11-02', customer_name: 'C', basis: 'collection', mode: 'invoice', rate: 3, base: 10000, collected_base: 10000, paid_amount: 11600, last_pay_date: '2026-11-10', expected: 300 };
  const R1 = { referral_id: 5, invoice_id: 21, sat_no: 'B-1', inv_date: '2026-11-03', customer_name: 'D', referred_name: 'Ricardo', last_pay_date: '2026-11-12', base: 10000, rate: 1, amount: 100 };
  const s = CA.buildSnapshot({ agentId: 1, agentName: 'Juan', settleYm: '2026-11', lines: [L1], referrals: [R1], referralAdjustments: [{ payout_id: 1, referral_id: 5, invoice_id: 20, amount: -20, paid_base: 10000, new_base: 8000, paid_amount: 100 }] });
  assert.equal(s.commission_total, 300); assert.equal(s.referral_total, 100); assert.equal(s.referral_adjustment_total, -20); assert.equal(s.total, 380);
  assert.equal(s.referral_count, 1);
  assert.match(CA.bodyNodes(s).map((x) => x.v).join('\n'), /소개 커미션 1건 MXN 100\.00/);
  assert.equal(CA.compareSnapshot(s, s).ok, true);
  const changed = CA.compareSnapshot(s, CA.buildSnapshot({ agentId: 1, settleYm: '2026-11', lines: [L1], referrals: [{ ...R1, amount: 90 }], referralAdjustments: [{ amount: -20 }] }));
  assert.equal(changed.ok, false); assert.match(changed.diffs.join(' '), /소개 커미션 B-1 100 → 90/);
  const old = CA.buildSnapshot({ agentId: 1, settleYm: '2026-11', lines: [L1] }); delete old.referrals; delete old.referral_adjustment_total;
  assert.equal(CA.compareSnapshot(old, CA.buildSnapshot({ agentId: 1, settleYm: '2026-11', lines: [L1] })).ok, true, '0307 전 스냅샷과 비교해도 같음');
});

// ── 실제 PostgreSQL 종단 ───────────────────────────────────────────────
const TAG = 'RFTEST';
let app, query;
const ID = {}; const T = {};
// 1×1 투명 PNG 는 너무 작다(빈 서명 거부) → 400×120 짜리 선 하나 PNG 를 만든다
import { deflateSync } from 'node:zlib';
function pngLine() {
  const w = 400, h = 120; const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; const on = Math.abs(y - 60 - Math.round(20 * Math.sin(x / 30))) < 2; raw[o] = 20; raw[o + 1] = 20; raw[o + 2] = 20; raw[o + 3] = on ? 255 : 0; } }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const SIG = pngLine();
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% test\n').toString('base64');
const pdfN = (n) => 'data:application/pdf;base64,' + Buffer.from(`%PDF-1.4\n% test ${n}\n`).toString('base64');
const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// 오늘(멕시코) 기준 다음 달 · 다다음 달
const todayMx = new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
const addM = (ym, n) => { let [y, m] = ym.split('-').map(Number); m += n; while (m > 12) { m -= 12; y += 1; } return `${y}-${String(m).padStart(2, '0')}`; };
const YM0 = todayMx.slice(0, 7), YM1 = addM(YM0, 1), YM2 = addM(YM0, 2);
const START = `${addM(YM0, -2)}-01`;   // 계약 시작일 = 두 달 전 1일 (효력일은 서명·서류일인 오늘)

async function call(who, method, url, payload) {
  const res = await app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + T[who], 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0' } });
  let body = null; try { body = res.json(); } catch { body = res.body; }
  return { code: res.statusCode, body };
}
async function ok(...a) { const r = await call(...a); assert.ok(r.code < 300, `${a[1]} ${a[2]} → ${r.code} ${JSON.stringify(r.body).slice(0, 400)}`); return r.body; }

async function cleanup() {
  const U = `(SELECT id FROM users WHERE login_id LIKE 'rftest%')`;
  const D = `(SELECT id FROM approval_documents WHERE drafter_id IN ${U})`;
  const R = `(SELECT id FROM commission_referrals WHERE referrer_id IN ${U} OR referred_id IN ${U})`;
  await query(`DELETE FROM commission_referral_adjustments WHERE payout_id IN (SELECT id FROM commission_referral_payouts WHERE referral_id IN ${R})`);
  await query(`DELETE FROM commission_referral_payouts WHERE referral_id IN ${R}`);
  await query(`ALTER TABLE commission_referral_signatures DISABLE TRIGGER trg_comm_referral_sig_immutable`);
  await query(`DELETE FROM commission_referral_signatures WHERE referral_id IN ${R}`);
  await query(`ALTER TABLE commission_referral_signatures ENABLE TRIGGER trg_comm_referral_sig_immutable`);
  await query(`DELETE FROM commission_referral_docs WHERE referral_id IN ${R}`);
  await query(`DELETE FROM commission_referrals WHERE id IN ${R}`);
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
  await query(`DELETE FROM notas_credito WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE memo LIKE '%${TAG}%')`);
  await query(`DELETE FROM sales_payment_allocations WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE memo LIKE '%${TAG}%')`);
  await query(`DELETE FROM sales_payments WHERE memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM sales_invoices WHERE memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM bonus_payouts WHERE user_id IN ${U} OR confirmed_by IN ${U} OR updated_by IN ${U}`);
  await query(`DELETE FROM commission_batches WHERE settle_ym IN ($1,$2) OR confirmed_by IN ${U}`, [YM1, YM2]);
  await query(`DELETE FROM audit_log WHERE user_id IN ${U}`);
  await query(`DELETE FROM user_page_access WHERE user_id IN ${U}`);
  await query(`DELETE FROM customers WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM accounts WHERE name LIKE '${TAG}%'`);
  await query(`UPDATE approval_settings SET director_user_id=NULL, ceo_user_id=NULL, finance_user_id=NULL WHERE director_user_id IN ${U} OR ceo_user_id IN ${U} OR finance_user_id IN ${U}`);
  await query(`DELETE FROM users WHERE login_id LIKE 'rftest%'`);
}

let custA, custB, acc;
const inv = async (sat, cust, date, sub) => Number((await query(
  `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn, status, owner_id, memo, created_by)
   VALUES ($1,$2,$3,30,$3::date+30,$4,$5,$6,'posted',$7,$8,$7) RETURNING id`, [sat, cust, date, sub, sub * 0.16, sub * 1.16, ID.dir, `${TAG} ${sat}`])).rows[0].id);
const pay = async (cust, date, invId, amt) => {
  const p = Number((await query(`INSERT INTO sales_payments (customer_id, pay_date, account_id, amount, memo, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [cust, date, acc, amt, `${TAG} ${date}`, ID.dir])).rows[0].id);
  await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount) VALUES ($1,$2,$3)`, [p, invId, amt]);
};

test('E0 준비 — 디렉터·재무·대표·A·B·제3자 · B 고객 · A 고객 · 커미션 기간', { skip: SKIP }, async () => {
  ({ query } = await import('../src/db.js'));
  const { hashPin } = await import('../src/auth.js');
  const { buildApp } = await import('../src/server.js');
  app = buildApp(); await app.ready();
  await cleanup();
  const mk = async (name, role, login) => Number((await query(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,$3,$4) RETURNING id`, [name, role, hashPin('2468'), login])).rows[0].id);
  ID.dir = await mk(`${TAG}Sebastian`, 'director', 'rftest_dir');
  ID.fin = await mk(`${TAG}Christopher`, 'treasury', 'rftest_fin');
  ID.ceo = await mk(`${TAG}Jang`, 'socio', 'rftest_ceo');
  ID.A = await mk(`${TAG}Juan`, 'sales', 'rftest_a');
  ID.B = await mk(`${TAG}Ricardo`, 'sales', 'rftest_b');
  ID.X = await mk(`${TAG}Otro`, 'sales', 'rftest_x');
  for (const u of [ID.fin, ID.A, ID.B, ID.X]) await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'commission','anywhere','edit') ON CONFLICT DO NOTHING`, [u]);
  await query(`UPDATE approval_settings SET director_user_id=$1, ceo_user_id=$2, finance_user_id=$3, ceo_pre_threshold=100000 WHERE id=1`, [ID.dir, ID.ceo, ID.fin]);
  for (const k of ['dir', 'fin', 'ceo', 'A', 'B', 'X']) T[k] = app.jwt.sign({ sub: ID[k] });
  acc = Number((await query(`INSERT INTO accounts (name, type, currency, open_balance, created_by) VALUES ($1,'bank','MXN',0,$2) RETURNING id`, [`${TAG}은행`, ID.dir])).rows[0].id);
  custB = Number((await query(`INSERT INTO customers (name, code, credit_days, owner_id, created_by) VALUES ($1,$2,30,$3,$4) RETURNING id`, [`${TAG}Refaccionaria Águila`, `${TAG}-B`, ID.B, ID.dir])).rows[0].id);
  custA = Number((await query(`INSERT INTO customers (name, code, credit_days, owner_id, created_by) VALUES ($1,$2,30,$3,$4) RETURNING id`, [`${TAG}Cliente de Juan`, `${TAG}-A`, ID.A, ID.dir])).rows[0].id);
  for (const [u, rate] of [[ID.B, 4], [ID.A, 3]]) {
    await query(`INSERT INTO commission_agents (user_id, default_rate, active, created_by, updated_by) VALUES ($1,$2,true,$3,$3)`, [u, rate, ID.dir]);
    await query(`INSERT INTO commission_agent_periods (user_id, start_date, end_date, basis, rate, match_on, created_by, updated_by) VALUES ($1,'2026-01-01',NULL,'collection',$2,'invoice',$3,$3)`, [u, rate, ID.dir]);
  }
});

test('E1 계약 등록 — 디렉터만 · 같은 B 중복 금지 · A 는 /me 에서 계약서를 본다', { skip: SKIP }, async () => {
  const body = { referrer_id: ID.A, referred_id: ID.B, rate: 1, start_date: START,
    referred_info: { name: 'Ricardo Gómez Treviño', rfc: 'GOTR850312AB1', address: 'Av. Constitución 1234, Monterrey, N.L.', phone: '+52 81 1234 5678', email: 'ricardo@ejemplo.mx', persona: 'fisica' } };
  assert.equal((await call('A', 'POST', '/api/commission/referrals', body)).code, 403);
  assert.equal((await call('fin', 'POST', '/api/commission/referrals', body)).code, 403);
  assert.equal((await call('dir', 'POST', '/api/commission/referrals', { ...body, referred_info: {} })).body.error, 'name_required');
  const c = await ok('dir', 'POST', '/api/commission/referrals', body);
  ID.ref = c.item.id;
  assert.equal(c.item.rate, 1); assert.equal(c.item.sign_status, 'pending'); assert.equal(c.item.docs.complete, false); assert.equal(c.item.effective_from, null);
  assert.equal((await call('dir', 'POST', '/api/commission/referrals', { ...body, referrer_id: ID.X })).body.error, 'already_referred');
  const me = await ok('A', 'GET', '/api/commission/referrals/me');
  assert.equal(me.items.length, 1);
  const doc = me.items[0].doc;
  assert.match(JSON.stringify(doc), /Ricardo Gómez Treviño/); assert.match(JSON.stringify(doc), /GOTR850312AB1/);
  ID.ver = me.items[0].version;
  assert.equal((await ok('B', 'GET', '/api/commission/referrals/me')).items.length, 0, 'B 는 소개자가 아님');
  assert.equal((await ok('X', 'GET', '/api/commission/referrals')).items.length, 0, '제3자에게 안 보임');
  assert.equal((await ok('fin', 'GET', '/api/commission/referrals')).items.length >= 1, true, '재무는 전체 열람');
  assert.equal((await call('X', 'GET', `/api/commission/referrals/${ID.ref}/performance`)).code, 404);
  assert.equal((await call('B', 'GET', `/api/commission/referrals/${ID.ref}/performance`)).code, 404);
});

test('E2 전자서명 — 서명·PIN·버전 검증 · 기록 수정 불가', { skip: SKIP }, async () => {
  const u = `/api/commission/referrals/${ID.ref}/sign`;
  assert.equal((await call('X', 'POST', u, { agree: true, pin: '2468', version: ID.ver, signature: SIG })).code, 403);
  assert.equal((await call('A', 'POST', u, { agree: false, pin: '2468', version: ID.ver, signature: SIG })).body.error, 'agree_required');
  assert.equal((await call('A', 'POST', u, { agree: true, pin: '2468', version: ID.ver, signature: PNG1 })).body.error, 'signature_empty');
  assert.equal((await call('A', 'POST', u, { agree: true, pin: '2468', version: 'zzz', signature: SIG })).body.error, 'version_changed');
  assert.equal((await call('A', 'POST', u, { agree: true, pin: '0000', version: ID.ver, signature: SIG })).body.error, 'bad_pin');
  const s = await ok('A', 'POST', u, { agree: true, pin: '2468', version: ID.ver, signature: SIG });
  ID.sig = s.id; assert.equal(s.version, ID.ver); assert.equal(s.device, 'Chrome / Android');
  const g = await ok('A', 'GET', `/api/commission/referrals/signatures/${ID.sig}`);
  assert.equal(g.signature, SIG); assert.equal(g.ip, null, '본인에게 IP 비공개'); assert.match(JSON.stringify(g.doc), /Ricardo Gómez Treviño/);
  assert.ok((await ok('dir', 'GET', `/api/commission/referrals/signatures/${ID.sig}`)).ip !== undefined);
  assert.equal((await call('X', 'GET', `/api/commission/referrals/signatures/${ID.sig}`)).code, 403);
  await assert.rejects(query(`UPDATE commission_referral_signatures SET version_hash='x' WHERE id=$1`, [ID.sig]), /수정·삭제할 수 없습니다/);
  const me = await ok('A', 'GET', '/api/commission/referrals/me');
  assert.equal(me.items[0].sign_status, 'signed'); assert.equal(me.items[0].effective_from, null, '서류 미완비 → 아직 효력 없음');
});

test('E3 서류 — 완비되면 효력일 = 오늘 · 삭제되면 비워짐 · 파일 열람 권한', { skip: SKIP }, async () => {
  const up = (party, doc_type, n, extra = {}) => call('dir', 'POST', `/api/commission/referrals/${ID.ref}/docs`, { party, doc_type, file_name: `${party}_${doc_type}.pdf`, data_url: pdfN(n), ...extra });
  // 0309: 소개자(A)도 자기 계약 서류를 올릴 수 있다 → 제3자(X)만 막힌다
  assert.equal((await call('X', 'POST', `/api/commission/referrals/${ID.ref}/docs`, { party: 'referrer', doc_type: 'csf', file_name: 'a.pdf', data_url: PDF })).code, 403);
  assert.equal((await up('referred', 'banco', 99)).body.error, 'bad_doc_type');
  let i = 0;
  for (const t of ['csf', 'domicilio', 'ine']) assert.ok((await up('referred', t, ++i, t === 'csf' ? { issued_date: todayMx } : {})).code < 300);
  for (const t of ['csf', 'domicilio', 'ine']) assert.ok((await up('referrer', t, ++i)).code < 300);
  assert.equal((await up('referrer', 'ine', 3)).body.error, 'duplicate');
  let st = (await ok('dir', 'GET', `/api/commission/referrals?referrer_id=${ID.A}`)).items[0];
  assert.equal(st.docs.complete, false); assert.equal(st.docs_complete_on, null);
  const last = await up('referrer', 'banco', ++i);
  assert.ok(last.code < 300); assert.equal(last.body.docs_complete_on, todayMx);
  ID.bancoDoc = last.body.id;
  st = last.body.item;
  assert.equal(st.docs.complete, true); assert.equal(st.effective_from, todayMx < START ? START : todayMx);
  // A 는 자기 서류만 연다 · B 서류는 디렉터만
  const bDoc = st.docs.items.find((x) => x.party === 'referred' && x.type === 'csf').doc.id;
  assert.equal((await call('A', 'GET', `/api/commission/referrals/docs/${bDoc}/file`)).code, 403);
  assert.equal((await call('A', 'GET', `/api/commission/referrals/docs/${ID.bancoDoc}/file`)).code, 200);
  assert.equal((await call('dir', 'GET', `/api/commission/referrals/docs/${bDoc}/file`)).code, 200);
  // 삭제 → 미완비 → 다시 올리면 오늘로 완비
  assert.equal((await ok('dir', 'DELETE', `/api/commission/referrals/docs/${ID.bancoDoc}`)).docs_complete_on, null);
  const again = await up('referrer', 'banco', 777);
  assert.equal(again.body.docs_complete_on, todayMx);
  const me = (await ok('A', 'GET', '/api/commission/referrals/me')).items[0];
  assert.equal(me.files, undefined, 'A 에게 파일 목록(내용) 없음');
  assert.equal(me.docs.items.find((x) => x.party === 'referred' && x.type === 'csf').doc.file_name, null, 'B 서류 파일명도 비공개');
});

test('E4 B 매출 → A 실적 화면 — 완납·미수·효력일 전 · 공개 범위', { skip: SKIP }, async () => {
  // 효력일 전(지난달) 완납: 대상 아님
  ID.b0 = await inv('RF-B0', custB, `${addM(YM0, -1)}-03`, 2000); await pay(custB, `${addM(YM0, -1)}-20`, ID.b0, 2320);
  // 다음 달 완납: 10,000 → 1% = 100
  ID.b1 = await inv('RF-B1', custB, `${YM1}-02`, 10000); await pay(custB, `${YM1}-10`, ID.b1, 11600);
  // 다음 달 발행 · 일부 수금: 대기(5,000 → 50 예정)
  ID.b2 = await inv('RF-B2', custB, `${YM1}-05`, 5000); await pay(custB, `${YM1}-20`, ID.b2, 1000);
  // A 본인 고객: 다음 달 완납 4,000 × 3% = 120
  ID.a1 = await inv('RF-A1', custA, `${YM1}-04`, 4000); await pay(custA, `${YM1}-15`, ID.a1, 4640);
  const p = await ok('A', 'GET', `/api/commission/referrals/${ID.ref}/performance`);
  const by = Object.fromEntries(p.lines.map((l) => [l.sat_no, l]));
  assert.equal(by['RF-B0'].status, 'before');
  assert.equal(by['RF-B1'].status, 'confirmed'); assert.equal(by['RF-B1'].amount, 100); assert.equal(by['RF-B1'].settle_ym, YM1); assert.equal(by['RF-B1'].pay_date, `${YM2}-15`);
  assert.equal(by['RF-B2'].status, 'pending'); assert.equal(by['RF-B2'].potential, 50); assert.equal(by['RF-B2'].paid_pct, 17.2);
  assert.equal(by['RF-A1'], undefined, 'A 본인 매출은 소개 실적에 없음');
  const m = p.months.find((x) => x.ym === YM1);
  assert.equal(m.sales, 15000); assert.equal(m.collected, 10000); assert.equal(m.commission, 100); assert.equal(m.unpaid, 100);
  assert.equal(p.customers.length, 1); assert.equal(p.customers[0].customer_name, `${TAG}Refaccionaria Águila`);
  assert.equal(p.totals.potential, 50);
  // 공개 범위: 원가·마진·할인 관련 키 없음
  const keys = new Set(p.lines.flatMap((l) => Object.keys(l)));
  for (const k of ['cost', 'cogs', 'margin', 'discount', 'cost_mxn', 'profit']) assert.equal(keys.has(k), false, k);
  assert.equal(JSON.stringify(p).includes('pin_hash'), false);
});

test('E5 월 확정 → 지급 대상에 소개 커미션 포함 → 한 전표로 지급', { skip: SKIP }, async () => {
  await ok('dir', 'POST', `/api/commission/batches/${YM1}/confirm`);
  const batches = await ok('dir', 'GET', '/api/commission/batches');
  const b = batches.items.find((x) => x.settle_ym === YM1);
  // 배치(전 사원 합계)에 소개 커미션이 들어간다 — 다른 테스트 데이터가 같은 달에 있을 수 있어 이 테스트 몫만 본다.
  //   A 120 + 소개 100 + B 본인 400(10,000×4%) = 620 이상 · 소개 몫(소개자 A) = 100
  assert.ok(b.confirmed >= 620, String(b.confirmed));
  const { confirmedReferralMonthLines } = await import('../src/commissionReferralData.js');
  const refMonth = (await confirmedReferralMonthLines()).filter((l) => l.settle_ym === YM1 && Number(l.owner_id) === ID.A);
  assert.deepEqual(refMonth.map((l) => [l.expected, l.paid]), [[100, false]]);
  const pa = await ok('fin', 'GET', `/api/commission/payable?agent_id=${ID.A}&settle_ym=${YM1}`);
  assert.equal(pa.commission_total, 120); assert.equal(pa.referral_total, 100); assert.equal(pa.total, 220);
  assert.equal(pa.referrals.length, 1); assert.equal(pa.referrals[0].sat_no, 'RF-B1'); assert.equal(pa.referrals[0].referred_name, 'Ricardo Gómez Treviño');
  const mine = await ok('A', 'GET', `/api/commission/payable?settle_ym=${YM1}`);
  assert.equal(mine.total, 220, 'A 본인도 자기 지급 대상(소개 포함)을 본다');
  // 너무 작은 금액(커미션 120 만) → 소개 커미션은 다음으로 — 부분 충당 없음 → 금액 220 으로 등록
  const r = await ok('fin', 'POST', '/api/commission/payments', { agent_id: ID.A, settle_ym: YM1, amount: 220, evidence: PNG1, paid_date: `${YM2}-15` });
  assert.equal(r.settled, 220); assert.equal(r.referral_count, 1); assert.equal(r.referral_settled, 100); assert.equal(r.leftover, 0);
  const rp = (await query(`SELECT amount, base_mxn, rate, settle_ym, paid, to_char(paid_date,'YYYY-MM-DD') AS pd, payment_id FROM commission_referral_payouts WHERE referral_id=$1`, [ID.ref])).rows;
  assert.equal(rp.length, 1); assert.equal(Number(rp[0].amount), 100); assert.equal(Number(rp[0].base_mxn), 10000); assert.equal(rp[0].settle_ym, YM1); assert.equal(rp[0].pd, `${YM2}-15`); assert.equal(Number(rp[0].payment_id), r.payment_id);
  assert.equal(Number((await query(`SELECT settled FROM commission_payments WHERE id=$1`, [r.payment_id])).rows[0].settled), 220);
  const after1 = await ok('fin', 'GET', `/api/commission/payable?agent_id=${ID.A}&settle_ym=${YM1}`);
  assert.equal(after1.referrals.length, 0); assert.equal(after1.total, 0);
  const p = await ok('A', 'GET', `/api/commission/referrals/${ID.ref}/performance`);
  assert.equal(p.lines.find((l) => l.sat_no === 'RF-B1').status, 'paid');
  assert.equal(p.totals.paid, 100);
  // B 의 지급 대상에는 영향 없음(B 본인 400)
  assert.equal((await ok('fin', 'GET', `/api/commission/payable?agent_id=${ID.B}&settle_ym=${YM1}`)).total, 400);
});

test('E6 B 매출 NC → 다음 달 차감 · 전자결재 문서(소개 커미션 포함) → 승인 → 수령증 마감', { skip: SKIP }, async () => {
  // RF-B1 에 NC 2,000(ex-IVA) 적용 → A 차감 −20
  await query(`INSERT INTO notas_credito (invoice_id, customer_id, concepto, total_mxn, base_mxn, iva_mxn, status, created_by, applied_at)
               VALUES ($1,$2,'devolución',2320,2000,320,'applied',$3,now())`, [ID.b1, custB, ID.dir]);
  // RF-B2 다다음 달 완납 → 소개 50
  await pay(custB, `${YM2}-08`, ID.b2, 4800);
  await ok('dir', 'POST', `/api/commission/batches/${YM2}/confirm`);
  const pa = await ok('fin', 'GET', `/api/commission/payable?agent_id=${ID.A}&settle_ym=${YM2}`);
  assert.equal(pa.referral_total, 50); assert.equal(pa.referral_adjustment_total, -20); assert.equal(pa.total, 30);
  assert.equal(pa.referral_adjustments[0].reason, 'nota_credito');
  // 전자결재 문서
  const c = await ok('dir', 'POST', '/api/commission/approval-docs', { agent_id: ID.A, settle_ym: YM2 });
  ID.doc = c.document_id; assert.equal(c.total, 30);
  const det = await ok('dir', 'GET', `/api/approvals/${ID.doc}`);
  assert.equal(det.commission.snapshot.referrals.length, 1); assert.equal(det.commission.snapshot.referral_adjustment_total, -20);
  assert.match(det.doc.body, /소개 커미션 1건 MXN 50\.00/);
  await ok('dir', 'POST', `/api/approvals/${ID.doc}/submit`, {});
  let d = await ok('dir', 'GET', `/api/approvals/${ID.doc}`);
  for (let i = 0; i < 4 && d.doc.status === 'progress'; i++) {
    const pend = d.lines.find((l) => l.status === 'pending');
    const who = ['dir', 'fin', 'ceo'].find((k) => ID[k] === pend.user_id);
    await ok(who, 'POST', `/api/approvals/${ID.doc}/act`, { action: 'approve' });
    d = await ok('dir', 'GET', `/api/approvals/${ID.doc}`);
  }
  assert.equal(d.doc.status, 'approved');
  const s = await ok('fin', 'POST', `/api/commission/approval-docs/${ID.doc}/settle`, { paid_date: `${addM(YM2, 1)}-15`, evidence: PNG1 });
  assert.equal(s.referral_count, 1); assert.equal(s.settled, 30); assert.equal(s.leftover, 0);
  const rows = (await query(`SELECT i.sat_no, rp.amount, rp.base_mxn FROM commission_referral_payouts rp JOIN sales_invoices i ON i.id=rp.invoice_id WHERE rp.referral_id=$1 ORDER BY i.sat_no`, [ID.ref])).rows;
  assert.deepEqual(rows.map((r) => [r.sat_no, Number(r.amount), Number(r.base_mxn)]), [['RF-B1', 80, 8000], ['RF-B2', 50, 5000]]);
  const adj = (await query(`SELECT amount, reason, payment_id FROM commission_referral_adjustments`)).rows.filter((r) => Number(r.payment_id) === s.payment_id);
  assert.deepEqual(adj.map((r) => [Number(r.amount), r.reason]), [[-20, 'nota_credito']]);
  assert.equal((await ok('fin', 'GET', `/api/commission/payable?agent_id=${ID.A}&settle_ym=${YM2}`)).referral_adjustments.length, 0, '차감은 한 번만');
});

test('E6b 대면 서명(0308) — 디렉터 화면에서 B 정보 수정 → A 손서명 + A PIN · 디렉터 PIN 거부 · 재무 불가', { skip: SKIP }, async () => {
  const cur = (await ok('dir', 'GET', `/api/commission/referrals?referrer_id=${ID.A}`)).items[0];
  // 디렉터가 B 정보를 고침 → 버전 변경 → 재서명 필요
  const u = await ok('dir', 'PUT', `/api/commission/referrals/${ID.ref}`, { rate: cur.rate, start_date: cur.start_date, end_date: null,
    referred_info: { ...cur.referred_info, address: 'Av. Reforma 500, Col. Juárez, CDMX, C.P. 06600', legal_rep: 'Lic. Ana Ruiz', persona: 'moral' } });
  assert.equal(u.item.sign_status, 'changed');
  assert.equal(u.item.docs.complete, false, '법인으로 바꾸면 정관·위임장이 추가로 필요');
  const pv = await ok('dir', 'GET', `/api/commission/referrals/${ID.ref}/preview`);
  assert.match(JSON.stringify(pv.doc), /Av\. Reforma 500/);
  const u2 = `/api/commission/referrals/${ID.ref}/sign`;
  const body = { agree: true, version: pv.version, signature: SIG };
  assert.equal((await call('fin', 'POST', u2, { ...body, pin: '2468' })).code, 403, '재무는 대면 서명 불가');
  // 디렉터 PIN 이 아니라 A 의 PIN — A 의 PIN 을 바꿔 두고 디렉터 PIN(2468)으로 시도 → 거부
  const { hashPin } = await import('../src/auth.js');
  await query(`UPDATE users SET pin_hash=$2 WHERE id=$1`, [ID.A, hashPin('1357')]);
  const bad = await call('dir', 'POST', u2, { ...body, pin: '2468' });
  assert.equal(bad.body.error, 'bad_pin'); assert.match(bad.body.note, /RFTESTJuan/);
  const s = await ok('dir', 'POST', u2, { ...body, pin: '1357' });
  assert.equal(s.in_person, true); assert.equal(s.version, pv.version);
  const row = (await query(`SELECT user_id, captured_by FROM commission_referral_signatures WHERE id=$1`, [s.id])).rows[0];
  assert.equal(Number(row.user_id), ID.A, '서명자는 A'); assert.equal(Number(row.captured_by), ID.dir, '받은 화면 = 디렉터');
  const g = await ok('A', 'GET', `/api/commission/referrals/signatures/${s.id}`);
  assert.equal(g.captured_by_name, `${TAG}Sebastian`); assert.equal(g.signer_name, `${TAG}Juan`);
  assert.equal((await ok('A', 'GET', '/api/commission/referrals/me')).items[0].sign_status, 'signed');
  // A 의 자기 화면 서명은 captured_by 가 비어 있다(E2)
  assert.equal((await query(`SELECT captured_by FROM commission_referral_signatures WHERE id=$1`, [ID.sig])).rows[0].captured_by, null);
  await query(`UPDATE users SET pin_hash=$2 WHERE id=$1`, [ID.A, hashPin('2468')]);
});

test('E7 조건 변경 → 재서명 필요(지급은 막지 않음) · 해지 → A 화면에서 사라짐', { skip: SKIP }, async () => {
  const cur = (await ok('dir', 'GET', `/api/commission/referrals?referrer_id=${ID.A}`)).items[0];
  const u = await ok('dir', 'PUT', `/api/commission/referrals/${ID.ref}`, { rate: 1.5, start_date: cur.start_date, end_date: null, referred_info: cur.referred_info });
  assert.equal(u.item.sign_status, 'changed'); assert.notEqual(u.item.version, ID.ver);
  assert.equal(u.item.effective_from, cur.effective_from, '효력일은 첫 서명 기준 유지');
  const pv = await ok('fin', 'GET', `/api/commission/referrals/${ID.ref}/preview`);
  assert.match(JSON.stringify(pv.doc), /1\.5%/);
  assert.equal((await call('A', 'GET', `/api/commission/referrals/${ID.ref}/preview`)).code, 403);
  await ok('dir', 'POST', `/api/commission/referrals/${ID.ref}/deactivate`);
  assert.equal((await ok('A', 'GET', '/api/commission/referrals/me')).items.length, 0);
  assert.equal((await call('A', 'GET', `/api/commission/referrals/${ID.ref}/performance`)).code, 404);
  assert.equal((await ok('dir', 'GET', `/api/commission/referrals/${ID.ref}/performance`)).lines.length > 0, true, '디렉터는 해지 후에도 이력 확인');
  // 해지 후 지급분은 배치 집계에 동결 금액으로 남는다
  const b = (await ok('dir', 'GET', '/api/commission/batches')).items.find((x) => x.settle_ym === YM2);
  assert.ok(b.paid >= 50);
  await cleanup();
});
