// 전자결재(0234) — 규칙 · 배선 · 실제 PostgreSQL E2E
//
//   A. 순수 규칙(src/approval.js) — DB 없이
//   B. 배선(server.js 등록 · 마이그레이션 · nav.js 화면키) — 파일 검사
//   C. E2E — TEST_PG_URL 이 있을 때 실제 PostgreSQL + buildApp().inject
//      (사전 조건: 0234 까지 migrate 된 DB, login_id 가 sebastian/christopher/jang/maria/oscar/jose/luis 인 사용자)
//
//   실행: node --test test/approval.test.mjs
//         TEST_PG_URL=postgres://... node --test test/approval.test.mjs
import { test } from 'node:test';
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

const R = await import('../src/approval.js');

const SET = { ceo_pre_threshold: 100000, threshold_basis: 'total', variance_tolerance_pct: 10, ceo_user_id: 3, director_user_id: 1, finance_user_id: 2 };
const doc = (o) => ({ planned_sub: 0, planned_total: 0, include_finance: true, status: 'draft', exec_status: 'none', post_status: 'none', drafter_id: 5, ...o });
const types = (ls) => ls.map((l) => `${l.step_type}:${l.user_id}:${l.status}`);

// ── A. 순수 규칙 ─────────────────────────────────────────────────────────
test('A1 직원 기안 — 템플릿 단계 → 디렉터 → 사후(대표이사), 기준액 미만은 사전승인 없음', () => {
  const r = R.buildLines({ drafterId: 5, catSteps: [{ step_order: 1, step_type: 'approve', user_id: 4 }], doc: doc({ planned_sub: 7284.48, planned_total: 8450 }) }, SET);
  assert.deepEqual(types(r.lines), ['draft:5:done', 'approve:4:waiting', 'director:1:waiting', 'post_ceo:3:waiting']);
  assert.equal(r.ceoPre, false);
});
test('A2 기준액 이상 → 대표이사 사전승인 포함 · 기준(소계/합계) 반영', () => {
  const d = doc({ planned_sub: 90000, planned_total: 104400 });
  assert.equal(R.buildLines({ drafterId: 5, doc: d }, SET).ceoPre, true);
  assert.equal(R.buildLines({ drafterId: 5, doc: d }, { ...SET, threshold_basis: 'sub' }).ceoPre, false);
  assert.equal(R.buildLines({ drafterId: 5, doc: doc({ planned_total: 100000 }) }, SET).ceoPre, true, '경계값 = 기준액 이상');
});
test('A3 디렉터 기안 — 재무 합의 토글 ON/OFF, 본인 결재 자동 완료, 템플릿 무시', () => {
  const on = R.buildLines({ drafterId: 1, drafterIsDirector: true, catSteps: [{ step_type: 'approve', user_id: 4 }], doc: doc({ drafter_id: 1, planned_total: 62000, include_finance: true }) }, SET);
  assert.deepEqual(types(on.lines), ['draft:1:done', 'agree:2:waiting', 'director:1:done', 'post_ceo:3:waiting']);
  const off = R.buildLines({ drafterId: 1, drafterIsDirector: true, doc: doc({ drafter_id: 1, planned_total: 62000, include_finance: false }) }, SET);
  assert.deepEqual(types(off.lines), ['draft:1:done', 'director:1:done', 'post_ceo:3:waiting']);
  assert.equal(R.advance(off.lines.map((l) => ({ ...l }))).approved, true, '합의 없으면 상신 즉시 승인완료');
});
test('A4 대표이사 기안 — 사전승인 생략, 사후승인은 디렉터', () => {
  const r = R.buildLines({ drafterId: 3, doc: doc({ drafter_id: 3, planned_total: 500000 }) }, SET);
  assert.equal(r.ceoPre, false);
  assert.deepEqual(types(r.lines).slice(-1), ['post_ceo:1:waiting']);
});
test('A5 본인·중복 단계 제거, 설정 누락 시 오류', () => {
  const r = R.buildLines({ drafterId: 2, catSteps: [{ step_type: 'agree', user_id: 2 }, { step_type: 'pass', user_id: 4 }, { step_type: 'pass', user_id: 4 }], doc: doc({ drafter_id: 2 }) }, SET);
  assert.deepEqual(types(r.lines), ['draft:2:done', 'pass:4:waiting', 'director:1:waiting', 'post_ceo:3:waiting']);
  assert.equal(R.buildLines({ drafterId: 5, doc: doc({}) }, { ...SET, director_user_id: null }).error, 'director_unset');
  assert.equal(R.buildLines({ drafterId: 5, doc: doc({}) }, { ...SET, ceo_user_id: null }).error, 'ceo_unset');
});
test('A6 advance — 순서대로 활성화, 병렬(같은 순번) 모두 끝나야 다음', () => {
  const ls = [
    { step_order: 0, step_type: 'draft', status: 'done' },
    { step_order: 1, step_type: 'agree', status: 'waiting' }, { step_order: 1, step_type: 'agree', status: 'waiting' },
    { step_order: 2, step_type: 'director', status: 'waiting' }, { step_order: 99, step_type: 'post_ceo', status: 'waiting' },
  ];
  assert.equal(R.advance(ls).activated.length, 2);
  ls[1].status = 'done';
  assert.equal(R.advance(ls).activated.length, 0, '병렬 한 명 남음');
  ls[2].status = 'done';
  assert.equal(R.advance(ls).activated[0].step_type, 'director');
  ls[3].status = 'done';
  const last = R.advance(ls);
  assert.equal(last.approved, true);
  assert.equal(ls[4].status, 'waiting', '사후승인은 집행 후에만 활성화');
});
test('A7 열람 권한 · 할 일 · 버튼', () => {
  const c = (uid, o = {}) => ({ uid, isDirector: false, isCeo: false, isFinance: false, ...o });
  const d = doc({ status: 'progress', drafter_id: 5 });
  const ls = [{ step_type: 'draft', user_id: 5, status: 'done' }, { step_type: 'director', user_id: 1, status: 'pending' }, { step_type: 'post_ceo', user_id: 3, status: 'waiting' }];
  const vs = [{ user_id: 7, kind: 'share' }, { user_id: 8, kind: 'ref' }];
  assert.equal(R.canSeeDoc(c(9), d, ls, vs), false);
  assert.equal(R.canSeeDoc(c(8), d, ls, vs), true, '참조는 진행 중에도');
  assert.equal(R.canSeeDoc(c(7), d, ls, vs), false, '공람은 승인 후');
  assert.equal(R.canSeeDoc(c(7), { ...d, status: 'approved' }, ls, vs), true);
  assert.equal(R.canSeeDoc(c(2, { isFinance: true }), d, ls, vs), false, '재무는 승인 전 문서 못 봄(결재선 밖)');
  assert.equal(R.canSeeDoc(c(9, { isCeo: true }), d, ls, vs), true);
  assert.equal(R.canSeeDoc(c(1, { isDirector: true }), doc({ status: 'draft', drafter_id: 5 }), [], []), false, '남의 임시저장은 디렉터도 못 봄');
  assert.equal(R.isTodo(c(1, { isDirector: true }), d, ls), true);
  assert.deepEqual(R.allowedActions(c(1, { isDirector: true }), d, ls), ['approve', 'reject']);
  assert.deepEqual(R.allowedActions(c(5), d, ls), ['withdraw'], '다른 사람이 처리하기 전이면 기안자 회수 가능');
});
test('A8 회수 — 다른 사람이 처리하기 전까지만', () => {
  const me = { uid: 5 };
  const d = doc({ status: 'progress', drafter_id: 5 });
  const ls = [{ step_type: 'draft', user_id: 5, status: 'done' }, { step_type: 'approve', user_id: 4, status: 'pending' }];
  assert.equal(R.withdrawable(me, d, ls), true);
  ls[1].status = 'done';
  assert.equal(R.withdrawable(me, d, ls), false);
});
test('A9 파일 검증 — 20MB · 확장자 허용목록 · MIME 교정', () => {
  const b64 = (bytes) => 'data:application/octet-stream;base64,' + Buffer.alloc(bytes, 1).toString('base64');
  const ok = R.decodeApprovalFile(b64(1024), 'Resumen.MSG');
  assert.equal(ok.ok, true); assert.equal(ok.mime, 'application/vnd.ms-outlook'); assert.equal(ok.bytes, 1024);
  assert.equal(R.decodeApprovalFile(b64(20 * 1024 * 1024), 'a.pdf').ok, true, '정확히 20MB 허용');
  assert.equal(R.decodeApprovalFile(b64(20 * 1024 * 1024 + 1), 'a.pdf').error, 'too_large');
  assert.equal(R.decodeApprovalFile(b64(10), 'virus.exe').error, 'bad_type');
  assert.equal(R.decodeApprovalFile('nope', 'a.pdf').error, 'bad_format');
  for (const f of ['a.docx', 'b.pptx', 'c.xlsx', 'd.jpeg', 'e.heic', 'f.xml', 'g.zip', 'h.eml', 'i.ppt', 'j.doc']) assert.equal(R.decodeApprovalFile(b64(5), f).ok, true, f);
});
test('A10 CFDI 파싱 · 종류 추정', () => {
  const x = '<?xml version="1.0"?><cfdi:Comprobante Version="4.0" SubTotal="11939.66" Total="13850.00"><cfdi:Emisor Rfc="GNO9203115K2" Nombre="X"/><cfdi:Complemento><tfd:TimbreFiscalDigital UUID="a1f3c2d4-58b1-4e0f-9c21-7f2b11d0a9e3"/></cfdi:Complemento></cfdi:Comprobante>';
  assert.deepEqual(R.parseCfdi(x), { uuid: 'A1F3C2D4-58B1-4E0F-9C21-7F2B11D0A9E3', rfc: 'GNO9203115K2', total: 13850 });
  assert.equal(R.parseCfdi('<root/>'), null);
  assert.equal(R.guessKind('CFDI_A1.xml'), 'Factura XML');
  assert.equal(R.guessKind('factura_0924.pdf'), 'Factura PDF');
  assert.equal(R.guessKind('comprobante_SPEI.pdf'), '송금증');
  assert.equal(R.guessKind('foto.heic'), '영수증');
});
test('A11 금액 · 리포트 · 완결성 점검', () => {
  assert.deepEqual(R.calcAmounts(7284.48, true), { planned_sub: 7284.48, planned_iva: 1165.52, planned_total: 8450 });
  assert.deepEqual(R.calcAmounts(100, false), { planned_sub: 100, planned_iva: 0, planned_total: 100 });
  const docs = [
    { id: 1, doc_no: 'A', category_id: 1, status: 'approved', exec_status: 'done', post_status: 'pending', planned_total: 100, actual_total: 120, exec_at: '2026-09-01T00:00:00Z', files: [] },
    { id: 2, doc_no: 'B', category_id: 1, status: 'approved', exec_status: 'pending', post_status: 'none', planned_total: 50, approved_at: '2026-09-01T00:00:00Z', files: [{ kind: '견적서', dup_of: 'A' }] },
  ];
  const rep = R.reportRows(docs, () => '출장비');
  assert.deepEqual([rep.total.n, rep.total.plan, rep.total.actual, rep.total.diff, rep.total.unexec, rep.total.postOpen], [2, 150, 120, 20, 50, 1]);
  const ck = Object.fromEntries(R.completenessChecks(docs, SET, Date.parse('2026-09-29T00:00:00Z')).map((c) => [c.key, c.items.map((i) => i.doc_no)]));
  assert.deepEqual(ck, { exec_no_evidence: ['A'], unexec_7d: ['B'], post_wait_7d: ['A'], flagged: [], over: ['A'], dup: ['B'] });
});

// ── B. 배선 ─────────────────────────────────────────────────────────────
test('B1 server.js 등록 · 마이그레이션 멱등 구문', () => {
  const s = read(join(API, 'src/server.js'));
  assert.match(s, /import approvalRoutes from '\.\/routes\/approvalRoutes\.js'/);
  assert.match(s, /app\.register\(approvalRoutes\)/);
  const m = read(join(API, 'migrations/0234_e_approval.sql'));
  const creates = m.match(/CREATE (TABLE|INDEX)\b[^;]*/g);
  assert.ok(creates.length >= 20);
  for (const c of creates) assert.match(c, /IF NOT EXISTS/, c.slice(0, 60));
  assert.doesNotMatch(m.replace(/--[^\n]*/g, ''), /\btransactions\b/i, '재무상태(transactions) 미반영');
});
test('B2 라우트는 transactions·cashflow 를 건드리지 않는다', () => {
  const r = read(join(API, 'src/routes/approvalRoutes.js'));
  assert.doesNotMatch(r.replace(/\/\/[^\n]*/g, ''), /\btransactions\b|cashflow/i);
  assert.match(r, /bodyLimit: APPROVAL_FILE_BODY_LIMIT/);
  assert.ok(R.APPROVAL_FILE_BODY_LIMIT > Math.ceil(R.APPROVAL_FILE_MAX_BYTES * 4 / 3), '20MB base64 가 bodyLimit 안에 들어간다');
});
test('B3 nav.js — 전자결재 화면(모든 역할) · 마케팅 권한키 복구', () => {
  const nav = read(join(REPO, 'refatrix-nav.js'));
  assert.match(nav, /approval:\{file:'refatrix-approval\.html'/);
  assert.match(nav, /approval:null/);
  assert.match(nav, /^\s*marketing:'marketing', mktspend:'marketing', survey:'marketing',/m, 'PAGEKEY 가 주석 안에 묻히지 않음');
  for (const g of ['common', 'finance', 'warehouse']) {
    const line = nav.match(new RegExp(`\\{key:'${g}'[^\\n]*`))[0];
    assert.match(line, /'approval'/, g);
  }
});

// ── C. 실제 PostgreSQL E2E ───────────────────────────────────────────────
test('C E2E — 기안·결재·집행·사후승인·이의·반려·재기안·증빙·댓글·설정·리포트', { skip: !PG }, async (t) => {
  const { buildApp } = await import('../src/server.js');
  const { pool } = await import('../src/db.js');
  const app = buildApp();
  await app.ready();
  const U = {};
  for (const r of (await pool.query(`SELECT id, login_id, role FROM users WHERE login_id = ANY($1)`,
    [['sebastian', 'christopher', 'jang', 'maria', 'oscar', 'jose', 'luis']])).rows) U[r.login_id] = { id: Number(r.id), tok: app.jwt.sign({ sub: Number(r.id), role: r.role }) };
  const call = async (who, method, url, payload) => {
    const res = await app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + U[who].tok } });
    let body = null; try { body = res.json(); } catch { body = res.body; }
    return { code: res.statusCode, body, raw: res };
  };
  const ok = async (...a) => { const r = await call(...a); assert.ok(r.code < 300, `${a[1]} ${a[2]} → ${r.code} ${JSON.stringify(r.body)}`); return r.body; };
  const dataUrl = (buf, mime = 'application/pdf') => `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
  const cfdi = (uuid, total) => `<?xml version="1.0"?><cfdi:Comprobante Total="${total}"><cfdi:Emisor Rfc="AAA010101AAA"/><tfd:TimbreFiscalDigital UUID="${uuid}"/></cfdi:Comprobante>`;
  const lines = async (id) => (await ok('sebastian', 'GET', `/api/approvals/${id}`)).lines.map((l) => `${l.step_type}:${l.status}`);

  try {
    // 설정 · 템플릿
    await ok('sebastian', 'PUT', '/api/approvals/settings', { ceo_pre_threshold: 100000, threshold_basis: 'total', variance_tolerance_pct: 10,
      ceo_user_id: U.jang.id, finance_user_id: U.christopher.id, director_user_id: U.sebastian.id });
    assert.equal((await call('maria', 'PUT', '/api/approvals/settings', { ceo_pre_threshold: 1 })).code, 403);
    const boot = await ok('maria', 'GET', '/api/approvals/bootstrap');
    const cat = (nm) => boot.categories.find((c) => c.name === nm).id;
    await pool.query(`DELETE FROM approval_category_steps WHERE category_id=$1`, [cat('출장비')]);   // 재실행 대비
    await ok('sebastian', 'POST', `/api/approvals/categories/${cat('출장비')}/steps`, { step_type: 'approve', user_id: U.maria.id });
    assert.equal((await call('sebastian', 'POST', `/api/approvals/categories/${cat('출장비')}/steps`, { step_type: 'approve', user_id: U.maria.id })).body.detail, 'duplicate');
    assert.equal((await ok('jang', 'GET', '/api/approvals/bootstrap')).me.isCeo, true);

    // 1) 직원 기안 → 중간결재 → 디렉터 → 집행 → 이의 → 소명 → 종결
    const d1 = (await ok('oscar', 'POST', '/api/approvals', { category_id: cat('출장비'), title: 'Mérida 출장', planned_sub: 7284.48, iva_applied: true, refs: [U.luis.id] })).id;
    const pdf = Buffer.from('%PDF-1.4 test receipt ' + Date.now());
    const f1 = await ok('oscar', 'POST', `/api/approvals/${d1}/files`, { file_name: '항공권.pdf', data_url: dataUrl(pdf) });
    assert.equal(f1.kind, '기타');
    assert.equal((await call('luis', 'GET', `/api/approvals/${d1}`)).code, 404, '임시저장은 참조자도 못 봄');
    const s1 = await ok('oscar', 'POST', `/api/approvals/${d1}/submit`);
    assert.match(s1.doc_no, /^EXP-\d{4}-\d{4}$/);
    assert.deepEqual(await lines(d1), ['draft:done', 'approve:pending', 'director:waiting', 'post_ceo:waiting']);
    assert.equal((await call('luis', 'GET', `/api/approvals/${d1}`)).code, 200, '참조자는 진행 중 열람');
    assert.equal((await call('jose', 'GET', `/api/approvals/${d1}`)).code, 404);
    assert.equal((await call('sebastian', 'POST', `/api/approvals/${d1}/act`, { action: 'approve' })).code, 409, '차례 아님');
    // 동시 클릭: 같은 사람이 두 번 → 하나만 성공
    const par = await Promise.all([call('maria', 'POST', `/api/approvals/${d1}/act`, { action: 'approve' }), call('maria', 'POST', `/api/approvals/${d1}/act`, { action: 'approve' })]);
    assert.deepEqual(par.map((r) => r.code).sort(), [200, 409]);
    assert.equal((await call('oscar', 'POST', `/api/approvals/${d1}/withdraw`)).code, 409, '처리 후 회수 불가');
    await ok('sebastian', 'POST', `/api/approvals/${d1}/act`, { action: 'approve', comment: '승인' });
    let det = await ok('christopher', 'GET', `/api/approvals/${d1}`);
    assert.equal(det.doc.status, 'approved'); assert.equal(det.doc.exec_status, 'pending'); assert.ok(det.actions.includes('execute'));
    assert.equal((await call('christopher', 'POST', `/api/approvals/${d1}/execute`, { actual_total: 9000, exec_date: '2026-09-28', pay_method: '계좌이체' })).body.error, 'exec_evidence_required');
    const up = await ok('christopher', 'POST', `/api/approvals/${d1}/files`, { file_name: 'CFDI_A1.xml', data_url: dataUrl(cfdi('11111111-2222-3333-4444-555555555555', 9000), 'text/xml') });
    assert.equal(up.kind, 'Factura XML'); assert.equal(up.cfdi.total, 9000);
    await ok('christopher', 'POST', `/api/approvals/${d1}/execute`, { actual_total: 9000, exec_date: '2026-09-28', pay_method: '계좌이체', memo: '항공 변경' });
    det = await ok('jang', 'GET', `/api/approvals/${d1}`);
    assert.equal(det.doc.post_status, 'pending'); assert.ok(det.doc.variance_pct > 6);
    assert.deepEqual(det.actions, ['post_confirm', 'flag']);
    assert.equal(det.files.find((f) => f.kind === 'Factura XML').stage, 'exec');
    assert.equal((await call('jang', 'POST', `/api/approvals/${d1}/flag`, {})).code, 400);
    await ok('jang', 'POST', `/api/approvals/${d1}/flag`, { memo: '초과 사유 설명 바랍니다' });
    const oscarList = (await ok('oscar', 'GET', '/api/approvals')).items.find((i) => i.id === d1);
    assert.equal(oscarList.stage, 'flagged'); assert.equal(oscarList.todo, true, '기안자 소명 할 일');
    const cm = await ok('oscar', 'POST', `/api/approvals/${d1}/comments`, { body: '항공권 변경 수수료입니다', with_files: true });
    const pngBuf = Buffer.from('png' + Date.now());
    await ok('oscar', 'POST', `/api/approvals/${d1}/files`, { file_name: '변경내역.png', data_url: dataUrl(pngBuf, 'image/png'), comment_id: cm.id });
    assert.equal((await call('luis', 'POST', `/api/approvals/${d1}/files`, { file_name: 'x.png', data_url: dataUrl(Buffer.from('x')), comment_id: cm.id })).code, 400, '남의 댓글에 파일 X');
    await ok('jang', 'POST', `/api/approvals/${d1}/close-flag`, { memo: '확인' });
    det = await ok('oscar', 'GET', `/api/approvals/${d1}`);
    assert.equal(det.doc.post_status, 'confirmed'); assert.ok(det.doc.closed_at);
    assert.equal(det.files.find((f) => f.file_name === '변경내역.png').comment_id, cm.id);
    assert.deepEqual(det.events.map((e) => e.action), ['submit', 'approve', 'approve', 'approved', 'execute', 'flag', 'close_flag']);

    // 파일 권한 · 다운로드 · 삭제/무효
    const pdfFile = det.files.find((f) => f.file_name === '항공권.pdf');
    const dl = await call('oscar', 'GET', `/api/approvals/files/${pdfFile.id}`);
    assert.equal(dl.code, 200); assert.equal(dl.raw.headers['content-type'], 'application/pdf');
    assert.equal(Buffer.compare(dl.raw.rawPayload, pdf), 0, '원본 바이트 그대로');
    assert.equal((await call('jose', 'GET', `/api/approvals/files/${pdfFile.id}`)).code, 404);
    assert.equal((await call('oscar', 'DELETE', `/api/approvals/files/${pdfFile.id}`)).code, 403, '승인 후 삭제 불가');
    assert.equal((await call('oscar', 'POST', `/api/approvals/files/${pdfFile.id}/void`, {})).code, 400);
    await ok('oscar', 'POST', `/api/approvals/files/${pdfFile.id}/void`, { reason: '중복 업로드' });

    // 2) 기준액 이상 → 사전승인 → 반려 → 재기안
    const d2 = (await ok('maria', 'POST', '/api/approvals', { category_id: cat('마케팅'), title: 'EXPO 부스', planned_sub: 160000, shares: [U.oscar.id] })).id;
    await ok('maria', 'POST', `/api/approvals/${d2}/files`, { file_name: '견적서.pdf', data_url: dataUrl(pdf) });
    assert.equal((await ok('maria', 'GET', `/api/approvals/${d2}`)).files[0].dup_of, null, '무효 처리된 파일과는 중복으로 보지 않음');
    await ok('maria', 'POST', `/api/approvals/${d2}/files`, { file_name: '시안.png', data_url: dataUrl(pngBuf, 'image/png') });
    const dupF = (await ok('maria', 'GET', `/api/approvals/${d2}`)).files.find((f) => f.file_name === '시안.png');
    assert.equal(dupF.dup_of, s1.doc_no, '같은 파일이 다른 문서에 쓰였음');
    await ok('maria', 'POST', `/api/approvals/${d2}/submit`);
    assert.equal((await call('oscar', 'GET', `/api/approvals/${d2}`)).code, 404, '공람은 승인 전 못 봄');
    await ok('sebastian', 'POST', `/api/approvals/${d2}/act`, { action: 'approve' });
    assert.deepEqual(await lines(d2), ['draft:done', 'director:done', 'pre_ceo:pending', 'post_ceo:waiting']);
    assert.equal((await ok('maria', 'GET', '/api/approvals')).items.find((i) => i.id === d2).stage, 'pre');
    assert.equal((await call('jang', 'POST', `/api/approvals/${d2}/act`, { action: 'reject' })).body.error, 'memo_required');
    await ok('jang', 'POST', `/api/approvals/${d2}/act`, { action: 'reject', comment: '비교견적 2건 추가 바랍니다' });
    const notes = (await ok('maria', 'GET', '/api/approvals/notifications')).items;
    assert.ok(notes.some((x) => x.kind === '반려' && x.memo === '비교견적 2건 추가 바랍니다' && x.document_id === d2 && !x.read_at));
    assert.deepEqual((await ok('maria', 'GET', `/api/approvals/${d2}`)).actions, ['resubmit']);
    const d3 = (await ok('maria', 'POST', `/api/approvals/${d2}/resubmit`)).id;
    const d3det = await ok('maria', 'GET', `/api/approvals/${d3}`);
    assert.equal(d3det.doc.version, 2); assert.equal(d3det.doc.parent_no, (await ok('maria', 'GET', `/api/approvals/${d2}`)).doc.doc_no);
    assert.equal(d3det.files.length, 2); assert.equal(d3det.links.length, 1); assert.equal(d3det.viewers.length, 1);
    await ok('maria', 'PUT', `/api/approvals/${d3}`, { category_id: cat('마케팅'), title: 'EXPO 부스 (비교견적)', planned_sub: 150000, shares: [U.oscar.id] });
    const s3 = await ok('maria', 'POST', `/api/approvals/${d3}/submit`);
    assert.notEqual(s3.doc_no, d3det.doc.parent_no);

    // 3) 디렉터 기안 — 재무 합의 토글 · 사전승인
    const d4 = (await ok('sebastian', 'POST', '/api/approvals', { category_id: cat('외주용역'), title: '웹카탈로그 2차', planned_sub: 53448.28, include_finance: false })).id;
    await ok('sebastian', 'POST', `/api/approvals/${d4}/submit`);
    let l4 = await ok('sebastian', 'GET', `/api/approvals/${d4}`);
    assert.equal(l4.doc.status, 'approved', '합의·사전승인 없으면 즉시 승인완료');
    assert.deepEqual(l4.lines.map((l) => l.step_type), ['draft', 'director', 'post_ceo']);
    assert.equal((await ok('jang', 'GET', '/api/approvals')).items.find((i) => i.id === d4).director_no_finance, true);
    const d5 = (await ok('sebastian', 'POST', '/api/approvals', { category_id: cat('외주용역'), title: '랙 공사', planned_sub: 64000, include_finance: true })).id;
    await ok('sebastian', 'POST', `/api/approvals/${d5}/submit`);
    assert.deepEqual(await lines(d5), ['draft:done', 'agree:pending', 'director:done', 'post_ceo:waiting']);
    await ok('christopher', 'POST', `/api/approvals/${d5}/act`, { action: 'approve', comment: '합의' });
    assert.equal((await ok('sebastian', 'GET', `/api/approvals/${d5}`)).doc.status, 'approved');

    // 4) 사후승인 일괄 확인 · 권한 없는 사람 무시
    for (const id of [d4, d5]) {
      await ok('christopher', 'POST', `/api/approvals/${id}/files`, { file_name: `송금증_${id}.jpg`, kind: '송금증', data_url: dataUrl(Buffer.from('spei' + id + Date.now()), 'image/jpeg') });
      await ok('christopher', 'POST', `/api/approvals/${id}/execute`, { actual_total: 62000, exec_date: '2026-09-29', pay_method: '계좌이체' });
    }
    const bulkNo = await ok('maria', 'POST', '/api/approvals/post-bulk', { ids: [d4, d5] });
    assert.deepEqual(bulkNo.done, []);
    const bulk = await ok('jang', 'POST', '/api/approvals/post-bulk', { ids: [d4, d5, d1] });
    assert.deepEqual(bulk.done.sort(), [d4, d5].sort()); assert.deepEqual(bulk.skipped, [d1]);

    // 5) 회수(처리 전) · 임시저장 삭제
    const d6 = (await ok('luis', 'POST', '/api/approvals', { category_id: cat('소모품'), title: '소모품', planned_sub: 100 })).id;
    await ok('luis', 'POST', `/api/approvals/${d6}/submit`);
    await ok('luis', 'POST', `/api/approvals/${d6}/withdraw`);
    assert.equal((await ok('luis', 'GET', `/api/approvals/${d6}`)).doc.status, 'draft');
    assert.equal((await call('luis', 'DELETE', `/api/approvals/${d6}`)).code, 409, '번호 받은 문서는 삭제 불가');
    const d7 = (await ok('luis', 'POST', '/api/approvals', { title: '메모' })).id;
    assert.equal((await call('luis', 'POST', `/api/approvals/${d7}/submit`)).body.detail, 'category_required');
    await ok('luis', 'DELETE', `/api/approvals/${d7}`);
    assert.equal((await call('luis', 'GET', `/api/approvals/${d7}`)).code, 404);

    // 6) 댓글 수정·삭제는 디렉터만 · 원문 보존
    assert.equal((await call('oscar', 'PUT', `/api/approvals/comments/${cm.id}`, { body: 'x' })).code, 403);
    await ok('sebastian', 'PUT', `/api/approvals/comments/${cm.id}`, { body: '항공권 변경 수수료입니다 (영수증 첨부)' });
    await ok('sebastian', 'DELETE', `/api/approvals/comments/${cm.id}`);
    const cO = (await ok('oscar', 'GET', `/api/approvals/${d1}`)).comments[0];
    assert.equal(cO.body, null); assert.ok(cO.deleted_at); assert.deepEqual(cO.history, []);
    const cJ = (await ok('jang', 'GET', `/api/approvals/${d1}`)).comments[0];
    assert.equal(cJ.body, '항공권 변경 수수료입니다 (영수증 첨부)'); assert.equal(cJ.history[0].body, '항공권 변경 수수료입니다');

    // 7) 파일 검증 · 링크 · 리포트 · 알림 읽음
    assert.equal((await call('oscar', 'POST', `/api/approvals/${d1}/files`, { file_name: 'x.exe', data_url: dataUrl(Buffer.from('MZ')) })).body.detail, 'bad_type');
    const big = await call('oscar', 'POST', `/api/approvals/${d1}/files`, { file_name: 'big.pdf', data_url: dataUrl(Buffer.alloc(20 * 1024 * 1024 + 10, 7)) });
    assert.equal(big.body.detail, 'too_large');
    const fit = await call('oscar', 'POST', `/api/approvals/${d1}/files`, { file_name: 'fit.pdf', data_url: dataUrl(Buffer.alloc(20 * 1024 * 1024, 9)) });
    assert.equal(fit.code, 200, '20MB 파일은 bodyLimit 안에서 통과');
    await ok('maria', 'POST', `/api/approvals/${d3}/links`, { doc_no: s1.doc_no });
    assert.equal((await call('maria', 'POST', `/api/approvals/${d3}/links`, { doc_no: 'EXP-1999-0001' })).body.detail, 'doc_not_found');
    assert.equal((await call('luis', 'GET', '/api/approvals/report')).code, 403);
    const rep = await ok('christopher', 'GET', '/api/approvals/report');
    assert.ok(rep.rows.length >= 2); assert.ok(rep.total.actual >= 9000 + 62000 * 2);
    assert.ok(!rep.checks.find((c) => c.key === 'dup').items.some((i) => i.id === d2), '재무는 못 보는 반려 문서(d2)는 재무 리포트에 안 나옴');
    const repDir = await ok('sebastian', 'GET', '/api/approvals/report');
    assert.ok(repDir.checks.find((c) => c.key === 'dup').items.some((i) => i.id === d2), '디렉터 리포트: 중복 증빙 의심 d2');
    await ok('maria', 'POST', '/api/approvals/notifications/read', { all: true });
    assert.equal((await ok('maria', 'GET', '/api/approvals/bootstrap')).unread, 0);
    // 목록 가시성
    const luisIds = (await ok('luis', 'GET', '/api/approvals')).items.map((i) => i.id);
    assert.ok(luisIds.includes(d1) && luisIds.includes(d6) && !luisIds.includes(d2));
    const chrisIds = (await ok('christopher', 'GET', '/api/approvals')).items.map((i) => i.id);
    assert.ok(chrisIds.includes(d4) && !chrisIds.includes(d3) , '재무: 승인 문서 + 본인 결재선');
    // 설정 이력
    await ok('sebastian', 'PUT', '/api/approvals/settings', { ceo_pre_threshold: 80000, threshold_basis: 'total', variance_tolerance_pct: 10,
      ceo_user_id: U.jang.id, finance_user_id: U.christopher.id, director_user_id: U.sebastian.id });
    assert.match((await ok('sebastian', 'GET', '/api/approvals/bootstrap')).settings_log[0].detail, /100,000\.00 → \$80,000\.00/);
  } finally {
    await app.close();
    await pool.end();
    // buildApp 이 띄우는 동기화 워커(setInterval)가 프로세스를 붙잡으므로 결과 보고 뒤 종료
    setTimeout(() => process.exit(process.exitCode || 0), 1500);
  }
});
