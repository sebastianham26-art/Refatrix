// devreq_platform_push_front.test.mjs — 관리 › 외부 서비스 키 「REFATRIX Platform (개발요청 전송)」 카드 (2026-11-09)
//
//   실제 화면(refatrix-apikeys.html)을 jsdom 으로 띄우고, 화면의 fetch 를 실제 라우트(secretRoutes · devRequestRoutes ·
//   실 PostgreSQL)로 돌린다. 플랫폼(Supabase RPC)만 가짜.
//   잠그는 것: 키 없을 때 꺼짐 표시 · 키 저장 → 곧바로 전체 전송 · 연결 테스트(빈 upsert, 틀린 키 안내) ·
//             [지금 전체 다시 보내기] · 최근 전송 기록 표 · 키 값은 화면에 내려오지 않음
//
//   실행: TEST_PG_URL=postgres://... node --test --test-concurrency=1 test/devreq_platform_push_front.test.mjs   (jsdom 필요)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.APP_SECRET_KEY = process.env.APP_SECRET_KEY || 'test-master-key-devreq-front-0123456789';
delete process.env.REFATRIX_DEVREQ_KEY;

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch {
  try { ({ JSDOM } = createRequire((process.env.JSDOM_DIR || '/tmp/jsd') + '/x.js')('jsdom')); } catch { /* skip */ }
}
const SKIP = !JSDOM ? 'jsdom 없음' : !PG ? 'TEST_PG_URL 없음' : false;
const GOOD = 'g'.repeat(64);

test('외부 서비스 키 화면 — 개발요청 전송 카드', { skip: SKIP }, async (t) => {
  const { query, pool } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const secretRoutes = (await import('../src/routes/secretRoutes.js')).default;
  const devRequestRoutes = (await import('../src/routes/devRequestRoutes.js')).default;
  const P = await import('../src/devReqPush.js');
  P._resetDevReqPush();

  // 가짜 플랫폼
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    if (!String(url).includes('/rpc/app_devreq_push')) return realFetch(url, opt);
    const b = JSON.parse(opt.body); calls.push(b);
    if (b.p_key !== GOOD) return new Response('{"code":"P0001","message":"DEVREQ_KEY_INVALID"}', { status: 400 });
    return new Response(JSON.stringify({ ok: true, mode: b.p_mode, n: b.p_items.length, ver: calls.length, total: b.p_items.length }), { status: 200 });
  };

  const wipe = async () => {
    await query(`DELETE FROM product_dev_requests WHERE input_code LIKE 'DRF-%'`);
    await query(`DELETE FROM service_secrets WHERE name='REFATRIX_DEVREQ_KEY'`).catch(() => {});
    await query(`DELETE FROM service_secret_changes WHERE name='REFATRIX_DEVREQ_KEY'`).catch(() => {});
    await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id='t_drf_dir')`);
    await query(`DELETE FROM users WHERE login_id='t_drf_dir'`);
  };
  await wipe();
  t.after(async () => {
    globalThis.fetch = realFetch; await wipe(); await pool.end().catch(() => {});
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  });
  const dirId = Number((await query(`INSERT INTO users (login_id,name,role,pin_hash) VALUES ('t_drf_dir','DRF 디렉터','director','x') RETURNING id`)).rows[0].id);
  await query(`INSERT INTO product_dev_requests (input_code, requested_qty, requested_at, status, created_by)
               VALUES ('DRF-0001',2,'2026-11-01','received',$1),('DRF-0002',null,'2026-11-02','reviewed',$1),('DRF-0003',1,'2026-11-02','developed',$1)`, [dirId]);

  const app = Fastify();
  // 운영 server.js 와 같은 JSON 파서 — 본문 없는 POST(연결 테스트)를 {} 로 받는다
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (!body || !String(body).trim()) return done(null, {});
    try { done(null, JSON.parse(body)); } catch (e) { e.statusCode = 400; done(e); }
  });
  await app.register(fastifyJwt, { secret: 'test-secret-drf' });
  await app.register(secretRoutes);
  await app.register(devRequestRoutes);
  await app.ready();
  t.after(() => app.close());
  const tok = app.jwt.sign({ sub: dirId });

  const html = readFileSync(new URL('../../refatrix-apikeys.html', import.meta.url), 'utf8')
    .replace(/<script src="refatrix-nav\.js[^"]*"><\/script>/, '');
  assert.match(html, /b20261109dr1/, '빌드 토큰');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://erp.example/refatrix-apikeys.html', pretendToBeVisual: true,
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: tok, api: 'http://erp', user: { name: 'DRF', role: 'director' } }));
      w.fetch = async (url, opt = {}) => {
        const u = new URL(url);
        const r = await app.inject({ method: opt.method || 'GET', url: u.pathname + u.search, headers: opt.headers || {}, payload: opt.body });
        return { ok: r.statusCode < 400, status: r.statusCode, json: async () => JSON.parse(r.body || '{}'), text: async () => r.body };
      };
    } });
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); } return false; };

  // ① 카드가 보이고, 키가 없으면 꺼짐
  assert.ok(await until(() => $('pfPush') && /KPI|전송/.test($('pfPush').textContent) && $('pfResync')), '전송 상태 패널');
  const card = $('pfPush').closest('.svc');
  assert.match(card.textContent, /REFATRIX Platform \(개발요청 전송\)/);
  assert.match(card.textContent, /REFATRIX_DEVREQ_KEY/);
  assert.match(card.textContent, /키 없음 — 기능 정지/);
  assert.match($('pfPush').textContent, /꺼짐 — 키 없음/);
  assert.equal($('pfResync').disabled, true, '키 없으면 버튼 잠김');
  assert.match($('pfPush').querySelector('.pf-kpi').textContent, /ERP 미완료 개발요청\(SYD 코드\)2/, '미완료 2개(개발완료 제외)');
  assert.match(w.document.body.textContent, /app_devreq_push/, '④ 감사표에 줄 추가');

  // ② 틀린 키 저장 → 연결 테스트가 거부를 알려 준다
  $('in_REFATRIX_DEVREQ_KEY').value = 'x'.repeat(64);
  card.querySelector('[data-save="refatrixplatform"]').click();
  assert.ok(await until(() => /저장했습니다/.test($('msg_refatrixplatform').textContent)), '저장');
  await sleep(300);
  w.document.querySelector('[data-test="refatrixplatform"]').click();
  assert.ok(await until(() => /❌/.test($('msg_refatrixplatform').textContent)));
  assert.match($('msg_refatrixplatform').textContent, /DEVREQ_KEY_INVALID/);

  // ③ 맞는 키 저장 → 곧바로 전체(replace) 전송
  const n0 = calls.length;
  $('in_REFATRIX_DEVREQ_KEY').value = GOOD;
  w.document.querySelector('[data-save="refatrixplatform"]').click();
  assert.ok(await until(() => calls.slice(n0).some((c) => c.p_key === GOOD && c.p_mode === 'replace')), '키 저장 즉시 replace');
  const rep = calls.slice(n0).find((c) => c.p_key === GOOD && c.p_mode === 'replace');
  assert.deepEqual(rep.p_items.map((x) => x.syd).sort(), ['DRF-0001', 'DRF-0002']);
  assert.equal(w.document.body.innerHTML.includes(GOOD), false, '키 원문이 화면에 없다');
  assert.ok(await until(() => /전송 중/.test($('pfPush').textContent) && /성공/.test($('pfPush').textContent), 6000), '4초 뒤 패널 갱신');
  assert.equal($('pfResync').disabled, false);

  // ④ 연결 테스트 — 빈 upsert, 목록 안 바뀜
  const n1 = calls.length;
  w.document.querySelector('[data-test="refatrixplatform"]').click();
  assert.ok(await until(() => /✅/.test($('msg_refatrixplatform').textContent)));
  assert.deepEqual(calls.slice(n1).map((c) => [c.p_mode, c.p_items.length]), [['upsert', 0]]);

  // ⑤ 지금 전체 다시 보내기
  const n2 = calls.length;
  $('pfResync').click();
  assert.ok(await until(() => $('pfMsg') && /✅ 전체 2개/.test($('pfMsg').textContent)), $('pfPush').textContent);
  assert.equal(calls[n2].p_mode, 'replace');
  assert.ok($('pfPush').querySelectorAll('tbody tr').length >= 2, '최근 전송 기록 표');
  dom.window.close();
});
