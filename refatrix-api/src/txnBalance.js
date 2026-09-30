// ===== 거래 후 잔고 (running balance) — 2026-09-30 =====
// 거래목록에서 각 거래 행 옆에 「그 거래가 반영된 직후의 계좌 잔고」를 보여주기 위한 계산.
// 나중에 잔고가 틀렸을 때 **어느 거래부터 어긋났는지** 은행 명세서와 한 줄씩 대조하려는 목적.
//
// 잔고 공식은 /api/accounts 의 balance, /api/accounts/:id/ledger 와 100% 동일해야 한다:
//   open_balance + Σ(in:+amount / out:-amount)
//   WHERE status='actual' AND approved=true AND deleted_at IS NULL
//   · 계좌 통화 기준(USD 계좌는 USD) — MXN 환산이 아니다.
//   · 순서: txn_date ASC, id ASC (같은 날은 등록 순). 소급 등록 거래도 날짜 자리에 끼워 계산된다.
//
// 목록 필터(기간·상태·구분·페이지)와 **무관하게** 계좌의 전 이력으로 누적한 뒤, 화면에 나온 행만 골라낸다.
//   → 필터를 걸어도, 200건씩 끊어 봐도 각 행의 잔고 값은 항상 같다.
// 비공개(is_private) 거래도 합산에 포함한다(계좌 잔액과 일치시키기 위해). 비디렉터에겐 그 행이
// 목록에 안 보일 뿐이라 잔고가 한 번에 건너뛰어 보일 수 있다 — 화면 안내문에 명시.
//
// 예정(plan)·미승인·계좌 미지정 거래는 잔고에 반영되지 않으므로 balance_after=null.

export const TXN_BALANCE_SQL = `
  SELECT x.id, x.bal_after
    FROM (
      SELECT t.id,
             a.open_balance + SUM(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END)
               OVER (PARTITION BY t.account_id ORDER BY t.txn_date ASC, t.id ASC
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS bal_after
        FROM transactions t
        JOIN accounts a ON a.id=t.account_id
       WHERE t.account_id = ANY($1)
         AND t.status='actual' AND t.approved=true AND t.deleted_at IS NULL
    ) x
   WHERE x.id = ANY($2)`;

// 이 행이 잔고에 반영되는 거래인가 (SQL WHERE 와 같은 조건)
export function countsInBalance(t) {
  return !!t && t.account_id != null && t.status === 'actual' && t.approved === true && !t.deleted_at;
}

function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

// rows: 목록에 나갈 거래 행들(account_id, status, approved 포함). 각 행에 balance_after 를 붙여 돌려준다.
// q: (sql, args) => Promise<{rows}>. 실패하면 잔고 없이(null) 목록은 그대로 — 목록 자체를 깨지 않는다.
export async function attachBalanceAfter(q, rows) {
  const target = rows.filter(countsInBalance);
  if (!target.length) return rows.map((t) => ({ ...t, balance_after: null }));
  const accIds = [...new Set(target.map((t) => Number(t.account_id)))];
  const ids = target.map((t) => Number(t.id));
  let map = new Map();
  try {
    const res = await q(TXN_BALANCE_SQL, [accIds, ids]);
    map = new Map(res.rows.map((r) => [Number(r.id), r2(r.bal_after)]));
  } catch (e) {
    // 잔고 계산 실패는 목록을 막지 않는다(표시만 빈칸).
    map = new Map();
  }
  return rows.map((t) => ({
    ...t,
    balance_after: countsInBalance(t) && map.has(Number(t.id)) ? map.get(Number(t.id)) : null,
  }));
}
