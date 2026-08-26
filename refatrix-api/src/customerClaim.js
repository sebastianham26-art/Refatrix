// 고객 선점(claim) 정규화 + 기준품목 단가 → 할인율 산출 (순수 함수 모듈)
//
//   배경: 100% 커미션 영업사원은 서로의 존재를 모르고 회사 소속도 아니다.
//         "먼저 등록한 사람이 그 고객의 커미션을 가져간다"가 유일한 보호 장치이므로,
//         선점 키(CONSTANCIA 번호·RFC)의 표기 흔들림으로 중복 등록이 새면 안 된다.
//
//   여기 있는 함수는 DB·HTTP 를 모르는 순수 함수다(단위 테스트 대상).

// ── 선점 키 정규화 ────────────────────────────────────────────────────
//   'ABC-123 456' · 'abc123456' · 'ABC.123.456' → 'ABC123456'
//   DB 의 생성 컬럼(constancia_no_norm / rfc_norm)과 반드시 같은 규칙이어야 한다.
export function normalizeClaimKey(v) {
  const s = String(v == null ? '' : v).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return s || null;
}

// RFC 는 멕시코 세금번호 — 법인 12자리 / 개인 13자리. 형식만 느슨하게 본다
// (동음이의 지점 표기 등 현장 데이터가 지저분해서 강한 검증은 등록을 막는다).
export function looksLikeRfc(v) {
  const s = normalizeClaimKey(v);
  return !!s && s.length >= 10 && s.length <= 13;
}

// ── 기준품목(SYD) 단가 → 할인율 산출 ──────────────────────────────────
//
//   고객이 경쟁사(SYD) 제품 1516049 를 얼마에 사는지 입력받아
//     ① 고객이 SYD 에서 받는 할인율        = 1 − 구매단가 ÷ SYD List Price
//     ② 우리가 그 가격보다 5% 싸게 주려면  = 목표가 = 구매단가 × 0.95
//     ③ 그 목표가를 만들려면 CTR 정가 대비 = 1 − 목표가 ÷ CTR List Price
//   ③ 이 등록 화면에 뜨는 「제안 할인율」이고, 실제 적용값은 등록자가 정한다.
//
//   ⚠ CTR List Price 는 1516049 에 매칭된 **실제 CTR 제품의 정가**를 쓴다
//     (viofinder 화면의 SYD정가×1.40 상수 방식이 아니라 제품 마스터 실측값).

export const UNDERCUT_RATE = 0.05;   // 고객 구매가 대비 우리 제품이 싼 비율(5%)
export const MAX_DISCOUNT_PCT = 95;  // 할인율 상한(입력 실수로 원가 이하 판매 방지)

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// 할인율은 소수 2자리 — customers.discount 가 NUMERIC(5,2) 라 그 이상은 저장되지 않는다.
//   화면에 3자리를 보여 주고 DB 에는 2자리가 들어가면 "제안대로 승인했는데 값이 다르다"가 된다.
function pct2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function money2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

/**
 * @param {object} a
 * @param {number|string} a.buy_price      고객이 SYD 에서 사는 구매단가(MXN)
 * @param {number|string} a.syd_list_price SYD List Price
 * @param {number|string} a.ctr_list_price 매칭된 CTR 제품 List Price
 * @param {number} [a.undercut]            기본 0.05
 * @returns {{ok:boolean, error:string|null, note:string|null,
 *            syd_discount:number|null, target_price:number|null,
 *            suggested_discount:number|null, suggested_price:number|null}}
 *          할인율은 % 단위(35.5 = 35.5%).
 */
export function computeBaselineDiscount(a = {}) {
  const buy = num(a.buy_price);
  const sydLP = num(a.syd_list_price);
  const ctrLP = num(a.ctr_list_price);
  const under = num(a.undercut) == null ? UNDERCUT_RATE : num(a.undercut);
  const out = {
    ok: false, error: null, note: null,
    syd_discount: null, target_price: null,
    suggested_discount: null, suggested_price: null,
  };

  if (buy == null || buy <= 0) { out.error = 'buy_price_required'; return out; }

  // ① 고객이 SYD 에서 받는 할인율
  if (sydLP != null && sydLP > 0) {
    const d = (1 - buy / sydLP) * 100;
    out.syd_discount = pct2(Math.max(0, Math.min(MAX_DISCOUNT_PCT, d)));
    if (d < 0) out.note = 'buy_above_list';          // 정가보다 비싸게 산다 = 입력 의심
    else if (d > MAX_DISCOUNT_PCT) out.note = 'discount_capped';
  } else {
    out.error = 'syd_list_price_missing';
  }

  // ② 우리가 제시할 목표 판매단가 (고객 구매가보다 5% 싸게)
  out.target_price = money2(buy * (1 - under));

  // ③ 그 목표가를 만드는 CTR 정가 대비 할인율
  if (ctrLP != null && ctrLP > 0) {
    const raw = (1 - out.target_price / ctrLP) * 100;
    if (raw < 0) {
      // CTR 정가가 이미 목표가보다 싸다 → 할인 없이도 이긴다.
      out.suggested_discount = 0;
      out.note = out.note || 'ctr_already_cheaper';
    } else {
      out.suggested_discount = pct2(Math.min(MAX_DISCOUNT_PCT, raw));
      if (raw > MAX_DISCOUNT_PCT) out.note = out.note || 'suggested_capped';
    }
    out.suggested_price = money2(ctrLP * (1 - out.suggested_discount / 100));
    out.ok = out.error == null;
  } else if (out.error == null) {
    out.error = 'ctr_list_price_missing';
  }
  return out;
}

// 등록 화면에서 사람이 정한 할인율이 쓸 만한 값인지 (저장 전 서버 검증)
export function validateChosenDiscount(v) {
  const n = num(v);
  if (n == null) return { ok: false, error: 'discount_required' };
  if (n < 0) return { ok: false, error: 'discount_negative' };
  if (n > MAX_DISCOUNT_PCT) return { ok: false, error: 'discount_too_high' };
  return { ok: true, value: pct2(n) };
}

// 제안값 대비 실제 선택값이 얼마나 벌어졌는지 — 디렉터 승인 화면에서 강조용.
export function discountGap(chosen, suggested) {
  const c = num(chosen), s = num(suggested);
  if (c == null || s == null) return null;
  return pct2(c - s);
}
