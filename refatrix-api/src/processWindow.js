// =====================================================================
// Refatrix ERP · processWindow.js
//   "오더확정 대기" 집계의 단일 기준 — SLA 카드(wbrRoutes)와
//   업무 프로세스 KPI(processKpiRoutes)가 동일한 정의를 쓰도록 공유한다.
//   · 미확정 = 포장출력 전. 상태는 draft/confirmed/expired 포함(만료=24h 초과 자동무효지만
//     여전히 "확정 안 된 오더"이므로 대기로 집계 — 방치 오더 가시성).
//   · 윈도우 = 견적접수 후 N일 이내만 활성 대기로 집계. 초과분은 "포기(방치)"로 보고
//     활성 대기/그래프에서 제외(영구 누적 방지).
//   값을 바꾸면 두 화면이 함께 바뀐다.
// =====================================================================
export const ORDER_WINDOW_DAYS = 30;
export const ORDER_WAIT_STATUSES = ['draft', 'confirmed', 'expired'];
