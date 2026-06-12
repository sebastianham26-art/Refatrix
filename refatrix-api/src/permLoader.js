import { query } from './db.js';
import { hashDeviceKey } from './auth.js';

// 사용자 권한 묶음을 DB에서 읽어 perm 객체로 구성
export async function loadPerm(userId) {
  const u = (await query(
    `SELECT id, name, dept, role, lang, scope, cur_scope, see_balance, see_process_map, team_id
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
  return {
    userId: u.id, name: u.name, dept: u.dept, role: u.role, lang: u.lang,
    scope: u.scope, curScope: u.cur_scope, seeProcessMap: u.see_process_map,
    teamId: u.team_id != null ? Number(u.team_id) : null, teamAccess,
    pages, pageAccess, fields, items,
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
