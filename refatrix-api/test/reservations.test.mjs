// =====================================================================
// 견적 재고예약 현황 — 순수 로직 + pg-mem 실행 + 화면(jsdom)   2026-09-30
//   실 PostgreSQL 종단 검증은 reservations_e2e.test.mjs (TEST_PG_URL).
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newDb } from 'pg-mem';

process.env.DATABASE_URL ||= 'postgres://x@127.0.0.1:1/none';
const R = await import('../src/reservations.js');

const NOW = new Date('2026-09-30T18:00:00Z');   // MX 12:00
const plus = (min) => new Date(NOW.getTime() + min * 60000).toISOString();

// ── 순수 로직 ────────────────────────────────────────────────────────
test('상태 — 남은 시간으로 곧/오늘/나중, 포장지시는 hold, 지난 건 released', () => {
  assert.equal(R.reservationState({ reserve_expires_at: plus(90) }, NOW).urgency, 'soon');
  assert.equal(R.reservationState({ reserve_expires_at: plus(120) }, NOW).urgency, 'soon');
  assert.equal(R.reservationState({ reserve_expires_at: plus(121) }, NOW).urgency, 'today');
  assert.equal(R.reservationState({ reserve_expires_at: plus(361) }, NOW).urgency, 'later');
  const h = R.reservationState({ reserve_expires_at: plus(-600), packing_printed_at: plus(-700) }, NOW);
  assert.deepEqual([h.state, h.releases_at], ['hold', null]);
  assert.equal(R.reservationState({ reserve_expires_at: plus(-1) }, NOW).state, 'released');
  assert.equal(R.reservationState({ reserve_expires_at: plus(30), status: 'expired' }, NOW).state, 'released');
  assert.equal(R.reservationState({ reserve_expires_at: null }, NOW).state, 'released');
});

test('누가 — 작성자 이름(로그인ID) / 웹카달록은 담당자', () => {
  assert.deepEqual(R.reservedBy({ creator_name: 'Oscar', creator_login_id: 'oscar' }), { kind: 'user', label: 'Oscar', sub: 'oscar' });
  assert.equal(R.reservedBy({ creator_login_id: 'oscar' }).label, 'oscar');
  assert.equal(R.reservedBy({}).label, '(작성자 없음)');
  assert.deepEqual(R.reservedBy({ origin: 'crm', assignee_name: 'Maria' }), { kind: 'catalog', label: '웹카달록', sub: '담당 Maria' });
  assert.equal(R.reservedBy({ origin: 'crm' }).sub, '담당 미지정');
});

test('행 모양 — 부분예약·예약분 금액·근무시간 외 접수', () => {
  const base = { line_id: '7', quote_id: '3', quote_no: 'Q-2026-0003', status: 'draft', product_id: '11', product_code: 'CTR-1',
    qty: '4.000', reserved_qty: '3.000', line_subtotal: '400.00', customer_id: '5', customer_name: 'ACME',
    creator_name: 'Oscar', created_at: '2026-09-30T16:00:00Z', reserve_expires_at: '2026-10-01T16:00:00Z' };
  const r = R.shapeRow(base, NOW);
  assert.equal(r.line_id, 7); assert.equal(r.product_id, 11);
  assert.equal(r.partial, true); assert.equal(r.reserved_sub, 300);
  assert.equal(r.offhours, false, '접수 = 기산');
  assert.equal(r.count_from, '2026-09-30T16:00:00.000Z');
  const off = R.shapeRow({ ...base, created_at: '2026-09-30T23:30:00Z', reserve_expires_at: '2026-10-02T13:30:00Z' }, NOW);
  assert.equal(off.offhours, true, '17:30 접수 → 다음날 07:30 기산');
  assert.equal(R.shapeRow({ ...base, customer_id: null, guest_name: '' }, NOW).party_name, '불특정 고객');
  assert.equal(R.shapeRow({ ...base, qty: 0 }, NOW).reserved_sub, 0);
  assert.equal(R.shapeRow({ ...base, packing_printed_at: '2026-09-30T17:00:00Z' }, NOW).offhours, false, '포장지시 건은 기산 표시 안 함');
});

test('제품별 묶음 · 요약 · released 파라미터', () => {
  const a = R.shapeRow({ line_id: 1, quote_id: 1, product_id: 1, product_code: 'A', qty: 2, reserved_qty: 2, line_subtotal: 20, reserve_expires_at: plus(60) }, NOW);
  const b = R.shapeRow({ line_id: 2, quote_id: 2, product_id: 1, product_code: 'A', qty: 3, reserved_qty: 3, line_subtotal: 30, reserve_expires_at: plus(30) }, NOW);
  const c = R.shapeRow({ line_id: 3, quote_id: 2, product_id: 2, product_code: 'B', qty: 1, reserved_qty: 1, line_subtotal: 5, reserve_expires_at: plus(30), packing_printed_at: plus(-5) }, NOW);
  const g = R.groupByProduct([a, b, c], [{ product_id: '1', stock_qty: '4', reserved_all: '6' }]);
  assert.equal(g[0].product_code, 'A'); assert.equal(g[0].reserved_qty, 5); assert.equal(g[0].quotes, 2);
  assert.equal(g[0].available, 0, '가용은 음수로 안 간다'); assert.equal(g[0].next_release, b.releases_at);
  assert.equal(g[1].next_release, null, '포장지시만 있으면 다음 해제 없음');
  const s = R.summarize([a, b, c]);
  assert.deepEqual(s, { quotes: 2, skus: 2, qty: 6, sub: 55, soon_quotes: 2, hold_quotes: 1 });
  assert.equal(R.releasedHours('48'), 48); assert.equal(R.releasedHours('999'), 168);
  assert.equal(R.releasedHours('-3'), 0); assert.equal(R.releasedHours(undefined), 0); assert.equal(R.releasedHours('x'), 0);
});

test('살아 있는 예약 정의 = 가용재고 계산과 같은 조건', () => {
  const src = readFileSync(new URL('../src/quoteBuild.js', import.meta.url), 'utf8');
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  for (const piece of [`q.status IN ('draft','confirmed')`, `(q.reserve_expires_at > now() OR q.packing_printed_at IS NOT NULL)`, `q.deleted_at IS NULL`]) {
    assert.ok(norm(src).includes(piece), 'quoteBuild: ' + piece);
    assert.ok(norm(R.ACTIVE_RESERVATION_SQL).includes(piece), 'reservations: ' + piece);
  }
});

test('server.js 에 등록돼 있다(스테일 푸시로 빠지면 여기서 걸린다)', () => {
  const s = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(s, /import reservationRoutes from '\.\/routes\/reservationRoutes\.js'/);
  assert.match(s, /app\.register\(reservationRoutes\)/);
});

// ── pg-mem: 라우트 SQL 을 실제로 돌린다 ────────────────────────────────
//   pg-mem 한계: `$1::int * interval` 이 안 되므로 풀린 예약(?released) 경로는 실 Postgres(e2e)에서만 본다.
test('pg-mem — 라우트가 살아 있는 예약만 돌려준다', async () => {
  const mem = newDb();
  mem.public.none(`
    CREATE TABLE users (id BIGINT PRIMARY KEY, name TEXT, login_id TEXT);
    CREATE TABLE customers (id BIGINT PRIMARY KEY, name TEXT, team_id BIGINT);
    CREATE TABLE products (id BIGINT PRIMARY KEY, code TEXT, name TEXT, stock_qty NUMERIC);
    CREATE TABLE quotes (id BIGINT PRIMARY KEY, quote_no TEXT, status TEXT, origin TEXT, external_quote_no TEXT,
      created_at TIMESTAMPTZ, reserve_expires_at TIMESTAMPTZ, packing_printed_at TIMESTAMPTZ, customer_id BIGINT,
      guest_name TEXT, created_by BIGINT, assigned_to BIGINT, deleted_at TIMESTAMPTZ);
    CREATE TABLE quote_lines (id BIGINT PRIMARY KEY, quote_id BIGINT, line_no INT, product_id BIGINT, ctr_code TEXT,
      product_name TEXT, qty NUMERIC, reserved_qty NUMERIC, line_subtotal NUMERIC);
    INSERT INTO users VALUES (1,'Oscar','oscar');
    INSERT INTO customers VALUES (10,'ACME',1),(11,'OTRO',2);
    INSERT INTO products VALUES (100,'CTR-1','Rotula',10),(101,'CTR-2','Buje',3);
  `);
  const ins = (id, st, expH, extra = {}) => mem.public.none(`INSERT INTO quotes (id, quote_no, status, created_at, reserve_expires_at, packing_printed_at, customer_id, created_by, deleted_at)
    VALUES (${id}, 'Q-${id}', '${st}', now(), now() + interval '${expH} hours', ${extra.packed ? 'now()' : 'NULL'}, ${extra.cust || 10}, 1, ${extra.deleted ? 'now()' : 'NULL'})`);
  ins(1, 'draft', 3); ins(2, 'confirmed', 1, { cust: 11 }); ins(3, 'expired', -2); ins(4, 'draft', -5, { packed: true });
  ins(5, 'converted', 4); ins(6, 'draft', 4, { deleted: true });
  mem.public.none(`INSERT INTO quote_lines VALUES
    (1,1,1,100,'CTR-1','Rotula',2,2,200),(2,1,2,101,'CTR-2','Buje',5,3,500),(3,2,1,100,'CTR-1','Rotula',1,1,100),
    (4,3,1,100,'CTR-1','Rotula',4,4,400),(5,4,1,101,'CTR-2','Buje',1,1,100),(6,5,1,100,'CTR-1','Rotula',9,9,900),
    (7,6,1,100,'CTR-1','Rotula',9,9,900),(8,1,3,100,'CTR-1','Rotula',3,0,300)`);
  const { Pool } = mem.adapters.createPg();
  const memPool = new Pool();
  const db = await import('../src/db.js');
  const orig = db.pool.query;
  // pg-mem 한계: `= ANY($1)`(숫자 배열 파라미터)를 못 받는다 → **시험에서만** IN(…) 으로 풀어 준다(운영 SQL 은 그대로).
  //   또 상관 서브쿼리의 바깥 별칭(p.id)을 못 본다 → 제품 합계 쿼리는 같은 조건의 GROUP BY 로 바꿔 돌린다(시험 전용).
  db.pool.query = (t, p) => {
    if (/AS reserved_all/.test(t) && Array.isArray(p && p[0])) {
      const ids = p[0].map(Number).join(',');
      return memPool.query(
        `SELECT p.id AS product_id, p.stock_qty, COALESCE(r.s, 0) AS reserved_all
           FROM products p LEFT JOIN (
             SELECT ql.product_id, SUM(ql.reserved_qty) AS s FROM quote_lines ql JOIN quotes q ON q.id = ql.quote_id
              WHERE ${R.ACTIVE_RESERVATION_SQL} GROUP BY ql.product_id) r ON r.product_id = p.id
          WHERE p.id IN (${ids})`, []);
    }
    const m = /= ANY\(\$(\d+)\)/.exec(t);
    if (m && Array.isArray(p && p[m[1] - 1])) {
      const k = Number(m[1]);
      const sql = t.replace(m[0], `IN (${p[k - 1].map(Number).join(',')})`)
        .replace(/\$(\d+)/g, (_x, d) => (Number(d) > k ? '$' + (Number(d) - 1) : '$' + d));
      return memPool.query(sql, p.filter((_v, x) => x !== k - 1));
    }
    return memPool.query(t, p);
  };
  try {
    const routes = (await import('../src/routes/reservationRoutes.js')).default;
    let h; await routes({ get: (_p, _o, fn) => { h = fn; } });
    const out = await h({ ctx: { perm: { role: 'director', userId: 1 } }, query: {} });
    const q = [...new Set(out.items.map((i) => i.quote_id))];
    assert.deepEqual(q, [2, 1, 4], '곧 풀리는 순, 포장지시 맨 뒤 · 만료/전환/삭제/예약0 제외');
    assert.equal(out.summary.qty, 7);
    const p100 = out.products.find((p) => p.product_id === 100);
    assert.equal(p100.reserved_all, 3); assert.equal(p100.available, 7);
    const team = await h({ ctx: { perm: { role: 'sales', userId: 9, teamId: 1 } }, query: {} });
    assert.deepEqual([...new Set(team.items.map((i) => i.quote_id))], [1, 4], '팀 가시성');
  } finally { db.pool.query = orig; }
});

// ── 화면(jsdom) ──────────────────────────────────────────────────────
test('화면 — 견적별/제품별 · 필터 · 남은 시간 · 인라인 onclick 없음', async () => {
  const { JSDOM } = await import('jsdom');
  const html = readFileSync(new URL('../../refatrix-reservations.html', import.meta.url), 'utf8');
  assert.equal(/onclick=/i.test(html), false, 'addEventListener 만 쓴다');
  assert.match(html, /refatrix-nav\.js\?v=\d{8}[a-z]+/);
  const now = Date.now();
  const iso = (m) => new Date(now + m * 60000).toISOString();
  const item = (o) => ({ state: 'active', urgency: 'later', partial: false, offhours: false, quote_status: 'draft', origin: 'internal',
    by: { kind: 'user', label: 'Oscar', sub: 'oscar' }, reserved_at: iso(-60), count_from: iso(-60), packing_printed_at: null,
    external_quote_no: null, ...o });
  const DATA = {
    now: new Date(now).toISOString(), scope: 'all', summary: {}, released_hours: 0, released: [],
    items: [
      item({ line_id: 1, quote_id: 1, quote_no: 'Q-1', party_name: 'ACME', product_id: 100, product_code: 'CTR-1', product_name: 'Rotula', qty: 2, reserved_qty: 2, reserved_sub: 200, releases_at: iso(90), remaining_min: 90 }),
      item({ line_id: 2, quote_id: 1, quote_no: 'Q-1', party_name: 'ACME', product_id: 101, product_code: 'CTR-2', product_name: 'Buje', qty: 5, reserved_qty: 3, reserved_sub: 300, partial: true, releases_at: iso(90), remaining_min: 90 }),
      item({ line_id: 3, quote_id: 2, quote_no: 'COT-9', party_name: 'TALLER', origin: 'catalog', by: { kind: 'catalog', label: '웹카달록', sub: '담당 Maria' }, product_id: 100, product_code: 'CTR-1', product_name: 'Rotula', qty: 1, reserved_qty: 1, reserved_sub: 100, releases_at: iso(600), remaining_min: 600 }),
      item({ line_id: 4, quote_id: 3, quote_no: 'Q-3', party_name: 'ACME', state: 'hold', urgency: 'hold', packing_printed_at: iso(-30), product_id: 101, product_code: 'CTR-2', product_name: 'Buje', qty: 1, reserved_qty: 1, reserved_sub: 100, releases_at: null, remaining_min: null }),
    ],
    products: [{ product_id: 100, stock_qty: 10, reserved_all: 3, available: 7 }, { product_id: 101, stock_qty: 4, reserved_all: 4, available: 0 }],
  };
  const calls = [];
  const dom = new JSDOM(html.replace(/<script src="[^"]*"><\/script>/g, ''), {
    runScripts: 'dangerously', url: 'https://erp.refatrix.com/refatrix-reservations.html',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.x', user: { name: 'Seb', role: 'director' } }));
      w.fetch = async (u) => { calls.push(String(u)); return { ok: true, status: 200, json: async () => DATA }; };
    },
  });
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(calls[0].startsWith('https://api.x/api/reservations'), calls[0]);
  assert.equal($('app').classList.contains('hidden'), false);
  const kpiText = $('kpis').textContent;
  assert.match(kpiText, /3예약 중 견적/); assert.match(kpiText, /1⏰ 2시간 내 해제 견적/); assert.match(kpiText, /1📦 포장지시/);
  // 견적별: 곧 풀리는 Q-1 이 먼저, 부분예약 표시, 카달록 담당, 포장지시 문구
  const blocks = [...w.document.querySelectorAll('.qg')];
  assert.equal(blocks.length, 3);
  assert.match(blocks[0].textContent, /Q-1/); assert.ok(blocks[0].classList.contains('soon'));
  assert.match(blocks[0].textContent, /요청 5/);
  assert.match(blocks[0].textContent, /1시간 \d+분 남음/);
  assert.match(blocks[1].textContent, /웹카달록.*담당 Maria/s);
  assert.match(blocks[2].textContent, /출고까지 유지/);
  assert.equal(blocks[0].querySelector('a.qno').getAttribute('href'), 'refatrix-quotelist.html?q=Q-1');
  // 필터: 출처 = 웹카달록
  $('segOrigin').querySelector('[data-v="catalog"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(w.document.querySelectorAll('.qg').length, 1);
  $('segOrigin').querySelector('[data-v=""]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  // KPI 클릭 = 2시간 내만
  w.document.querySelector('.kpi[data-when="soon"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(w.document.querySelectorAll('.qg').length, 1);
  w.document.querySelector('.kpi[data-when="soon"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(w.document.querySelectorAll('.qg').length, 3, '다시 누르면 해제');
  // 검색
  const kw = $('kw'); kw.value = 'buje'; kw.dispatchEvent(new w.Event('input'));
  assert.equal(w.document.querySelectorAll('.qg').length, 2);
  kw.value = ''; kw.dispatchEvent(new w.Event('input'));
  // 제품별 + 펼치기
  $('segView').querySelector('[data-v="product"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const rows = [...w.document.querySelectorAll('tr.ph')];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /CTR-2/, '예약 수량 많은 제품이 위(4 > 3)');
  assert.ok(rows[0].querySelector('.avail0'), '가용 0 은 빨강');
  assert.equal(rows[1].querySelector('.avail0'), null);
  rows[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(w.document.querySelector('tr.pd[data-pd="100"]').classList.contains('hidden'), false);
  // 최근 풀린 예약 선택 → ?released=48
  $('relH').value = '48'; $('relH').dispatchEvent(new w.Event('change'));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(calls.some((u) => u.endsWith('/api/reservations?released=48')));
  w.close();
});

test('견적 목록 — ?q= 로 들어오면 그 번호로 바로 찾는다', () => {
  const ql = readFileSync(new URL('../../refatrix-quotelist.html', import.meta.url), 'utf8');
  assert.match(ql, /new URLSearchParams\(location\.search\)\.get\('q'\)/);
  const nav = readFileSync(new URL('../../refatrix-nav.js', import.meta.url), 'utf8');
  assert.match(nav, /reservations:\{file:'refatrix-reservations\.html'/);
  assert.match(nav, /reservations:\['quote','sales'\]/);
});
