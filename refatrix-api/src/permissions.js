// 권한 판단 + 데이터 최소 전송(민감 필드/항목 제거)
// 순수 함수로 구현해 단위 테스트 가능. DB 조회 결과(perm)를 받아 판단한다.
//
// perm 형태:
//   { role, scope, curScope,
//     pages: { [pageKey]: 'registered_only'|'anywhere'|'blocked' },
//     fields: Set<field_key>,                 // 보임으로 설정된 필드
//     items: { [item_key]: {depth, resolution} } }

export const ALWAYS_PAGES = new Set(['home']);

// 메뉴 접근 가능 여부 (+ 기기 요구 반영)
export function pageAllowed(perm, pageKey, isRegisteredDevice) {
  if (perm.role === 'director') return true;          // 디렉터 전체 허용
  if (pageKey === 'settings') return false;           // 기준정의는 디렉터 전용
  if (ALWAYS_PAGES.has(pageKey)) return true;         // 요약은 항상
  const req = perm.pages?.[pageKey];
  if (!req || req === 'blocked') return false;
  if (req === 'registered_only' && !isRegisteredDevice) return false;
  return true; // 'anywhere' 또는 (registered_only && 등록기기)
}

// 민감 필드 노출 여부
export function fieldVisible(perm, fieldKey) {
  if (perm.role === 'director') return true;
  // 영업 대시보드 핵심 지표는 전 직원 공개(디렉터 외 모두):
  //   매출 금액(매출목표 대비 실적·주차별 워터폴·주간 캘린더), 수금/외상 금액(수금계획 대비 실적)
  if (fieldKey === 'sales_amount' || fieldKey === 'ar_amount') return true;
  // 소시오(파트너)는 원가(평균원가·재고평가·원가분석·매출총이익)도 열람 — 디렉터 결정. 직원 역할은 계속 숨김.
  if (perm.role === 'socio' && fieldKey === 'unit_cost') return true;
  return perm.fields?.has(fieldKey) ?? false;
}

// 민감 항목 열람 깊이
export function itemDepth(perm, itemKey) {
  if (perm.role === 'director') return { depth: 'full', resolution: 'day' };
  return perm.items?.[itemKey] || { depth: 'hidden', resolution: 'month' };
}

// 제품 응답 최소화: 권한 없는 필드는 객체에서 아예 제거(전송 안 함)
const PRODUCT_FIELD_GATE = {
  avg_cost: 'unit_cost',     // 단위원가
  list_price: 'sale_price',  // 판매 정가
  discount: 'sale_price',
};
export function minimizeProduct(perm, product) {
  const out = {};
  for (const [k, v] of Object.entries(product)) {
    const gate = PRODUCT_FIELD_GATE[k];
    if (gate && !fieldVisible(perm, gate)) continue; // 권한 없으면 생략
    out[k] = v;
  }
  // 마진은 별도 권한일 때만 계산해 부여
  if (fieldVisible(perm, 'unit_margin') &&
      product.list_price != null && product.avg_cost != null) {
    out.unit_margin = round2(Number(product.list_price) - Number(product.avg_cost));
    if (fieldVisible(perm, 'margin_rate') && Number(product.list_price) > 0) {
      out.margin_rate = round2(out.unit_margin / Number(product.list_price) * 100);
    }
  }
  return out;
}

export function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

// ── 마이그레이션 기간 한정 토글 ─────────────────────────────────────────────
// 디렉터가 "지난 달(과거)" 매출의 총액·IVA도 수정할 수 있게 허용하는 스위치.
//
// ⚠️ 현재 기본값 = ON (마이그레이션 기간). 별도 설정 없이 과거 달 수정이 켜져 있음.
// 시스템 안정 후 "당월만 수정"으로 되돌리는 방법 (둘 중 하나):
//   (A) Railway 환경변수 ALLOW_PAST_MONTH_SALES_EDIT = 0  → 재배포 없이 즉시 OFF.
//   (B) 아래 MIGRATION_DEFAULT_ON 을 false 로 바꿔 재배포.
// 환경변수를 1/true/yes/on 으로 두면 강제 ON, 0/false/no/off 로 두면 강제 OFF.
const MIGRATION_DEFAULT_ON = true;
export function allowPastMonthSalesEdit() {
  const env = String(process.env.ALLOW_PAST_MONTH_SALES_EDIT || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(env)) return true;    // 명시적 ON
  if (['0', 'false', 'no', 'off'].includes(env)) return false;  // 명시적 OFF
  return MIGRATION_DEFAULT_ON;                                    // 변수 없을 때의 기본값
}

// 평균원가 산정 방식.
//   기본(ON) = 단순가중평균: 입고 승인 시 제품 평균원가를 "현재 살아있는(삭제·원가제외 아님) 배치들의
//              Σ(수입수량×입고단가) ÷ Σ수입수량" 으로 다시 설정. 중간에 삭제된 배치는 자동으로 무시되고,
//              판매 타이밍에 영향받지 않음(이동평균 아님).
//   끄기  = 기존 이동평균 방식 유지. 환경변수 MOVING_AVG_COST 를 1/true/yes/on 으로 두면 강제 OFF(이동평균).
const FLAT_AVG_COST_DEFAULT_ON = true;
export function flatAvgCostEnabled() {
  const env = String(process.env.MOVING_AVG_COST || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(env)) return false;   // 이동평균 강제(평준화 끔)
  if (['0', 'false', 'no', 'off'].includes(env)) return true;   // 단순평균 강제
  return FLAT_AVG_COST_DEFAULT_ON;
}
