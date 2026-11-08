// =====================================================================
// 1108 · SYD 품명(DESCRIPCIÓN · 0324) — SYD 리스트 올리기 → /api/products/syd-names
//   · 리스트에 품명 열이 있으면 저장 · 없으면(옛 화면) 예전과 같이 저장(품명 null)
//   · 조회: 코드 표기 무관(대문자+영숫자) · 최신 리스트에 품명이 없으면 예전 리스트 품명 · 가격은 주지 않는다
//   실행: DATABASE_URL=... node --import ./test/helpers/stub-auth.mjs --test test/syd_names.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PM = await import('../src/priceMaster.js');

test('A. parseSydRows — 품명 대문자 · 공백 정리 · 없으면 null', () => {
  const { items } = PM.parseSydRows([
    { code: '1603005', price: 100, familia: 'zaux', descripcion: '  horquilla   inferior "R" ' },
    { code: 'K-9647', price: 50, familia: 'TERM' }]);
  assert.equal(items[0].descripcion, 'HORQUILLA INFERIOR "R"');
  assert.equal(items[1].descripcion, null, '옛 화면은 품명을 보내지 않는다');
});

test('B. 올리기 → 조회 (실 PostgreSQL)', { skip: !process.env.DATABASE_URL }, async () => {
  const Fastify = (await import('fastify')).default;
  const { query, pool } = await import('../src/db.js');
  const { default: priceMasterRoutes } = await import('../src/routes/priceMasterRoutes.js');
  const { default: positionRoutes } = await import('../src/routes/positionRoutes.js');
  const app = Fastify(); await app.register(priceMasterRoutes); await app.register(positionRoutes); await app.ready();
  const H = { 'x-test-user': '1:director' };
  const keep = (await query(`SELECT id FROM syd_price_lists`)).rows.map((r) => Number(r.id));
  const mine = [];
  const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  try {
    // ① 예전 리스트: 품명 있음
    let r = await app.inject({ method: 'POST', url: '/api/price-master/syd/lists', headers: H, payload: { list_date: day(60), file_name: 'syd_old.xlsx', rows: [
      { code: 'ZT-1603005', price: 980, familia: 'ZAUX', descripcion: 'SOPORTE BRAZO AUXILIAR' },
      { code: 'ZT-9647', price: 735, familia: 'TERM', descripcion: 'TERMINAL EXTERIOR "L"' }] } });
    assert.equal(r.statusCode, 200, r.body); mine.push(r.json().id);
    assert.equal((await query(`SELECT descripcion FROM syd_price_items WHERE list_id=$1 AND syd_code='ZT-9647'`, [r.json().id])).rows[0].descripcion, 'TERMINAL EXTERIOR "L"');
    // ② 최신 리스트: 한 코드는 품명 바뀜, 한 코드는 품명 없음(열 없는 파일)
    r = await app.inject({ method: 'POST', url: '/api/price-master/syd/lists', headers: H, payload: { list_date: day(1), file_name: 'syd_new.xlsx', rows: [
      { code: 'ZT-1603005', price: 1010, familia: 'ZAUX', descripcion: 'SOPORTE BRAZO AUXILIAR DELANTERO' },
      { code: 'ZT-9647', price: 760, familia: 'TERM' }] } });
    assert.equal(r.statusCode, 200, r.body); mine.push(r.json().id);
    // ③ 조회 — 표기 달라도(소문자 · 공백) 같은 코드 · 가격 없음 · 최신 품명 우선, 없으면 예전 품명
    r = await app.inject({ method: 'POST', url: '/api/products/syd-names', headers: { 'x-test-user': '5:sales' }, payload: { codes: ['zt 1603005', 'ZT-9647', 'NADA-1'] } });
    assert.equal(r.statusCode, 200, r.body);
    const it = r.json().items;
    assert.equal(it.ZT1603005.desc, 'SOPORTE BRAZO AUXILIAR DELANTERO', '최신 리스트 품명');
    assert.equal(it.ZT9647.desc, 'TERMINAL EXTERIOR "L"', '최신에 품명이 없으면 예전 품명');
    assert.equal(it.NADA1, undefined);
    assert.ok(!JSON.stringify(r.json()).includes('1010'), '가격은 주지 않는다');
  } finally {
    await app.close();
    for (const id of mine) await query(`DELETE FROM syd_price_lists WHERE id=$1`, [id]);
    void keep;
    await pool.end();
  }
});
