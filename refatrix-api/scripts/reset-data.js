import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from '../src/db.js';

// ERP 운영 데이터 초기화 (실사용 시작 전 1회용).
// 안전장치: 인자로 'confirm' 을 줘야만 실제로 실행됩니다.
//   실행:  npm run reset-data confirm
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = resolve(here, '..', 'reset_erp_data.sql');

const counts = async () => (await pool.query(`
  SELECT
    (SELECT count(*) FROM customers)            AS 고객,
    (SELECT count(*) FROM quotes)               AS 견적,
    (SELECT count(*) FROM sales_invoices)       AS 매출,
    (SELECT count(*) FROM transactions)         AS 거래,
    (SELECT count(*) FROM product_dev_requests) AS 개발요청,
    (SELECT count(*) FROM recurring_rules)      AS 고정비,
    (SELECT count(*) FROM products)             AS 제품_유지,
    (SELECT count(*) FROM accounts)             AS 계좌_유지,
    (SELECT count(*) FROM stages)               AS 단계_유지,
    (SELECT count(*) FROM categories)           AS 거래분류_유지,
    (SELECT count(*) FROM users)                AS 사용자_유지
`)).rows[0];

async function main() {
  const confirmed = process.argv.slice(2).includes('confirm');
  if (!confirmed) {
    console.log('\n⚠  이 명령은 ERP 운영 데이터를 모두 삭제합니다 (제품 마스터·사용자·설정은 유지).');
    console.log('   실제로 실행하려면 뒤에 confirm 을 붙이세요:\n');
    console.log('       npm run reset-data confirm\n');
    await pool.end();
    return;
  }

  console.log('\n── 실행 전 ──');
  console.table(await counts());

  const sql = readFileSync(sqlPath, 'utf-8');
  try {
    await pool.query(sql);            // 파일 안에 BEGIN … COMMIT 포함
    console.log('\n✅ 정리 완료 (오류 없음)');
  } catch (e) {
    console.error('\n❌ 실행 오류:', e.message);
    await pool.end();
    process.exit(1);
  }

  console.log('\n── 실행 후 (삭제대상 0 / 유지대상 보존 확인) ──');
  console.table(await counts());

  const chk = (await pool.query(`
    SELECT (SELECT count(*) FROM products WHERE stock_qty<>0 OR avg_cost<>0)                   AS 재고0_아닌_제품,
           (SELECT count(*) FROM accounts WHERE open_balance<>0 AND deleted_at IS NULL)   AS 잔액0_아닌_계좌
  `)).rows[0];
  console.log('재고 0 아닌 제품:', chk.재고0_아닌_제품, '| 시작잔액 0 아닌 계좌:', chk.잔액0_아닌_계좌, '(둘 다 0이어야 정상)');

  await pool.end();
  console.log('\n끝났습니다. 앱에서 Ctrl+Shift+R 후 화면을 확인하세요.\n');
}
main();
