// =====================================================================
// 영수증 번호 「다음 번호」 제안 — 순수 함수 (DB·HTTP 의존 없음)  2026-08-31
//
// 배경: 재무 > 거래등록에서 영수증 번호를 넣을 때마다 지난 영수증/거래목록을
//       뒤져 마지막 번호를 찾아야 했다. 그 수고를 없애기 위해
//       **가장 최근에 등록된 영수증 번호의 맨 뒤 숫자 덩어리 +1** 을 제안한다.
//
// 규칙은 일부러 단순하게 뒀다 — 어차피 사람이 보고 고칠 수 있는 "제안"이다.
//   A-12345        → A-12346          (접두사 보존)
//   F0087          → F0088            (앞자리 0 채움 폭 보존)
//   REC-2026-0012  → REC-2026-0013    (맨 뒤 덩어리만 증가 — 연도 2026 은 그대로)
//   0099           → 0100             (자리 올림 — 폭 유지)
//   99             → 100              (폭이 모자라면 늘어난다)
//   B-77-MX        → B-78-MX          (숫자 뒤 꼬리표는 그대로)
//   A-12345 (1)    → A-12345 (2)      ⚠ 맨 뒤 덩어리 규칙상 괄호 안이 올라간다 → 사람이 고침
//   ABC / 빈값     → null             (숫자가 없으면 제안하지 않음)
// =====================================================================

// transactions.receipt_no 저장 시 자르는 길이(financeRoutes 의 slice(0,60))와 동일.
export const RECEIPT_NO_MAX = 60;

// 숫자 덩어리가 이보다 길면 번호가 아니라고 보고 제안하지 않는다.
// (Number 정밀도 안전 구간 = 15자리)
const MAX_DIGITS = 15;

/**
 * 직전 영수증 번호에서 다음 번호를 만든다.
 * @param {string|null|undefined} prev 직전 영수증 번호
 * @param {{maxLen?:number}} [opt]
 * @returns {string|null} 제안 번호 (제안 불가 시 null)
 */
export function nextReceiptNo(prev, opt = {}) {
  const maxLen = opt.maxLen == null ? RECEIPT_NO_MAX : opt.maxLen;
  const s = String(prev == null ? '' : prev).trim();
  if (!s) return null;

  // 맨 뒤 숫자 덩어리 = 뒤쪽에 숫자가 더 없는 마지막 연속 숫자.
  //   (head 를 lazy 로 두고 tail 을 \D* 로 묶으면 역추적으로 마지막 덩어리가 잡힌다)
  const m = s.match(/^([\s\S]*?)(\d+)(\D*)$/);
  if (!m) return null;

  const head = m[1], digits = m[2], tail = m[3];
  if (digits.length > MAX_DIGITS) return null;

  let inc = String(Number(digits) + 1);
  if (inc.length < digits.length) inc = inc.padStart(digits.length, '0'); // 0099 → 0100

  const out = head + inc + tail;
  if (!out || out.length > maxLen) return null;
  return out;
}

export default { nextReceiptNo, RECEIPT_NO_MAX };
