// 고객 선점(claim) 정규화 + 기준품목 단가 → 할인율 산출 (순수 함수 모듈)
//
//   배경: 100% 커미션 영업사원은 서로의 존재를 모르고 회사 소속도 아니다.
//         "먼저 등록한 사람이 그 고객의 커미션을 가져간다"가 유일한 보호 장치이므로,
//         선점 키(0188 이후 RFC · 선택 입력 시 CONSTANCIA 번호)의 표기 흔들림으로 중복 등록이 새면 안 된다.
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
//   ⚠ 0188 이후 **신규 등록**은 아래 validateRfc() 로 엄격하게 본다.
//     looksLikeRfc 는 기존 데이터 조회·회귀용으로만 남긴다.
export function looksLikeRfc(v) {
  const s = normalizeClaimKey(v);
  return !!s && s.length >= 10 && s.length <= 13;
}

// ── 0188 · RFC = 선점 키 ──────────────────────────────────────────────
//
//   선점 조건을 CONSTANCIA(번호+PDF) → **RFC 입력** 으로 바꿨다.
//   영업사원이 현장에서 가장 먼저 확보하는 게 RFC 이고, CONSTANCIA 는 뒤따라 온다.
//   대신 "아무 문자열이나 넣고 선점" 이 되면 선점 장치 자체가 무의미해지므로
//   RFC 형식을 실제로 검사한다.
//
//   표기 정리는 공백·하이픈·점·슬래시만 지운다 — Ñ 와 & 는 RFC 에 실제로 쓰이는 글자다.
//   (선점 키 normalizeClaimKey 는 0185 DB 생성컬럼과 맞추느라 Ñ·& 까지 지운다.
//    'PEÑA800101AB1' 과 'PEA800101AB1' 이 같은 선점 키가 되는데,
//    실무상 충돌 확률이 없고 DB 생성컬럼을 바꾸면 기존 유니크 인덱스를 다시 만들어야 해 그대로 둔다.)
export function cleanRfc(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[\s\-._/]/g, '').trim();
}

// 법인(persona moral)  : 영문 3자 + YYMMDD + 호모클라베 3자 = 12자리
// 개인(persona física) : 영문 4자 + YYMMDD + 호모클라베 3자 = 13자리
const RFC_RE = /^([A-ZÑ&]{3,4})(\d{2})(\d{2})(\d{2})([A-Z\d]{3})$/;

// SAT 범용 RFC — 특정 고객이 아니다. 이걸로 선점되면 그 뒤 모두가 막힌다.
export const GENERIC_RFC = ['XAXX010101000', 'XEXX010101000'];

/**
 * 신규 등록용 RFC 검증.
 * @returns {{ok:true, value:string, kind:'moral'|'fisica'}|{ok:false, error:string}}
 *   error: rfc_required | rfc_invalid | rfc_invalid_date | rfc_generic
 */
export function validateRfc(v) {
  const s = cleanRfc(v);
  if (!s) return { ok: false, error: 'rfc_required' };
  if (GENERIC_RFC.includes(s)) return { ok: false, error: 'rfc_generic' };
  const m = RFC_RE.exec(s);
  if (!m) return { ok: false, error: 'rfc_invalid' };
  const mm = Number(m[3]), dd = Number(m[4]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return { ok: false, error: 'rfc_invalid_date' };
  return { ok: true, value: s, kind: m[1].length === 3 ? 'moral' : 'fisica' };
}

// ── 0193 · RFC 는 선택 입력 ───────────────────────────────────────────
//
//   RFC 를 못 받은 상태에서 상담이 먼저 시작되는 일이 많다. 그때 고객을 ERP 에 못 넣으면
//   상담·방문 이력이 통째로 유실되므로 **등록 자체는 RFC 없이도 되게** 한다.
//   대신 RFC 가 채워지는 순간 선점이 성립하고, 그 시점·그 사람에게 우선권이 간다.
//
//   ⚠ "비었으면 통과" 와 "넣었으면 0188 과 똑같이 엄격" 을 한 함수로 묶는다.
//     넣은 값을 느슨하게 봐 주면 「아무 문자열로 선점」 우회가 그대로 살아난다.
/**
 * @returns {{ok:true, value:string|null, kind:'moral'|'fisica'|null, empty:boolean}
 *          |{ok:false, error:string}}
 */
export function validateRfcOptional(v) {
  const s = cleanRfc(v);
  if (!s) return { ok: true, value: null, kind: null, empty: true };
  const r = validateRfc(s);
  return r.ok ? { ...r, empty: false } : r;
}

// ── 0200 · 「중복(선점) 검사에 쓸 수 있는 RFC 인가」 ────────────────────
//
//   증상: 고객등록에서 RFC 를 비워 두거나 `.` 만 찍으면, RFC 가 없는(또는 `.` 인)
//         다른 고객들이 「중복/선점됨」 으로 잡혔다.
//   원인: 중복 조회 키를 normalizeClaimKey 로만 만들었다. 이건 **영숫자만 남기는** 함수라
//         `.` → NULL 은 걸러 주지만 `1` · `NA` · `내고객` 같은 값은 그대로 조회 키가 된다.
//         게다가 값이 NULL 이어도 화면 쪽에서 「RFC 가 있다」로 분기하면 중복 안내까지 떴다.
//   방침: **정상 형식의 RFC 일 때만** 중복을 조회한다. RFC 가 없거나 형식이 아니면
//         조회 자체를 하지 않는다 — 어차피 그 값으로는 등록도 안 된다(rfc_invalid).
//
/**
 * @returns {string|null} 조회에 쓸 정규화 키. RFC 가 비었거나 형식이 아니면 null.
 */
export function claimKeyIfValidRfc(v) {
  const r = validateRfcOptional(v);
  if (!r.ok || r.empty) return null;
  return normalizeClaimKey(r.value);
}

/** 저장된 값이 「선점 키로 인정되는가」 — 빈값·`.`·`-` 등 영숫자 없는 값은 RFC 가 아니다. */
export function hasClaimKey(v) {
  return !!normalizeClaimKey(v);
}

// 화면·API 에 같은 문구를 쓰기 위한 단일 출처.
export const RFC_ERROR_NOTE = {
  rfc_required: 'RFC(세금번호)를 입력해야 고객을 등록할 수 있습니다 — RFC 가 곧 선점 키입니다.',
  rfc_invalid: 'RFC 형식이 올바르지 않습니다. 법인 12자리(영문 3 + YYMMDD + 3) 또는 개인 13자리(영문 4 + YYMMDD + 3)여야 합니다.',
  rfc_invalid_date: 'RFC 가운데 6자리(YYMMDD)의 월·일이 올바르지 않습니다. 다시 확인하세요.',
  rfc_generic: '범용 RFC(XAXX010101000 · XEXX010101000)로는 고객을 선점할 수 없습니다. 고객 고유의 RFC 를 입력하세요.',
  // 0193 ----------------------------------------------------------------
  rfc_claim_pending: '이 RFC 로는 이미 다른 영업사원의 선점 요청이 디렉터 승인 대기 중입니다 — 먼저 입력한 사람에게 우선권이 있습니다.',
  rfc_already_set: '이 고객에는 이미 RFC 가 등록되어 있습니다(=선점 완료). 값을 바꾸려면 고객 수정에서 하세요.',
  sales_rfc_required: 'RFC 가 없는 고객에게는 매출을 확정할 수 없습니다. 고객 상세에서 RFC 를 먼저 입력하세요 — 입력하는 순간 선점이 확정됩니다.',
};

// ── 0193 · 상호명 유사 판정 (경고 전용) ───────────────────────────────
//
//   RFC 가 없으면 법적 동일성을 판단할 방법이 없다. 그래서 상호명 유사는
//   **등록을 막지 않고 경고만** 한다 — 지점·법인 분리가 흔해서 차단하면 오탐이 더 비싸다.
//   판정은 「법인격 표기(S.A. DE C.V. 등)를 걷어낸 뒤 남은 단어의 겹침」으로 본다.

const CORP_TOKENS = new Set([
  'SA', 'SAPI', 'SAS', 'SC', 'SRL', 'RL', 'SPR', 'AC', 'CV', 'DE', 'DEL', 'LA', 'EL', 'LOS', 'LAS', 'Y',
  'SOCIEDAD', 'ANONIMA', 'CAPITAL', 'VARIABLE', 'RESPONSABILIDAD', 'LIMITADA', 'PROMOTORA', 'INVERSION',
]);

/** 악센트·기호·중복공백 제거 + 대문자. 'Refaccionés  Peña, S.A. de C.V.' → 'REFACCIONES PENA SA DE CV' */
export function normalizeCompanyName(v) {
  return String(v == null ? '' : v)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

/**
 * 법인격 표기·관사를 걷어낸 의미 단어들.
 * 한 글자 토큰도 버린다 — 'S.A. de C.V.' 가 'S','A','C','V' 로 쪼개져 남으면
 * 아무 상관 없는 두 법인이 그 조각들로 겹쳐 유사도가 부풀려진다.
 */
export function companyNameTokens(v) {
  return normalizeCompanyName(v).split(' ').filter((t) => t.length > 1 && !CORP_TOKENS.has(t));
}

/**
 * 0~1. 짧은 쪽 기준 겹침 비율이라 「REFACCIONES PENA」 ⊂ 「REFACCIONES PENA MONTERREY」 가 1.0 이 된다
 * (지점 표기가 붙은 같은 상호를 놓치지 않기 위함 — 어차피 경고일 뿐이라 관대하게 본다).
 */
export function nameSimilarity(a, b) {
  const A = new Set(companyNameTokens(a));
  const B = new Set(companyNameTokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((t) => { if (B.has(t)) inter++; });
  return Math.round((inter / Math.min(A.size, B.size)) * 100) / 100;
}

export const NAME_SIMILAR_THRESHOLD = 0.6;   // 이 이상이면 화면에 「유사 고객」 으로 띄운다

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
