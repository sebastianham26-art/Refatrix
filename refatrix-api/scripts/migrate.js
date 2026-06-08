import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { pool } from '../src/db.js';

// migrations 폴더의 0*.sql 을 순서대로 적용. 적용 이력은 _migrations 테이블에 기록.
// SQL 파일은 백엔드 폴더 안의 migrations/ 에 함께 둔다(refatrix-api/migrations).
const here = dirname(fileURLToPath(import.meta.url));
const migDir = resolve(here, '..', 'migrations');

async function main() {
  await pool.query(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await pool.query(`SELECT name FROM _migrations`)).rows.map((r) => r.name));
  const files = readdirSync(migDir).filter((f) => /^0\d+_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    if (done.has(f)) { console.log('skip ', f); continue; }
    const sql = readFileSync(join(migDir, f), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO _migrations(name) VALUES ($1)`, [f]);
      await client.query('COMMIT');
      console.log('apply', f);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('FAIL ', f, e.message);
      process.exit(1);
    } finally { client.release(); }
  }
  console.log('migrations complete');
  await pool.end();
}
main();
