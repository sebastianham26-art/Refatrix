// 전자결재(0234) — 규칙 · 배선 · 실제 PostgreSQL E2E
//
//   A. 순수 규칙(src/approval.js) — DB 없이
//   B. 배선(server.js 등록 · 마이그레이션 · nav.js 화면키) — 파일 검사
//   C. E2E — TEST_PG_URL 이 있을 때 실제 PostgreSQL + buildApp().inject
//      (사전 조건: 0234 까지 migrate 된 DB, login_id 가 sebastian/christopher/jang/maria/oscar/jose/luis 인 사용자)
//
//   실행: node --test test/approval.test.mjs
//         TEST_PG_URL=postgres://... node --test test/approval.test.mjs
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

const R = await import('../src/approval.js');

// E2E 들이 같은 DB 풀을 쓰므로 파일 끝에서 한 번만 정리. buildApp 동기화 워커(setInterval)가 프로세스를 붙잡아 결과 보고 뒤 종료.
after(async () => {
  if (!PG) return;
  const { pool } = await import('../src/db.js');
  await pool.end().catch(() => {});
  setTimeout(() => process.exit(process.exitCode || 0), 500);
});

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
  assert.deepEqual(types(on.lines), ['draft:1:done', 'director:1:done', 'agree:2:waiting', 'post_ceo:3:waiting'], '내 결재 뒤에 재무');
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
    assert.deepEqual(await lines(d5), ['draft:done', 'director:done', 'agree:pending', 'post_ceo:waiting']);
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
  }
});

// ═════════ 0237 — 통화 · 결제 방식 · 본문 그림 ═════════
test('A12 회차 날짜 — 매주·격주·매월(말일 보정)·분기', () => {
  assert.deepEqual([0, 1, 2].map((i) => R.addPeriod('2026-09-28', 'weekly', i)), ['2026-09-28', '2026-10-05', '2026-10-12']);
  assert.equal(R.addPeriod('2026-12-28', 'biweekly', 1), '2027-01-11');
  assert.deepEqual([0, 1, 2, 3].map((i) => R.addPeriod('2026-01-31', 'monthly', i)), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.equal(R.addPeriod('2026-11-30', 'quarterly', 1), '2027-02-28');
});
test('A13 지급 일정 — 일시불 · 정기 · 분할(합계 검증)', () => {
  assert.deepEqual(R.buildSchedule({ type: 'once', total: 116, pay_due: '2026-10-01' }).rows, [{ seq: 1, due_date: '2026-10-01', amount: 116 }]);
  const rec = R.buildSchedule({ type: 'recurring', total: 100, plan: { freq: 'weekly', count: 3, start: '2026-10-05', per_sub: 1 } });
  assert.deepEqual(rec.rows.map((r) => r.amount), [33.33, 33.33, 33.34], '마지막 회차가 단수 흡수');
  assert.equal(rec.rows[2].due_date, '2026-10-19');
  assert.equal(R.buildSchedule({ type: 'recurring', total: 1, plan: { freq: 'daily', count: 3, start: '2026-10-05' } }).error, 'bad_freq');
  assert.equal(R.buildSchedule({ type: 'recurring', total: 1, plan: { freq: 'weekly', count: 61, start: '2026-10-05' } }).error, 'bad_count');
  const ok = R.buildSchedule({ type: 'installment', total: 1000, rows: [{ due_date: '2026-10-01', amount: 300 }, { due_date: '2026-11-01', amount: 700 }] });
  assert.equal(ok.rows.length, 2);
  assert.equal(R.buildSchedule({ type: 'installment', total: 1000, rows: [{ amount: 300 }, { amount: 600 }] }).error, 'schedule_sum');
  assert.equal(R.buildSchedule({ type: 'installment', total: 1000, rows: [{ amount: 1000 }] }).error, 'bad_count');
});
test('A14 MXN 환산 — 합계 정확 · 회차 단수 보정', () => {
  const mx = R.toMxn({ orig_sub: 4000, orig_total: 4640 }, 18.5);
  assert.deepEqual(mx, { planned_sub: 74000, planned_iva: 11840, planned_total: 85840 });
  const p = R.paymentsMxn([33.33, 33.33, 33.34], 18.123457, R.round2(100 * 18.123457));
  assert.equal(R.round2(p.reduce((a, b) => a + b, 0)), R.round2(100 * 18.123457));
});
test('A15 본문 — 텍스트·그림만 통과, 위험한 그림 주소 거부', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const r = R.normalizeBodyRich([{ t: 'p', v: '가' }, { t: 'p', v: '나' }, { t: 'img', src: png, w: 10, h: 5, onerror: 'x' }, { t: 'html', v: '<script>' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.nodes, [{ t: 'p', v: '가\n나' }, { t: 'img', src: png, w: 10, h: 5 }]);
  assert.equal(r.plain, '가\n나\n[그림]');
  for (const bad of ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGI+', 'https://x/y.png', png + '"><script>'])
    assert.equal(R.normalizeBodyRich([{ t: 'img', src: bad }]).error, 'bad_image', bad);
  assert.equal(R.normalizeBodyRich(null, '옛 본문').plain, '옛 본문', '0237 이전 문서 호환');
  assert.equal(R.normalizeBodyRich([{ t: 'img', src: 'data:image/jpeg;base64,' + 'A'.repeat(R.BODY_IMG_MAX) }]).error, 'image_too_large');
});

test('D E2E — USD 환율 고정 · 정기 지급 회차별 집행 · 회차 중단 · 분할 · 본문 그림', { skip: !PG }, async () => {
  const { buildApp } = await import('../src/server.js');
  const { pool } = await import('../src/db.js');
  const app = buildApp();
  await app.ready();
  const U = {};
  for (const r of (await pool.query(`SELECT id, login_id, role FROM users WHERE login_id = ANY($1)`,
    [['sebastian', 'christopher', 'jang', 'maria', 'oscar']])).rows) U[r.login_id] = { id: Number(r.id), tok: app.jwt.sign({ sub: Number(r.id), role: r.role }) };
  const call = async (who, method, url, payload) => {
    const res = await app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + U[who].tok } });
    let body = null; try { body = res.json(); } catch { body = res.body; }
    return { code: res.statusCode, body };
  };
  const ok = async (...a) => { const r = await call(...a); assert.ok(r.code < 300, `${a[1]} ${a[2]} → ${r.code} ${JSON.stringify(r.body)}`); return r.body; };
  const dataUrl = (buf, mime) => `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
  const today = new Date().toISOString().slice(0, 10);
  const setRate = (d, r) => pool.query(
    `INSERT INTO fx_rates(rate_date, base, quote, rate, source) VALUES ($1,'USD','MXN',$2,'test')
     ON CONFLICT (rate_date, base, quote) DO UPDATE SET rate=EXCLUDED.rate, source='test'`, [d, r]);
  try {
    await pool.query(`UPDATE approval_settings SET ceo_pre_threshold=100000, threshold_basis='total', ceo_user_id=$1, director_user_id=$2, finance_user_id=$3 WHERE id=1`,
      [U.jang.id, U.sebastian.id, U.christopher.id]);
    await setRate(today, 18.5); await setRate('2026-09-15', 18.1); await setRate('2026-09-01', 17.9);
    const cat = (await ok('maria', 'GET', '/api/approvals/bootstrap')).categories[0].id;

    // ① USD · 매주 4회 · 회당 소계 1,000 → 총 USD 4,640 → 미리보기 MXN 85,840
    const png = dataUrl(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), 'image/png');
    const body = { category_id: cat, title: 'USD 정기 · 창고 경비 용역', currency: 'USD', payment_type: 'recurring', iva_applied: true,
      payment_plan: { freq: 'weekly', count: 4, start: '2026-10-05', per_sub: 1000 },
      body_rich: [{ t: 'p', v: '주간 경비 용역\n4주' }, { t: 'img', src: png, w: 16, h: 16 }] };
    const d = (await ok('maria', 'POST', '/api/approvals', body)).id;
    let det = await ok('maria', 'GET', `/api/approvals/${d}`);
    assert.equal(det.doc.currency, 'USD'); assert.equal(det.doc.orig_total, 4640); assert.equal(det.doc.planned_total, 85840);
    assert.equal(det.doc.fx_locked_at, null, '임시저장은 미리보기(고정 아님)');
    assert.deepEqual(det.payments.map((p) => [p.seq, p.due_date, p.planned_amount]), [[1, '2026-10-05', 1160], [2, '2026-10-12', 1160], [3, '2026-10-19', 1160], [4, '2026-10-26', 1160]]);
    assert.equal(R.round2(det.payments.reduce((s, p) => s + p.planned_mxn, 0)), 85840);
    assert.equal(det.body_nodes[1].t, 'img'); assert.equal(det.doc.body, '주간 경비 용역\n4주\n[그림]');
    assert.equal((await ok('maria', 'GET', '/api/approvals')).items.find((i) => i.id === d).body, undefined, '목록엔 본문 없음');

    // ② 상신 → 환율 고정 → 환율이 바뀌어도 문서 금액 불변
    await ok('maria', 'POST', `/api/approvals/${d}/submit`);
    det = await ok('maria', 'GET', `/api/approvals/${d}`);
    assert.ok(det.doc.fx_locked_at); assert.equal(det.doc.fx_rate, 18.5); assert.equal(det.doc.fx_date, today);
    assert.match(det.events[0].detail, /USD 4640\.00 × 18\.5/);
    await setRate(today, 19.9);
    assert.equal((await ok('maria', 'GET', `/api/approvals/${d}`)).doc.planned_total, 85840);
    // 회수 → 금액 수정 → 재상신: 고정 환율 유지(19.9 아님)
    await ok('maria', 'POST', `/api/approvals/${d}/withdraw`);
    await ok('maria', 'PUT', `/api/approvals/${d}`, { ...body, payment_plan: { ...body.payment_plan, per_sub: 1100 } });
    det = await ok('maria', 'GET', `/api/approvals/${d}`);
    assert.equal(det.doc.fx_rate, 18.5); assert.equal(det.doc.planned_total, R.round2(5104 * 18.5));
    await ok('maria', 'POST', `/api/approvals/${d}/submit`);
    await ok('sebastian', 'POST', `/api/approvals/${d}/act`, { action: 'approve' });
    det = await ok('christopher', 'GET', `/api/approvals/${d}`);
    assert.equal(det.doc.exec_status, 'pending');

    // ③ 1회차: 증빙 없으면 거부 → 회차 증빙 첨부 → 지급일(09-15) 환율 18.1 로 고정
    const p1 = det.payments[0].id, p2 = det.payments[1].id;
    assert.equal((await call('christopher', 'POST', `/api/approvals/${d}/execute`, { payment_id: p1, actual_amount: 1276, exec_date: '2026-09-15', pay_method: '계좌이체' })).body.error, 'exec_evidence_required');
    await ok('christopher', 'POST', `/api/approvals/${d}/files`, { file_name: 'spei_w1.pdf', kind: '송금증', payment_id: p1, data_url: dataUrl('spei1' + Date.now(), 'application/pdf') });
    const e1 = await ok('christopher', 'POST', `/api/approvals/${d}/execute`, { payment_id: p1, actual_amount: 1276, exec_date: '2026-09-15', pay_method: '계좌이체' });
    assert.equal(e1.fx.rate, 18.1); assert.equal(e1.actual_mxn, R.round2(1276 * 18.1)); assert.equal(e1.finished, false);
    assert.equal((await call('christopher', 'POST', `/api/approvals/${d}/execute`, { payment_id: p1, actual_amount: 1, exec_date: '2026-09-15' })).body.detail, 'payment_not_open');
    let li = (await ok('christopher', 'GET', '/api/approvals')).items.find((i) => i.id === d);
    assert.deepEqual([li.pay_n, li.pay_done, li.next_due, li.stage], [4, 1, '2026-10-12', 'execwait']);
    // 2회차: 문서에 먼저 올린 Factura 를 연결(link_file_ids) · 지급일 09-20 은 그 이전 최근 환율(09-15 18.1)
    const fx2 = await ok('christopher', 'POST', `/api/approvals/${d}/files`, { file_name: 'CFDI_w2.xml', data_url: dataUrl('<cfdi:Comprobante Total="1276.00"/>', 'text/xml') });
    const e2 = await ok('christopher', 'POST', `/api/approvals/${d}/execute`, { payment_id: p2, actual_amount: 1276, exec_date: '2026-09-20', pay_method: '계좌이체', link_file_ids: [fx2.id] });
    assert.equal(e2.fx.rate, 18.1); assert.equal(e2.fx.date, '2026-09-15');
    assert.equal((await ok('christopher', 'GET', `/api/approvals/${d}`)).files.find((f) => f.id === fx2.id).payment_id, p2);
    // 과거 날짜 환율이 나중에 바뀌어도 집행된 회차는 그대로
    await setRate('2026-09-15', 25);
    assert.equal((await ok('christopher', 'GET', `/api/approvals/${d}`)).payments[0].actual_mxn, R.round2(1276 * 18.1));
    // 3·4회차 중단 → 전 회차 처리 → 집행완료 · 사후승인 요청
    const [p3, p4] = (await ok('christopher', 'GET', `/api/approvals/${d}`)).payments.slice(2).map((p) => p.id);
    assert.equal((await call('maria', 'POST', `/api/approvals/${d}/payments/${p3}/skip`, { reason: 'x' })).code, 403);
    assert.equal((await call('christopher', 'POST', `/api/approvals/${d}/payments/${p3}/skip`, {})).code, 400);
    await ok('christopher', 'POST', `/api/approvals/${d}/payments/${p3}/skip`, { reason: '계약 조기 종료' });
    const sk = await ok('christopher', 'POST', `/api/approvals/${d}/payments/${p4}/skip`, { reason: '계약 조기 종료' });
    assert.equal(sk.finished, true);
    det = await ok('jang', 'GET', `/api/approvals/${d}`);
    assert.equal(det.doc.exec_status, 'done'); assert.equal(det.doc.post_status, 'pending');
    assert.equal(det.doc.actual_total, R.round2(1276 * 18.1 * 2)); assert.equal(det.doc.exec_date, '2026-09-20');
    assert.deepEqual(det.actions, ['post_confirm', 'flag']);
    assert.ok(det.events.some((e) => e.action === 'pay_skip') && det.events.some((e) => e.action === 'exec_done'));
    await setRate('2026-09-15', 18.1);

    // ④ USD 기준액: 소계 6,000 → MXN 128,760 ≥ 100,000 → 사전승인
    const d2 = (await ok('oscar', 'POST', '/api/approvals', { category_id: cat, title: 'USD 장비', currency: 'USD', orig_sub: 6000 })).id;
    await setRate(today, 18.5);
    await ok('oscar', 'POST', `/api/approvals/${d2}/submit`);
    assert.ok((await ok('sebastian', 'GET', `/api/approvals/${d2}`)).lines.some((l) => l.step_type === 'pre_ceo'));

    // ⑤ 분할: 합계 불일치 거부 · 선급 30% + 잔금
    assert.equal((await call('oscar', 'POST', '/api/approvals', { category_id: cat, title: '분할', orig_sub: 1000, payment_type: 'installment',
      schedule: [{ due_date: '2026-10-01', amount: 300 }, { due_date: '2026-11-01', amount: 500 }] })).body.detail, 'schedule_sum');
    const d3 = (await ok('oscar', 'POST', '/api/approvals', { category_id: cat, title: '분할', orig_sub: 1000, payment_type: 'installment',
      schedule: [{ due_date: '2026-10-01', amount: 348 }, { due_date: '2026-11-01', amount: 812 }] })).id;
    const d3det = await ok('oscar', 'GET', `/api/approvals/${d3}`);
    assert.deepEqual(d3det.payments.map((p) => p.planned_mxn), [348, 812]); assert.equal(d3det.doc.pay_due, '2026-10-01');

    // ⑥ 본문 그림 — 위험한 주소 거부 · 재기안 복사
    assert.equal((await call('oscar', 'POST', '/api/approvals', { title: 'x', body_rich: [{ t: 'img', src: 'javascript:alert(1)' }] })).body.detail, 'bad_image');
    assert.equal((await call('oscar', 'POST', '/api/approvals', { title: 'x', body_rich: [{ t: 'img', src: 'data:image/svg+xml;base64,PHN2Zz4=' }] })).body.detail, 'bad_image');
    await ok('jang', 'POST', `/api/approvals/${d2}/act`, { action: 'approve' }).catch(() => {});
    const d4 = (await ok('maria', 'POST', '/api/approvals', { category_id: cat, title: '그림 재기안', orig_sub: 10, currency: 'USD', body_rich: body.body_rich })).id;
    await ok('maria', 'POST', `/api/approvals/${d4}/submit`);
    await ok('sebastian', 'POST', `/api/approvals/${d4}/act`, { action: 'reject', comment: '다시' });
    const d5 = (await ok('maria', 'POST', `/api/approvals/${d4}/resubmit`)).id;
    const d5det = await ok('maria', 'GET', `/api/approvals/${d5}`);
    assert.equal(d5det.body_nodes[1].src, png); assert.equal(d5det.doc.currency, 'USD');
    assert.equal(d5det.doc.fx_locked_at, null, '재기안 새 문서는 상신 때 새로 고정'); assert.equal(d5det.payments.length, 1);
  } finally {
    await app.close();
  }
});

// ═════════ 0244 — 결재선 수동 수정 · 내용 수정 · 추가 작성 ═════════
test('A16 권한 — 내용 수정·추가 작성·결재선 수정', () => {
  const c = (uid, o = {}) => ({ uid, isDirector: false, isCeo: false, isFinance: false, ...o });
  const d = { status: 'progress', drafter_id: 5 };
  const ls = [{ step_type: 'draft', user_id: 5, status: 'done' }, { step_type: 'pass', user_id: 6, status: 'done' },
    { step_type: 'approve', user_id: 4, status: 'pending' }, { step_type: 'director', user_id: 1, status: 'waiting' }, { step_type: 'post_ceo', user_id: 3, status: 'waiting' }];
  assert.equal(R.canEditContent(c(4), d, ls), true, '현재 차례 중간결재자');
  assert.equal(R.canEditContent(c(5), d, ls), false, '기안자는 상신 후 수정 불가(회수 후 편집)');
  assert.equal(R.canEditContent(c(1, { isDirector: true }), d, ls), true, '디렉터는 차례 밖에도');
  assert.equal(R.canEditContent(c(3), d, ls), false);
  assert.equal(R.canEditContent(c(1, { isDirector: true }), { ...d, status: 'approved' }, ls), false, '승인 후 내용 수정 불가');
  const passLs = ls.map((l) => (l.step_type === 'approve' ? { ...l, step_type: 'pass' } : l));
  assert.equal(R.canEditContent(c(4), d, passLs), false, '경유는 수정 불가');
  assert.equal(R.canAddend(c(4), d, passLs), true, '경유도 추가 작성은 가능');
  assert.equal(R.canAddend(c(1, { isDirector: true }), { ...d, status: 'approved' }, ls), true, '디렉터 추가 작성은 승인 후에도');
  assert.equal(R.canAddend(c(6), d, ls), false, '이미 처리한 사람은 차례가 아님');
  assert.equal(R.canEditLines(c(1, { isDirector: true }), d), true);
  assert.equal(R.canEditLines(c(4), d), false);
  assert.equal(R.canEditLines(c(1, { isDirector: true }), { status: 'approved', post_status: 'confirmed' }), false);
  assert.equal(R.editorStep(c(1, { isDirector: true }), ls), 'director_override');
  assert.equal(R.editorStep(c(4), ls), 'approve');
});
test('A17 결재선 수정 계획 — 처리된 단계 잠금 · 디렉터 1명 · 사전승인 마지막 · 기안자 제외', () => {
  const doc = { status: 'progress', drafter_id: 5 };
  const lines = [{ id: 1, step_order: 0, step_type: 'draft', user_id: 5, status: 'done' }, { id: 2, step_order: 1, step_type: 'approve', user_id: 4, status: 'done' },
    { id: 3, step_order: 2, step_type: 'director', user_id: 1, status: 'pending' }, { id: 9, step_order: 99, step_type: 'post_ceo', user_id: 3, status: 'waiting' }];
  const act = [1, 2, 3, 4, 5, 6];
  const ok = R.planLineEdit({ lines, doc, activeUserIds: act, postUser: 3, steps: [{ step_type: 'agree', user_id: 2 }, { step_type: 'director', user_id: 1 }, { step_type: 'pre_ceo', user_id: 3 }] });
  assert.deepEqual(ok.locked.map((l) => l.id), [1, 2]);
  assert.deepEqual(ok.rows.map((r) => [r.step_order, r.step_type, r.user_id]), [[2, 'agree', 2], [3, 'director', 1], [4, 'pre_ceo', 3]]);
  const e = (steps, extra = {}) => R.planLineEdit({ lines, doc, activeUserIds: act, postUser: 3, steps, ...extra }).error;
  assert.equal(e([{ step_type: 'agree', user_id: 2 }]), 'director_count');
  assert.equal(e([{ step_type: 'director', user_id: 1 }, { step_type: 'director', user_id: 6 }]), 'director_count');
  assert.equal(e([{ step_type: 'pre_ceo', user_id: 3 }, { step_type: 'director', user_id: 1 }]), 'pre_ceo_last');
  assert.equal(e([{ step_type: 'approve', user_id: 5 }, { step_type: 'director', user_id: 1 }]), 'drafter_in_line');
  assert.equal(e([{ step_type: 'approve', user_id: 99 }, { step_type: 'director', user_id: 1 }]), 'bad_user');
  assert.equal(e([{ step_type: 'post_ceo', user_id: 3 }, { step_type: 'director', user_id: 1 }]), 'bad_step_type');
  assert.equal(e([{ step_type: 'agree', user_id: 2 }, { step_type: 'agree', user_id: 2 }, { step_type: 'director', user_id: 1 }]), 'duplicate');
  assert.equal(e([{ step_type: 'director', user_id: 1 }], { postUser: 5 }), 'drafter_in_line');
  const doneLines = lines.map((l) => (l.step_type === 'director' ? { ...l, status: 'done' } : l));
  assert.equal(R.planLineEdit({ lines: doneLines, doc: { status: 'approved', exec_status: 'done', drafter_id: 5 }, activeUserIds: act, postUser: 1, steps: [{ step_type: 'agree', user_id: 2 }] }).error, 'only_post_editable', '집행 후에는 사후승인자만');
  const re = R.planLineEdit({ lines: doneLines, doc: { status: 'approved', exec_status: 'pending', drafter_id: 5 }, activeUserIds: act, postUser: 1, steps: [{ step_type: 'agree', user_id: 2 }] });
  assert.deepEqual(re.rows.map((r) => [r.step_order, r.step_type]), [[3, 'agree']], '승인 후 집행 전: 단계 추가 가능');
  assert.equal(R.planLineEdit({ lines, doc: { status: 'approved', drafter_id: 5 }, activeUserIds: act, postUser: 1, steps: [] }).postUser, 1);
});
test('A18 내용 비교 — 바뀐 항목만 · 금액 변경 판정', () => {
  const a = { title: '랙', vendor: 'A', category_name: '외주', currency: 'MXN', orig_total: 116, planned_total: 116, iva_applied: true, pay_method: '계좌이체',
    payment_type: 'once', payments: [{ due_date: '2026-10-01', amount: 116 }], body: '원문\n[그림]', body_nodes: [{ t: 'p', v: '원문' }, { t: 'img', src: 'x' }] };
  assert.deepEqual(R.diffContent(a, { ...a }), []);
  const ch = R.diffContent(a, { ...a, title: '랙 설치', orig_total: 232, planned_total: 232, payments: [{ due_date: '2026-10-01', amount: 232 }], body: '원문 보완', body_nodes: [{ t: 'p', v: '원문 보완' }] });
  assert.deepEqual(ch.map((c) => c.field), ['title', 'amount', 'schedule', 'body', 'images']);
  assert.equal(ch.find((c) => c.field === 'amount').new, '$232.00');
  assert.equal(R.amountChanged(ch), true);
  assert.equal(R.amountChanged(R.diffContent(a, { ...a, vendor: 'B' })), false);
});

test('E E2E — 디렉터 결재선 수정 · 결재자 내용 수정/반려/추가 작성 · 사전승인 자동 추가', { skip: !PG }, async () => {
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
  const steps = async (id) => (await ok('sebastian', 'GET', `/api/approvals/${id}`)).lines.map((l) => `${l.step_type}:${Object.keys(U).find((k) => U[k].id === l.user_id)}:${l.status}`);
  try {
    await pool.query(`UPDATE approval_settings SET ceo_pre_threshold=100000, threshold_basis='total', ceo_user_id=$1, director_user_id=$2, finance_user_id=$3 WHERE id=1`,
      [U.jang.id, U.sebastian.id, U.christopher.id]);
    const boot = await ok('maria', 'GET', '/api/approvals/bootstrap');
    const cat = boot.categories[0].id, cat2 = boot.categories[1].id;
    await pool.query(`DELETE FROM approval_category_steps WHERE category_id=$1`, [cat]);
    await ok('sebastian', 'POST', `/api/approvals/categories/${cat}/steps`, { step_type: 'approve', user_id: U.maria.id });
    const form = { category_id: cat, title: '창고 소모품', vendor: 'Empaques', orig_sub: 1000, body_rich: [{ t: 'p', v: '원문 내용' }] };
    const d = (await ok('oscar', 'POST', '/api/approvals', form)).id;
    await ok('oscar', 'POST', `/api/approvals/${d}/submit`);
    assert.deepEqual(await steps(d), ['draft:oscar:done', 'approve:maria:pending', 'director:sebastian:waiting', 'post_ceo:jang:waiting']);

    // ① 2차(중간결재 Maria): 내용 수정 → 이력 · 기안자 알림. 다른 사람은 불가
    assert.equal((await call('luis', 'PUT', `/api/approvals/${d}/content`, form)).code, 404);
    assert.equal((await call('oscar', 'PUT', `/api/approvals/${d}/content`, form)).code, 403, '기안자는 상신 후 수정 불가');
    const e1 = await ok('maria', 'PUT', `/api/approvals/${d}/content`, { ...form, title: '창고 소모품 (10월)', body_rich: [{ t: 'p', v: '원문 내용\n수량 보완: 테이프 48 → 60' }], reason: '수량 정정' });
    assert.deepEqual(e1.changes.map((c) => c.field), ['title', 'body']);
    let det = await ok('oscar', 'GET', `/api/approvals/${d}`);
    assert.equal(det.doc.title, '창고 소모품 (10월)'); assert.equal(det.revisions.length, 1);
    assert.equal(det.revisions[0].step_type, 'approve'); assert.equal(det.revisions[0].reason, '수량 정정');
    assert.ok((await ok('oscar', 'GET', '/api/approvals/notifications')).items.some((x) => x.document_id === d && /문서 수정/.test(x.kind)));
    assert.equal((await ok('maria', 'PUT', `/api/approvals/${d}/content`, { ...form, title: '창고 소모품 (10월)', body_rich: [{ t: 'p', v: '원문 내용\n수량 보완: 테이프 48 → 60' }] })).changes.length, 0, '바뀐 게 없으면 이력 안 남김');
    // ② Maria 추가 작성 + 파일
    const ad = await ok('maria', 'POST', `/api/approvals/${d}/addenda`, { body_rich: [{ t: 'p', v: '중간결재 의견: 단가 확인함' }, { t: 'img', src: 'data:image/png;base64,iVBORw0KGgo=' }] });
    await ok('maria', 'POST', `/api/approvals/${d}/files`, { file_name: '단가비교.xlsx', addendum_id: ad.id, data_url: dataUrl('xlsx' + Date.now(), 'application/octet-stream') });
    assert.equal((await call('oscar', 'POST', `/api/approvals/${d}/files`, { file_name: 'x.pdf', addendum_id: ad.id, data_url: dataUrl('x', 'application/pdf') })).body.detail, 'bad_addendum');
    assert.equal((await call('luis', 'POST', `/api/approvals/${d}/addenda`, { body_rich: [{ t: 'p', v: 'x' }] })).code, 404);
    assert.equal((await call('oscar', 'POST', `/api/approvals/${d}/addenda`, { body_rich: [{ t: 'p', v: 'x' }] })).code, 403, '기안자는 추가 작성 대신 댓글');
    det = await ok('sebastian', 'GET', `/api/approvals/${d}`);
    assert.equal(det.addenda.length, 1); assert.equal(det.addenda[0].nodes[1].t, 'img'); assert.equal(det.addenda[0].step_type, 'approve');
    assert.equal(det.files.find((f) => f.file_name === '단가비교.xlsx').addendum_id, ad.id);
    await ok('maria', 'POST', `/api/approvals/${d}/act`, { action: 'approve' });
    assert.equal((await call('maria', 'PUT', `/api/approvals/${d}/content`, form)).code, 403, '처리 후에는 수정 불가');

    // ③ 디렉터(내 차례): 결재선 수정 — 합의(Christopher) 추가 + 사전승인 추가, 본인 차례 유지 → 알림 중복 없음
    assert.deepEqual(det.lines.find((l) => l.step_type === 'director').status === 'waiting', true);
    det = await ok('sebastian', 'GET', `/api/approvals/${d}`);
    assert.equal(det.can_edit_lines, true); assert.equal(det.can_edit_content, true); assert.equal(det.can_addend, true);
    assert.equal((await call('maria', 'PUT', `/api/approvals/${d}/lines`, { steps: [], post_user_id: U.jang.id })).code, 403);
    const nBefore = (await pool.query(`SELECT count(*)::int c FROM approval_notifications WHERE user_id=$1 AND document_id=$2`, [U.sebastian.id, d])).rows[0].c;
    await ok('sebastian', 'PUT', `/api/approvals/${d}/lines`, { steps: [{ step_type: 'director', user_id: U.sebastian.id }, { step_type: 'agree', user_id: U.christopher.id }, { step_type: 'pre_ceo', user_id: U.jang.id }], post_user_id: U.jang.id, reason: '금액 검토 필요' });
    assert.deepEqual(await steps(d), ['draft:oscar:done', 'approve:maria:done', 'director:sebastian:pending', 'agree:christopher:waiting', 'pre_ceo:jang:waiting', 'post_ceo:jang:waiting']);
    const nAfter = (await pool.query(`SELECT count(*)::int c FROM approval_notifications WHERE user_id=$1 AND document_id=$2`, [U.sebastian.id, d])).rows[0].c;
    assert.equal(nAfter, nBefore, '이미 내 차례였으면 다시 알림 안 감');
    det = await ok('sebastian', 'GET', `/api/approvals/${d}`);
    assert.equal(det.doc.ceo_pre_required, true);
    const le = det.events.find((x) => x.action === 'lines_edit');
    assert.match(le.detail, /변경 전: .*중간결재 Maria✓ › 디렉터 결재 Sebastian/); assert.match(le.detail, /합의 Christopher/); assert.match(le.detail, /사유: 금액 검토 필요/);
    // 잘못된 수정은 거부(처리된 단계는 목록에 없어도 잠겨 유지됨)
    assert.equal((await call('sebastian', 'PUT', `/api/approvals/${d}/lines`, { steps: [{ step_type: 'agree', user_id: U.christopher.id }], post_user_id: U.jang.id })).body.detail, 'director_count');
    assert.equal((await call('sebastian', 'PUT', `/api/approvals/${d}/lines`, { steps: [{ step_type: 'director', user_id: U.sebastian.id }, { step_type: 'approve', user_id: U.oscar.id }], post_user_id: U.jang.id })).body.detail, 'drafter_in_line');
    // 디렉터: 내 차례에 금액 수정 + 추가 작성 → 승인
    const e2 = await ok('sebastian', 'PUT', `/api/approvals/${d}/content`, { ...form, category_id: cat2, title: '창고 소모품 (10월)', orig_sub: 1200, body_rich: [{ t: 'p', v: '원문 내용\n수량 보완: 테이프 48 → 60' }] });
    assert.deepEqual(e2.changes.map((c) => c.field), ['category', 'amount', 'schedule']);
    assert.ok((await ok('maria', 'GET', '/api/approvals/notifications')).items.some((x) => x.document_id === d && x.kind === '승인 후 금액 변경'), '이미 승인한 Maria 에게 금액 변경 알림');
    await ok('sebastian', 'POST', `/api/approvals/${d}/addenda`, { body_rich: [{ t: 'p', v: '디렉터: 10월분까지만 승인' }] });
    await ok('sebastian', 'POST', `/api/approvals/${d}/act`, { action: 'approve' });
    assert.deepEqual(await steps(d), ['draft:oscar:done', 'approve:maria:done', 'director:sebastian:done', 'agree:christopher:pending', 'pre_ceo:jang:waiting', 'post_ceo:jang:waiting']);
    // ④ 디렉터가 차례 밖에서 결재선 수정: 합의 대기자를 Luis 로 교체 → Christopher 알림 정리 · Luis 알림
    await ok('sebastian', 'PUT', `/api/approvals/${d}/lines`, { steps: [{ step_type: 'agree', user_id: U.luis.id }, { step_type: 'pre_ceo', user_id: U.jang.id }], post_user_id: U.jang.id });
    assert.deepEqual(await steps(d), ['draft:oscar:done', 'approve:maria:done', 'director:sebastian:done', 'agree:luis:pending', 'pre_ceo:jang:waiting', 'post_ceo:jang:waiting']);
    assert.ok(!(await ok('christopher', 'GET', '/api/approvals/notifications')).items.some((x) => x.document_id === d && x.kind === '합의 요청' && !x.read_at), '빠진 사람의 요청 알림 정리');
    assert.ok((await ok('luis', 'GET', '/api/approvals/notifications')).items.some((x) => x.document_id === d && x.kind === '합의 요청'));
    // ⑤ 최종(대표이사 사전승인) 단계: Luis 합의 → Jang 이 내용 수정 · 반려 가능
    await ok('luis', 'POST', `/api/approvals/${d}/act`, { action: 'approve' });
    det = await ok('jang', 'GET', `/api/approvals/${d}`);
    assert.equal(det.can_edit_content, true); assert.equal(det.can_addend, true); assert.equal(det.can_edit_lines, false);
    await ok('jang', 'PUT', `/api/approvals/${d}/content`, { ...form, category_id: cat2, title: '창고 소모품 (10월) — 대표 확인', orig_sub: 1200, body_rich: [{ t: 'p', v: '원문 내용\n수량 보완: 테이프 48 → 60' }] });
    assert.equal((await ok('jang', 'GET', `/api/approvals/${d}`)).revisions.at(-1).step_type, 'pre_ceo');
    await ok('jang', 'POST', `/api/approvals/${d}/act`, { action: 'reject', comment: '11월분과 합쳐 다시 올려 주세요' });
    assert.equal((await ok('oscar', 'GET', `/api/approvals/${d}`)).doc.status, 'rejected');
    assert.equal((await call('sebastian', 'PUT', `/api/approvals/${d}/lines`, { steps: [], post_user_id: U.jang.id })).code, 409, '반려된 문서는 결재선 수정 불가');

    // ⑥ 금액이 커져 기준액을 넘으면 사전승인 자동 추가(중간결재자 수정)
    const d2 = (await ok('oscar', 'POST', '/api/approvals', form)).id;
    await ok('oscar', 'POST', `/api/approvals/${d2}/submit`);
    const e3 = await ok('maria', 'PUT', `/api/approvals/${d2}/content`, { ...form, orig_sub: 90000 });
    assert.equal(e3.pre_added, true); assert.equal(e3.planned_total, 104400);
    assert.deepEqual(await steps(d2), ['draft:oscar:done', 'approve:maria:pending', 'director:sebastian:waiting', 'pre_ceo:jang:waiting', 'post_ceo:jang:waiting']);
    // 디렉터가 사전승인을 빼면(결재선 수정) 기록 남김
    await ok('sebastian', 'PUT', `/api/approvals/${d2}/lines`, { steps: [{ step_type: 'approve', user_id: U.maria.id }, { step_type: 'director', user_id: U.sebastian.id }], post_user_id: U.jang.id, reason: '긴급 · 사후 보고' });
    const d2det = await ok('sebastian', 'GET', `/api/approvals/${d2}`);
    assert.equal(d2det.doc.ceo_pre_required, false); assert.ok(!d2det.lines.some((l) => l.step_type === 'pre_ceo'));
    assert.equal(d2det.lines.find((l) => l.step_type === 'approve').status, 'pending', 'Maria 차례 유지');
    // ⑦ 승인 후(집행 전): 단계 추가 → 다시 결재중 · 처리 후 다시 승인 / 집행 후에는 사후승인자만
    await ok('maria', 'POST', `/api/approvals/${d2}/act`, { action: 'approve' });
    await ok('sebastian', 'POST', `/api/approvals/${d2}/act`, { action: 'approve' });
    assert.equal((await ok('sebastian', 'GET', `/api/approvals/${d2}`)).doc.status, 'approved');
    const ro = await ok('sebastian', 'PUT', `/api/approvals/${d2}/lines`, { steps: [{ step_type: 'agree', user_id: U.luis.id }], post_user_id: U.jang.id, reason: '재무 확인 추가' });
    assert.equal(ro.reopened, true); assert.equal(ro.status, 'progress');
    let d2b = await ok('sebastian', 'GET', `/api/approvals/${d2}`);
    assert.deepEqual([d2b.doc.status, d2b.doc.exec_status], ['progress', 'none']);
    assert.equal(d2b.lines.find((l) => l.step_type === 'agree').status, 'pending');
    assert.match(d2b.events.filter((x) => x.action === 'lines_edit').pop().detail, /승인 후 결재선 추가/);
    assert.ok((await ok('oscar', 'GET', '/api/approvals/notifications')).items.some((x) => x.document_id === d2 && /재결재/.test(x.kind)));
    assert.equal((await call('christopher', 'POST', `/api/approvals/${d2}/execute`, { actual_total: 1, exec_date: '2026-10-02' })).code, 409, '재결재 중에는 집행 불가');
    await ok('luis', 'POST', `/api/approvals/${d2}/act`, { action: 'approve' });
    d2b = await ok('sebastian', 'GET', `/api/approvals/${d2}`);
    assert.deepEqual([d2b.doc.status, d2b.doc.exec_status], ['approved', 'pending'], '다시 승인완료 · 집행대기');
    // 승인 후 결재선에서 사후승인자만 바꾸면 재결재 아님
    const po = await ok('sebastian', 'PUT', `/api/approvals/${d2}/lines`, { steps: [], post_user_id: U.jang.id });
    assert.equal(po.reopened, false);
    await ok('sebastian', 'PUT', `/api/approvals/${d2}/lines`, { steps: [], post_user_id: U.christopher.id });
    assert.equal((await ok('sebastian', 'GET', `/api/approvals/${d2}`)).lines.find((l) => l.step_type === 'post_ceo').user_id, U.christopher.id);
    await ok('sebastian', 'POST', `/api/approvals/${d2}/addenda`, { body_rich: [{ t: 'p', v: '집행 시 분할 지급 협의' }] });
    assert.equal((await call('maria', 'POST', `/api/approvals/${d2}/addenda`, { body_rich: [{ t: 'p', v: 'x' }] })).code, 403, '승인 후 일반 결재자는 추가 작성 불가');
    assert.equal((await call('sebastian', 'PUT', `/api/approvals/${d2}/content`, form)).code, 403, '승인 후 내용 수정 불가');
    // 집행 후: 단계 추가 불가 · 사후승인자는 변경 가능
    await ok('christopher', 'POST', `/api/approvals/${d2}/files`, { file_name: 'spei_d2.pdf', kind: '송금증', data_url: dataUrl('spei-d2-' + Date.now(), 'application/pdf') });
    await ok('christopher', 'POST', `/api/approvals/${d2}/execute`, { actual_total: 104400, exec_date: '2026-10-02', pay_method: '계좌이체' });
    assert.equal((await call('sebastian', 'PUT', `/api/approvals/${d2}/lines`, { steps: [{ step_type: 'agree', user_id: U.luis.id }], post_user_id: U.jang.id })).body.detail, 'only_post_editable');
    await ok('sebastian', 'PUT', `/api/approvals/${d2}/lines`, { steps: [], post_user_id: U.sebastian.id });
    assert.equal((await ok('sebastian', 'GET', `/api/approvals/${d2}`)).lines.find((l) => l.step_type === 'post_ceo').user_id, U.sebastian.id);

    // ⑧ 결재 전(작성 중): 디렉터가 결재선을 직접 짜서 상신 — 내 결재 뒤 경유 Maria → 합의 Christopher
    const cs = (await ok('sebastian', 'POST', '/api/approvals', { ...form, title: '디렉터 기안 · 직접 결재선', orig_sub: 500,
      custom_steps: [{ step_type: 'pass', user_id: U.maria.id }, { step_type: 'agree', user_id: U.christopher.id }] })).id;
    assert.deepEqual((await ok('sebastian', 'GET', `/api/approvals/${cs}`)).doc.custom_steps, [{ step_type: 'pass', user_id: U.maria.id }, { step_type: 'agree', user_id: U.christopher.id }]);
    assert.equal((await call('sebastian', 'PUT', `/api/approvals/${cs}`, { ...form, custom_steps: [{ step_type: 'pre_ceo', user_id: U.jang.id }, { step_type: 'agree', user_id: U.christopher.id }] })).body.detail, 'pre_ceo_last');
    assert.equal((await call('sebastian', 'PUT', `/api/approvals/${cs}`, { ...form, custom_steps: [{ step_type: 'director', user_id: U.sebastian.id }] })).body.detail, 'bad_step_type');
    await ok('sebastian', 'POST', `/api/approvals/${cs}/submit`);
    assert.deepEqual(await steps(cs), ['draft:sebastian:done', 'director:sebastian:done', 'pass:maria:pending', 'agree:christopher:waiting', 'post_ceo:jang:waiting']);
    // 직원이 custom_steps 를 보내도 무시(카테고리 템플릿)
    const emp = (await ok('oscar', 'POST', '/api/approvals', { ...form, custom_steps: [{ step_type: 'agree', user_id: U.luis.id }] })).id;
    assert.equal((await ok('oscar', 'GET', `/api/approvals/${emp}`)).doc.custom_steps, null);
    // 기준액 이상이면 목록에 사전승인이 없어도 자동으로 붙음
    const cs2 = (await ok('sebastian', 'POST', '/api/approvals', { ...form, title: '디렉터 기안 · 큰 금액', orig_sub: 100000, custom_steps: [{ step_type: 'agree', user_id: U.christopher.id }] })).id;
    await ok('sebastian', 'POST', `/api/approvals/${cs2}/submit`);
    assert.deepEqual(await steps(cs2), ['draft:sebastian:done', 'director:sebastian:done', 'agree:christopher:pending', 'pre_ceo:jang:waiting', 'post_ceo:jang:waiting']);
    // 빈 목록 = 내 결재만 → 상신 즉시 승인완료
    const cs3 = (await ok('sebastian', 'POST', '/api/approvals', { ...form, title: '디렉터 기안 · 단독', custom_steps: [] })).id;
    await ok('sebastian', 'POST', `/api/approvals/${cs3}/submit`);
    assert.equal((await ok('sebastian', 'GET', `/api/approvals/${cs3}`)).doc.status, 'approved');
  } finally {
    await app.close();
  }
});
