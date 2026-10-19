// =====================================================================
// 0287 화면 행동 — 재무 › 커미션(refatrix-commission.html) · 전자결재(refatrix-approval.html)
//   jsdom 으로 실제 API(PostgreSQL)에 붙여 돈다.
//   실행: TEST_PG_URL=postgres://... node --test test/commission_approval_front.test.mjs   (전체 migrate 후)
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const COM = readFileSync(join(REPO, 'refatrix-commission.html'), 'utf8');
const APR = readFileSync(join(REPO, 'refatrix-approval.html'), 'utf8');
const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
const TAG = 'CAPFRONT';

after(async () => {
  if (!PG) return;
  const { pool } = await import('../src/db.js');
  await pool.end().catch(() => {});
  setTimeout(() => process.exit(process.exitCode || 0), 300);
});

test('S0 정적 — 빌드 토큰 · 새 코드에 인라인 onclick 없음 · 수령증/문서생성 문구', () => {
  assert.match(COM, /<title>[^<]*b1019cap<\/title>/);
  assert.match(APR, /<title>[^<]*b20261019cap<\/title>/);
  const start = COM.indexOf('// ══ 0287'); const end = COM.indexOf('// ── 지급 전표 내역 + 증빙 열람 ──');
  assert.ok(start > 0 && end > start);
  const block = COM.slice(start, end);
  assert.doesNotMatch(block, /onclick=/, '새 코드는 addEventListener(위임)만');
  for (const k of ['커미션 지급승인 전자문서 생성', 'RECIBO DE PAGO DE COMISIONES', 'RECIBÍ DE CONFORMIDAD', '수령증 업로드 · 지급 확정(반제) · 문서 마감']) assert.ok(COM.includes(k), k);
  assert.ok(APR.includes('커미션 화면에서 수령증으로 지급'));
});

test('S1 화면 흐름 — 확정 월 → 전자문서 생성 → (상신·승인) → 수령증 인쇄 → 스캔 업로드 → 마감 · 전자결재 상세/인쇄 표', { skip: !PG }, async () => {
  const { JSDOM } = await import('jsdom');
  const { buildApp } = await import('../src/server.js');
  const { pool } = await import('../src/db.js');
  const q = (s, a) => pool.query(s, a);
  const app = buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const API = `http://127.0.0.1:${app.server.address().port}`;
  const doms = [];
  // ── 데이터
  const U = `(SELECT id FROM users WHERE login_id LIKE 'capfront%')`;
  const clean = async () => {
    const D = `(SELECT id FROM approval_documents WHERE drafter_id IN ${U})`;
    await q(`DELETE FROM commission_approval_docs WHERE agent_id IN ${U}`);
    await q(`UPDATE approval_payments SET txn_id=NULL WHERE document_id IN ${D}`);
    await q(`DELETE FROM transactions WHERE created_by IN ${U} OR owner_id IN ${U}`);
    for (const t of ['approval_files', 'approval_events', 'approval_notifications', 'approval_lines', 'approval_viewers', 'approval_payments']) await q(`DELETE FROM ${t} WHERE document_id IN ${D}`);
    await q(`DELETE FROM approval_documents WHERE drafter_id IN ${U}`);
    await q(`DELETE FROM commission_payment_allocations WHERE payment_id IN (SELECT id FROM commission_payments WHERE agent_id IN ${U})`);
    await q(`DELETE FROM commission_payouts WHERE agent_id IN ${U}`);
    await q(`DELETE FROM commission_payments WHERE agent_id IN ${U}`);
    await q(`DELETE FROM commission_agent_periods WHERE user_id IN ${U}`);
    await q(`DELETE FROM commission_agents WHERE user_id IN ${U}`);
    await q(`DELETE FROM sales_payment_allocations WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE memo LIKE '%${TAG}%')`);
    await q(`DELETE FROM sales_payments WHERE memo LIKE '%${TAG}%'`);
    await q(`DELETE FROM sales_invoices WHERE memo LIKE '%${TAG}%'`);
    await q(`DELETE FROM bonus_payouts WHERE user_id IN ${U} OR confirmed_by IN ${U} OR updated_by IN ${U}`);
    await q(`DELETE FROM commission_batches WHERE settle_ym='2026-05' OR confirmed_by IN ${U}`);
    await q(`DELETE FROM audit_log WHERE user_id IN ${U}`);
    await q(`DELETE FROM user_page_access WHERE user_id IN ${U}`);
    await q(`DELETE FROM customers WHERE name LIKE '${TAG}%'`);
    await q(`DELETE FROM accounts WHERE name LIKE '${TAG}%'`);
    await q(`UPDATE approval_settings SET director_user_id=NULL, ceo_user_id=NULL, finance_user_id=NULL WHERE director_user_id IN ${U} OR ceo_user_id IN ${U} OR finance_user_id IN ${U}`);
    await q(`DELETE FROM users WHERE login_id LIKE 'capfront%'`);
  };
  await clean();
  const mk = async (name, role, login) => Number((await q(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name, role, login])).rows[0].id);
  const ID = { dir: await mk(`${TAG}Sebastian`, 'director', 'capfront_dir'), fin: await mk(`${TAG}Chris`, 'treasury', 'capfront_fin'), ceo: await mk(`${TAG}Jang`, 'socio', 'capfront_ceo'), rep: await mk(`${TAG}Armando`, 'sales', 'capfront_rep') };
  const TOK = Object.fromEntries(Object.entries(ID).map(([k, v]) => [k, app.jwt.sign({ sub: v })]));
  await q(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'commission','anywhere','edit')`, [ID.fin]);
  await q(`UPDATE approval_settings SET director_user_id=$1, ceo_user_id=$2, finance_user_id=$3, ceo_pre_threshold=100000 WHERE id=1`, [ID.dir, ID.ceo, ID.fin]);
  const acc = Number((await q(`INSERT INTO accounts (name, type, currency, open_balance, created_by) VALUES ($1,'bank','MXN',0,$2) RETURNING id`, [`${TAG}은행`, ID.dir])).rows[0].id);
  const cust = Number((await q(`INSERT INTO customers (name, code, credit_days, owner_id, phone, created_by) VALUES ($1,$2,30,$3,'+52 999 000 0000',$4) RETURNING id`, [`${TAG}Refaccionaria Sur`, `${TAG}-1`, ID.rep, ID.dir])).rows[0].id);
  await q(`INSERT INTO commission_agents (user_id, default_rate, active, created_by, updated_by) VALUES ($1,5,true,$2,$2)`, [ID.rep, ID.dir]);
  await q(`INSERT INTO commission_agent_periods (user_id, start_date, end_date, basis, rate, match_on, created_by, updated_by) VALUES ($1,'2026-04-01',NULL,'collection',5,'invoice',$2,$2)`, [ID.rep, ID.dir]);
  const inv = Number((await q(`INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn, status, owner_id, memo, created_by)
    VALUES ('CF-001',$1,'2026-04-20',30,'2026-05-20',24690.6,3950.5,28641.1,'posted',$2,$3,$2) RETURNING id`, [cust, ID.dir, `${TAG} CF-001`])).rows[0].id);
  const sp = Number((await q(`INSERT INTO sales_payments (customer_id, pay_date, account_id, amount, memo, created_by) VALUES ($1,'2026-05-12',$2,28641.1,$3,$4) RETURNING id`, [cust, acc, `${TAG} p`, ID.dir])).rows[0].id);
  await q(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount) VALUES ($1,$2,28641.1)`, [sp, inv]);
  const api = async (who, method, url, payload) => {
    const res = await app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + TOK[who] } });
    const b = res.json(); assert.ok(res.statusCode < 300, `${url} ${res.statusCode} ${JSON.stringify(b)}`); return b;
  };
  await api('dir', 'POST', '/api/commission/batches/2026-05/confirm');   // 커미션 = 24,690.60 × 5% = 1,234.53

  const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return; } catch { /* 아직 */ } await new Promise((r) => setTimeout(r, 25)); } throw new Error('timeout: ' + fn.toString().slice(0, 160)); };
  const openPage = (html, file, who, role, hash = '') => {
    const opened = [];
    const dom = new JSDOM(html.replace(/<script src=[^>]*><\/script>/g, ''), {
      runScripts: 'dangerously', pretendToBeVisual: true, url: `https://erp.test/${file}${hash}`,
      beforeParse(w) {
        w.fetch = (u, o) => fetch(u, o); w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {}; w.print = () => {};
        w.open = () => { const doc = { html: '', open() { this.html = ''; }, write(s) { this.html += s; }, close() {} }; const win = { document: doc, focus() {}, print() { win.printed = true; } }; opened.push(win); return win; };
        w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: TOK[who], api: API, user: { id: ID[who], name: who, role } }));
      },
    });
    doms.push(dom);
    const w = dom.window; const errs = []; w.addEventListener('error', (e) => errs.push(e.message));
    return { w, d: w.document, $: (s) => w.document.querySelector(s), opened, errs };
  };
  const click = (p, el) => { assert.ok(el, 'element'); el.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true })); };

  try {
    // ── 디렉터: 전자결재에서 넘어온 링크처럼 사원·월 자동 선택 → 지급 대상 + 「전자문서 생성」
    const c = openPage(COM, 'refatrix-commission.html', 'dir', 'director', `#cm_agent=${ID.rep}&cm_ym=2026-05`);
    await until(() => c.$('#apBox') && !c.$('#apBox').classList.contains('hidden') && c.$('[data-ap="create"]'));
    assert.equal(c.$('#agentSel').value, String(ID.rep)); assert.equal(c.$('#payMonth').value, '2026-05');
    assert.match(c.$('#payBody').textContent, /CF-001/);
    assert.match(c.$('#payBody').textContent, /2026-05-12/, '수금일 표시');
    assert.match(c.$('#apBox').textContent, /1\. 월 확정/);
    assert.ok(c.$('#apBox .apflow span.done'), '월 확정 완료 표시');
    click(c, c.$('[data-ap="create"]'));
    await until(() => /임시저장 문서를 만들었습니다/.test(c.$('#apMsg') ? c.$('#apMsg').textContent : ''));
    const link = c.$('#apMsg a'); assert.match(link.getAttribute('href'), /^refatrix-approval\.html#doc=\d+$/);
    const docId = Number(link.getAttribute('href').split('=')[1]);
    assert.match(c.$('#apBox').textContent, /결재선·참조를 지정하고 상신/);
    assert.ok(c.$('#payForm').classList.contains('locked'), '문서 진행 중엔 송금 지급 폼 잠김');
    // 미리보기(초안) 수령증
    click(c, c.$('[data-ap="preview"]'));
    await until(() => c.opened.length && c.opened[0].document.html.includes('RECIBO'));
    assert.ok(c.opened[0].document.html.includes('BORRADOR'));

    // ── 전자결재 화면(디렉터): 임시저장 상세에 커미션 지급 내역 표
    const a = openPage(APR, 'refatrix-approval.html', 'dir', 'director', `#doc=${docId}`);
    await until(() => /커미션 지급 내역/.test(a.$('#app').textContent));
    await until(() => [...a.d.querySelectorAll('.card.sec h3')].some((x) => /커미션 지급 내역/.test(x.textContent)));
    const card = [...a.d.querySelectorAll('.card.sec')].find((x) => /^커미션 지급 내역/.test(x.querySelector('h3') ? x.querySelector('h3').textContent : ''));
    assert.match(card.textContent, /CAPFRONTRefaccionaria Sur/); assert.match(card.textContent, /CF-001/); assert.match(card.textContent, /5%/);
    assert.match(card.textContent, /\$1,234\.53/); assert.match(card.textContent, /CAPFRONTArmando/);
    // 상신 → 승인(API) 후 다시 열기 → 집행 칸은 커미션 화면 링크
    await api('dir', 'POST', `/api/approvals/${docId}/submit`, {});
    let det = await api('dir', 'GET', `/api/approvals/${docId}`);
    for (let i = 0; i < 4 && det.doc.status === 'progress'; i++) {
      const pd = det.lines.find((l) => l.status === 'pending');
      const who = Object.keys(ID).find((k) => ID[k] === pd.user_id);
      await api(who, 'POST', `/api/approvals/${docId}/act`, { action: 'approve' });
      det = await api('dir', 'GET', `/api/approvals/${docId}`);
    }
    assert.equal(det.doc.status, 'approved');
    const a2 = openPage(APR, 'refatrix-approval.html', 'fin', 'treasury', `#doc=${docId}`);
    await until(() => [...a2.d.querySelectorAll('#app a')].some((x) => /커미션 화면에서 수령증으로 지급/.test(x.textContent)));
    const cmLink = [...a2.d.querySelectorAll('a')].find((x) => /커미션 화면에서 수령증으로 지급/.test(x.textContent));
    assert.equal(cmLink.getAttribute('href'), `refatrix-commission.html#cm_agent=${ID.rep}&cm_ym=2026-05`);
    assert.ok(!a2.$('[data-act="exec"]'), '여기서 집행 버튼 없음');
    const sheet = a2.w.eval('printSheetHtml()');
    assert.match(sheet, /커미션 지급 내역 · CAPFRONTArmando · 2026년 5월 반제분/); assert.match(sheet, /CF-001/);

    // ── 재무: 커미션 화면 → 승인완료 → 수령증 인쇄 → 스캔 업로드 → 마감
    const f = openPage(COM, 'refatrix-commission.html', 'fin', 'treasury', `#cm_agent=${ID.rep}&cm_ym=2026-05`);
    await until(() => f.$('[data-ap="print"]'));
    assert.match(f.$('#apBox').textContent, /결재 승인완료/);
    assert.ok(!f.$('[data-ap="create"]'));
    click(f, f.$('[data-ap="print"]'));
    await until(() => f.opened.length && f.opened[0].printed);
    const rc = f.opened[0].document.html;
    for (const k of ['RECIBO DE PAGO DE COMISIONES', det.doc.doc_no, 'CAPFRONTArmando', 'CAPFRONTRefaccionaria Sur', 'CF-001', '$1,234.53', 'MIL DOSCIENTOS TREINTA Y CUATRO PESOS 53/100 M.N.', 'mayo de 2026', 'RECIBÍ DE CONFORMIDAD', 'ENTREGÓ', 'AUTORIZÓ', 'CAPFRONTSebastian']) assert.ok(rc.includes(k), k);
    assert.ok(!rc.includes('BORRADOR'));
    // 금액 글자 변환
    const L = (v) => f.w.eval(`numLetras(${v})`);
    assert.equal(L(1), 'UN PESO 00/100 M.N.');
    assert.equal(L(21), 'VEINTIUN PESOS 00/100 M.N.');
    assert.equal(L(100), 'CIEN PESOS 00/100 M.N.');
    assert.equal(L(101.5), 'CIENTO UN PESOS 50/100 M.N.');
    assert.equal(L(1000), 'MIL PESOS 00/100 M.N.');
    assert.equal(L(15600.07), 'QUINCE MIL SEISCIENTOS PESOS 07/100 M.N.');
    assert.equal(L(100000), 'CIEN MIL PESOS 00/100 M.N.');
    assert.equal(L(1000000), 'UN MILLON DE PESOS 00/100 M.N.');
    assert.equal(L(2531999.99), 'DOS MILLONES QUINIENTOS TREINTA Y UN MIL NOVECIENTOS NOVENTA Y NUEVE PESOS 99/100 M.N.');
    // 업로드 — 파일 없으면 안내
    click(f, f.$('[data-ap="settle"]'));
    await until(() => /수령증 스캔을 첨부/.test(f.$('#apMsg').textContent));
    const pdf = new f.w.File([new Uint8Array(Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'))], 'recibo_firmado.pdf', { type: 'application/pdf' });
    Object.defineProperty(f.$('#apFile'), 'files', { value: [pdf] });
    f.$('#apDate').value = '2026-06-15';
    click(f, f.$('[data-ap="settle"]'));
    await until(() => /지급 등록·반제 완료/.test(f.$('#apMsg') ? f.$('#apMsg').textContent : ''), 10000);
    assert.match(f.$('#apMsg').textContent, /집행완료 → 대표이사 사후승인 대기/);
    await until(() => /지급·마감 완료/.test(f.$('#apBox').textContent));
    assert.ok(!f.$('#payForm').classList.contains('locked') || f.$('#payForm').classList.contains('hidden'));
    const row = (await q(`SELECT cp.amount, cp.evi_mime, d.exec_status, d.post_status FROM commission_approval_docs l JOIN commission_payments cp ON cp.id=l.commission_payment_id JOIN approval_documents d ON d.id=l.document_id WHERE l.document_id=$1`, [docId])).rows[0];
    assert.deepEqual([Number(row.amount), row.evi_mime, row.exec_status, row.post_status], [1234.53, 'application/pdf', 'done', 'pending']);
    const file = (await q(`SELECT kind, mime_type FROM approval_files WHERE document_id=$1`, [docId])).rows[0];
    assert.deepEqual([file.kind, file.mime_type], ['수령증', 'application/pdf']);
    for (const p of [c, a, a2, f]) assert.deepEqual(p.errs, [], 'JS 오류 없음');
  } catch (e) { console.error('S1 FAIL:', e && e.stack || e); throw e; } finally {
    await new Promise((r) => setTimeout(r, 300));
    for (const dm of doms) dm.window.close();
    await clean();
    await app.close();
  }
});
