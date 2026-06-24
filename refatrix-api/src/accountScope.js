// 계좌별 접근 권한 헬퍼 (순수 함수 — DB 의존 없음, 단위 테스트 가능)
//
// perm.accountAccess 형태:
//   디렉터:        { all: true,  viewIds: null, detailIds: null, operateIds: null }
//   그 외 사용자:  { all: false, viewIds: Set, detailIds: Set, operateIds: Set }
//
//   - viewIds    : 계좌 존재·잔액을 볼 수 있는 계좌(재무/계좌). 행이 있으면 모두 포함.
//   - detailIds  : 거래내역(거래목록·현금흐름)까지 볼 수 있는 계좌(can_detail=true).
//   - operateIds : 거래를 등록/확정할 수 있는 계좌(can_operate=true).
//   - detailBlock: '세부 차단' 계좌(현금·불공제 등). 잔액은 보이되 거래내역/현금흐름/운영은 막힘.
//                  ★ 디렉터(all:true)에게도 적용되는 유일한 예외 — restrict_cash_detail 사용자용.
//   관계: operateIds ⊆ detailIds ⊆ viewIds. detailBlock 은 detail/operate 에서 제외된다.

function truthy(v) { return v === true || v === 't' || v === 'true'; }

// 세부 차단(현금·불공제) 계좌 집합으로 변환. 빈 값이면 빈 Set.
function toBlockSet(blockIds) {
  const s = new Set();
  for (const v of blockIds || []) {
    const id = Number(v);
    if (Number.isFinite(id)) s.add(id);
  }
  return s;
}

// DB 행으로 accountAccess 구성. role==='director' 이면 전체 허용(all:true).
// rows: [{ account_id, can_operate, can_detail }]
// blockIds: '세부 차단' 계좌 id 배열(현금·불공제). 디렉터에게도 적용된다(잔액만 노출).
export function buildAccountAccess(role, rows, blockIds) {
  const detailBlock = toBlockSet(blockIds);
  if (role === 'director') {
    // 디렉터는 전체. 단, detailBlock 계좌는 잔액만(세부·운영 차단).
    return { all: true, viewIds: null, detailIds: null, operateIds: null, detailBlock };
  }
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
  // 세부 차단 계좌는 비디렉터의 detail/operate 에서도 제외(잔액은 viewIds 에 남아 노출).
  for (const id of detailBlock) { detailIds.delete(id); operateIds.delete(id); }
  return { all: false, viewIds, detailIds, operateIds, detailBlock };
}

// 계좌 존재·잔액 열람 가능 계좌 ID 배열. 디렉터는 null(=전체).
export function allowedAccountIds(perm) {
  const a = perm && perm.accountAccess;
  if (!a || a.all) return null;
  return [...a.viewIds];
}

// 거래내역(세부) 열람 가능 계좌 ID 배열(화이트리스트). 디렉터는 null(=전체).
export function allowedDetailAccountIds(perm) {
  const a = perm && perm.accountAccess;
  if (!a || a.all) return null;
  return [...a.detailIds];
}

// '세부 차단' 계좌 ID 배열(블랙리스트). 디렉터(all)에서 detailBlock 으로만 차단할 때 사용.
// 비디렉터는 detailIds 화이트리스트에서 이미 빠져 있으므로 빈 배열 반환(중복 차단 불필요).
export function blockedDetailAccountIds(perm) {
  const a = perm && perm.accountAccess;
  if (!a) return [];
  const blk = a.detailBlock;
  if (!blk || blk.size === 0) return [];
  return a.all ? [...blk] : [];
}

// 특정 계좌 "존재·잔액" 열람 가능 여부.
export function canViewAccount(perm, accountId) {
  const a = perm && perm.accountAccess;
  if (!a || a.all) return true;    // 잔액은 detailBlock 과 무관하게 노출
  if (accountId == null) return false;
  return a.viewIds.has(Number(accountId));
}

// 특정 계좌 "거래내역(세부)" 열람 가능 여부.
export function canViewDetail(perm, accountId) {
  const a = perm && perm.accountAccess;
  if (!a) return true;
  if (accountId != null && a.detailBlock && a.detailBlock.has(Number(accountId))) return false; // 현금·불공제 차단
  if (a.all) return true;
  if (accountId == null) return false;
  return a.detailIds.has(Number(accountId));
}

// 특정 계좌 "운영(거래등록/확정)" 가능 여부.
export function canOperateAccount(perm, accountId) {
  const a = perm && perm.accountAccess;
  if (!a) return true;
  if (accountId != null && a.detailBlock && a.detailBlock.has(Number(accountId))) return false; // 세부 차단이면 운영도 불가
  if (a.all) return true;
  if (accountId == null) return false;
  return a.operateIds.has(Number(accountId));
}

// 운영 가능한 계좌가 하나라도 있는지(거래등록 메뉴 노출 판단용).
export function hasAnyOperate(perm) {
  const a = perm && perm.accountAccess;
  if (!a || a.all) return true;
  return a.operateIds.size > 0;
}
