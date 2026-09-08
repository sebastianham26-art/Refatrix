// 고객코드 채번 — 계열(접두어)별로 번호를 따로 센다.
//
//   C-#### : ERP 에서 영업사원·디렉터가 등록한 고객
//   P-#### : 웹카달록(CRM)에서 들어온 고객  ← 0206/0208
//
//   ⚠ 삭제된 고객(soft delete)의 코드도 세어야 한다. customers.code 에는 유니크 제약이 걸려
//     있고 소프트삭제 행은 테이블에 남으므로, deleted_at IS NULL 만 보면 이미 쓰인 번호를
//     다시 뽑아 INSERT 가 계속 실패한다.
import { query } from './db.js';

export async function computeNextCode(prefix = 'C') {
  const rows = (await query(`SELECT code FROM customers`)).rows;
  const used = new Set(); let maxn = 0;
  const re = new RegExp('^' + String(prefix) + '-?(\\d+)$', 'i');
  for (const r of rows) {
    const m = String(r.code || '').match(re);
    if (m) { const n = parseInt(m[1], 10); used.add(n); if (n > maxn) maxn = n; }
  }
  let next = maxn + 1;
  while (used.has(next)) next++;
  return String(prefix).toUpperCase() + '-' + String(next).padStart(4, '0');
}
