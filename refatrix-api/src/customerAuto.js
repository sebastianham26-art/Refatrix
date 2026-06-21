// 불특정(게스트) 견적 → 고객 자동등록 헬퍼.
//  · 같은 이름(공백·대소문자 무시) 고객이 있으면 재사용, 없으면 신규 생성.
//  · 코드(C-NNNN) 자동 발번, 유니크 충돌 시 재시도.
import { query } from './db.js';

async function nextCustomerCode() {
  const rows = (await query(`SELECT code FROM customers WHERE deleted_at IS NULL`)).rows;
  let maxn = 0;
  for (const r of rows) { const m = String(r.code || '').match(/^c-?(\d+)$/i); if (m) { const n = parseInt(m[1], 10); if (n > maxn) maxn = n; } }
  return 'C-' + String(maxn + 1).padStart(4, '0');
}

// { name, discount, teamId, userId } → { id, created } | null
export async function findOrCreateCustomerByName({ name, discount, teamId, userId }) {
  const nm = String(name || '').trim();
  if (!nm) return null;
  const ex = (await query(
    `SELECT id FROM customers WHERE deleted_at IS NULL AND lower(btrim(name)) = lower(btrim($1)) ORDER BY id LIMIT 1`, [nm])).rows[0];
  if (ex) return { id: Number(ex.id), created: false };
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = await nextCustomerCode();
    try {
      const ins = (await query(
        `INSERT INTO customers (code, name, discount, team_id, owner_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [code, nm, Number(discount) || 0, teamId || null, userId || null, userId || null])).rows[0];
      return { id: Number(ins.id), created: true };
    } catch (e) {
      if (attempt === 4) throw e;   // 코드 유니크 충돌 → 재시도, 마지막엔 throw
    }
  }
  return null;
}
