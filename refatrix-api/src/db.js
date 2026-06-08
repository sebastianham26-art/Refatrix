import pg from 'pg';
import { config } from './config.js';

// 단일 커넥션 풀. 라우트에서 query()/withTx() 사용.
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
});

export function query(text, params) {
  return pool.query(text, params);
}

// 트랜잭션 헬퍼 (수입 승인처럼 여러 테이블을 한 번에 갱신할 때 사용)
export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
