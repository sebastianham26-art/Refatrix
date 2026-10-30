// =====================================================================
// 0309 소개 계약 본인 작성 — 실제 PostgreSQL 종단 검증
//   실행: TEST_PG_URL=postgres://... node --test test/commission_referral_self_e2e.test.mjs   (전체 migrate 후)
//   흐름: Clarisa(A)가 직접 — B(CDMX) 선택 · B 회사 정보 · 본인 정보 → 서류 업로드(A·B) → 손서명+PIN
//         → 디렉터 승인 전에는 효력 없음 → 승인 → 효력 · 이후 Clarisa 수정 불가
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
const SKIP = !PG;
const RF = await import('../src/commissionReferral.js');

after(async () => {
  if (!PG) return;
  const { pool } = await import('../src/db.js');
  await pool.end().catch(() => {});
  setTimeout(() => process.exit(process.exitCode || 0), 300);
});

test('P1 효력일 — 승인일 필요 · 인자 없으면 종전 규칙', () => {
  const base = { start_date: '2026-10-01', docs_complete_on: '2026-10-20', first_signed_on: '2026-10-25' };
  assert.equal(RF.effectiveFrom(base), '2026-10-25');
  assert.equal(RF.effectiveFrom({ ...base, approved_on: null }), null);
  assert.equal(RF.effectiveFrom({ ...base, approved_on: '2026-10-30' }), '2026-10-30');
  assert.equal(RF.effectiveFrom({ ...base, approved_on: '2026-10-02' }), '2026-10-25');
});

test('P2 A 정보 — 비어 있으면 계약서 버전 불변 · 입력하면 진술 II 표', () => {
  const ref = { id: 1, referrer_id: 1, referred_id: 2, rate: 1, start_date: '2026-11-01', referred_info: { name: 'CDMX Refacciones' } };
  const t0 = RF.buildReferralTerms(ref, { referrerName: 'Clarisa' });
  const t1 = RF.buildReferralTerms({ ...ref, referrer_info: {} }, { referrerName: 'Clarisa' });
  assert.equal(RF.referralHash(t0), RF.referralHash(t1), '빈 A 정보는 버전을 바꾸지 않음');
  const t2 = RF.buildReferralTerms({ ...ref, referrer_info: { name: 'Clarisa Martínez', rfc: 'mapc900101aa1', address: 'Calle 1, Monterrey' } }, { referrerName: 'Clarisa' });
  assert.notEqual(RF.referralHash(t2), RF.referralHash(t0));
  const d = RF.buildReferralDoc(t2);
  const decl = d.sections.find((x) => x.key === 'decl');
  assert.equal(decl.tableAt, 1);
  assert.deepEqual(decl.table.rows.slice(0, 3), [['Nombre o razón social', 'Clarisa Martínez'], ['RFC', 'MAPC900101AA1'], ['Domicilio', 'Calle 1, Monterrey']]);
  assert.match(decl.paras[1], /Sus datos son los siguientes/);
});

const TAG = 'SELFT';
let app, query;
const ID = {}; const T = {};
function pngLine() {
  const w = 300, h = 100; const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; raw[o + 3] = Math.abs(y - 50 - Math.round(15 * Math.sin(x / 20))) < 2 ? 255 : 0; }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const SIG = pngLine();
const pdf = (n) => 'data:application/pdf;base64,' + Buffer.from(`%PDF-1.4\n% self ${n}\n`).toString('base64');
async function call(who, method, url, payload) {
  const res = await app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + T[who] } });
  let body = null; try { body = res.json(); } catch { body = res.body; }
  return { code: res.statusCode, body };
}
async function ok(...a) { const r = await call(...a); assert.ok(r.code < 300, `${a[1]} ${a[2]} → ${r.code} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; }
async function cleanup() {
  const U = `(SELECT id FROM users WHERE login_id LIKE 'selft%')`;
  const R = `(SELECT id FROM commission_referrals WHERE referrer_id IN ${U} OR referred_id IN ${U})`;
  await query(`ALTER TABLE commission_referral_signatures DISABLE TRIGGER trg_comm_referral_sig_immutable`);
  await query(`DELETE FROM commission_referral_signatures WHERE referral_id IN ${R}`);
  await query(`ALTER TABLE commission_referral_signatures ENABLE TRIGGER trg_comm_referral_sig_immutable`);
  await query(`DELETE FROM commission_referral_docs WHERE referral_id IN ${R}`);
  await query(`DELETE FROM commission_referrals WHERE id IN ${R}`);
  await query(`DELETE FROM audit_log WHERE user_id IN ${U}`);
  await query(`DELETE FROM users WHERE login_id LIKE 'selft%'`);
}

test('E0 준비 — 디렉터 · Clarisa(A) · CDMX(B) · 다른 영업 X', { skip: SKIP }, async () => {
  ({ query } = await import('../src/db.js'));
  const { hashPin } = await import('../src/auth.js');
  const { buildApp } = await import('../src/server.js');
  app = buildApp(); await app.ready();
  await cleanup();
  const mk = async (name, role, login, pin) => Number((await query(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,$3,$4) RETURNING id`, [name, role, hashPin(pin), login])).rows[0].id);
  ID.dir = await mk(`${TAG}Sebastian`, 'director', 'selft_dir', '1111');
  ID.A = await mk(`${TAG}Clarisa`, 'sales', 'selft_a', '2468');
  ID.B = await mk(`${TAG}CDMX`, 'sales', 'selft_b', '3333');
  ID.X = await mk(`${TAG}Otro`, 'sales', 'selft_x', '4444');
  for (const k of ['dir', 'A', 'B', 'X']) T[k] = app.jwt.sign({ sub: ID[k] });
});

test('E1 Clarisa 가 직접 신청 — B 선택 · B 정보 · 본인 정보 (율 1% 고정 · 미승인)', { skip: SKIP }, async () => {
  const c = await ok('A', 'GET', '/api/commission/referrals/candidates');
  assert.ok(c.items.some((u) => u.id === ID.B)); assert.ok(!c.items.some((u) => u.id === ID.A), '본인 제외');
  assert.equal((await call('A', 'POST', '/api/commission/referrals/request', { referred_id: ID.B, referred_info: {} })).body.error, 'name_required');
  assert.equal((await call('A', 'POST', '/api/commission/referrals/request', { referred_id: ID.A, referred_info: { name: 'x' } })).body.error, 'same_user');
  const r = await ok('A', 'POST', '/api/commission/referrals/request', {
    referred_id: ID.B, rate: 9, start_date: '2026-11-01',
    referred_info: { name: 'CDMX Refacciones SA de CV', rfc: 'cre210101ab1', address: 'Av. Insurgentes Sur 1602, CDMX', phone: '+52 55 1234 5678', email: 'cdmx@ejemplo.mx', legal_rep: 'Lic. Ana Ruiz', persona: 'moral' },
    referrer_info: { name: 'Clarisa Martínez López', rfc: 'malc900101aa1', address: 'Calle Hidalgo 10, Monterrey', phone: '+52 81 5555 0000', email: 'clarisa@ejemplo.mx' },
  });
  ID.ref = r.item.id;
  assert.equal(r.item.rate, 1, '율은 본인이 못 정함(기본 1%)');
  assert.equal(r.item.approved, false); assert.equal(r.item.can_edit, true); assert.equal(r.item.self_requested, true);
  assert.equal(r.item.docs.items.length, 9, '법인 = 정관·위임장 포함');
  const doc = JSON.stringify(r.item.doc);
  for (const k of ['CDMX Refacciones SA de CV', 'CRE210101AB1', 'Clarisa Martínez López', 'MALC900101AA1', 'Calle Hidalgo 10']) assert.ok(doc.includes(k), k);
  assert.equal((await call('X', 'POST', '/api/commission/referrals/request', { referred_id: ID.B, referred_info: { name: 'x' } })).body.error, 'already_referred');
  // 디렉터 현황판에 승인 대기로 보인다
  const board = await ok('dir', 'GET', '/api/commission/referrals');
  const it = board.items.find((x) => x.id === ID.ref);
  assert.equal(it.approved, false); assert.equal(it.referrer_info.rfc, 'MALC900101AA1');
});

test('E2 Clarisa 가 수정 · 서류 업로드(A·B) · 열기 · 삭제 — 남의 계약은 불가', { skip: SKIP }, async () => {
  const u = await ok('A', 'PUT', `/api/commission/referrals/${ID.ref}/mine`, {
    start_date: '2026-11-01', referred_info: { name: 'CDMX Refacciones SA de CV', rfc: 'CRE210101AB1', address: 'Av. Insurgentes Sur 1602, Col. Crédito Constructor, CDMX', persona: 'moral', legal_rep: 'Lic. Ana Ruiz' },
    referrer_info: { name: 'Clarisa Martínez López', rfc: 'MALC900101AA1', address: 'Calle Hidalgo 10, Monterrey' } });
  assert.match(JSON.stringify(u.item.doc), /Crédito Constructor/);
  assert.equal((await call('X', 'PUT', `/api/commission/referrals/${ID.ref}/mine`, { referred_info: { name: 'x' } })).code, 404);
  assert.equal((await call('X', 'POST', `/api/commission/referrals/${ID.ref}/docs`, { party: 'referred', doc_type: 'csf', file_name: 'a.pdf', data_url: pdf(0) })).code, 403);
  let n = 0;
  for (const [party, t] of [['referred', 'csf'], ['referred', 'domicilio'], ['referred', 'ine'], ['referred', 'acta'], ['referred', 'poder'], ['referrer', 'csf'], ['referrer', 'domicilio'], ['referrer', 'ine']]) {
    await ok('A', 'POST', `/api/commission/referrals/${ID.ref}/docs`, { party, doc_type: t, file_name: `${party}_${t}.pdf`, data_url: pdf(++n) });
  }
  const last = await ok('A', 'POST', `/api/commission/referrals/${ID.ref}/docs`, { party: 'referrer', doc_type: 'banco', file_name: 'banco.pdf', data_url: pdf(++n) });
  assert.ok(last.docs_complete_on, '서류 완비');
  const bCsf = last.item.docs.items.find((x) => x.party === 'referred' && x.type === 'csf').doc;
  assert.equal(bCsf.file_name, 'referred_csf.pdf', '본인이 올린 B 서류는 파일명이 보인다');
  assert.equal(bCsf.can_open, true); assert.equal(bCsf.can_delete, true);
  assert.equal((await call('A', 'GET', `/api/commission/referrals/docs/${bCsf.id}/file`)).code, 200);
  assert.equal((await call('X', 'GET', `/api/commission/referrals/docs/${bCsf.id}/file`)).code, 403);
  // 삭제 → 다시 올림
  await ok('A', 'DELETE', `/api/commission/referrals/docs/${bCsf.id}`);
  await ok('A', 'POST', `/api/commission/referrals/${ID.ref}/docs`, { party: 'referred', doc_type: 'csf', file_name: 'csf2.pdf', data_url: pdf(99) });
  // 디렉터가 올린 파일은 A 가 못 지운다
  const dd = await ok('dir', 'POST', `/api/commission/referrals/${ID.ref}/docs`, { party: 'referred', doc_type: 'ine', file_name: 'ine_dir.pdf', data_url: pdf(100) });
  assert.equal((await call('A', 'DELETE', `/api/commission/referrals/docs/${dd.id}`)).code, 403);
});

test('E3 Clarisa 서명 → 승인 전에는 효력 없음 → 디렉터 승인 → 효력 · 이후 수정·삭제 불가', { skip: SKIP }, async () => {
  const me = (await ok('A', 'GET', '/api/commission/referrals/me')).items.find((x) => x.id === ID.ref);
  const s = await ok('A', 'POST', `/api/commission/referrals/${ID.ref}/sign`, { agree: true, pin: '2468', version: me.version, signature: SIG });
  assert.equal(s.in_person, false);
  let it = (await ok('A', 'GET', '/api/commission/referrals/me')).items.find((x) => x.id === ID.ref);
  assert.equal(it.sign_status, 'signed'); assert.equal(it.docs.complete, true);
  assert.equal(it.effective_from, null, '디렉터 승인 전 = 효력 없음');
  assert.equal((await call('A', 'POST', `/api/commission/referrals/${ID.ref}/approve`)).code, 403, '본인 승인 불가');
  const a = await ok('dir', 'POST', `/api/commission/referrals/${ID.ref}/approve`);
  assert.equal(a.item.approved, true); assert.ok(a.item.approved_by_name);
  assert.equal((await call('dir', 'POST', `/api/commission/referrals/${ID.ref}/approve`)).body.error, 'not_pending');
  it = (await ok('A', 'GET', '/api/commission/referrals/me')).items.find((x) => x.id === ID.ref);
  const todayMx = new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
  assert.equal(it.effective_from, ['2026-11-01', todayMx].sort().pop());
  assert.equal(it.can_edit, false);
  assert.equal((await call('A', 'PUT', `/api/commission/referrals/${ID.ref}/mine`, { referred_info: { name: 'otro' } })).body.error, 'approved');
  const own = it.docs.items.find((x) => x.party === 'referrer' && x.type === 'banco').doc;
  assert.equal(own.can_delete, false);
  assert.equal((await call('A', 'DELETE', `/api/commission/referrals/docs/${own.id}`)).code, 403);
  // 기존(디렉터 등록) 계약은 등록 즉시 승인
  const d = await ok('dir', 'POST', '/api/commission/referrals', { referrer_id: ID.X, referred_id: ID.dir, rate: 1, start_date: '2026-11-01', referred_info: { name: 'Z' } });
  assert.equal(d.item.approved, true);
  await cleanup();
});
