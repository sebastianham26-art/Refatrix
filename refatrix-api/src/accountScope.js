// 계좌별 접근 권한 헬퍼 (순수 함수 — DB 의존 없음, 단위 테스트 가능)
//
// perm.accountAccess 형태:
//   디렉터:        { all: true,  viewIds: null, operateIds: null }
//   그 외 사용자:  { all: false, viewIds: Set<number>, operateIds: Set<number> }
//
//   - viewIds    : 잔고·무브먼트·현금흐름을 "열람"할 수 있는 계좌
//   - operateIds : 거래를 "등록/확정"할 수 있는 계좌 (operate는 view의 부분집합)

// DB 행으로 accountAccess 구성. role==='director' 이면 전체 허용(all:true).
export function buildAccountAccess(role, rows) {
  if (role === 'director') return { all: true, viewIds: null, operateIds: null };
  const viewIds = new Set();
  const operateIds = new Set();
  for (const r of rows || []) {
    const id = Number(r.account_id);
    if (!Number.isFinite(id)) continue;
    viewIds.add(id);
    if (r.can_operate === true || r.can_operate === 't' || r.can_operate === 'true') operateIds.add(id);
  }
  return { all: false, viewIds, operateIds };
}

// 열람 가능 계좌 ID 배열. 디렉터는 null(=전체, 필터 미적용 신호).
export function allowedAccountIds(perm) {
  const a = perm && perm.accountAccess;
  if (!a || a.all) return null;
  return [...a.viewIds];
}

// 특정 계좌 "열람" 가능 여부. account_id 가 null 이면 비디렉터는 불가.
export function canViewAccount(perm, accountId) {
  const a = perm && perm.accountAccess;
  if (!a || a.all) return true;
  if (accountId == null) return false;
  return a.viewIds.has(Number(accountId));
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
