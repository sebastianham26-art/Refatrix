import { query } from './db.js';
import { hashDeviceKey } from './auth.js';
import { buildAccountAccess } from './accountScope.js';

// ── 타팀 고객 수정요청 권한 ──────────────────────────────────────────
// 이 권한은 **새 컬럼을 만들지 않고** 기존 user_page_access 테이블에 한 줄로 저장한다.
//   이유: 스키마 변경이 없어야 "코드는 배포됐는데 migrate 는 다른 DB에 돌아갔다" 류의
//   반쪽 배포 사고에서 자유롭다. 파일만 배포하면 어느 DB에서든 바로 동작한다.
//   user_page_access 는 0002 부터 있던 테이블이고, 쓰기가 전부 키 단위(upsert/delete by key)라
//   다른 권한을 건드리지 않는다. loadPerm 이 이미 이 테이블을 읽으므로 쿼리도 늘지 않는다.
// 행이 있으면 허용, 없으면 차단. 값(access/device_req)은 쓰지 않는다.
export const CROSS_TEAM_PAGE_KEY = 'cust_cross_req';

// 사용자 권한 묶음을 DB에서 읽어 perm 객체로 구성
export async function loadPerm(userId) {
  const u = (await query(
    `SELECT id, name, dept, role, lang, scope, cur_scope, see_balance, see_process_map, team_id, dash_drilldown, restrict_cash_detail
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
    // 타팀 고객 수정요청 권한(디렉터 승인 전제) — user_page_access 에 행이 있으면 허용.
    crossTeamRequest: Object.prototype.hasOwnProperty.call(pages, CROSS_TEAM_PAGE_KEY),
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
