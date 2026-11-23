// ===== 계좌 통화 기준 거래금액 — 2026-11-23 =====
// 배경(디렉터 보고): 금고(MXN) 계좌에서 USD 200 을 지출했는데, 계좌 잔액·계좌 원장 엑셀·거래 후 잔고·
// 일일 자금 요약이 t.amount(원통화 금액)를 그대로 더해 **MXN 200** 으로 빠져 있었다.
// 거래목록 화면은 amount_mxn(거래 당시 환율 환산)으로 보여주고 있어 두 화면의 합계가 서로 달랐다.
//
// 규칙: 잔액은 **계좌 통화**로 쌓는다(09-30 결정 유지). 거래 통화가 계좌 통화와 다르면 계좌 통화로 환산한다.
//   · 같은 통화(또는 계좌 미지정)          → t.amount
//   · MXN 계좌 + USD 거래                   → t.amount_mxn (거래 당시 환율로 확정 저장된 값 — 현금흐름과 동일)
//   · USD 계좌 + MXN 거래                   → amount_mxn ÷ 거래일(없으면 그 이전 최근) USD→MXN 환율
//                                             (환율 기록이 하나도 없으면 원금액 그대로 — 기존 동작)
//
// t = transactions 별칭, a = accounts 별칭. LEFT JOIN 으로 a 가 NULL 이면 원금액.
export function accAmtSql(t = 't', a = 'a') {
  return `(CASE
    WHEN ${a}.currency IS NULL OR ${t}.currency IS NOT DISTINCT FROM ${a}.currency THEN ${t}.amount
    WHEN ${a}.currency = 'MXN' THEN COALESCE(${t}.amount_mxn, ROUND(${t}.amount * COALESCE(NULLIF(${t}.fx_rate, 0), 1), 2))
    ELSE COALESCE(ROUND(COALESCE(${t}.amount_mxn, ${t}.amount) / NULLIF((
           SELECT fxr.rate FROM fx_rates fxr
            WHERE fxr.base='USD' AND fxr.quote='MXN' AND fxr.rate_date <= ${t}.txn_date
            ORDER BY fxr.rate_date DESC LIMIT 1), 0), 2), ${t}.amount)
  END)`;
}

// 부호 포함(수입 +, 지출 −)
export function signedAccAmtSql(t = 't', a = 'a') {
  return `(CASE WHEN ${t}.direction='in' THEN ${accAmtSql(t, a)} ELSE -${accAmtSql(t, a)} END)`;
}
