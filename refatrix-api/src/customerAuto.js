// 불특정(게스트) 견적 → 고객 **조회** 헬퍼.
//
//  ⚠ 2026-08-26 (0185) 정책 변경 — 자동 생성 경로를 전면 차단했다.
//     100% 커미션 영업사원이 도입되면서, 고객 등록은
//       ① RFC 입력(=선점)  ② 선점(중복) 검사  ③ 디렉터 승인  · CONSTANCIA 는 선택 증빙
//     이 세 관문을 반드시 지나야 한다. 견적 화면의 「★ 미등록 고객(직접 입력)」이
//     고객을 조용히 만들어 주면 이 관문 전부가 우회된다(= 남의 고객을 뺏거나
//     증빙 없는 고객이 생김). 그래서 여기서는 **찾기만** 하고 만들지 않는다.
//
//     기존 고객(이름 일치)은 그대로 재사용된다 — 현장에서 이미 등록된 고객을
//     이름으로 집어 쓰는 흐름은 깨지지 않는다.
import { query } from './db.js';

// { name } → { id, created:false, approval_status } | { error:'customer_not_registered' } | null
export async function findOrCreateCustomerByName({ name }) {
  const nm = String(name || '').trim();
  if (!nm) return null;
  let ex;
  try {
    ex = (await query(
      `SELECT id, COALESCE(approval_status,'approved') AS approval_status
         FROM customers
        WHERE deleted_at IS NULL AND lower(btrim(name)) = lower(btrim($1))
        ORDER BY id LIMIT 1`, [nm])).rows[0];
  } catch (_) {
    // 0185 마이그레이션 전 DB — approval_status 컬럼이 없다. 승인 개념 없이 조회만.
    ex = (await query(
      `SELECT id FROM customers
        WHERE deleted_at IS NULL AND lower(btrim(name)) = lower(btrim($1))
        ORDER BY id LIMIT 1`, [nm])).rows[0];
    if (ex) ex.approval_status = 'approved';
  }
  if (ex) return { id: Number(ex.id), created: false, approval_status: ex.approval_status };
  return { error: 'customer_not_registered' };
}
