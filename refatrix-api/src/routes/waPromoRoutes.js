// =====================================================================
// Refatrix ERP · waPromoRoutes.js — 제품·마케팅 › WhatsApp 마케팅 (0260)
//   2026-10-13 디렉터 지시: 디렉터 · 소시오 전용. 로직은 src/waPromo.js.
//   2026-10-16 디렉터 지시: 관리자 화면에서 **사용자별로** 열 수 있게 — 화면 권한 키 `wapromo`(없음 · 열람 · 수정).
//     디렉터 · 소시오는 지금처럼 항상 연다. 그 밖의 역할은 wapromo 권한이 있어야 하고, 쓰기(POST · PATCH · DELETE)는 「수정」만.
//   (이전: 열람 requirePage('marketing') · 쓰기 requirePageEdit('marketing'))
//
//   연락처
//   GET    /api/wa-promo/contacts?q&consent&limit        목록 + 상태별 건수
//   POST   /api/wa-promo/contacts {name, phone, memo}    1건 추가
//   POST   /api/wa-promo/contacts/bulk {rows, dry_run}   엑셀 대량(미리보기 → 저장)
//   PATCH  /api/wa-promo/contacts/:id                    이름·메모·동의(영업 확인)·담당·메모·처리 상태
//   DELETE /api/wa-promo/contacts/:id                    삭제(소프트)
//   POST   /api/wa-promo/consent/ask {ids?}              동의 요청 대기열(미확인만 · 1회)
//   ── 0283 연락처 그룹 ──
//   GET    /api/wa-promo/groups                          그룹 목록 + 인원(전체 · ✅ 동의) · 그룹 없는 사람 수
//   POST   /api/wa-promo/groups {name, color?, memo?} · PATCH /api/wa-promo/groups/:id · DELETE (소프트)
//   POST   /api/wa-promo/groups/assign {group_id | group_name, action: add|remove, ids? | filter?{q,consent,group} | phones?}
//          고른 사람 · 지금 조건에 맞는 전체 · 번호 붙여넣기 — 한 번에 수천 명
//   GET    /api/wa-promo/audience?groups=1,2&memo=        예약 전 대상(✅ 동의) 수
//   (contacts/bulk · survey-import 저장 때 group_id 를 주면 새로 · 이미 등록된 번호 모두 그 그룹에)
//   GET    /api/wa-promo/survey-sources                  설문 + 이름/전화 문항 추정
//   POST   /api/wa-promo/survey-import {survey_id, name_k, phone_k, company_k?, dry_run}
//   발송 일정
//   GET    /api/wa-promo/campaigns?from&to               일정(이미지 제외) + 결과 집계
//   POST   /api/wa-promo/campaigns {send_at | send_now, caption, image_b64·image_mime·image_name | from_campaign_id, memo_filter, contact_ids?}
//            contact_ids(0261) = 고른 연락처 중 ✅ 동의자에게만 · from_campaign_id = 지난 발송 이미지 다시 쓰기
//   GET    /api/wa-promo/campaigns/recent-images         다시 쓸 이미지 목록(최근 발송)
//   PATCH  /api/wa-promo/campaigns/:id                   예약 상태만 수정 · DELETE = 취소
//   GET    /api/wa-promo/campaigns/:id/image             이미지
//   GET    /api/wa-promo/campaigns/:id/sends             발송 원장(실제 전달 상태)
//   POST   /api/wa-promo/campaigns/:id/test {phone}      한 번호로 시험 발송(동의·상한 무시)
//   이미지 뱅크(0281 · 2026-10-16)
//   GET    /api/wa-promo/images?q&folder                 목록(원본 제외) + 사용 횟수 · 최근 사용일 · 폴더 목록
//   POST   /api/wa-promo/images {name, mime, image_b64, thumb_b64?, width?, height?, folder?}  1장(화면이 여러 장을 차례로) · 같은 파일은 duplicate
//   PATCH  /api/wa-promo/images/:id {name?, folder?} · DELETE /api/wa-promo/images/:id (소프트 · 발송은 그대로)
//   POST   /api/wa-promo/images/bulk {ids, action: delete|move, folder?}
//   GET    /api/wa-promo/images/:id/file · /thumb       원본 · 썸네일
//   GET    /api/wa-promo/images/:id/history             이 이미지로 나간 광고(날짜순)
//   POST/PATCH campaigns 에 image_id(뱅크에서 고름) — 새로 올린 이미지는 뱅크에도 자동 저장
//   받은 메시지
//   GET    /api/wa-promo/conversations?state&assignee    대화 목록(번호별 마지막 메시지)
//   GET    /api/wa-promo/conversations/:phone            대화 내용
//   POST   /api/wa-promo/conversations/:phone/reply {text}   직접 답장(24시간 창 안)
//   POST   /api/wa-promo/conversations/:phone/contact {name} 미등록 번호를 연락처로
//   GET    /api/wa-promo/messages/export?from&to&state   엑셀용 원자료
//   자동응답
//   GET/POST /api/wa-promo/autoreplies · PATCH/DELETE /api/wa-promo/autoreplies/:id
//   REFATRIX Platform(본사) 마케팅 이미지 — 0282 · 플랫폼 화면 marketing.html (원본 templates/marketing_platform.html)
//   POST   /api/pf-images/login {token, name, user_key}   플랫폼 세션 → 1시간 업로드 토큰(typ pf_img · ERP API 는 전부 401)
//   GET    /api/pf-images                                 내가 올린 것(이름 · 크기 · 올린 날 · 설명 · ERP 에서 정리됐는지)
//   POST   /api/pf-images {name, mime, image_b64, thumb_b64?, width?, height?, memo?}  1장 → ERP 뱅크 「본사(CTR)」
//   GET    /api/pf-images/:id/thumb                       내 것만
//   DELETE /api/pf-images/:id                             내 것 · 아직 광고에 안 쓴 것만
//   설정
//   GET    /api/wa-promo/status                          상한 · 템플릿 · 웹훅 · 품질(가능하면)
//   GET    /api/wa-promo/users                           담당자 선택용
// =====================================================================
import { query } from '../db.js';
import { authGuard, DIR_SOCIO } from '../middleware/authGuard.js';
import { pageAllowed } from '../permissions.js';
import { platformApi } from '../surveyViewer.js';
import { logEvent } from '../audit.js';
import { normalizeWaNumber, waApiReady } from '../waSend.js';
import { explainWaError } from '../waWebhook.js';
import {
  promoCfg, promoReady, insertContacts, classifyRows, queueConsentAsk, sentToday, audienceCount,
  sendCampaignTo, manualReply, maskPhone, MAX_IMAGE_BYTES, uploadCampaignImage, targetIdsOf,
} from '../waPromo.js';

export const WA_PAGE = 'wapromo';
// 읽기: 디렉터 · 소시오 또는 wapromo 권한(열람/수정) · 쓰기: 디렉터 · 소시오 또는 wapromo 「수정」
function waGuard(write) {
  return async (req, reply) => {
    const { perm, isRegistered } = req.ctx;
    if (DIR_SOCIO.includes(perm.role)) return;
    if (!pageAllowed(perm, WA_PAGE, isRegistered)) return reply.code(403).send({ error: 'forbidden', page: WA_PAGE });
    if (write && ((perm.pageAccess && perm.pageAccess[WA_PAGE]) || 'edit') !== 'edit') return reply.code(403).send({ error: 'read_only', page: WA_PAGE });
  };
}
const R = { preHandler: [authGuard, waGuard(false)] };
const W = { preHandler: [authGuard, waGuard(true)] };
const IMG_LIMIT = { preHandler: [authGuard, waGuard(true)], bodyLimit: 9 * 1024 * 1024 };
const IMG_MIMES = ['image/jpeg', 'image/png'];
const CONSENTS = ['unknown', 'asked', 'yes', 'no'];
const ACTIONS = ['none', 'consent_yes', 'consent_no', 'lead'];
const idOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const localMx = (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(s || ''));   // 멕시코 시각 'YYYY-MM-DDTHH:MM'
const MXT = (expr) => `to_char(${expr} AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD"T"HH24:MI')`;

function contactOut(r) {
  return { id: Number(r.id), name: r.name, phone: r.phone, phone_masked: maskPhone(r.phone), memo: r.memo || null,
    source: r.source, source_ref: r.source_ref || null, consent: r.consent, consent_at: r.consent_at || null, consent_via: r.consent_via || null,
    ask_queued: !!r.ask_queued_at && !r.asked_at, asked_at: r.asked_at || null, ask_error: r.ask_error || null,
    inbox_state: r.inbox_state, lead: r.lead === true, assigned_to: r.assigned_to != null ? Number(r.assigned_to) : null,
    assigned_name: r.assigned_name || null, note: r.note || null, last_in_at: r.last_in_at || null, last_out_at: r.last_out_at || null,
    created_at: r.created_at };
}
function dlv(x) {
  const o = { dlv_status: x.dlv_status || null, delivered_at: x.delivered_at || null, read_at: x.read_at || null };
  if (x.dlv_status === 'failed') o.dlv_reason = explainWaError(x.dlv_code, x.dlv_title) + (x.dlv_detail ? ` — ${x.dlv_detail}` : '');
  return o;
}
const DLV_JOIN = (alias) => `LEFT JOIN wa_message_status m ON m.message_id = ${alias}`;
const DLV_COLS = `m.status AS dlv_status, m.delivered_at, m.read_at, m.error_code AS dlv_code, m.error_title AS dlv_title, m.error_detail AS dlv_detail`;

export default async function waPromoRoutes(app) {
  // ───────── 연락처 ─────────
  // 연락처 조건(목록 · 「조건에 맞는 전체」 그룹 넣기가 같이 쓴다) — q · consent · queued · group(id | none)
  function contactConds(f, args) {
    const conds = ['w.deleted_at IS NULL'];
    const kw = String((f && f.q) || '').trim();
    if (kw) { args.push('%' + kw + '%'); const d = kw.replace(/\D/g, ''); conds.push(`(w.name ILIKE $${args.length} OR w.memo ILIKE $${args.length}${d.length >= 3 ? ` OR w.phone LIKE '%${d}%'` : ''})`); }
    if (f && CONSENTS.includes(f.consent)) { args.push(f.consent); conds.push(`w.consent = $${args.length}`); }
    if (f && String(f.queued) === '1') conds.push(`w.ask_queued_at IS NOT NULL AND w.asked_at IS NULL`);
    const g = f && f.group;
    if (g === 'none') conds.push(`NOT EXISTS (SELECT 1 FROM wa_contact_groups cg JOIN wa_groups gg ON gg.id = cg.group_id AND gg.deleted_at IS NULL WHERE cg.contact_id = w.id)`);
    else if (idOf(g)) { args.push(idOf(g)); conds.push(`EXISTS (SELECT 1 FROM wa_contact_groups cg WHERE cg.contact_id = w.id AND cg.group_id = $${args.length})`); }
    return conds;
  }
  app.get('/api/wa-promo/contacts', R, async (req) => {
    const args = []; const conds = contactConds(req.query, args);
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const rows = (await query(
      `SELECT w.*, u.name AS assigned_name,
              ARRAY(SELECT cg.group_id FROM wa_contact_groups cg JOIN wa_groups g ON g.id = cg.group_id AND g.deleted_at IS NULL
                     WHERE cg.contact_id = w.id ORDER BY lower(g.name)) AS group_ids
         FROM wa_contacts w LEFT JOIN users u ON u.id = w.assigned_to
        WHERE ${conds.join(' AND ')} ORDER BY w.created_at DESC, w.id DESC LIMIT ${limit}`, args)).rows;
    const matched = Number((await query(`SELECT count(*)::int n FROM wa_contacts w WHERE ${conds.join(' AND ')}`, args)).rows[0].n);
    const counts = (await query(
      `SELECT count(*)::int total,
              count(*) FILTER (WHERE consent='yes')::int yes, count(*) FILTER (WHERE consent='asked')::int asked,
              count(*) FILTER (WHERE consent='unknown')::int unknown, count(*) FILTER (WHERE consent='no')::int no,
              count(*) FILTER (WHERE consent='unknown' AND ask_queued_at IS NOT NULL AND asked_at IS NULL)::int queued,
              count(*) FILTER (WHERE inbox_state='open')::int inbox_open
         FROM wa_contacts WHERE deleted_at IS NULL`)).rows[0];
    return { items: rows.map((r) => ({ ...contactOut(r), groups: (r.group_ids || []).map(Number) })), counts, matched };
  });

  app.post('/api/wa-promo/contacts', W, async (req, reply) => {
    const b = req.body || {};
    const r = await insertContacts([{ name: b.name, phone: b.phone, memo: b.memo }], { source: 'manual', userId: req.ctx.perm.userId });
    const row = r.rows[0];
    if (row.status === 'bad_phone') return reply.code(400).send({ error: 'bad_phone' });
    if (row.status === 'no_name') return reply.code(400).send({ error: 'name_required' });
    if (row.status === 'exists') return reply.code(409).send({ error: 'duplicate_phone', existing: row.existing });
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `wa_contact:${row.id}`, detail: { to: maskPhone(row.phone) } });
    return { id: row.id, phone: row.phone };
  });

  app.post('/api/wa-promo/contacts/bulk', W, async (req, reply) => {
    const b = req.body || {};
    const rows = Array.isArray(b.rows) ? b.rows.slice(0, 5000) : [];
    if (!rows.length) return reply.code(400).send({ error: 'no_rows' });
    if (b.dry_run !== false) {
      const cls = await classifyRows(rows);
      return { dry_run: true, rows: cls, summary: summarize(cls) };
    }
    const gid = b.group_id != null ? await liveGroupId(b.group_id) : null;
    if (b.group_id != null && !gid) return reply.code(404).send({ error: 'group_not_found' });
    const r = await insertContacts(rows, { source: 'excel', userId: req.ctx.perm.userId });
    const grouped = gid ? await addToGroup(gid, importedIds(r.rows), req.ctx.perm.userId) : 0;
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: 'wa_contacts:bulk', detail: { added: r.added, rows: rows.length, group: gid, grouped } });
    return { dry_run: false, added: r.added, grouped, rows: r.rows, summary: summarize(r.rows) };
  });

  app.patch('/api/wa-promo/contacts/:id', W, async (req, reply) => {
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {}; const sets = []; const args = [];
    const put = (sql, v) => { args.push(v); sets.push(sql.replace('?', '$' + args.length)); };
    if (b.name != null) { const n = String(b.name).trim().slice(0, 120); if (!n) return reply.code(400).send({ error: 'name_required' }); put('name=?', n); }
    if (b.memo !== undefined) put('memo=?', String(b.memo || '').trim().slice(0, 300) || null);
    if (b.note !== undefined) put('note=?', String(b.note || '').trim().slice(0, 1000) || null);
    if (b.phone != null) {
      const p = normalizeWaNumber(b.phone); if (!p) return reply.code(400).send({ error: 'bad_phone' });
      const dup = (await query(`SELECT id FROM wa_contacts WHERE phone=$1 AND deleted_at IS NULL AND id<>$2`, [p, id])).rows[0];
      if (dup) return reply.code(409).send({ error: 'duplicate_phone' });
      put('phone=?', p);
    }
    if (b.consent != null) {
      if (!CONSENTS.includes(b.consent) || b.consent === 'asked') return reply.code(400).send({ error: 'bad_consent' });
      // 본인이 버튼·메시지로 수신거부한 사람은 사람이 되돌릴 수 없다(본인이 다시 「Sí, quiero」를 보내면 자동으로 동의)
      if (b.consent === 'yes') {
        const cur = (await query(`SELECT consent, consent_via FROM wa_contacts WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
        if (cur && cur.consent === 'no' && ['button', 'message'].includes(cur.consent_via)) return reply.code(409).send({ error: 'opted_out' });
      }
      put('consent=?', b.consent);
      sets.push('consent_at=now()'); put('consent_via=?', b.consent === 'unknown' ? null : 'sales'); put('consent_by=?', req.ctx.perm.userId);
      if (b.consent !== 'unknown') sets.push('ask_queued_at=NULL');
    }
    if (b.assigned_to !== undefined) put('assigned_to=?', b.assigned_to ? idOf(b.assigned_to) : null);
    if (b.inbox_state != null) { if (!['none', 'open', 'done'].includes(b.inbox_state)) return reply.code(400).send({ error: 'bad_state' }); put('inbox_state=?', b.inbox_state); }
    if (typeof b.lead === 'boolean') put('lead=?', b.lead);
    if (!sets.length) return reply.code(400).send({ error: 'nothing_to_update' });
    args.push(id);
    const r = (await query(`UPDATE wa_contacts SET ${sets.join(', ')}, updated_at=now() WHERE id=$${args.length} AND deleted_at IS NULL RETURNING *`, args)).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    if (b.consent != null) await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `wa_contact:${id}`, detail: { consent: b.consent, via: 'sales' } });
    return contactOut(r);
  });

  app.delete('/api/wa-promo/contacts/:id', W, async (req, reply) => {
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const r = (await query(`UPDATE wa_contacts SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `wa_contact:${id}` });
    return { ok: true };
  });

  app.post('/api/wa-promo/consent/ask', W, async (req) => {
    const b = req.body || {};
    const r = await queueConsentAsk({ ids: Array.isArray(b.ids) ? b.ids : null });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: 'wa_contacts:consent_ask', detail: r });
    return { ...r, remaining_today: Math.max(0, promoCfg().cap - await sentToday()), cap: promoCfg().cap };
  });

  // 설문 응답자 가져오기 — 이름·전화 문항은 화면에서 고른다(추정값을 미리 채움)
  app.get('/api/wa-promo/survey-sources', R, async () => {
    const rows = (await query(
      `SELECT s.id, s.title, s.code_prefix, s.questions,
              (SELECT count(*)::int FROM survey_pages p WHERE p.survey_id = s.id AND p.status = 'done') AS done_n
         FROM surveys s WHERE s.deleted_at IS NULL ORDER BY s.id DESC`)).rows;
    return { items: rows.map((s) => {
      const qs = (Array.isArray(s.questions) ? s.questions : []).filter((x) => x && ['text', 'info', 'number'].includes(x.type))
        .map((x) => ({ k: x.k, no: x.no, text: x.text, ko: x.ko || null, type: x.type }));
      const guess = (re) => (qs.find((x) => re.test(`${x.text} ${x.ko || ''}`)) || {}).k || null;
      return { id: Number(s.id), title: s.title, code_prefix: s.code_prefix, done_n: s.done_n, questions: qs,
        guess: { name_k: guess(/nombre|name|이름|성명/i), phone_k: guess(/tel|whats|cel|móvil|movil|전화|휴대/i), company_k: guess(/empresa|taller|refacc|negocio|상호|회사/i) } };
    }) };
  });
  app.post('/api/wa-promo/survey-import', W, async (req, reply) => {
    const b = req.body || {};
    const sid = idOf(b.survey_id); if (!sid) return reply.code(400).send({ error: 'bad_survey' });
    if (!b.phone_k) return reply.code(400).send({ error: 'phone_k_required' });
    const s = (await query(`SELECT id, code_prefix FROM surveys WHERE id=$1 AND deleted_at IS NULL`, [sid])).rows[0];
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const pages = (await query(`SELECT id, red_number, answers FROM survey_pages WHERE survey_id=$1 AND status='done' ORDER BY id`, [sid])).rows;
    const pick = (A, k) => (k && A && A[k] != null ? String(A[k]).trim() : '');
    const rows = pages.map((p) => {
      const A = p.answers || {};
      const company = pick(A, b.company_k), nm = pick(A, b.name_k);
      return { name: nm || company || `Encuesta ${p.red_number || p.id}`, phone: pick(A, b.phone_k),
        memo: [s.code_prefix ? `Encuesta ${s.code_prefix}${p.red_number ? '_' + p.red_number : ''}` : 'Encuesta', company && nm ? company : null].filter(Boolean).join(' · '),
        source_ref: `survey:${sid}:${p.red_number || p.id}` };
    }).filter((r) => r.phone);
    if (b.dry_run !== false) { const cls = await classifyRows(rows); return { dry_run: true, rows: cls, summary: summarize(cls), pages: pages.length }; }
    const gid = b.group_id != null ? await liveGroupId(b.group_id) : null;
    if (b.group_id != null && !gid) return reply.code(404).send({ error: 'group_not_found' });
    const r = await insertContacts(rows, { source: 'survey', userId: req.ctx.perm.userId });
    const grouped = gid ? await addToGroup(gid, importedIds(r.rows), req.ctx.perm.userId) : 0;
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `wa_contacts:survey:${sid}`, detail: { added: r.added, group: gid, grouped } });
    return { dry_run: false, added: r.added, grouped, summary: summarize(r.rows), pages: pages.length };
  });

  // ───────── 0283 · 연락처 그룹 ─────────
  const GROUP_COLORS = ['#2a78d6', '#11743b', '#d81e25', '#b26a00', '#7b4bc4', '#0f8a8a', '#c2417d', '#5b6470'];
  const cleanColor = (v) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : null);
  async function liveGroupId(v) {
    const id = idOf(v); if (!id) return null;
    const r = (await query(`SELECT id FROM wa_groups WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    return r ? Number(r.id) : null;
  }
  function importedIds(rows) {     // 새로 등록 + 이미 등록된 번호(같은 사람) — 파일 안 중복 · 오류는 뺀다
    const s = new Set();
    for (const r of rows || []) { if (r.status === 'new' && r.id) s.add(Number(r.id)); else if (r.status === 'exists' && r.existing && r.existing.id) s.add(Number(r.existing.id)); }
    return [...s];
  }
  async function addToGroup(gid, ids, userId) {
    if (!ids.length) return 0;
    return (await query(
      `INSERT INTO wa_contact_groups (contact_id, group_id, added_by)
       SELECT w.id, $2, $3 FROM wa_contacts w WHERE w.id = ANY($1::bigint[]) AND w.deleted_at IS NULL
       ON CONFLICT (contact_id, group_id) DO NOTHING`, [ids, gid, userId])).rowCount;
  }
  async function groupList() {
    const rows = (await query(
      `SELECT g.id, g.name, g.color, g.memo, ${MXT('g.created_at')} AS created_mx,
              count(w.id)::int AS n, count(w.id) FILTER (WHERE w.consent='yes')::int AS yes
         FROM wa_groups g LEFT JOIN wa_contact_groups cg ON cg.group_id = g.id
         LEFT JOIN wa_contacts w ON w.id = cg.contact_id AND w.deleted_at IS NULL
        WHERE g.deleted_at IS NULL GROUP BY g.id ORDER BY lower(g.name)`)).rows;
    const none = (await query(
      `SELECT count(*)::int n, count(*) FILTER (WHERE consent='yes')::int yes FROM wa_contacts w WHERE w.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM wa_contact_groups cg JOIN wa_groups g ON g.id = cg.group_id AND g.deleted_at IS NULL WHERE cg.contact_id = w.id)`)).rows[0];
    return { items: rows.map((r) => ({ ...r, id: Number(r.id) })), none };
  }
  app.get('/api/wa-promo/groups', R, async () => groupList());
  async function createGroup(name, b, userId) {
    const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!n) return { error: 'group_name_required' };
    const ex = (await query(`SELECT id FROM wa_groups WHERE lower(name)=lower($1) AND deleted_at IS NULL`, [n])).rows[0];
    if (ex) return { id: Number(ex.id), exists: true };
    const cnt = Number((await query(`SELECT count(*)::int n FROM wa_groups`)).rows[0].n);
    const r = (await query(`INSERT INTO wa_groups (name, color, memo, created_by) VALUES ($1,$2,$3,$4)
                             ON CONFLICT (lower(name)) WHERE deleted_at IS NULL DO UPDATE SET updated_at = wa_groups.updated_at RETURNING id`,
      [n, cleanColor(b && b.color) || GROUP_COLORS[cnt % GROUP_COLORS.length], String((b && b.memo) || '').trim().slice(0, 300) || null, userId])).rows[0];
    return { id: Number(r.id) };
  }
  app.post('/api/wa-promo/groups', W, async (req, reply) => {
    const b = req.body || {};
    const r = await createGroup(b.name, b, req.ctx.perm.userId);
    if (r.error) return reply.code(400).send({ error: r.error });
    if (r.exists) return reply.code(409).send({ error: 'group_exists', id: r.id });
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `wa_group:${r.id}`, detail: { name: b.name } });
    return { id: r.id };
  });
  app.patch('/api/wa-promo/groups/:id', W, async (req, reply) => {
    const id = await liveGroupId(req.params.id); if (!id) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {}; const sets = []; const args = [id];
    if (b.name !== undefined) {
      const n = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 60); if (!n) return reply.code(400).send({ error: 'group_name_required' });
      if ((await query(`SELECT 1 FROM wa_groups WHERE lower(name)=lower($1) AND deleted_at IS NULL AND id<>$2`, [n, id])).rows[0]) return reply.code(409).send({ error: 'group_exists' });
      args.push(n); sets.push(`name=$${args.length}`);
    }
    if (b.color !== undefined) { args.push(cleanColor(b.color)); sets.push(`color=COALESCE($${args.length}, color)`); }
    if (b.memo !== undefined) { args.push(String(b.memo || '').trim().slice(0, 300) || null); sets.push(`memo=$${args.length}`); }
    if (!sets.length) return reply.code(400).send({ error: 'nothing_to_update' });
    await query(`UPDATE wa_groups SET ${sets.join(', ')}, updated_at=now() WHERE id=$1`, args);
    return { ok: true };
  });
  app.delete('/api/wa-promo/groups/:id', W, async (req, reply) => {
    const id = await liveGroupId(req.params.id); if (!id) return reply.code(404).send({ error: 'not_found' });
    // 예약된 발송이 이 그룹만 대상으로 하면 지우지 못하게(대상이 「동의 전체」로 바뀌는 사고 방지)
    const used = (await query(`SELECT id FROM wa_campaigns WHERE status IN ('scheduled','sending') AND $1 = ANY(target_groups)`, [id])).rows;
    if (used.length) return reply.code(409).send({ error: 'group_in_use', campaigns: used.map((r) => Number(r.id)) });
    await query(`UPDATE wa_groups SET deleted_at=now() WHERE id=$1`, [id]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `wa_group:${id}` });
    return { ok: true };
  });
  // 한 번에 그룹에 넣기 / 빼기 — ids(고른 사람) · filter(지금 조건에 맞는 전체) · phones(번호 붙여넣기) 중 하나
  app.post('/api/wa-promo/groups/assign', W, async (req, reply) => {
    const b = req.body || {};
    const action = b.action === 'remove' ? 'remove' : 'add';
    let gid = null; let created = false;
    if (b.group_id != null) { gid = await liveGroupId(b.group_id); if (!gid) return reply.code(404).send({ error: 'group_not_found' }); }
    else if (b.group_name && action === 'add') { const r = await createGroup(b.group_name, b, req.ctx.perm.userId); if (r.error) return reply.code(400).send({ error: r.error }); gid = r.id; created = !r.exists; }
    else return reply.code(400).send({ error: 'group_required' });
    let ids = []; let unknownPhones = []; let mode;
    if (Array.isArray(b.ids)) {
      mode = 'ids'; ids = targetIdsOf(b.ids) || [];
      if (ids.length > 20000) return reply.code(400).send({ error: 'too_many_contacts' });
    } else if (b.filter && typeof b.filter === 'object') {
      mode = 'filter'; const args = []; const conds = contactConds(b.filter, args);
      ids = (await query(`SELECT w.id FROM wa_contacts w WHERE ${conds.join(' AND ')}`, args)).rows.map((r) => Number(r.id));
    } else if (Array.isArray(b.phones) || typeof b.phones === 'string') {
      mode = 'phones';
      const raw = (Array.isArray(b.phones) ? b.phones : String(b.phones).split(/[\n,;\t]+/)).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20000);
      const norm = new Map(); for (const x of raw) { const p = normalizeWaNumber(x); if (p) norm.set(p, x); else unknownPhones.push(x); }
      const found = (await query(`SELECT id, phone FROM wa_contacts WHERE deleted_at IS NULL AND phone = ANY($1::text[])`, [[...norm.keys()]])).rows;
      const fset = new Set(found.map((r) => r.phone));
      for (const [p, x] of norm) if (!fset.has(p)) unknownPhones.push(x);
      ids = found.map((r) => Number(r.id));
    } else return reply.code(400).send({ error: 'no_contacts' });
    let changed = 0;
    if (action === 'add') changed = await addToGroup(gid, ids, req.ctx.perm.userId);
    else if (ids.length) changed = (await query(`DELETE FROM wa_contact_groups WHERE group_id=$1 AND contact_id = ANY($2::bigint[])`, [gid, ids])).rowCount;
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `wa_group:${gid}`, detail: { action, mode, matched: ids.length, changed } });
    return { group_id: gid, created, action, matched: ids.length, changed, unchanged: ids.length - changed,
      unknown_phones: unknownPhones.slice(0, 200), unknown_n: unknownPhones.length };
  });
  // 예약 전 대상 수
  app.get('/api/wa-promo/audience', R, async (req) => {
    const groups = String(req.query.groups || '').split(',').map(idOf).filter(Boolean);
    return { n: await audienceCount({ memo_filter: req.query.memo || null, target_groups: groups }) };
  });
  async function cleanGroups(v) {   // 예약 대상 그룹 — 살아 있는 그룹만, 없으면 null
    const ids = targetIdsOf(v); if (!ids) return null;
    const ok = (await query(`SELECT id FROM wa_groups WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`, [ids])).rows.map((r) => Number(r.id));
    return ok.length ? ok : undefined;   // undefined = 고른 그룹이 다 없어짐(오류)
  }

  // ───────── 발송 일정 ─────────
  const CAMP_COLS = `c.id, ${MXT('c.send_at')} AS send_at_mx, c.send_at, c.caption, c.image_mime, c.image_name, octet_length(c.image) AS image_bytes,
                     c.memo_filter, COALESCE(cardinality(c.target_ids), 0) AS target_sel, c.target_groups, c.image_id, c.status, c.target_n, c.created_at, c.started_at, c.finished_at, u.name AS created_by_name`;
  async function campaignStats(ids) {
    if (!ids.length) return new Map();
    const rows = (await query(
      `SELECT s.campaign_id, count(*) FILTER (WHERE s.sent_at IS NOT NULL)::int sent,
              count(*) FILTER (WHERE s.sent_at IS NULL AND s.status='failed')::int failed,
              count(*) FILTER (WHERE m.status IN ('delivered','read'))::int delivered,
              count(*) FILTER (WHERE m.status = 'read')::int read,
              count(*) FILTER (WHERE m.status = 'failed')::int dlv_failed
         FROM wa_campaign_sends s ${DLV_JOIN('s.message_id')}
        WHERE s.campaign_id = ANY($1::bigint[]) GROUP BY s.campaign_id`, [ids])).rows;
    const replies = (await query(
      `SELECT s.campaign_id, count(DISTINCT s.contact_id)::int replied FROM wa_campaign_sends s
         JOIN wa_messages i ON i.contact_id = s.contact_id AND i.direction='in' AND i.at > s.sent_at AND i.at < s.sent_at + interval '3 days'
        WHERE s.campaign_id = ANY($1::bigint[]) AND s.sent_at IS NOT NULL GROUP BY s.campaign_id`, [ids])).rows;
    const m = new Map(rows.map((r) => [Number(r.campaign_id), { ...r, replied: 0 }]));
    for (const r of replies) { const o = m.get(Number(r.campaign_id)) || {}; o.replied = r.replied; m.set(Number(r.campaign_id), o); }
    return m;
  }
  app.get('/api/wa-promo/campaigns', R, async (req) => {
    const args = []; const conds = [`c.status <> 'cancelled' OR $1::boolean`]; args.push(req.query.cancelled === '1');
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ''))) { args.push(req.query.from); conds.push(`c.send_at >= ($${args.length}::date::timestamp AT TIME ZONE 'America/Mexico_City')`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ''))) { args.push(req.query.to); conds.push(`c.send_at < (($${args.length}::date + 1)::timestamp AT TIME ZONE 'America/Mexico_City')`); }
    const rows = (await query(`SELECT ${CAMP_COLS} FROM wa_campaigns c LEFT JOIN users u ON u.id=c.created_by
                                WHERE ${conds.map((x) => `(${x})`).join(' AND ')} ORDER BY c.send_at, c.id`, args)).rows;
    const st = await campaignStats(rows.map((r) => Number(r.id)));
    return { items: rows.map((r) => ({ ...r, id: Number(r.id), image_id: r.image_id != null ? Number(r.image_id) : null, image_bytes: Number(r.image_bytes), target_sel: Number(r.target_sel), target_groups: (r.target_groups || []).map(Number), stats: st.get(Number(r.id)) || null })),
      audience_yes: await audienceCount(null) };
  });

  function readImage(b) {
    if (!b.image_b64) return { none: true };
    const mime = String(b.image_mime || '').toLowerCase();
    if (!IMG_MIMES.includes(mime)) return { error: 'bad_image_type' };
    const buf = Buffer.from(String(b.image_b64).replace(/^data:[^,]*,/, ''), 'base64');
    if (!buf.length) return { error: 'bad_image' };
    if (buf.length > MAX_IMAGE_BYTES) return { error: 'image_too_large' };
    return { buf, mime, name: String(b.image_name || '').slice(0, 120) || null };
  }
  // 0281 · 이미지 뱅크에 넣기(같은 파일이면 있던 것) → id
  async function saveToBank(img, userId, extra = {}, q = query) {
    const ex = (await q(`SELECT id FROM wa_images WHERE deleted_at IS NULL AND hash = md5($1::bytea)`, [img.buf])).rows[0];
    if (ex) return { id: Number(ex.id), duplicate: true };
    const r = (await q(
      `INSERT INTO wa_images (name, mime, bytes, size, hash, width, height, thumb, folder, created_by, source, pf_user, pf_user_name, memo)
       VALUES ($1,$2,$3,$4,md5($3::bytea),$5,$6,$7,$8,$9,COALESCE($10,'erp'),$11,$12,$13)
       ON CONFLICT (hash) WHERE deleted_at IS NULL DO UPDATE SET updated_at = wa_images.updated_at RETURNING id, (xmax = 0) AS inserted`,
      [img.name || 'imagen', img.mime, img.buf, img.buf.length, extra.width || null, extra.height || null, extra.thumb || null, extra.folder || null, userId,
        extra.source || null, extra.pf_user || null, extra.pf_user_name || null, extra.memo || null])).rows[0];
    return { id: Number(r.id), duplicate: !r.inserted };
  }
  async function bankImage(id) {
    return (await query(`SELECT id, bytes, mime, name FROM wa_images WHERE id=$1 AND deleted_at IS NULL`, [idOf(id)])).rows[0] || null;
  }
  app.get('/api/wa-promo/campaigns/recent-images', R, async () => {
    const rows = (await query(
      `SELECT DISTINCT ON (md5(c.image)) c.id, c.caption, c.image_name, ${MXT('c.send_at')} AS send_at_mx
         FROM wa_campaigns c ORDER BY md5(c.image), c.send_at DESC, c.id DESC`)).rows
      .sort((a, b) => String(b.send_at_mx).localeCompare(String(a.send_at_mx))).slice(0, 12);
    return { items: rows.map((r) => ({ id: Number(r.id), caption: r.caption, image_name: r.image_name, send_at_mx: r.send_at_mx })) };
  });
  app.post('/api/wa-promo/campaigns', IMG_LIMIT, async (req, reply) => {
    const b = req.body || {};
    const now = b.send_now === true;
    if (!now && !localMx(b.send_at)) return reply.code(400).send({ error: 'bad_send_at' });
    const caption = String(b.caption || '').trim();
    if (!caption) return reply.code(400).send({ error: 'caption_required' });
    if (caption.length > 900) return reply.code(400).send({ error: 'caption_too_long' });
    let img = readImage(b);
    if (img.error) return reply.code(400).send({ error: img.error });
    let bankId = null;
    if (img.none && b.image_id) {           // 0281 · 이미지 뱅크에서 고름
      const bi = await bankImage(b.image_id);
      if (!bi) return reply.code(404).send({ error: 'image_source_not_found' });
      img = { buf: bi.bytes, mime: bi.mime, name: bi.name }; bankId = Number(bi.id);
    } else if (img.none && b.from_campaign_id) {   // 지난 발송 이미지 다시 쓰기
      const src = (await query(`SELECT image, image_mime, image_name, image_id FROM wa_campaigns WHERE id=$1`, [idOf(b.from_campaign_id)])).rows[0];
      if (!src) return reply.code(404).send({ error: 'image_source_not_found' });
      img = { buf: src.image, mime: src.image_mime, name: src.image_name }; bankId = src.image_id != null ? Number(src.image_id) : null;
    }
    if (img.none) return reply.code(400).send({ error: 'image_required' });
    if (!bankId) { try { bankId = (await saveToBank(img, req.ctx.perm.userId, { folder: '발송에서 올림' })).id; } catch (_) { bankId = null; /* 0281 전 */ } }
    // 0261 · 고른 연락처 — 그중 ✅ 동의자만 대상. 동의자가 없으면 만들지 않는다.
    let targets = null; let picked = null;
    if (b.contact_ids != null) {
      const ids = targetIdsOf(b.contact_ids);
      if (!ids) return reply.code(400).send({ error: 'no_contacts' });
      if (ids.length > 5000) return reply.code(400).send({ error: 'too_many_contacts' });
      const rows = (await query(`SELECT id, consent FROM wa_contacts WHERE deleted_at IS NULL AND id = ANY($1::bigint[])`, [ids])).rows;
      picked = { selected: ids.length, yes: 0, unknown: 0, asked: 0, no: 0, missing: ids.length - rows.length };
      for (const r of rows) picked[r.consent] = (picked[r.consent] || 0) + 1;
      targets = rows.filter((r) => r.consent === 'yes').map((r) => Number(r.id));
      if (!targets.length) return reply.code(400).send({ error: 'no_consented', picked });
    }
    // 0283 · 그룹 대상(고른 사람이 아닐 때) — 그룹 중 하나라도 들어 있는 ✅ 동의자 · 0명이면 만들지 않는다
    let groups = null;
    if (!targets && b.target_groups != null && targetIdsOf(b.target_groups)) {
      groups = await cleanGroups(b.target_groups);
      if (groups === undefined) return reply.code(404).send({ error: 'group_not_found' });
      if (!(await audienceCount({ memo_filter: b.memo_filter, target_groups: groups }))) return reply.code(400).send({ error: 'no_consented_in_groups' });
    }
    const r = (await query(
      `INSERT INTO wa_campaigns (send_at, caption, image, image_mime, image_name, memo_filter, target_ids, created_by, target_groups${bankId ? ', image_id' : ''})
       VALUES (CASE WHEN $8 THEN now() ELSE ($1::timestamp AT TIME ZONE 'America/Mexico_City') END,$2,$3,$4,$5,$6,$7::bigint[],$9,$10::bigint[]${bankId ? ',$11' : ''})
       RETURNING id, (send_at <= now()) AS past`,
      [now ? null : b.send_at, caption, img.buf, img.mime, img.name, targets ? null : (String(b.memo_filter || '').trim() || null), targets, now, req.ctx.perm.userId, groups].concat(bankId ? [bankId] : []))).rows[0];
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `wa_campaign:${r.id}`,
      detail: { send_at: now ? 'now' : b.send_at, targets: targets ? targets.length : null } });
    return { id: Number(r.id), past: r.past === true, audience: await audienceCount({ memo_filter: targets ? null : b.memo_filter, target_ids: targets, target_groups: groups }), picked,
      remaining_today: Math.max(0, promoCfg().cap - await sentToday()) };
  });
  app.patch('/api/wa-promo/campaigns/:id', IMG_LIMIT, async (req, reply) => {
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {}; const sets = []; const args = [];
    const put = (sql, v) => { args.push(v); sets.push(sql.replace(/\?/g, '$' + args.length)); };
    if (b.send_at != null) { if (!localMx(b.send_at)) return reply.code(400).send({ error: 'bad_send_at' }); put(`send_at=(?::timestamp AT TIME ZONE 'America/Mexico_City')`, b.send_at); }
    if (b.caption != null) { const c = String(b.caption).trim(); if (!c) return reply.code(400).send({ error: 'caption_required' }); if (c.length > 900) return reply.code(400).send({ error: 'caption_too_long' }); put('caption=?', c); }
    if (b.memo_filter !== undefined) put('memo_filter=?', String(b.memo_filter || '').trim() || null);
    if (b.target_groups !== undefined) {   // 0283 · 빈 배열 = 그룹 조건 없앰(동의 전체)
      const g = targetIdsOf(b.target_groups) ? await cleanGroups(b.target_groups) : null;
      if (g === undefined) return reply.code(404).send({ error: 'group_not_found' });
      put('target_groups=?::bigint[]', g);
    }
    let img = readImage(b);
    if (img.error) return reply.code(400).send({ error: img.error });
    let bankId = null;
    if (img.none && b.image_id) { const bi = await bankImage(b.image_id); if (!bi) return reply.code(404).send({ error: 'image_source_not_found' }); img = { buf: bi.bytes, mime: bi.mime, name: bi.name }; bankId = Number(bi.id); }
    else if (!img.none) { try { bankId = (await saveToBank(img, req.ctx.perm.userId, { folder: '발송에서 올림' })).id; } catch (_) { bankId = null; } }
    if (!img.none) { put('image=?', img.buf); put('image_mime=?', img.mime); put('image_name=?', img.name); sets.push('media_id=NULL', 'media_at=NULL'); if (bankId) put('image_id=?', bankId); }
    if (!sets.length) return reply.code(400).send({ error: 'nothing_to_update' });
    args.push(id);
    const r = (await query(`UPDATE wa_campaigns SET ${sets.join(', ')}, updated_at=now() WHERE id=$${args.length} AND status='scheduled' RETURNING id`, args)).rows[0];
    if (!r) return reply.code(409).send({ error: 'not_editable', note: '예약 상태인 발송만 고칠 수 있습니다(발송 중·완료·취소는 불가).' });
    return { ok: true };
  });
  app.delete('/api/wa-promo/campaigns/:id', W, async (req, reply) => {
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const r = (await query(`UPDATE wa_campaigns SET status='cancelled', updated_at=now() WHERE id=$1 AND status IN ('scheduled','sending') RETURNING id`, [id])).rows[0];
    if (!r) return reply.code(409).send({ error: 'not_cancellable' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `wa_campaign:${id}` });
    return { ok: true };
  });
  app.get('/api/wa-promo/campaigns/:id/image', R, async (req, reply) => {
    const r = (await query(`SELECT image, image_mime FROM wa_campaigns WHERE id=$1`, [idOf(req.params.id)])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return reply.type(r.image_mime).header('cache-control', 'private, max-age=3600').send(r.image);
  });
  app.get('/api/wa-promo/campaigns/:id/sends', R, async (req) => {
    const rows = (await query(
      `SELECT s.contact_id, w.name, w.phone, s.status, s.error, s.attempts, s.sent_at, s.updated_at, ${DLV_COLS}
         FROM wa_campaign_sends s JOIN wa_contacts w ON w.id = s.contact_id ${DLV_JOIN('s.message_id')}
        WHERE s.campaign_id=$1 ORDER BY s.updated_at DESC`, [idOf(req.params.id)])).rows;
    return { items: rows.map((x) => ({ contact_id: Number(x.contact_id), name: x.name, phone_masked: maskPhone(x.phone), status: x.status,
      error: x.error, attempts: Number(x.attempts), sent_at: x.sent_at, updated_at: x.updated_at, ...dlv(x) })) };
  });
  app.post('/api/wa-promo/campaigns/:id/test', W, async (req, reply) => {
    if (!promoReady()) return reply.code(400).send({ error: 'wa_not_configured' });
    const id = idOf(req.params.id);
    const to = normalizeWaNumber((req.body || {}).phone);
    if (!to) return reply.code(400).send({ error: 'bad_phone' });
    const c = (await query(`SELECT id, caption, image, image_mime, image_name FROM wa_campaigns WHERE id=$1`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    // 시험 발송은 매번 새로 올린다(예약분의 media_id 와 섞지 않음)
    const up = await uploadCampaignImage(c);
    if (!up.ok) return reply.code(502).send({ error: 'upload_failed', detail: up.error });
    const res = await sendCampaignTo({ id: Number(c.id), caption: c.caption }, { id: null, phone: to }, up.id, { source: 'test' });
    return res.ok ? { ok: true, kind: res.kind } : reply.code(502).send({ error: 'send_failed', detail: res.error, kind: res.kind });
  });

  // ───────── 0281 · 이미지 뱅크 ─────────
  const IMG_COLS = `i.id, i.name, i.mime, i.size, i.width, i.height, i.folder, i.created_at, ${MXT('i.created_at')} AS created_mx, (i.thumb IS NOT NULL) AS has_thumb,
    COALESCE(u.name, CASE WHEN i.source = 'platform' THEN '본사 · ' || COALESCE(i.pf_user_name, '') END) AS created_by_name, i.source, i.memo`;
  app.get('/api/wa-promo/images', R, async (req) => {
    const args = []; const conds = ['i.deleted_at IS NULL'];
    const kw = String(req.query.q || '').trim();
    if (kw) { args.push('%' + kw + '%'); conds.push(`(i.name ILIKE $${args.length} OR i.folder ILIKE $${args.length})`); }
    if (req.query.folder === '__none') conds.push(`i.folder IS NULL`);
    else if (req.query.folder) { args.push(String(req.query.folder)); conds.push(`i.folder = $${args.length}`); }
    const rows = (await query(
      `SELECT ${IMG_COLS},
              count(c.id) FILTER (WHERE c.status <> 'cancelled')::int AS uses,
              ${MXT("max(c.send_at) FILTER (WHERE c.status <> 'cancelled')")} AS last_used_mx
         FROM wa_images i LEFT JOIN users u ON u.id = i.created_by LEFT JOIN wa_campaigns c ON c.image_id = i.id
        WHERE ${conds.join(' AND ')}
        GROUP BY i.id, u.name ORDER BY i.created_at DESC, i.id DESC LIMIT 3000`, args)).rows;
    const folders = (await query(`SELECT folder, count(*)::int n FROM wa_images WHERE deleted_at IS NULL GROUP BY folder ORDER BY folder NULLS LAST`)).rows;
    return { items: rows.map((r) => ({ ...r, id: Number(r.id) })), folders };
  });
  app.post('/api/wa-promo/images', IMG_LIMIT, async (req, reply) => {
    const b0 = req.body || {};
    const b = { ...b0, image_mime: b0.image_mime || b0.mime, image_name: b0.image_name || b0.name };
    const img = readImage(b);
    if (img.error) return reply.code(400).send({ error: img.error });
    if (img.none) return reply.code(400).send({ error: 'image_required' });
    let thumb = null;
    if (b.thumb_b64) { thumb = Buffer.from(String(b.thumb_b64).replace(/^data:[^,]*,/, ''), 'base64'); if (!thumb.length || thumb.length > 600 * 1024) thumb = null; }
    const dim = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 20000 ? n : null; };
    const folder = String(b.folder || '').trim().slice(0, 60) || null;
    const r = await saveToBank(img, req.ctx.perm.userId, { thumb, width: dim(b.width), height: dim(b.height), folder });
    if (!r.duplicate) await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `wa_image:${r.id}`, detail: { name: img.name, size: img.buf.length } });
    return { id: r.id, duplicate: r.duplicate };
  });
  app.patch('/api/wa-promo/images/:id', W, async (req, reply) => {
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {}; const sets = []; const args = [id];
    if (b.name !== undefined) { const n = String(b.name || '').trim().slice(0, 120); if (!n) return reply.code(400).send({ error: 'name_required' }); args.push(n); sets.push(`name=$${args.length}`); }
    if (b.folder !== undefined) { args.push(String(b.folder || '').trim().slice(0, 60) || null); sets.push(`folder=$${args.length}`); }
    if (b.memo !== undefined) { args.push(String(b.memo || '').trim().slice(0, 500) || null); sets.push(`memo=$${args.length}`); }
    if (!sets.length) return reply.code(400).send({ error: 'nothing_to_update' });
    const r = (await query(`UPDATE wa_images SET ${sets.join(', ')}, updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id`, args)).rows[0];
    return r ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });
  app.delete('/api/wa-promo/images/:id', W, async (req, reply) => {
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const r = (await query(`UPDATE wa_images SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `wa_image:${id}` });
    return { ok: true };
  });
  app.post('/api/wa-promo/images/bulk', W, async (req, reply) => {
    const b = req.body || {};
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(idOf).filter(Boolean).slice(0, 3000);
    if (!ids.length) return reply.code(400).send({ error: 'no_images' });
    if (b.action === 'delete') {
      const n = (await query(`UPDATE wa_images SET deleted_at=now() WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`, [ids])).rowCount;
      await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: 'wa_images', detail: { n } });
      return { updated: n };
    }
    if (b.action === 'move') {
      const n = (await query(`UPDATE wa_images SET folder=$2, updated_at=now() WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`, [ids, String(b.folder || '').trim().slice(0, 60) || null])).rowCount;
      return { updated: n };
    }
    return reply.code(400).send({ error: 'bad_action' });
  });
  app.get('/api/wa-promo/images/:id/file', R, async (req, reply) => {
    const r = (await query(`SELECT bytes, mime, name FROM wa_images WHERE id=$1`, [idOf(req.params.id)])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return reply.type(r.mime).header('cache-control', 'private, max-age=86400').send(r.bytes);
  });
  app.get('/api/wa-promo/images/:id/thumb', R, async (req, reply) => {
    const r = (await query(`SELECT COALESCE(thumb, bytes) AS b, CASE WHEN thumb IS NULL THEN mime ELSE 'image/jpeg' END AS t FROM wa_images WHERE id=$1`, [idOf(req.params.id)])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return reply.type(r.t).header('cache-control', 'private, max-age=86400').send(r.b);
  });
  app.get('/api/wa-promo/images/:id/history', R, async (req, reply) => {
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const rows = (await query(`SELECT ${CAMP_COLS} FROM wa_campaigns c LEFT JOIN users u ON u.id=c.created_by WHERE c.image_id=$1 ORDER BY c.send_at DESC, c.id DESC`, [id])).rows;
    const st = await campaignStats(rows.map((r) => Number(r.id)));
    return { items: rows.map((r) => ({ ...r, id: Number(r.id), image_id: Number(r.image_id), image_bytes: Number(r.image_bytes), target_sel: Number(r.target_sel), stats: st.get(Number(r.id)) || null })) };
  });

  // ───────── 받은 메시지 ─────────
  app.get('/api/wa-promo/conversations', R, async (req) => {
    const args = []; const conds = [];
    if (req.query.state === 'open') conds.push(`w.inbox_state = 'open'`);
    else if (req.query.state === 'done') conds.push(`w.inbox_state = 'done'`);
    else if (req.query.state === 'unregistered') conds.push(`w.id IS NULL`);
    if (req.query.assignee) { args.push(idOf(req.query.assignee)); conds.push(`w.assigned_to = $${args.length}`); }
    if (req.query.lead === '1') conds.push(`w.lead = true`);
    const rows = (await query(
      `WITH last AS (
         SELECT DISTINCT ON (phone) phone, id, direction, body, kind, source, at
           FROM wa_messages ORDER BY phone, at DESC, id DESC
       ), cnt AS (
         SELECT phone, count(*) FILTER (WHERE direction='in')::int n_in FROM wa_messages GROUP BY phone
       )
       SELECT last.phone, last.direction, last.body, last.kind, last.source, last.at, cnt.n_in,
              w.id AS contact_id, w.name, w.consent, w.inbox_state, w.lead, w.assigned_to, u.name AS assigned_name,
              i.last_at AS inbound_at, (i.last_at > now() - interval '24 hours') AS window_open
         FROM last JOIN cnt ON cnt.phone = last.phone
         LEFT JOIN wa_contacts w ON w.phone = last.phone AND w.deleted_at IS NULL
         LEFT JOIN users u ON u.id = w.assigned_to
         LEFT JOIN wa_inbound i ON i.wa_from = last.phone
        WHERE cnt.n_in > 0${conds.length ? ' AND ' + conds.join(' AND ') : ''}
        ORDER BY (w.inbox_state = 'open') DESC NULLS LAST, last.at DESC LIMIT 300`, args)).rows;
    return { items: rows.map((r) => ({ phone: r.phone, phone_masked: maskPhone(r.phone), contact_id: r.contact_id != null ? Number(r.contact_id) : null,
      name: r.name || null, consent: r.consent || null, inbox_state: r.inbox_state || null, lead: r.lead === true,
      assigned_to: r.assigned_to != null ? Number(r.assigned_to) : null, assigned_name: r.assigned_name || null,
      last: { direction: r.direction, body: r.body, kind: r.kind, source: r.source, at: r.at }, n_in: r.n_in,
      window_open: r.inbound_at ? r.window_open === true : false, inbound_at: r.inbound_at || null })) };
  });
  app.get('/api/wa-promo/conversations/:phone', R, async (req, reply) => {
    const p = normalizeWaNumber(req.params.phone); if (!p) return reply.code(400).send({ error: 'bad_phone' });
    const msgs = (await query(
      `SELECT x.id, x.direction, x.kind, x.body, x.source, x.campaign_id, x.ok, x.error, x.at, u.name AS sent_by_name, ${DLV_COLS}
         FROM wa_messages x LEFT JOIN users u ON u.id = x.sent_by ${DLV_JOIN('x.wamid')}
        WHERE x.phone=$1 ORDER BY x.at, x.id LIMIT 1000`, [p])).rows;
    const ct = (await query(`SELECT w.*, u.name AS assigned_name FROM wa_contacts w LEFT JOIN users u ON u.id=w.assigned_to WHERE w.phone=$1 AND w.deleted_at IS NULL`, [p])).rows[0];
    const win = (await query(`SELECT last_at, (last_at > now() - interval '24 hours') AS open FROM wa_inbound WHERE wa_from=$1`, [p])).rows[0];
    return { phone: p, contact: ct ? contactOut(ct) : null,
      window: { open: win ? win.open === true : false, last_in_at: win ? win.last_at : null },
      items: msgs.map((x) => ({ id: Number(x.id), direction: x.direction, kind: x.kind, body: x.body, source: x.source,
        campaign_id: x.campaign_id != null ? Number(x.campaign_id) : null, ok: x.ok, error: x.error, at: x.at, sent_by_name: x.sent_by_name || null,
        ...(x.direction === 'out' ? dlv(x) : {}) })) };
  });
  app.post('/api/wa-promo/conversations/:phone/reply', W, async (req, reply) => {
    if (!promoReady()) return reply.code(400).send({ error: 'wa_not_configured' });
    const r = await manualReply({ phone: req.params.phone, text: (req.body || {}).text, userId: req.ctx.perm.userId });
    if (!r.ok) return reply.code(r.error === 'window_closed' ? 409 : 400).send({ error: r.error });
    return r;
  });
  app.post('/api/wa-promo/conversations/:phone/contact', W, async (req, reply) => {
    const r = await insertContacts([{ name: (req.body || {}).name, phone: req.params.phone, memo: (req.body || {}).memo }], { source: 'manual', userId: req.ctx.perm.userId });
    const row = r.rows[0];
    if (row.status !== 'new') return reply.code(row.status === 'exists' ? 409 : 400).send({ error: row.status });
    await query(`UPDATE wa_messages SET contact_id=$1 WHERE phone=$2 AND contact_id IS NULL`, [row.id, row.phone]);
    await query(`UPDATE wa_contacts SET inbox_state='open', last_in_at=(SELECT max(at) FROM wa_messages WHERE phone=$2 AND direction='in') WHERE id=$1`, [row.id, row.phone]);
    return { id: row.id };
  });
  app.get('/api/wa-promo/messages/export', R, async (req) => {
    const args = []; const conds = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ''))) { args.push(req.query.from); conds.push(`x.at >= ($${args.length}::date::timestamp AT TIME ZONE 'America/Mexico_City')`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ''))) { args.push(req.query.to); conds.push(`x.at < (($${args.length}::date + 1)::timestamp AT TIME ZONE 'America/Mexico_City')`); }
    if (req.query.state === 'open') conds.push(`w.inbox_state='open'`);
    if (req.query.direction === 'in') conds.push(`x.direction='in'`);
    const rows = (await query(
      `SELECT ${MXT('x.at')} AS at_mx, x.direction, x.phone, w.name, w.memo, w.consent, w.inbox_state, x.kind, x.source, x.body,
              u.name AS sent_by_name, us.name AS assigned_name, m.status AS dlv_status
         FROM wa_messages x LEFT JOIN wa_contacts w ON w.phone = x.phone AND w.deleted_at IS NULL
         LEFT JOIN users u ON u.id = x.sent_by LEFT JOIN users us ON us.id = w.assigned_to
         ${DLV_JOIN('x.wamid')}
        ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY x.phone, x.at, x.id LIMIT 50000`, args)).rows;
    await logEvent({ userId: req.ctx.perm.userId, action: 'export', target: 'wa_messages', detail: { rows: rows.length } });
    return { items: rows };
  });

  // ───────── 자동응답 ─────────
  const ruleOut = (r) => ({ id: Number(r.id), sort: r.sort, keywords: r.keywords || [], is_fallback: r.is_fallback === true, reply: r.reply,
    buttons: r.buttons || [], action: r.action, active: r.active === true });
  const cleanList = (v, max, len) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map((s) => String(s || '').trim()).filter(Boolean).slice(0, max).map((s) => s.slice(0, len));
  app.get('/api/wa-promo/autoreplies', R, async () => ({
    items: (await query(`SELECT * FROM wa_autoreplies WHERE deleted_at IS NULL ORDER BY is_fallback, sort, id`)).rows.map(ruleOut) }));
  app.post('/api/wa-promo/autoreplies', W, async (req, reply) => {
    const b = req.body || {};
    const kws = cleanList(b.keywords, 30, 60); const reply1 = String(b.reply || '').trim().slice(0, 1000);
    if (!reply1) return reply.code(400).send({ error: 'reply_required' });
    if (!b.is_fallback && !kws.length) return reply.code(400).send({ error: 'keywords_required' });
    if (b.action && !ACTIONS.includes(b.action)) return reply.code(400).send({ error: 'bad_action' });
    if (b.is_fallback) { const ex = (await query(`SELECT 1 FROM wa_autoreplies WHERE is_fallback AND deleted_at IS NULL`)).rows.length; if (ex) return reply.code(409).send({ error: 'fallback_exists' }); }
    const r = (await query(
      `INSERT INTO wa_autoreplies (sort, keywords, is_fallback, reply, buttons, action, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [Number(b.sort) || 100, kws, !!b.is_fallback, reply1, cleanList(b.buttons, 3, 20), b.action || 'none', req.ctx.perm.userId])).rows[0];
    return ruleOut(r);
  });
  app.patch('/api/wa-promo/autoreplies/:id', W, async (req, reply) => {
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {}; const sets = []; const args = [];
    const put = (col, v) => { args.push(v); sets.push(`${col}=$${args.length}`); };
    if (b.sort != null) put('sort', Number(b.sort) || 100);
    if (b.keywords != null) put('keywords', cleanList(b.keywords, 30, 60));
    if (b.reply != null) { const t = String(b.reply).trim().slice(0, 1000); if (!t) return reply.code(400).send({ error: 'reply_required' }); put('reply', t); }
    if (b.buttons != null) put('buttons', cleanList(b.buttons, 3, 20));
    if (b.action != null) { if (!ACTIONS.includes(b.action)) return reply.code(400).send({ error: 'bad_action' }); put('action', b.action); }
    if (typeof b.active === 'boolean') put('active', b.active);
    if (!sets.length) return reply.code(400).send({ error: 'nothing_to_update' });
    put('updated_by', req.ctx.perm.userId); args.push(id);
    const r = (await query(`UPDATE wa_autoreplies SET ${sets.join(', ')}, updated_at=now() WHERE id=$${args.length} AND deleted_at IS NULL RETURNING *`, args)).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    if (!r.is_fallback && !(r.keywords || []).length) return reply.code(400).send({ error: 'keywords_required' });
    return ruleOut(r);
  });
  app.delete('/api/wa-promo/autoreplies/:id', W, async (req, reply) => {
    const r = (await query(`UPDATE wa_autoreplies SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [idOf(req.params.id)])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // ───────── 설정 · 상태 ─────────
  let qualityCache = { at: 0, v: null };
  async function quality() {
    if (!waApiReady()) return null;
    if (Date.now() - qualityCache.at < 600000) return qualityCache.v;
    let v = null;
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(`https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v20.0'}/${process.env.WHATSAPP_PHONE_ID}?fields=quality_rating,verified_name,display_phone_number`,
        { headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }, signal: ctrl.signal });
      clearTimeout(t);
      const d = await r.json().catch(() => ({}));
      if (r.ok) v = { quality_rating: d.quality_rating || null, verified_name: d.verified_name || null, display_phone_number: d.display_phone_number || null };
    } catch { v = null; }
    qualityCache = { at: Date.now(), v }; return v;
  }
  app.get('/api/wa-promo/status', R, async () => {
    const cfg = promoCfg();
    const today = await sentToday();
    const due = (await query(`SELECT count(*)::int n FROM wa_campaigns WHERE status='sending'`)).rows[0].n;
    return { enabled: cfg.enabled, api_ready: promoReady(), cap: cfg.cap, sent_today: today, remaining_today: Math.max(0, cfg.cap - today),
      consent_template: cfg.consentTpl, image_template: cfg.imageTpl, template_lang: cfg.lang,
      webhook: !!(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN && process.env.WHATSAPP_APP_SECRET),
      sending_campaigns: due, meta: await quality() };
  });
  // ───────── REFATRIX Platform(본사) 마케팅 이미지 — 0282 (2026-10-16) ─────────
  //   플랫폼 로그인한 사람 모두 · 올리면 ERP 뱅크 「본사(CTR)」 폴더에 바로(승인 없음) · 플랫폼은 자기 것만 본다.
  //   토큰 typ=pf_img → authGuard 가 ERP API 를 전부 401 로 막는다(설문 열람 토큰과 같은 방식).
  const PF_TYP = 'pf_img';
  const PF_FOLDER = '본사(CTR)';
  const PF_DAY_CAP = 400;                                  // 한 사람 하루 업로드 상한(실수 · 남용 방지)
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const pfClean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n) || null;
  async function pfGuard(req, reply) {
    try { await req.jwtVerify(); } catch { return reply.code(401).send({ error: 'unauthorized' }); }
    const u = req.user || {};
    if (u.typ !== PF_TYP || !u.uk) return reply.code(401).send({ error: 'unauthorized' });
    req.pf = { key: String(u.uk), name: String(u.name || 'REFATRIX Platform') };
  }
  const PF_R = { preHandler: [pfGuard] };
  const PF_IMG = { preHandler: [pfGuard], bodyLimit: 9 * 1024 * 1024 };
  app.post('/api/pf-images/login', async (req, reply) => {
    const b = req.body || {};
    const tok = String(b.token || '').trim();
    if (!UUID_RE.test(tok)) return reply.code(401).send({ error: 'platform_session_invalid' });
    const chk = await platformApi.log(tok, '마케팅 이미지 뱅크 접속 (ERP 연동)');
    if (!chk.ok) return reply.code(chk.invalid ? 401 : 502).send({ error: chk.invalid ? 'platform_session_invalid' : (chk.error || 'platform_unreachable') });
    const name = pfClean(b.name, 80) || 'REFATRIX Platform';
    const uk = pfClean(b.user_key, 80) || name;
    await logEvent({ userId: null, action: 'login', target: 'pf_images:' + name, result: 'ok' }).catch(() => {});
    const token = await reply.jwtSign({ sub: 'pfimg', typ: PF_TYP, uk, name }, { expiresIn: '1h' });
    return { token, name, folder: PF_FOLDER, max_bytes: MAX_IMAGE_BYTES };
  });
  app.get('/api/pf-images', PF_R, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const rows = (await query(
      `SELECT i.id, i.name, i.mime, i.size, i.width, i.height, i.memo, ${MXT('i.created_at')} AS created_mx,
              (i.thumb IS NOT NULL) AS has_thumb, (i.deleted_at IS NOT NULL) AS removed,
              EXISTS (SELECT 1 FROM wa_campaigns c WHERE c.image_id = i.id AND c.status <> 'cancelled') AS used
         FROM wa_images i WHERE i.source = 'platform' AND i.pf_user = $1
        ORDER BY i.created_at DESC, i.id DESC LIMIT 1000`, [req.pf.key])).rows;
    return { name: req.pf.name, folder: PF_FOLDER, items: rows.map((r) => ({ id: Number(r.id), name: r.name, mime: r.mime, size: r.size, width: r.width, height: r.height,
      memo: r.memo, created_mx: r.created_mx, has_thumb: r.has_thumb, removed: r.removed })) };
  });
  app.post('/api/pf-images', PF_IMG, async (req, reply) => {
    const b0 = req.body || {};
    const b = { ...b0, image_mime: b0.image_mime || b0.mime, image_name: b0.image_name || b0.name };
    const img = readImage(b);
    if (img.error) return reply.code(400).send({ error: img.error });
    if (img.none) return reply.code(400).send({ error: 'image_required' });
    const today = (await query(`SELECT count(*)::int n FROM wa_images WHERE source='platform' AND pf_user=$1 AND created_at > now() - interval '24 hours'`, [req.pf.key])).rows[0].n;
    if (today >= PF_DAY_CAP) return reply.code(429).send({ error: 'daily_cap', cap: PF_DAY_CAP });
    let thumb = null;
    if (b.thumb_b64) { thumb = Buffer.from(String(b.thumb_b64).replace(/^data:[^,]*,/, ''), 'base64'); if (!thumb.length || thumb.length > 600 * 1024) thumb = null; }
    const dim = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 20000 ? n : null; };
    const r = await saveToBank(img, null, { thumb, width: dim(b.width), height: dim(b.height), folder: PF_FOLDER,
      source: 'platform', pf_user: req.pf.key, pf_user_name: req.pf.name, memo: pfClean(b.memo, 500) });
    if (!r.duplicate) await logEvent({ userId: null, action: 'create', target: `wa_image:${r.id}`, detail: { platform: req.pf.name, name: img.name, size: img.buf.length } }).catch(() => {});
    return { id: r.id, duplicate: r.duplicate };
  });
  async function pfOwn(req) {
    const id = idOf(req.params.id);
    return id && (await query(`SELECT id, thumb, bytes, mime, deleted_at FROM wa_images WHERE id=$1 AND source='platform' AND pf_user=$2`, [id, req.pf.key])).rows[0];
  }
  app.get('/api/pf-images/:id/thumb', PF_R, async (req, reply) => {
    const r = await pfOwn(req);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    reply.header('Cache-Control', 'private, max-age=600');
    if (r.thumb) { reply.header('Content-Type', 'image/jpeg'); return reply.send(r.thumb); }
    reply.header('Content-Type', r.mime); return reply.send(r.bytes);
  });
  app.delete('/api/pf-images/:id', PF_R, async (req, reply) => {
    const r = await pfOwn(req);
    if (!r || r.deleted_at) return reply.code(404).send({ error: 'not_found' });
    const used = (await query(`SELECT 1 FROM wa_campaigns WHERE image_id=$1 AND status <> 'cancelled' LIMIT 1`, [r.id])).rows[0];
    if (used) return reply.code(409).send({ error: 'already_used' });
    await query(`UPDATE wa_images SET deleted_at=now() WHERE id=$1`, [r.id]);
    await logEvent({ userId: null, action: 'delete', target: `wa_image:${r.id}`, detail: { platform: req.pf.name } }).catch(() => {});
    return { ok: true };
  });

  app.get('/api/wa-promo/users', R, async () => ({
    items: (await query(`SELECT id, name, role FROM users WHERE deleted_at IS NULL ORDER BY name`)).rows.map((u) => ({ id: Number(u.id), name: u.name, role: u.role })) }));
}

function summarize(rows) {
  const s = { total: rows.length, new: 0, exists: 0, dup_in_file: 0, bad_phone: 0, no_name: 0 };
  for (const r of rows) s[r.status] = (s[r.status] || 0) + 1;
  return s;
}
