// =====================================================================
// Refatrix ERP · quoteStage.js
//   견적(오더)별 현재 진행 단계/상태/경고 판정 (순수 함수).
//   추이 화면(devRequestRoutes)과 경고 sweep(stageAlerts)이 동일 로직을 공유.
//   단계: 견적작성 → 포장작업 중(출력) → 포장완료 → SAT 입력대기(전환)
//         → 수금대기(외상일중/지연중) → 수금완료
//   경고 기준(디렉터 확정):
//    · 견적작성→포장출력: 48시간(벽시계) 초과
//    · 포장출력→포장완료: 업무시간 6시간(packing_due_at) 초과
//    · 전환→SAT 입력: 3시간(벽시계) 초과
//    · 수금: 인보이스 외상일(due_date) 경과 → 지연중(연체)
// =====================================================================
import { mxTodayStr } from './workingHours.js';

export const STAGE_LABELS = {
  created: '견적작성', printing: '포장작업 중', packed: '포장완료',
  await_sat: 'SAT 입력대기', await_collect: '수금대기', collected: '수금완료',
  backorder: '전환(백오더)', cancelled: '취소', expired: '만료', pricelist: '가용재고/견적', other: '-',
};
export const STAGE_RANK = {
  created: 1, printing: 2, packed: 3, await_sat: 4, backorder: 4,
  await_collect: 5, collected: 6, cancelled: 0, expired: 0, pricelist: 0, other: 0,
};

export function computeQuoteStage(o, now) {
  const nowMs = now.getTime();
  function pack(key, dl = null, w = false, sk = null, wl = '') {
    return {
      stage_key: key, stage_label: STAGE_LABELS[key] || key, stage_rank: STAGE_RANK[key] || 0,
      status_key: sk, deadline: dl ? new Date(dl).toISOString() : null,
      warn: !!w, warn_rank: w ? 1 : 0, warn_label: wl,
    };
  }
  const realSat = !!(o.sat_no && !String(o.sat_no).startsWith('TMP-'));
  const hasInvoice = o.invoice_id != null;
  const total = o.total_mxn == null ? null : Number(o.total_mxn);
  const outstanding = (total == null) ? null : (total - Number(o.paid_sum || 0));
  const todayMx = mxTodayStr(now);
  const due = o.due_date ? String(o.due_date).slice(0, 10) : null;

  if (o.status === 'cancelled') return pack('cancelled');
  if (o.status === 'expired') return pack('expired');
  if (o.status === 'pricelist') return pack('pricelist');

  if (hasInvoice && outstanding != null && outstanding <= 0.005) return pack('collected');

  if (hasInvoice && realSat) {
    const dl = o.due_date ? new Date(o.due_date) : null;
    if (due && due < todayMx && (outstanding == null || outstanding > 0.005)) {
      return pack('await_collect', dl, true, 'overdue', '외상 지연(연체)');
    }
    return pack('await_collect', dl, false, 'within', '');
  }
  if (hasInvoice) {
    const base = o.converted_at ? new Date(o.converted_at).getTime() : null;
    const dl = base ? new Date(base + 3 * 3600000) : null;
    const w = dl ? nowMs > dl.getTime() : false;
    return pack('await_sat', dl, w, null, w ? 'SAT 입력 지연(전환 후 3시간 초과)' : '');
  }
  if (o.status === 'converted') return pack('backorder');
  if (o.packed_at) return pack('packed');
  if (o.packing_printed_at) {
    const dl = o.packing_due_at ? new Date(o.packing_due_at) : null;
    const w = dl ? nowMs > dl.getTime() : false;
    return pack('printing', dl, w, null, w ? '포장완료 지연(업무시간 6시간 초과)' : '');
  }
  const dl = o.created_at ? new Date(new Date(o.created_at).getTime() + 48 * 3600000) : null;
  const w = dl ? nowMs > dl.getTime() : false;
  return pack('created', dl, w, null, w ? '오더 미확정(견적 후 48시간 초과)' : '');
}
