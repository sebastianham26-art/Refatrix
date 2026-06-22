// 계좌별 접근 권한 헬퍼 (순수 함수 — DB 의존 없음, 단위 테스트 가능)
//
// perm.accountAccess 형태:
//   디렉터:        { all: true,  viewIds: null, detailIds: null, operateIds: null }
//   그 외 사용자:  { all: false, viewIds: Set, detailIds: Set, operateIds: Set }
//
//   - viewIds    : 계좌 존재·잔액을 볼 수 있는 계좌(재무/계좌). 행이 있으면 모두 포함.
//   - detailIds  : 거래내역(거래목록·현금흐름)까지 볼 수 있는 계좌(can_detail=true).
//   - operateIds : 거래를 등록/확정할 수 있는 계좌(can_operate=true).
//   관계: operateIds ⊆ detailIds ⊆ viewIds.

function truthy(v) { return v === true || v === 't' || v === 'true'; }

// DB 행으로 accountAccess 구성. role==='director' 이면 전체 허용(all:true).
// rows: [{ account_id, can_operate, can_detail }]
export function buildAccountAccess(role, rows) {
  if (role === 'director') return { all: true, viewIds: null, detailIds: null, operateIds: null };
  const viewIds = new Set();
  const detailIds = new Set();
  const operateIds = new Set();
  for (const r of rows || []) {
    const id = Number(r.account_id);
    if (!Number.isFinite(id)) continue;
    viewIds.add(id);
    // can_detail 컬럼이 없던 과거 데이터(undefined)는 true 로 간주(기존 동작 보존).
    const detail = (r.can_detail === undefined || r.can_detail === null) ? true : truthy(r.can_detail);
    if (detail) detailIds.add(id);
    if (truthy(r.can_operate)) { operateIds.add(id); detailIds.add(id); } // 운영이면 detail 포함
  }
  return { all: false, viewIds, detailIds, operateIds };
}

// 계좌 존재·잔액 열람 가능 계좌 ID 배열. 디렉터는 null(=전체).
export function allowedAccountIds(perm) {
  const a = perm && perm.accountAccess;
  if (!a || a.all) return null;
  return [...a.viewIds];
}

// 거래내역(세부) 열람 가능 계좌 ID 배열. 디렉터는 null(=전체).
export function allowedDetailAccountIds(perm) {
  const a = perm && perm.accountAccess;
  if (!a || a.all) return null;
  return [...a.detailIds];
}

// 특정 계좌 "존재·잔액" 열람 가능 여부.
export function canViewAccount(perm, accountId) {
  const a = perm && perm.accountAccess;
  if (!a || a.all) return true;
  if (accountId == null) return false;
  return a.viewIds.has(Number(accountId));
}

// 특정 계좌 "거래내역(세부)" 열람 가능 여부.
export function canViewDetail(perm, accountId) {
  const a = perm && perm.accountAccess;
  if (!a || a.all) return true;
  if (accountId == null) return false;
  return a.detailIds.has(Number(accountId));
}

// 특정 계좌 "운영(거래등록/확정)" 가능 여부.
export function canOperateAccount(perm, accountId) {
  const a = perm && perm.accountAccess;
  if (!a || a.all) return true;
  if (accountId == null) return false;
  return a.operateIds.has(Number(accountId));
}

// 운영 가능한 계좌가 하나라도 있는지(거래등록 메뉴 노출 판단용).
export function hasAnyOperate(perm) {
  const a = perm && perm.accountAccess;
  if (!a || a.all) return true;
  return a.operateIds.size > 0;
}
