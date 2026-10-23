// 0293 · VIO 프로모션(키트) — 번호 K0001 · 금액 · 키트 이름 · 키트 제품 만들기 · 견적에서 부품 줄로 풀기
//   실행: DATABASE_URL=… node --import ./test/helpers/stub-auth.mjs --test test/vio_promos.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { promoNo, promoTotals, kitName, kitBuildable } from '../src/vioPromos.js';

test('번호 · 금액 · 키트 이름 · 만들 수 있는 수량', () => {
  assert.equal(promoNo(1), 'K0001'); assert.equal(promoNo(123), 'K0123'); assert.equal(promoNo(12345), 'K12345');
  const t = promoTotals([{ list_price: 623, qty: 2 }, { list_price: 336.5, qty: 1 }], 10);
  assert.deepEqual(t, { total_list: 1582.5, total_promo: 1424.25, discount_amt: 158.25, pieces: 3, discount_pct: 10 });
  assert.equal(promoTotals([{ list_price: 100, qty: 1 }], 0).total_promo, 100);
  assert.equal(kitName({ model: 'Sportage', title: 'KIA Sportage', years: '2016-2022', items: [{ ctr_code: 'CE0342L', qty: 1 }, { ctr_code: 'CE0342R', qty: 1 }, { ctr_code: 'CR0297', qty: 1 }] }),
    'KIT T SPORTAGE 2016-2022_CE0342L_CE0342R_CR0297');
  assert.equal(kitName({ title: 'Versa', years: '2012 - 2019', items: [{ code: 'gv0083', qty: 2 }] }), 'KIT T VERSA 2012-2019_GV0083x2');
  assert.equal(kitBuildable([{ qty: 2, stock_qty: 7 }, { qty: 1, stock_qty: 5 }]), 3);
  assert.equal(kitBuildable([{ qty: 1, stock_qty: 0 }]), 0);
});

const SKIP = !process.env.DATABASE_URL;
test('라우트: 저장(번호) → 목록 · 수정 · 키트 제품 → 견적 미리보기·저장 줄에서 부품으로 풀림 · 카탈로그 제외', { skip: SKIP }, async () => {
  const { query } = await import('../src/db.js');
  const { default: vioPromoRoutes } = await import('../src/routes/vioPromoRoutes.js');
  const { buildLines } = await import('../src/quoteBuild.js');
  const { expandKitLines } = await import('../src/vioPromos.js');
  const TAG = String(Date.now()).slice(-5);
  const A = 'CE' + TAG + 'L', B = 'CE' + TAG + 'R', C = 'CR' + TAG;
  const pid = {};
  for (const [code, lp, st] of [[A, 623, 10], [B, 623, 3], [C, 336.5, 8]]) {
    pid[code] = Number((await query(`INSERT INTO products (code, name, list_price, stock_qty) VALUES ($1,'TERMINAL',$2,$3) RETURNING id`, [code, lp, st])).rows[0].id);
  }
  const app = Fastify(); await app.register(vioPromoRoutes); await app.ready();
  const DIR = { 'x-test-user': '1:director' }, MKT = { 'x-test-user': '2:marketing' };
  let kitPid = null; let promoId = null;
  try {
    const body = { model_key: 'kia|sportage', model: 'Sportage', title: 'KIA Sportage', years: '2016-2022', discount_pct: 10, show_totals: true,
      items: [{ code: A.toLowerCase(), qty: 1 }, { code: B, qty: 1 }, { code: C, qty: 2 }, { code: C, qty: 0 }] };
    let r = await app.inject({ method: 'POST', url: '/api/vio-promos', headers: DIR, payload: body });
    assert.equal(r.statusCode, 200, r.body);
    const p1 = r.json(); promoId = p1.id;
    assert.match(p1.promo_no, /^K\d{4,}$/);
    assert.equal(p1.total_list, 623 + 623 + 336.5 * 2); assert.equal(p1.total_promo, Math.round((623 + 623 + 673) * 0.9 * 100) / 100);
    assert.equal(p1.kit_name, 'KIT T SPORTAGE 2016-2022_' + A + '_' + B + '_' + C + 'x2');
    assert.equal(p1.buildable, 3, 'B 재고 3 → 3세트');
    // 두 번째 = 다음 번호
    r = await app.inject({ method: 'POST', url: '/api/vio-promos', headers: DIR, payload: { ...body, items: [{ code: A, qty: 1 }] } });
    const p2 = r.json();
    assert.equal(Number(p2.promo_no.slice(1)), Number(p1.promo_no.slice(1)) + 1, '연번');
    // 삭제(10-23): 남의 것 403 · 만든 사람/디렉터 200 · 다시 조회 404 · 번호는 다시 안 씀
    r = await app.inject({ method: 'DELETE', url: '/api/vio-promos/' + p2.id, headers: MKT });
    assert.equal(r.statusCode, 403);
    r = await app.inject({ method: 'DELETE', url: '/api/vio-promos/' + p2.id, headers: DIR });
    assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().promo_no, p2.promo_no);
    r = await app.inject({ method: 'GET', url: '/api/vio-promos/' + p2.id, headers: DIR });
    assert.equal(r.statusCode, 404);
    assert.equal(Number((await query(`SELECT count(*) n FROM vio_promo_items WHERE promo_id=$1`, [p2.id])).rows[0].n), 0, '구성품도 같이 지움');
    r = await app.inject({ method: 'POST', url: '/api/vio-promos', headers: DIR, payload: { ...body, items: [{ code: A, qty: 1 }] } });
    assert.equal(Number(r.json().promo_no.slice(1)), Number(p2.promo_no.slice(1)) + 1, '지운 번호는 다시 안 씀');
    await query(`DELETE FROM vio_promos WHERE id=$1`, [r.json().id]);
    // 오류
    r = await app.inject({ method: 'POST', url: '/api/vio-promos', headers: DIR, payload: { ...body, items: [{ code: 'ZZ00000', qty: 1 }] } });
    assert.equal(r.statusCode, 400); assert.deepEqual(r.json().codes, ['ZZ00000']);
    r = await app.inject({ method: 'POST', url: '/api/vio-promos', headers: DIR, payload: { ...body, items: [] } });
    assert.equal(r.json().error, 'no_items');
    // 목록 · 금액은 판매가 권한자만
    r = await app.inject({ method: 'GET', url: '/api/vio-promos?q=' + C, headers: DIR });
    assert.ok(r.json().items.some((x) => x.id === promoId));
    r = await app.inject({ method: 'GET', url: '/api/vio-promos/' + p1.promo_no, headers: MKT });
    assert.equal(r.statusCode, 200); assert.equal(r.json().total_list, undefined, '판매가 권한 없으면 금액 없음'); assert.equal(r.json().items[0].list_price, undefined);
    // 고치기: 남이 만든 건 못 고침 · 할인 바꾸면 금액 다시
    r = await app.inject({ method: 'PATCH', url: '/api/vio-promos/' + promoId, headers: MKT, payload: { discount_pct: 20 } });
    assert.equal(r.statusCode, 403);
    r = await app.inject({ method: 'PATCH', url: '/api/vio-promos/' + promoId, headers: DIR, payload: { discount_pct: 20, items: [{ code: A, qty: 1 }, { code: B, qty: 1 }, { code: C, qty: 1 }], model: 'Sportage' } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().total_list, 1582.5); assert.equal(r.json().total_promo, 1266); assert.equal(r.json().kit_name, 'KIT T SPORTAGE 2016-2022_' + A + '_' + B + '_' + C);
    // 키트 제품: 디렉터만
    r = await app.inject({ method: 'POST', url: '/api/vio-promos/' + promoId + '/kit', headers: MKT, payload: {} });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().error, 'kit_permission');
    // 0294 · 「🧰 키트 등록」(kit_create) 권한을 받은 영업(palomino 같은)은 만들 수 있음 — 목록에 can_kit
    const salesId = Number((await query(`INSERT INTO users (name, login_id, role, pin_hash) VALUES ('kitsales'||$1, 'kitsales'||$1, 'sales', 'x') ON CONFLICT DO NOTHING RETURNING id`, [TAG]).catch(() => ({ rows: [] }))).rows[0]?.id || 1);
    const SALESK = { 'x-test-user': salesId + ':sales', 'x-test-fields': 'sale_price,kit_create' };
    r = await app.inject({ method: 'GET', url: '/api/vio-promos?limit=5', headers: SALESK }); assert.equal(r.json().can_kit, true);
    r = await app.inject({ method: 'GET', url: '/api/vio-promos?limit=5', headers: MKT }); assert.equal(r.json().can_kit, false);
    r = await app.inject({ method: 'POST', url: '/api/vio-promos', headers: SALESK, payload: { ...body, items: [{ code: C, qty: 3 }] } });
    const p4 = r.json();
    r = await app.inject({ method: 'POST', url: '/api/vio-promos/' + p4.id + '/kit', headers: SALESK, payload: {} });
    assert.equal(r.statusCode, 200, r.body); const kit4 = r.json().product_id;
    await query(`DELETE FROM product_price_history WHERE product_id=$1`, [kit4]).catch(() => {}); await query(`DELETE FROM product_change_log WHERE product_id=$1`, [kit4]).catch(() => {});
    await query(`DELETE FROM vio_promos WHERE id=$1`, [p4.id]); await query(`DELETE FROM products WHERE id=$1`, [kit4]);
    if (salesId !== 1) { await query(`DELETE FROM audit_log WHERE user_id=$1`, [salesId]).catch(() => {}); await query(`DELETE FROM users WHERE id=$1`, [salesId]).catch(() => {}); }
    r = await app.inject({ method: 'POST', url: '/api/vio-promos/' + promoId + '/kit', headers: DIR, payload: {} });
    assert.equal(r.statusCode, 200, r.body);
    kitPid = r.json().product_id;
    assert.equal(r.json().code, p1.promo_no); assert.equal(r.json().list_price, 1582.5, '정가 합계');
    const prod = (await query(`SELECT code, name, list_price, app FROM products WHERE id=$1`, [kitPid])).rows[0];
    assert.equal(prod.name, 'KIT T SPORTAGE 2016-2022_' + A + '_' + B + '_' + C); assert.equal(Number(prod.list_price), 1582.5); assert.equal(prod.app, 'KIA Sportage 2016-2022');
    r = await app.inject({ method: 'POST', url: '/api/vio-promos/' + promoId + '/kit', headers: DIR, payload: {} });
    assert.equal(r.statusCode, 409);
    r = await app.inject({ method: 'PATCH', url: '/api/vio-promos/' + promoId, headers: DIR, payload: { items: [{ code: A, qty: 3 }] } });
    assert.equal(r.statusCode, 409, '키트 뒤 품목 잠김');
    r = await app.inject({ method: 'DELETE', url: '/api/vio-promos/' + promoId, headers: DIR });
    assert.equal(r.statusCode, 409, '제품 카탈로그에 키트가 있으면 삭제 안 됨'); assert.equal(r.json().kit_code, p1.promo_no);
    // 10-23 · 키트 사진 → R2 (키 없으면 503 · 형식 검사 · 키 있으면 서명된 PUT products/K…/K…_1.webp)
    const { createServer } = await import('node:http');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 7)]);
    const b64 = 'data:image/png;base64,' + png.toString('base64');
    const saved = { ...process.env }; for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT']) delete process.env[k];
    const got = []; const srv = createServer((q, s2) => { const ch = []; q.on('data', (c) => ch.push(c)); q.on('end', () => { got.push({ url: q.url, method: q.method, h: q.headers, n: Buffer.concat(ch).length }); s2.writeHead(200); s2.end(); }); });
    await new Promise((res) => srv.listen(0, '127.0.0.1', res));
    try {
      r = await app.inject({ method: 'GET', url: '/api/vio-promos/r2-status', headers: MKT });
      assert.equal(r.json().ready, false); assert.ok(r.json().missing.includes('R2_BUCKET'));
      r = await app.inject({ method: 'POST', url: '/api/vio-promos/' + promoId + '/kit-image', headers: DIR, payload: { image_b64: b64 } });
      assert.equal(r.statusCode, 503); assert.equal(r.json().error, 'r2_not_configured');
      Object.assign(process.env, { R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'AK', R2_SECRET_ACCESS_KEY: 'SK', R2_BUCKET: 'fotos', R2_ENDPOINT: 'http://127.0.0.1:' + srv.address().port });
      r = await app.inject({ method: 'POST', url: '/api/vio-promos/' + promoId + '/kit-image', headers: MKT, payload: { image_b64: b64 } });
      assert.equal(r.statusCode, 403, '디렉터만');
      r = await app.inject({ method: 'POST', url: '/api/vio-promos/' + promoId + '/kit-image', headers: DIR, payload: { image_b64: 'data:image/png;base64,' + Buffer.alloc(400, 1).toString('base64') } });
      assert.equal(r.statusCode, 415, '내용이 PNG 아님');
      r = await app.inject({ method: 'POST', url: '/api/vio-promos/' + promoId + '/kit-image', headers: DIR, payload: { image_b64: b64 } });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().key, 'products/' + p1.promo_no + '/' + p1.promo_no + '_1.webp');
      assert.equal(got.length, 1); assert.equal(got[0].method, 'PUT'); assert.equal(got[0].url, '/fotos/products/' + p1.promo_no + '/' + p1.promo_no + '_1.webp');
      assert.match(got[0].h.authorization, /^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
      assert.equal(got[0].h['content-type'], 'image/png'); assert.equal(got[0].n, png.length);
      r = await app.inject({ method: 'POST', url: '/api/vio-promos/' + p2.id + '/kit-image', headers: DIR, payload: { image_b64: b64 } });
      assert.equal(r.statusCode, 404, '지운 프로모션');

      // ★ 10-23 · R2 점검 — 쓰기·읽기를 따로 알려 준다(사진이 저장되지 않을 때 어디가 막혔는지)
      r = await app.inject({ method: 'POST', url: '/api/vio-promos/r2-check', headers: MKT, payload: {} });
      assert.equal(r.statusCode, 403, '디렉터만');
      r = await app.inject({ method: 'POST', url: '/api/vio-promos/r2-check', headers: DIR, payload: {} });
      assert.equal(r.statusCode, 200, r.body);
      let d = r.json();
      assert.equal(d.config.ready, true);
      assert.equal(d.escritura.ok, true, '올리기는 성공');
      assert.ok(got.some((x) => x.url.startsWith('/fotos/products/_diag/')), '점검 파일만 올린다 — 키트 사진은 안 건드린다');

      // ★ 쓰기가 막히면 무엇을 고쳐야 하는지까지 말해 준다
      const antes = process.env.R2_ENDPOINT;
      const malo = createServer((q, s3) => { q.resume(); q.on('end', () => { s3.writeHead(403); s3.end('<Error><Code>AccessDenied</Code></Error>'); }); });
      await new Promise((res) => malo.listen(0, '127.0.0.1', res));
      try {
        process.env.R2_ENDPOINT = 'http://127.0.0.1:' + malo.address().port;
        r = await app.inject({ method: 'POST', url: '/api/vio-promos/r2-check', headers: DIR, payload: {} });
        d = r.json();
        assert.equal(d.escritura.ok, false);
        assert.match(d.escritura.why, /HTTP 403/);
        assert.match(d.escritura.why, /쓰기/, '토큰 권한을 올리라고 알려 준다');

        r = await app.inject({ method: 'POST', url: '/api/vio-promos/' + promoId + '/kit-image', headers: DIR, payload: { image_b64: b64 } });
        assert.equal(r.statusCode, 502);
        assert.match(r.json().why, /AccessDenied|쓰기/, '화면에 진짜 사유가 간다');
        assert.match(r.json().note, /R2 저장 실패/);
      } finally { malo.close(); process.env.R2_ENDPOINT = antes; }
    } finally { srv.close(); for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT']) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; } }
    r = await app.inject({ method: 'GET', url: '/api/vio-promos/' + promoId, headers: DIR });
    assert.equal(r.json().kit_code, p1.promo_no);
    // 견적: 키트 2세트 → 부품 줄(코드로도 · id 로도)
    const ex = await expandKitLines([{ code: p1.promo_no.toLowerCase(), qty: 2 }, { code: A, qty: 1 }]);
    assert.deepEqual(ex.map((l) => [l.code, l.qty, l.kit_no || null]), [[A, 2, p1.promo_no], [B, 2, p1.promo_no], [C, 2, p1.promo_no], [A, 1, null]]);
    const lines = await buildLines(15, 16, [{ code: p1.promo_no, product_id: kitPid, qty: 2 }]);
    assert.deepEqual(lines.map((l) => [l.ctr_code, l.qty, l.discount_rate, l.line_no]), [[A, 2, 15, 1], [B, 2, 15, 2], [C, 2, 15, 3]]);
    assert.equal(lines[0].list_price, 623); assert.equal(lines[1].stock_flag, 'ok');
    // 견적 미리보기(화면): 키트 줄 → 부품 줄 + input_lines(화면 줄 목록 교체용) · 검색/코드 해석에 키트 정보
    const { default: quoteRoutes } = await import('../src/routes/quoteRoutes.js');
    const qa = Fastify(); await qa.register(quoteRoutes); await qa.ready();
    try {
      let q = await qa.inject({ method: 'POST', url: '/api/quotes/preview', headers: DIR, payload: { discount_rate: 10, lines: [{ code: A, product_id: pid[A], qty: 1 }, { code: p1.promo_no, qty: 2 }] } });
      assert.equal(q.statusCode, 200, q.body);
      const pv = q.json();
      assert.deepEqual(pv.lines.map((l) => [l.ctr_code, l.qty, l.kit_no]), [[A, 1, null], [A, 2, p1.promo_no], [B, 2, p1.promo_no], [C, 2, p1.promo_no]]);
      assert.deepEqual(pv.input_lines.map((l) => [l.code, l.product_id, l.qty, l.kit_no || null]), [[A, pid[A], 1, null], [A, pid[A], 2, p1.promo_no], [B, pid[B], 2, p1.promo_no], [C, pid[C], 2, p1.promo_no]]);
      assert.equal(pv.lines[1].discount_rate, 10);
      q = await qa.inject({ method: 'POST', url: '/api/quotes/preview', headers: DIR, payload: { discount_rate: 10, lines: [{ code: A, product_id: pid[A], qty: 1 }] } });
      assert.equal(q.json().input_lines, undefined, '키트 없으면 그대로');
      q = await qa.inject({ method: 'GET', url: '/api/quotes/search-code?q=' + p1.promo_no, headers: DIR });
      const hit = q.json().items.find((x) => x.ctr_code === p1.promo_no);
      assert.ok(hit && hit.kit && hit.kit.items.length === 3, JSON.stringify(q.json()).slice(0, 300));
      q = await qa.inject({ method: 'GET', url: '/api/quotes/resolve-code?code=' + p1.promo_no, headers: DIR });
      assert.equal(q.json().matches[0].kit.promo_no, p1.promo_no);
    } finally { await qa.close(); }
    // 제품 찾기 목록: 키트 행에 구성품(재고 · Backorder · 랙) + 세트 수 · 판매가 권한 없으면 가격 없음
    const { default: productRoutes } = await import('../src/routes/productRoutes.js');
    const pa = Fastify(); await pa.register(productRoutes); await pa.ready();
    try {
      await query(`UPDATE products SET rack_location='A-01' WHERE id=$1`, [pid[B]]);
      let q = await pa.inject({ method: 'GET', url: '/api/products?q=' + p1.promo_no + '&limit=20', headers: DIR });
      assert.equal(q.statusCode, 200, q.body);
      const kit = q.json().items.find((x) => x.code === p1.promo_no);
      assert.ok(kit && kit.kit, JSON.stringify(q.json()).slice(0, 300));
      assert.equal(kit.kit.promo_no, p1.promo_no); assert.equal(kit.kit.buildable, 3);
      assert.deepEqual(kit.kit.items.map((c) => [c.code, c.kit_qty, Number(c.stock_qty), Number(c.backorder_qty)]), [[A, 1, 10, 0], [B, 1, 3, 0], [C, 1, 8, 0]]);
      assert.equal(kit.kit.items[1].rack_location, 'A-01'); assert.equal(Number(kit.kit.items[0].list_price), 623);
      q = await pa.inject({ method: 'GET', url: '/api/products?q=' + A + '&limit=20', headers: DIR });
      assert.equal(q.json().items.find((x) => x.code === A).kit, undefined, '부품 행에는 kit 없음');
      q = await pa.inject({ method: 'GET', url: '/api/products?q=' + p1.promo_no + '&limit=20', headers: MKT });
      if (q.statusCode === 200) { const k2 = q.json().items.find((x) => x.code === p1.promo_no); assert.ok(k2.kit); assert.equal('list_price' in k2.kit.items[0], false, '판매가 권한 없으면 구성품 가격 없음'); }
    } finally { await pa.close(); }
  } finally {
    await app.close();
    if (kitPid) { await query(`DELETE FROM product_price_history WHERE product_id=$1`, [kitPid]).catch(() => {}); await query(`DELETE FROM product_change_log WHERE product_id=$1`, [kitPid]).catch(() => {}); }
    await query(`DELETE FROM vio_promos WHERE id=$1`, [promoId]).catch(() => {});
    await query(`DELETE FROM products WHERE id = ANY($1)`, [[...Object.values(pid), kitPid].filter(Boolean)]);
  }
});

test('카탈로그 API: 키트 코드(K0001…)는 내보내지 않음', async () => {
  const { readFileSync } = await import('node:fs');
  const s = readFileSync(new URL('../src/catalogPull.js', import.meta.url), 'utf-8');
  assert.match(s, /\^K\[0-9\]\{4,\}\$/);
  const q = readFileSync(new URL('../src/quoteBuild.js', import.meta.url), 'utf-8');
  assert.match(q, /inputLines = await expandKitLines\(inputLines\)/);
});
