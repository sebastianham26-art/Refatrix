// WhatsApp 발송 시각 설정(0262) — 판정 규칙 · API · 화면
//   실행: TEST_PG_URL=postgres://... node --test test/wa_schedule.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
const W = await import('../src/waSchedule.js');
after(async () => { if (!PG) return; const { pool } = await import('../src/db.js'); await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); });

const at = (iso) => W.mxParts(Date.parse(iso));
test('A1 isDue — 설정 시각부터 6시간 창 · 자정 넘기지 않음 · 꺼짐', () => {
  const c = { send_time: '18:00', target_day: 'today', enabled: true };
  assert.equal(W.isDue(c, at('2026-10-08T23:55:00Z')), false, 'MX 17:55');
  assert.equal(W.isDue(c, at('2026-10-09T00:00:00Z')), true, 'MX 18:00');
  assert.equal(W.isDue(c, at('2026-10-09T05:59:00Z')), true, 'MX 23:59');
  assert.equal(W.isDue({ ...c, enabled: false }, at('2026-10-09T00:00:00Z')), false);
  const m = { send_time: '06:00', target_day: 'yesterday', enabled: true };
  assert.equal(W.isDue(m, at('2026-10-08T18:00:00Z')), true, 'MX 12:00 (창 끝)');
  assert.equal(W.isDue(m, at('2026-10-08T18:05:00Z')), false, 'MX 12:05');
});
test('A2 대상일 · 다음 발송 · 기본값 · 시각 형식', () => {
  const n = at('2026-10-09T00:30:00Z');   // MX 10/8 18:30
  assert.equal(n.ymd, '2026-10-08');
  assert.equal(W.targetDate({ target_day: 'today' }, n), '2026-10-08');
  assert.equal(W.targetDate({ target_day: 'yesterday' }, n), '2026-10-07');
  assert.equal(W.nextRun({ send_time: '18:00', enabled: true }, n), '2026-10-09 18:00');
  assert.equal(W.nextRun({ send_time: '19:00', enabled: true }, n), '2026-10-08 19:00');
  assert.equal(W.nextRun({ send_time: '19:00', enabled: false }, n), null);
  assert.equal(W.normalizeCfg('treasury_daily', null).send_time, '18:00');
  assert.equal(W.normalizeCfg('daily_summary', { send_time: '25:00' }).send_time, '05:00', '잘못된 값은 기본값');
  for (const t of ['00:00', '18:00', '23:59']) assert.ok(W.TIME_RE.test(t));
  for (const t of ['24:00', '6:00', '18:60', '']) assert.ok(!W.TIME_RE.test(t));
});
test('B1 배선 — 마이그레이션 기본값 · 서버 등록 · 두 스케줄러가 설정 사용 · nav · 화면', () => {
  const mig = readFileSync(join(HERE, '..', 'migrations', '0262_wa_schedules.sql'), 'utf8');
  assert.match(mig, /\('treasury_daily',\s+'18:00', 'today'\)/);
  assert.match(mig, /\('daily_summary',\s+'05:00', 'yesterday'\)/);
  const srv = readFileSync(join(HERE, '..', 'src', 'server.js'), 'utf8');
  assert.match(srv, /app\.register\(waScheduleRoutes\)/);
  assert.match(readFileSync(join(HERE, '..', 'src', 'treasuryDaily.js'), 'utf8'), /isDue\(cd, now\)/);
  assert.match(readFileSync(join(HERE, '..', 'src', 'routes', 'dailySummaryRoutes.js'), 'utf8'), /loadSchedule\('daily_summary'\)/);
  const nav = readFileSync(join(REPO, 'refatrix-nav.js'), 'utf8');
  assert.match(nav, /waSched:\{file:'refatrix-wasched\.html'/); assert.match(nav, /waSched:'__director__'/);
  const page = readFileSync(join(REPO, 'refatrix-wasched.html'), 'utf8');
  assert.match(page, /build wasched-1008b/); assert.doesNotMatch(page, /\son(click|change|input)=/);
  assert.match(page, /refatrix-nav\.js\?v=20261008ws/);
});

const E = PG ? test : test.skip;
E('C1 API — 디렉터 전용 · 조회 · 저장(검증) · 캐시 갱신 · 화면 저장 흐름', async () => {
  const { buildApp } = await import('../src/server.js');
  const { pool } = await import('../src/db.js');
  const one = async (s, a) => (await pool.query(s, a)).rows[0];
  const dir = (await one(`SELECT id FROM users WHERE login_id='tdir'`)) || await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ('T Director','director','x','tdir') RETURNING id`);
  const tre = (await one(`SELECT id FROM users WHERE login_id='ttre'`)) || await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ('T Treasury','treasury','x','ttre') RETURNING id`);
  await pool.query(`UPDATE wa_schedules SET send_time = CASE job WHEN 'daily_summary' THEN '05:00' ELSE '18:00' END, target_day = CASE job WHEN 'daily_summary' THEN 'yesterday' ELSE 'today' END, enabled=true`);
  W.clearScheduleCache();
  const app = buildApp(); await app.listen({ port: 0, host: '127.0.0.1' });
  const API = `http://127.0.0.1:${app.server.address().port}`;
  const D = app.jwt.sign({ sub: Number(dir.id), role: 'director' }), X = app.jwt.sign({ sub: Number(tre.id), role: 'treasury' });
  const call = (tok, method, url, payload) => app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + tok } });
  try {
    assert.equal((await call(X, 'GET', '/api/wa-schedules')).statusCode, 403);
    const g = (await call(D, 'GET', '/api/wa-schedules')).json();
    const by = Object.fromEntries(g.items.map((i) => [i.job, i]));
    assert.deepEqual([by.treasury_daily.send_time, by.treasury_daily.target_day], ['18:00', 'today']);
    assert.equal(by.daily_summary.send_time, '05:00'); assert.match(g.now_mx, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal((await call(D, 'PUT', '/api/wa-schedules/treasury_daily', { send_time: '24:00' })).json().error, 'bad_time');
    assert.equal((await call(D, 'PUT', '/api/wa-schedules/treasury_daily', { target_day: 'x' })).json().error, 'bad_target');
    assert.equal((await call(D, 'PUT', '/api/wa-schedules/nope', {})).statusCode, 404);
    await W.loadSchedules();   // 캐시 채움
    const p = (await call(D, 'PUT', '/api/wa-schedules/treasury_daily', { send_time: '19:30', target_day: 'yesterday' })).json();
    assert.equal(p.send_time, '19:30'); assert.ok(p.next_run.endsWith('19:30'));
    assert.equal((await W.loadSchedule('treasury_daily')).send_time, '19:30', '저장 즉시 스케줄러에 반영(캐시 비움)');
    const st = (await call(D, 'GET', '/api/treasury/wa/status')).json();
    assert.equal(st.schedule.daily.send_time, '19:30');
    const ds = (await call(D, 'GET', '/api/daily-summary/wa/status')).json();
    assert.equal(ds.send_time, '05:00');
    // 화면(jsdom): 18:00 으로 되돌려 저장
    let JSDOM; try { ({ JSDOM } = await import('jsdom')); } catch (_) { JSDOM = null; }
    if (JSDOM) {
      const HTML = readFileSync(join(REPO, 'refatrix-wasched.html'), 'utf8');
      const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://erp.test/refatrix-wasched.html',
        beforeParse(w) { w.fetch = (u, o) => fetch(u, o); w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: D, api: API, user: { name: 'T', role: 'director' } })); } });
      const w = dom.window, d = w.document; const errs = []; w.addEventListener('error', (e) => errs.push(e.message));
      const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return; } catch { /* */ } await new Promise((r) => setTimeout(r, 25)); } throw new Error('timeout'); };
      await until(() => d.querySelector('.card[data-job="treasury_daily"]'));
      const c = d.querySelector('.card[data-job="treasury_daily"]');
      assert.equal(c.querySelector('[data-f="hh"]').value + ':' + c.querySelector('[data-f="mm"]').value, '19:30');
      assert.equal(c.querySelectorAll('[data-f="hh"] option').length, 24, '00~23');
      assert.equal(c.querySelectorAll('[data-f="target_day"] option').length, 2);
      assert.ok(c.querySelector('[data-f="skip_empty_sunday"]'), '일일 카드엔 일요일 옵션');
      assert.ok(!d.querySelector('.card[data-job="daily_summary"] [data-f="skip_empty_sunday"]'));
      const save = c.querySelector('[data-act="save"]');
      assert.equal(save.disabled, true, '바꾸기 전엔 저장 잠금');
      c.querySelector('[data-f="hh"]').value = '18'; c.querySelector('[data-f="mm"]').value = '00';
      c.querySelector('[data-f="target_day"]').value = 'today';
      c.querySelector('[data-f="hh"]').dispatchEvent(new w.Event('change', { bubbles: true }));
      assert.equal(save.disabled, false);
      save.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await until(() => /저장했습니다/.test(c.querySelector('[data-k="msg"]').textContent));
      assert.match(c.querySelector('[data-k="next"]').textContent, /18:00$/);
      const row = await one(`SELECT send_time, target_day, updated_by FROM wa_schedules WHERE job='treasury_daily'`);
      assert.deepEqual([row.send_time, row.target_day, Number(row.updated_by)], ['18:00', 'today', Number(dir.id)]);
      assert.deepEqual(errs, []);
      dom.window.close();
    }
  } finally { await app.close(); }
});
