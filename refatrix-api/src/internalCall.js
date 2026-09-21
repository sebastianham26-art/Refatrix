// =====================================================================
// Refatrix ERP · internalCall.js  (2026-09-21 · 0224c)
// 서버 내부 호출(app.inject) 표식.
//
// 왜 필요한가
//   견적 → 매출 전환(/api/quotes/:id/convert)은 인보이스를 만들 때
//   POST /api/sales 를 app.inject 로 **내부 호출**한다. 그런데 /api/sales 에는
//   0179 의 「판매중단 SKU 매출등록 차단」이 걸려 있어서, 판매중단 SKU 에 재고가
//   남아 있으면 전환 전체가 sale_failed(inactive_product) 로 멈췄다.
//   디렉터 지시(2026-09-18): 「inactivo 이후 들어온 오더는 기록하되, 그 오더가 포함된
//   견적은 매출확정이 되게 하라.」
//
//   직접 매출등록 화면은 계속 막아야 하므로 「이 요청은 전환 경로에서 온 내부 호출」임을
//   구별해야 한다. 클라이언트가 보낼 수 있는 body 값(예: source_quote_id 만)으로 구별하면
//   누구나 흉내 낼 수 있다 → **프로세스 기동 시 만든 난수 토큰**을 헤더로 붙인다.
//   외부 요청은 이 값을 알 수 없다(로그·응답 어디에도 내보내지 않는다).
// =====================================================================
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const INTERNAL_HEADER = 'x-refatrix-internal';
const TOKEN = randomBytes(24).toString('hex');
const TOKEN_BUF = Buffer.from(TOKEN);

/** app.inject 에 붙일 헤더 */
export function internalHeaders() {
  return { [INTERNAL_HEADER]: TOKEN };
}

/** 이 요청이 같은 프로세스의 내부 호출인가 */
export function isInternalCall(req) {
  const v = req && req.headers ? req.headers[INTERNAL_HEADER] : null;
  if (typeof v !== 'string') return false;
  const b = Buffer.from(v);
  return b.length === TOKEN_BUF.length && timingSafeEqual(b, TOKEN_BUF);
}
