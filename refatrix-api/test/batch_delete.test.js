import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';

function seed() {
  const db = newDb();
  db.public.registerFunction({ name: 'now', returns: 'timestamptz', implementation: () => new Date() });
  db.public.none(`
    CREATE TABLE products (id INT PRIMARY KEY, stock_qty NUMERIC, updated_by INT);
    CREATE TABLE import_batches (id INT PRIMARY KEY, batch_no TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE stock_movements (id INT PRIMARY KEY, batch_id INT, product_id INT, move_type TEXT, qty NUMERIC);
    INSERT INTO products VALUES (1,100,NULL),(2,40,NULL);
    INSERT INTO import_batches VALUES (10,'TEST-1',NULL),(11,'TEST-2',NULL);
    INSERT INTO stock_movements VALUES (1,10,1,'in',60),(2,10,2,'in',40);
  `);
  return db.public;
}

// 엔드포인트 핵심 로직 재현
function deleteBatch(pub, batchId, userId) {
  const b = pub.many(`SELECT id, batch_no FROM import_batches WHERE id=${batchId} AND deleted_at IS NULL`)[0];
  if (!b) return { error: 'not_found' };
  const mv = pub.many(`SELECT product_id, move_type, qty FROM stock_movements WHERE batch_id=${batchId}`);
  for (const r of mv) {
    const p = pub.many(`SELECT stock_qty FROM products WHERE id=${r.product_id}`)[0];
    if (!p) continue;
    const qty = Number(r.qty) || 0;
    const delta = r.move_type === 'in' ? Math.abs(qty) : (r.move_type === 'out' ? -Math.abs(qty) : qty);
    pub.none(`UPDATE products SET stock_qty=${Number(p.stock_qty) - delta}, updated_by=${userId} WHERE id=${r.product_id}`);
  }
  if (mv.length) pub.none(`DELETE FROM stock_movements WHERE batch_id=${batchId}`);
  pub.none(`UPDATE import_batches SET deleted_at=now() WHERE id=${batchId}`);
  return { ok: true, batch_no: b.batch_no, movements_reversed: mv.length };
}

test('이동 있는 배치: 재고 역산 + 이동 삭제 + 기록 soft-delete', () => {
  const pub = seed();
  const r = deleteBatch(pub, 10, 9);
  assert.equal(r.ok, true); assert.equal(r.movements_reversed, 2);
  assert.equal(Number(pub.many(`SELECT stock_qty FROM products WHERE id=1`)[0].stock_qty), 40, '재고 100-60');
  assert.equal(Number(pub.many(`SELECT stock_qty FROM products WHERE id=2`)[0].stock_qty), 0, '재고 40-40');
  assert.equal(pub.many(`SELECT * FROM stock_movements WHERE batch_id=10`).length, 0, '이동 삭제');
  assert.ok(pub.many(`SELECT deleted_at FROM import_batches WHERE id=10`)[0].deleted_at, '배치 soft-delete');
  // 비삭제 목록에서 제외
  assert.equal(pub.many(`SELECT * FROM import_batches WHERE deleted_at IS NULL`).length, 1, '목록에서 사라짐(11만 남음)');
});

test('이동 없는(이미 재고삭제했던) 배치: 기록만 정리', () => {
  const pub = seed();
  const r = deleteBatch(pub, 11, 9); // 11은 stock_movements 없음
  assert.equal(r.ok, true); assert.equal(r.movements_reversed, 0, '역산할 이동 없음');
  assert.ok(pub.many(`SELECT deleted_at FROM import_batches WHERE id=11`)[0].deleted_at, '기록 soft-delete');
});

test('없는/이미삭제 배치: not_found', () => {
  const pub = seed();
  pub.none(`UPDATE import_batches SET deleted_at=now() WHERE id=10`);
  assert.equal(deleteBatch(pub, 10, 9).error, 'not_found', '이미 삭제됨');
  assert.equal(deleteBatch(pub, 999, 9).error, 'not_found', '없는 배치');
});
