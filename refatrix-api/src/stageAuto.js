// 자동 단계이동 — 견적서 작성 → 견적(30), 매출확정 → 거래중(60).
//  · 전진만(현재 단계보다 뒤로는 절대 이동 안 함). 이미 도달/초과면 단계는 그대로.
//  · 수기 단계변경과 동일한 이력관리: customer_stage_history(닫고-열기) + customers 갱신 + customer_meetings 로그(날짜 포함).
//  · 베스트에포트: 호출부에서 try/catch로 감싸 본 흐름(견적/매출 생성)을 절대 깨지 않게.
import { query, withTx } from './db.js';

// 전진 여부(순수): 목표 sort_order가 현재보다 크면 전진. (현재 미지정 = -1 취급)
export function decideAdvance(curSort, targetSort) {
  const cur = (curSort == null) ? -1 : Number(curSort);
  return Number(targetSort) > cur;
}

async function stageBySort(sort) {
  return (await query(`SELECT id, sort_order FROM stages WHERE sort_order=$1 AND deleted_at IS NULL ORDER BY id LIMIT 1`, [sort])).rows[0] || null;
}

// opts: { customerId, targetSort, onDate?, userId?, note?, alwaysLog? }
//  alwaysLog=true → 전진이 없어도 customer_meetings에 기록(매출내역 표기용).
export async function autoStage({ customerId, targetSort, onDate, userId, note, alwaysLog = false }) {
  if (!customerId) return { ok: false };
  const cust = (await query(`SELECT id, stage_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [customerId])).rows[0];
  if (!cust) return { ok: false };
  const target = await stageBySort(targetSort);
  if (!target) return { ok: false };
  const cur = cust.stage_id ? (await query(`SELECT sort_order FROM stages WHERE id=$1`, [cust.stage_id])).rows[0] : null;
  const advance = decideAdvance(cur ? cur.sort_order : null, target.sort_order);
  const date = onDate || new Date().toISOString().slice(0, 10);
  if (!advance && !alwaysLog) return { ok: true, advanced: false };
  await withTx(async (cx) => {
    if (advance) {
      await cx.query(`UPDATE customer_stage_history SET left_at=$2 WHERE customer_id=$1 AND left_at IS NULL`, [customerId, date]);
      await cx.query(`INSERT INTO customer_stage_history (customer_id, stage_id, entered_at, created_by) VALUES ($1,$2,$3,$4)`,
        [customerId, target.id, date, userId || null]);
      await cx.query(`UPDATE customers SET stage_id=$1, stage_since=$2 WHERE id=$3`, [target.id, date, customerId]);
    }
    await cx.query(
      `INSERT INTO customer_meetings (customer_id, meeting_date, note, stage_before, stage_after, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [customerId, date, note || null, cust.stage_id || null, advance ? target.id : (cust.stage_id || null), userId || null]);
  });
  return { ok: true, advanced: advance };
}
