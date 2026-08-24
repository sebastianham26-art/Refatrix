import { query } from './db.js';
import { hashDeviceKey } from './auth.js';
import { buildAccountAccess } from './accountScope.js';

// ── 반쪽 배포 안전장치 ────────────────────────────────────────────────
// users.cross_team_request 는 마이그레이션 0181 에서 추가된다.
// 백엔드가 먼저 뜨고 migrate 가 아직 안 돌았다면 이 컬럼이 없는데,
// SELECT 에 그냥 넣어두면 loadPerm 이 42703 으로 터지고 → authGuard 가 500 →
// 로그인 이후 "모든 화면·모든 저장"이 죽는다(고객 수정 포함).
// 그래서 컬럼 존재 여부를 확인해서 없으면 그 항목만 빼고 읽는다(권한은 false 취급).
// 결과는 캐시하되, "없음"일 때는 60초마다 다시 확인해서 migrate 직후 자동 복구되게 한다.
let crossCol = { known: false, exists: false, checkedAt: 0 };
export async function hasCrossTeamRequestColumn() {
  if (crossCol.known && crossCol.exists) return true;                  // 있으면 영구 캐시
  if (crossCol.known && Date.now() - crossCol.checkedAt < 60000) return false; // 없으면 60초 후 재확인
  try {
    // ⚠ information_schema + table_schema='public' 하드코딩은 쓰지 않는다.
    //   스키마가 public 이 아니거나 search_path 가 다르면 컬럼이 실제로 있는데도 "없음"으로 오판한다.
    //   to_regclass('users') 는 이 연결의 search_path 로 해석되므로 앱의 다른 쿼리와 정확히 같은 테이블을 본다.
    const r = await query(
      `SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('users')
          AND attname = 'cross_team_request'
          AND attnum > 0 AND NOT attisdropped
        LIMIT 1`);
    crossCol = { known: true, exists: r.rows.length > 0, checkedAt: Date.now() };
  } catch {
    crossCol = { known: true, exists: false, checkedAt: Date.now() };
  }
  return crossCol.exists;
}

// 이 연결이 실제로 붙어 있는 DB 정보 — "migrate 는 돌았는데 왜 안 되지?" 진단용.
//   migrate 를 다른 DB/다른 컨테이너에서 돌린 경우를 눈으로 확인할 수 있게 한다.
export async function dbIdentity() {
  try {
    const r = await query(
      `SELECT current_database() AS db, current_schema() AS schema, current_user AS usr`);
    return r.rows[0] || {};
  } catch { return {}; }
}
// 테스트/운영 점검용 — 캐시 초기화
export function resetCrossTeamColumnCache() { crossCol = { known: false, exists: false, checkedAt: 0 }; }

// 사용자 권한 묶음을 DB에서 읽어 perm 객체로 구성
export async function loadPerm(userId) {
  const hasCross = await hasCrossTeamRequestColumn();
  const u = (await query(
    `SELECT id, name, dept, role, lang, scope, cur_scope, see_balance, see_process_map, team_id, dash_drilldown, restrict_cash_detail
            ${hasCross ? ', cross_team_request' : ''}
       FROM users WHERE id=$1 AND deleted_at IS NULL`, [userId])).rows[0];
  if (!u) return null;

  const pages = {};
  const pageAccess = {};
  for (const r of (await query(
    `SELECT page_key, device_req, access FROM user_page_access WHERE user_id=$1`, [userId])).rows) {
    pages[r.page_key] = r.device_req;
    pageAccess[r.page_key] = r.access || 'edit';
  }
  const fields = new Set();
  for (const r of (await query(
    `SELECT field_key FROM user_field_access WHERE user_id=$1 AND visible=true`, [userId])).rows) {
    fields.add(r.field_key);
  }
  const items = {};
  for (const r of (await query(
    `SELECT item_key, depth, resolution FROM user_item_depth WHERE user_id=$1`, [userId])).rows) {
    items[r.item_key] = { depth: r.depth, resolution: r.resolution };
  }
  // 상대팀 열람 권한(소속팀 외 추가로 볼 수 있는 팀)
  const teamAccess = [];
  for (const r of (await query(
    `SELECT team_id, can_edit FROM user_team_access WHERE user_id=$1`, [userId])).rows) {
    teamAccess.push({ teamId: Number(r.team_id), canEdit: r.can_edit });
  }
  // 계좌별 열람/운영 권한.
  const accRows = (await query(
    `SELECT account_id, can_operate, can_detail FROM user_account_access WHERE user_id=$1`, [userId])).rows;
  // 소시오: 디렉터가 계좌별로 '잔액만'(can_detail=false)으로 지정한 계좌는 세부내역(드릴다운·거래목록·현금흐름)·운영 차단.
  //   디렉터는 항상 무제한(blockIds 비움). 비디렉터는 buildAccountAccess 가 기존대로 처리.
  let blockIds = [];
  if (u.role === 'socio') {
    blockIds = accRows.filter((r) => r.can_detail === false).map((r) => Number(r.account_id));
  }
  const accountAccess = buildAccountAccess(u.role, accRows, blockIds);
  return {
    userId: u.id, name: u.name, dept: u.dept, role: u.role, lang: u.lang,
    scope: u.scope, curScope: u.cur_scope, seeProcessMap: u.see_process_map,
    teamId: u.team_id != null ? Number(u.team_id) : null, teamAccess,
    dashDrilldown: u.dash_drilldown !== false,
    // 타팀 고객 수정요청 권한(디렉터 승인 전제). 마이그레이션 0181 이전 DB에서는 undefined → false 취급.
    crossTeamRequest: u.cross_team_request === true,
    pages, pageAccess, fields, items, accountAccess,
  };
}

// 이 기기가 이 사용자에게 '승인된 등록 기기'인지
export async function isRegisteredDevice(userId, rawDeviceKey) {
  if (!rawDeviceKey) return { registered: false, deviceId: null };
  const h = hashDeviceKey(rawDeviceKey);
  const row = (await query(
    `SELECT id, status FROM devices WHERE user_id=$1 AND device_key_hash=$2`, [userId, h])).rows[0];
  return { registered: !!row && row.status === 'approved', deviceId: row?.id ?? null, status: row?.status ?? null };
}
