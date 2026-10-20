// =====================================================================
// Refatrix ERP · waCustomerSync.js — 영업 고객 → WhatsApp 마케팅 연락처 (0291 · 2026-10-20 디렉터 지시)
//
//   등록된 영업 고객(customers)을 연락처로 가져와 액티브 / 잠재로 나누고, 영업담당자 이름으로 자동 그룹을 만든다.
//   · 액티브 = 1페소 이상 SAT 인보이스를 한 번이라도 발행(실제 SAT 번호 · TMP 아님 · 삭제/취소 아님) · 아니면 잠재
//   · 구매금액 = 발행 인보이스 합계(IVA 제외 · subtotal_mxn) · 마지막 인보이스 날짜
//   · 주(estado) = CRM 웹 가입 때 고객이 적은 주 → 없으면 배송 주소 글에서 주 이름 · 도시로 알아냄(surveyGeo.stateOf)
//   · 번호 = 고객 전화 → 구매 담당 전화(한 칸에 여러 번호면 처음 맞는 것)
//   · 같은 번호의 연락처가 이미 있으면(Meta · 설문 등) 그 연락처에 고객을 잇기만 한다 — 이름 · 동의 · 메모는 그대로.
//   · 한 번호를 여러 고객이 쓰면 액티브 · 최근 인보이스 · 최근 등록 순으로 하나만.
//   · 영업담당자 그룹(auto_key 'rep:<id>' · 담당 없음 'rep:none')은 가져올 때마다 소속을 다시 맞춘다(담당 바뀌면 옮김).
//   · 고객이 지워졌거나 번호가 바뀌어 더 이상 그 번호가 아니면 연결을 푼다(연락처 자체는 남음).
//   동의 규칙은 그대로 — 영업 고객도 ✅ 동의해야 정기 이미지가 간다(Meta 정책).
// =====================================================================
import { query } from './db.js';
import { normalizeWaNumber } from './waSend.js';
import { stateOf } from './surveyGeo.js';

export const REP_GROUP_PREFIX = '영업 · ';
const SAT_OK = `si.deleted_at IS NULL AND COALESCE(si.status,'') NOT IN ('deleted','cancelled')
                AND si.sat_no IS NOT NULL AND btrim(si.sat_no) <> '' AND si.sat_no NOT LIKE 'TMP-%'`;

export function firstWaNumber(...fields) {
  for (const f of fields) {
    if (!f) continue;
    const s = String(f);
    const whole = normalizeWaNumber(s);
    if (whole) return whole;
    for (const part of s.split(/[,;/|]|\s+(?:y|o|ó)\s+|\s{2,}/i)) {
      const p = normalizeWaNumber(part);
      if (p) return p;
    }
  }
  return null;
}

async function repGroupId(q, key, name, userId) {
  const ex = (await q(`SELECT id, name FROM wa_groups WHERE auto_key=$1 AND deleted_at IS NULL`, [key])).rows[0];
  let want = REP_GROUP_PREFIX + name;
  const clash = async (n, selfId) => (await q(`SELECT 1 FROM wa_groups WHERE lower(name)=lower($1) AND deleted_at IS NULL AND ($2::bigint IS NULL OR id<>$2)`, [n, selfId])).rows.length > 0;
  if (await clash(want, ex ? ex.id : null)) want = want + ' (영업)';
  if (ex) {
    if (ex.name !== want) await q(`UPDATE wa_groups SET name=$2, updated_at=now() WHERE id=$1`, [ex.id, want]);
    return Number(ex.id);
  }
  const r = (await q(`INSERT INTO wa_groups (name, color, memo, created_by, auto_key) VALUES ($1,'#5b6470',$2,$3,$4) RETURNING id`,
    [want, '영업 고객 가져오기가 자동으로 만든 그룹 — 담당자가 바뀌면 자동으로 옮겨짐', userId, key])).rows[0];
  return Number(r.id);
}

export async function syncCustomerContacts({ userId = null, q = query } = {}) {
  const custs = (await q(
    `SELECT c.id, c.code, c.name, c.rfc, c.phone, c.buyer_phone, c.contact, c.ship_address, c.owner_id, c.created_at,
            u.name AS rep_name, t.name AS team_name,
            inv.sub AS purchase, inv.last_date, COALESCE(inv.active, false) AS active,
            (SELECT l.estado FROM crm_web_leads l WHERE l.customer_id = c.id AND l.estado IS NOT NULL AND btrim(l.estado) <> ''
              ORDER BY l.received_at DESC LIMIT 1) AS crm_estado
       FROM customers c
       LEFT JOIN users u ON u.id = c.owner_id
       LEFT JOIN sales_teams t ON t.id = c.team_id
       LEFT JOIN LATERAL (SELECT sum(si.subtotal_mxn) AS sub, max(si.inv_date) AS last_date, bool_or(si.total_mxn >= 1) AS active
                            FROM sales_invoices si WHERE si.customer_id = c.id AND ${SAT_OK}) inv ON true
      WHERE c.deleted_at IS NULL`)).rows;
  const st = { customers: custs.length, with_phone: 0, no_phone: 0, dup_phone: 0, inserted: 0, linked: 0, unlinked: 0,
    active: 0, potential: 0, groups: 0, no_phone_list: [] };
  // 번호별 대표 고객
  const byPhone = new Map();
  const rank = (c) => [c.active ? 1 : 0, c.last_date ? new Date(c.last_date).getTime() : 0, new Date(c.created_at).getTime(), Number(c.id)];
  const better = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; };
  for (const c of custs) {
    const phone = firstWaNumber(c.phone, c.buyer_phone);
    if (!phone) { st.no_phone++; if (st.no_phone_list.length < 300) st.no_phone_list.push({ id: Number(c.id), code: c.code, name: c.name, rep_name: c.rep_name || null }); continue; }
    st.with_phone++;
    c.wa = phone;
    const cur = byPhone.get(phone);
    if (cur) { st.dup_phone++; if (better(c, cur)) byPhone.set(phone, c); } else byPhone.set(phone, c);
  }
  const keep = new Set();
  const repMembers = new Map();    // auto_key → contact ids
  const reps = new Map();          // auto_key → name
  for (const [phone, c] of byPhone) {
    const estado = stateOf(c.crm_estado) || stateOf(c.ship_address) || null;
    const status = c.active ? 'active' : 'potential';
    st[status]++;
    const vals = [Number(c.id), status, c.code || null, c.name || null, c.rfc ? String(c.rfc).toUpperCase().replace(/[^A-Z0-9&Ñ]/g, '') || null : null,
      c.purchase != null ? Number(c.purchase) : 0, c.last_date || null, c.owner_id != null ? Number(c.owner_id) : null, c.rep_name || null, c.team_name || null];
    const ex = (await q(`SELECT id FROM wa_contacts WHERE phone=$1 AND deleted_at IS NULL`, [phone])).rows[0];
    let cid;
    if (ex) {
      cid = Number(ex.id);
      await q(`UPDATE wa_contacts SET customer_id=$2, cust_status=$3, cust_code=$4, cust_name=$5, rfc=$6, purchase_mxn=$7, last_inv_date=$8,
                      rep_id=$9, rep_name=$10, team_name=$11, cust_synced_at=now(), estado=COALESCE(estado, $12), updated_at=now()
                WHERE id=$1`, [cid, ...vals, estado]);
      st.linked++;
    } else {
      cid = Number((await q(
        `INSERT INTO wa_contacts (name, phone, memo, source, source_ref, created_by, customer_id, cust_status, cust_code, cust_name, rfc, purchase_mxn,
                                  last_inv_date, rep_id, rep_name, team_name, cust_synced_at, estado)
         VALUES ($1,$2,$3,'customer',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),$16)
         ON CONFLICT (phone) WHERE deleted_at IS NULL DO UPDATE SET customer_id=EXCLUDED.customer_id RETURNING id`,
        [String(c.name || c.code || 'Cliente').slice(0, 120), phone, c.contact ? String(c.contact).slice(0, 300) : null, `customer:${c.id}`, userId, ...vals, estado])).rows[0].id);
      st.inserted++;
    }
    keep.add(cid);
    const key = c.owner_id != null ? `rep:${c.owner_id}` : 'rep:none';
    reps.set(key, c.owner_id != null ? (c.rep_name || `#${c.owner_id}`) : '담당 없음');
    if (!repMembers.has(key)) repMembers.set(key, []);
    repMembers.get(key).push(cid);
  }
  // 더 이상 고객 번호가 아닌 연락처 — 연결 풀기
  const un = await q(`UPDATE wa_contacts SET customer_id=NULL, cust_status=NULL, cust_code=NULL, cust_name=NULL, rfc=NULL, purchase_mxn=NULL, last_inv_date=NULL,
                             rep_id=NULL, rep_name=NULL, team_name=NULL, cust_synced_at=now(), updated_at=now()
                       WHERE customer_id IS NOT NULL AND deleted_at IS NULL AND NOT (id = ANY($1::bigint[]))`, [[...keep]]);
  st.unlinked = un.rowCount || 0;
  // 담당자 그룹 — 소속을 정확히 맞춤
  const autoIds = [];
  for (const [key, name] of reps) {
    const gid = await repGroupId(q, key, name, userId);
    autoIds.push(gid);
    const ids = repMembers.get(key) || [];
    await q(`DELETE FROM wa_contact_groups WHERE group_id=$1 AND NOT (contact_id = ANY($2::bigint[]))`, [gid, ids]);
    await q(`INSERT INTO wa_contact_groups (contact_id, group_id, added_by) SELECT unnest($1::bigint[]), $2, $3 ON CONFLICT DO NOTHING`, [ids, gid, userId]);
  }
  // 고객이 없어진 담당자 그룹 — 비움(그룹은 남겨 둔다: 예약 발송이 쓰고 있을 수 있음)
  await q(`DELETE FROM wa_contact_groups cg USING wa_groups g WHERE g.id = cg.group_id AND g.auto_key LIKE 'rep:%' AND g.deleted_at IS NULL
             AND NOT (g.id = ANY($1::bigint[]))`, [autoIds]);
  st.groups = autoIds.length;
  return st;
}

// 하루 한 번 자동(워커) — 마지막으로 가져온 지 20시간이 지났으면
let lastAuto = 0;   // 이 프로세스에서 마지막으로 돈 시각(번호 있는 고객이 하나도 없어도 1분마다 돌지 않게)
const AUTO_MS = 20 * 3600 * 1000;
export async function maybeAutoSync(q = query) {
  if (Date.now() - lastAuto < AUTO_MS) return { skipped: 'recent' };
  const r = (await q(`SELECT max(cust_synced_at) AS at FROM wa_contacts`)).rows[0];
  lastAuto = Date.now();
  if (r && r.at && Date.now() - new Date(r.at).getTime() < AUTO_MS) return { skipped: 'recent' };
  return syncCustomerContacts({ q });
}
