import pg from 'pg';
import { config } from './config.js';

// 단일 커넥션 풀. 라우트에서 query()/withTx() 사용.
// 2026-07-01: 창고 사진(대용량 base64)이 풀을 잡아먹어 로그인 등 전체가 20초씩 대기하던 문제 대응.
//   - max 10→30: 동시 처리 가능한 연결 수 3배(대용량 요청이 몇 개 물려도 로그인이 안 굶음)
//   - connectionTimeoutMillis: 빈 연결을 10초 안에 못 얻으면 에러(무한 대기 방지 → '영원히 로딩' 제거)
//   - statement_timeout: 단일 쿼리가 60초 넘게 걸리면 취소(폭주 쿼리 차단, 정상 리포트엔 여유)
//   - idle_in_transaction_session_timeout: 열린 채 방치된 트랜잭션 30초 후 정리(락 물고 안 놓는 사고 방지)
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 30,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 60000,
  idle_in_transaction_session_timeout: 30000,
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
