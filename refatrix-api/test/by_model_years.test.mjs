// 2026-10-22 · GET /api/products/by-model — 같은 차종명에 적용 연식이 여러 줄이면 cell.yrs 에 모두 남는다
//   (VIO 제품찾기·프로모션의 세대별 필터용. 예: Sportage 2011-2016 / 2017-2020 둘 다 맞는 코드)
//   실행: DATABASE_URL=postgres://…/빈DB(전체 마이그레이션) node --import ./test/helpers/stub-auth.mjs --test test/by_model_years.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

const SKIP = !process.env.DATABASE_URL;
const TAG = 'BMY' + Date.now().toString(36).toUpperCase();

test('by-model: cell.yrs 에 같은 차종명의 연식이 모두 · year 는 첫 줄 그대로(호환)', { skip: SKIP }, async () => {
  const { query } = await import('../src/db.js');
  const { default: productRoutes } = await import('../src/routes/productRoutes.js');
  const one = async (s, p = []) => (await query(s, p)).rows[0];
  const model = 'Zsportage' + TAG;   // 다른 시험 자료와 안 섞이게
  const pid = (await one(`INSERT INTO products (code, name, list_price, stock_qty) VALUES ($1,'HORQUILLA',1000,4) RETURNING id`, ['CQ' + TAG + 'L'])).id;
  const pid2 = (await one(`INSERT INTO products (code, name, list_price, stock_qty) VALUES ($1,'RÓTULA',300,2) RETURNING id`, ['CB' + TAG])).id;
  for (const [p, mk, md, a, b] of [[pid, 'KIA', model, 2011, 2016], [pid, 'KIA', model, 2017, 2020], [pid, 'HYUNDAI', 'Tucson', 2010, 2015], [pid2, 'KIA', model, 2011, 2016]]) {
    await query(`INSERT INTO product_applications (product_id, app_text, maker, model, year_from, year_to) VALUES ($1,$2,$3,$4,$5,$6)`,
      [p, 'KIA ' + model + ' // HYUNDAI Tucson', mk, md, a, b]);
  }
  const app = Fastify(); await app.register(productRoutes); await app.ready();
  try {
    const r = await app.inject({ method: 'GET', url: '/api/products/by-model?q=' + encodeURIComponent(model), headers: { 'x-test-user': '1:director' } });
    assert.equal(r.statusCode, 200);
    const d = r.json();
    const cells = []; d.categories.forEach((c) => Object.entries(c.cells).forEach(([vk, arr]) => arr.forEach((x) => cells.push({ vk, ...x }))));
    const mine = cells.find((x) => x.ctr === 'CQ' + TAG + 'L' && x.vk.toLowerCase() === model.toLowerCase());
    assert.ok(mine, JSON.stringify(cells.map((x) => x.vk + ':' + x.ctr)));
    assert.deepEqual([...mine.yrs].sort(), ['2011-2016', '2017-2020']);
    assert.ok(['2011-2016', '2017-2020'].includes(mine.year), '예전 year 칸 유지');
    const tuc = cells.find((x) => x.ctr === 'CQ' + TAG + 'L' && x.vk === 'Tucson');
    assert.deepEqual(tuc.yrs, ['2010-2015'], '다른 차종명 줄은 따로');
    const cb = cells.find((x) => x.ctr === 'CB' + TAG);
    assert.deepEqual(cb.yrs, ['2011-2016']);
  } finally {
    await app.close();
    await query(`DELETE FROM product_applications WHERE product_id = ANY($1)`, [[pid, pid2]]);
    await query(`DELETE FROM products WHERE id = ANY($1)`, [[pid, pid2]]);
  }
});
