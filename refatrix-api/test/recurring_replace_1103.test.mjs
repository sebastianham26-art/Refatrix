// =====================================================================
// 2026-11-03 고정비 중복(SUA·임차료) — 실제 서버(PostgreSQL) + jsdom
//   ① /api/cashflow : 지난달 미처리 고정비 예정은 같은 고정비가 이번 달에도 돌면 제외(이번 달 회차만)
//   ② 전자결재 작성 화면 「고정비 대체」 카드 — 추천 표시 · 체크 → 임시저장 본문 replaces_txn_ids → 상세 표시
//   ③ 승인 → 고정비 회차 숨김 / 반려 → 되살림 (HTTP 경로)
//   실행: TEST_PG_URL=postgres://... node --test test/recurring_replace_1103.test.mjs   (전체 migrate 후)
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APR = readFileSync(join(HERE, '..', '..', 'refatrix-approval.html'), 'utf8');
const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
const TAG = 'RR1103';

after(async () => {
  if (!PG) return;
  const { pool } = await import('../src/db.js');
  await pool.end().catch(() => {});
  setTimeout(() => process.exit(process.exitCode || 0), 300);
});

test('R0 정적 — 빌드 토큰 · 인라인 onclick 없음 · 카드 문구', () => {
  assert.match(APR, /<title>[^<]*b20261103rep<\/title>/);
  const s = APR.indexOf('/* 0313 고정비 대체'), e = APR.indexOf('function renderCompose(){');
  assert.ok(s > 0 && e > s);
  assert.doesNotMatch(APR.slice(s, e), /onclick=/);
  assert.ok(APR.includes('고정비 대체 <span class="sub">'));
});

test('R1 현금흐름 · 고정비 대체 화면 흐름', { skip: !PG }, async () => {
  const { JSDOM } = await import('jsdom');
  const { buildApp } = await import('../src/server.js');
  const { pool } = await import('../src/db.js');
  const q = (s, a) => pool.query(s, a);
  const app = buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const API = `http://127.0.0.1:${app.server.address().port}`;
  const doms = [];
  const U = `(SELECT id FROM users WHERE login_id LIKE 'rr1103%')`;
  const clean = async () => {
    const D = `(SELECT id FROM approval_documents WHERE drafter_id IN ${U})`;
    await q(`UPDATE approval_payments SET txn_id=NULL WHERE document_id IN ${D}`);
    await q(`DELETE FROM transactions WHERE created_by IN ${U} OR owner_id IN ${U}`);
    for (const t of ['approval_files', 'approval_events', 'approval_notifications', 'approval_lines', 'approval_viewers', 'approval_payments']) await q(`DELETE FROM ${t} WHERE document_id IN ${D}`);
    await q(`DELETE FROM approval_documents WHERE drafter_id IN ${U}`);
    await q(`DELETE FROM recurring_rules WHERE name LIKE '${TAG}%'`);
    await q(`DELETE FROM approval_categories WHERE name LIKE '${TAG}%'`);
    await q(`DELETE FROM accounts WHERE name LIKE '${TAG}%'`);
    await q(`DELETE FROM audit_log WHERE user_id IN ${U}`);
    await q(`UPDATE approval_settings SET director_user_id=NULL, ceo_user_id=NULL WHERE director_user_id IN ${U} OR ceo_user_id IN ${U}`);
    await q(`DELETE FROM users WHERE login_id LIKE 'rr1103%'`);
  };
  await clean();
  const mk = async (name, role, login) => Number((await q(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name, role, login])).rows[0].id);
  const ID = { dir: await mk(`${TAG}Dir`, 'director', 'rr1103_dir'), ceo: await mk(`${TAG}Ceo`, 'socio', 'rr1103_ceo') };
  const TOK = Object.fromEntries(Object.entries(ID).map(([k, v]) => [k, app.jwt.sign({ sub: v })]));
  await q(`UPDATE approval_settings SET director_user_id=$1, ceo_user_id=$2, ceo_pre_threshold=10000000 WHERE id=1`, [ID.dir, ID.ceo]);
  const api = async (who, method, path, body) => {
    const r = await fetch(API + path, { method, headers: { Authorization: 'Bearer ' + TOK[who], ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${JSON.stringify(d)}`); return d;
  };
  await q(`INSERT INTO categories(code,name,group_name) VALUES ('R911','${TAG}세금과공과','지출') ON CONFLICT (code) DO NOTHING`);
  const acc = Number((await q(`INSERT INTO accounts (name, type, currency, open_balance, created_by) VALUES ($1,'bank','MXN',500000,$2) RETURNING id`, [`${TAG}BBVA`, ID.dir])).rows[0].id);
  const ym = new Date().toISOString().slice(0, 7);
  const mAdd = (k) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 7); };
  const rid = Number((await q(`INSERT INTO recurring_rules(name, category_code, amount, direction, currency, account_id, freq, day_of_month, start_date, active, created_by)
    VALUES ('${TAG}SUA','R911',25000,'out','MXN',$1,'month',28,$2,true,$3) RETURNING id`, [acc, `${mAdd(-3)}-01`, ID.dir])).rows[0].id);
  const plan = async (m) => Number((await q(
    `INSERT INTO transactions(account_id, txn_date, plan_date, direction, amount, currency, fx_rate, amount_mxn, plan_amount, category_code, status, kind, approved, owner_id, memo, recurring_rule_id, recurring_period, created_by)
     VALUES ($1,$2,$2,'out',25000,'MXN',1,25000,25000,'R911','plan','general',true,$3,'[고정비] ${TAG}SUA',$4,$5,$3) RETURNING id`, [acc, `${m}-28`, ID.dir, rid, m])).rows[0].id);
  const pPrev2 = await plan(mAdd(-2)); await plan(mAdd(-1)); const pCur = await plan(ym);
  const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return; } catch { /* 아직 */ } await new Promise((r) => setTimeout(r, 25)); } throw new Error('timeout: ' + fn.toString().slice(0, 160)); };
  const openPage = (hash = '') => {
    const dom = new JSDOM(APR.replace(/<script src=[^>]*><\/script>/g, ''), {
      runScripts: 'dangerously', pretendToBeVisual: true, url: `https://erp.test/refatrix-approval.html${hash}`,
      beforeParse(w) {
        w.fetch = (u, o) => fetch(u, o); w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {}; w.print = () => {};
        w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: TOK.dir, api: API, user: { id: ID.dir, name: 'dir', role: 'director' } }));
      },
    });
    doms.push(dom);
    const w = dom.window; const errs = []; w.addEventListener('error', (e) => errs.push(e.message));
    return { w, d: w.document, $: (s) => w.document.querySelector(s), errs };
  };
  const click = (p, el) => { assert.ok(el, 'element'); el.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true })); };

  try {
    // ① 현금흐름: 지난 두 달 미처리 SUA 는 빠지고 이번 달 SUA 만
    const cf = await api('dir', 'GET', `/api/cashflow?granularity=day&includePlan=1&accounts=${acc}&until=${ym}`);
    const totalOut = cf.rows.reduce((s, r) => s + Number(r.outflow || 0), 0);
    assert.equal(totalOut, 25000, `현금흐름 유출 = 이번 달 SUA 1건(25,000) — 받은 값 ${totalOut}`);

    // ② 작성 화면 — 카테고리(과목 R911) 고르면 이번 달 SUA 「추천」
    await q(`INSERT INTO approval_categories(name, fin_category_code, active) VALUES ($1,'R911',true)`, [`${TAG}세금`]);
    const p = openPage();
    await until(() => p.$('#tabs [data-v="compose"]'));
    click(p, p.$('#tabs [data-v="compose"]'));
    await until(() => p.$('#cRep'));
    const catSel = p.$('select[data-f="category_id"]');
    const opt = [...catSel.options].find((o) => o.textContent.includes(`${TAG}세금`));
    catSel.value = opt.value; catSel.dispatchEvent(new p.w.Event('input', { bubbles: true }));
    p.$('input[data-f="title"]').value = 'SUA 이번 달'; p.$('input[data-f="title"]').dispatchEvent(new p.w.Event('input', { bubbles: true }));
    p.$('input[data-f="orig_sub"]').value = '24000'; p.$('input[data-f="orig_sub"]').dispatchEvent(new p.w.Event('input', { bubbles: true }));
    p.$('input[data-f="pay_due"]').value = `${ym}-20`; p.$('input[data-f="pay_due"]').dispatchEvent(new p.w.Event('input', { bubbles: true }));
    await until(() => p.$(`#cRep input[data-rep="${pCur}"]`));
    const rowTxt = p.$(`#cRep input[data-rep="${pCur}"]`).closest('label').textContent;
    assert.ok(rowTxt.includes('추천') && rowTxt.includes(`${TAG}SUA`), '이번 달 SUA 추천 표시');
    assert.ok(!p.$(`#cRep input[data-rep="${pPrev2}"]`), '두 달 전 회차는 추천 아님(전체 보기에만)');
    click(p, p.$('#cRep [data-act="repall"]'));
    await until(() => p.$(`#cRep input[data-rep="${pPrev2}"]`));
    const cb = p.$(`#cRep input[data-rep="${pCur}"]`);
    cb.checked = true; cb.dispatchEvent(new p.w.Event('change', { bubbles: true }));
    assert.ok(p.$('#cRep').textContent.includes('선택 1건'));
    // 임시저장 → 상세
    click(p, [...p.d.querySelectorAll('[data-act="csave"]')][0]);
    let doc = null;
    for (let i = 0; i < 200 && !doc; i++) { doc = (await q(`SELECT id, replaces_txn_ids FROM approval_documents WHERE drafter_id=$1`, [ID.dir])).rows[0]; if (!doc) await new Promise((r) => setTimeout(r, 25)); }
    assert.ok(doc, '임시저장됨');
    assert.deepEqual((doc.replaces_txn_ids || []).map(Number), [pCur], '저장 본문에 고른 회차');
    // 디렉터 기안 = 임시저장부터 예정 → 이미 대체(숨김)
    let st = (await q(`SELECT deleted_at IS NOT NULL AS del, replaced_by_doc FROM transactions WHERE id=$1`, [pCur])).rows[0];
    assert.ok(st.del && Number(st.replaced_by_doc) === Number(doc.id), '디렉터 기안은 임시저장부터 고정비 대체');
    const det = await api('dir', 'GET', `/api/approvals/${doc.id}`);
    assert.equal(det.replaces.length, 1); assert.ok(det.replaces[0].active);
    const cf2 = await api('dir', 'GET', `/api/cashflow?granularity=day&includePlan=1&until=${ym}`);
    const apOut = cf2.rows.reduce((s, r) => s + Number(r.outflow || 0), 0);
    assert.ok(apOut >= 24000 * 1.16 - 0.01, '전자결재 예정이 대신 잡힘');
    // 상세 화면 표시
    const p2 = openPage(`#doc=${doc.id}`);
    await until(() => p2.d.body.textContent.includes('고정비 대체') && p2.d.body.textContent.includes(`${TAG}SUA`));
    // ③ 삭제 → 되살림
    await api('dir', 'DELETE', `/api/approvals/${doc.id}`);
    st = (await q(`SELECT deleted_at IS NOT NULL AS del, replaced_by_doc FROM transactions WHERE id=$1`, [pCur])).rows[0];
    assert.ok(!st.del && st.replaced_by_doc == null, '임시저장 삭제 → 고정비 되살림');
    assert.deepEqual([...p.errs, ...p2.errs], [], '화면 JS 오류 없음');
  } finally {
    for (const d of doms) d.window.close();
    await clean();
    await app.close();
  }
});
