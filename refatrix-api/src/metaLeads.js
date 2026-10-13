// =====================================================================
// Refatrix ERP · metaLeads.js — Meta 광고 문의(Messenger · Instagram) 가져오기 (0270 · 2026-10-12 디렉터 지시)
//
//   「Meta 받은편지함에 500건이 넘는 문의 — 지역 · 이름 · 연락처 · 수요품목으로 목록화해서
//    우리 고객(refaccionaria)에게 판매기회를 만들고 싶다」
//
//   받은편지함 화면은 대화를 20건씩 손으로 내려야 더 보여 주므로(창이 숨겨지면 멈춘다) 화면 대신
//   Graph API 를 쓴다:  GET /{page-id}/conversations?platform=messenger|instagram&fields=…messages{…}
//
//   토큰: META_PAGE_TOKEN(페이지 토큰 또는 시스템 사용자 토큰). 비우면 WHATSAPP_TOKEN 으로 시도 —
//         같은 시스템 사용자에게 페이지 자산을 붙이면 키 하나로 된다. 시스템 사용자 토큰이면
//         /{page}?fields=access_token 으로 페이지 토큰을 받아 쓴다(50분 캐시).
//   저장: 한 대화 = meta_threads 한 행. 고객이 쓴 말에서 업종 · 지역 · 전화 · 차종 · 부품을 자동 추출(a_*),
//         사람이 고친 값(m_*) · 상태 · 메모는 다시 가져와도 지우지 않는다.
//   주기: 30분마다 새로 바뀐 대화만(META_LEADS_AUTO=0 이면 끔). 첫 실행은 최근 META_LEADS_DAYS(기본 180)일.
//   한계: Facebook 프로필의 「거주지」는 API 로 주지 않는다 — 지역은 고객이 대화에서 말한 것만 잡힌다.
// =====================================================================
import { query } from './db.js';
import { extractLead } from './metaLeadExtract.js';
import { normalizeWaNumber } from './waSend.js';
import { kickAnalyze } from './metaLeadsAi.js';

export const metaPageId = () => process.env.META_PAGE_ID || '1338649012669713';
const apiVer = () => process.env.META_GRAPH_VERSION || process.env.WHATSAPP_API_VERSION || 'v20.0';
const baseToken = () => process.env.META_PAGE_TOKEN || process.env.WHATSAPP_TOKEN || '';
export const metaLeadsConfigured = () => !!baseToken();
export const metaTokenSource = () => (process.env.META_PAGE_TOKEN ? 'META_PAGE_TOKEN' : (process.env.WHATSAPP_TOKEN ? 'WHATSAPP_TOKEN' : null));
const DAYS = () => Math.max(1, Math.min(730, Number(process.env.META_LEADS_DAYS) || 180));
const MAX_THREADS = 5000;
const MSG_KEEP = 80;
const TIMEOUT_MS = 30000;

let fetchOverride = null;                 // 시험용 — (url) => {ok,status,json}
export function setMetaFetch(fn) { fetchOverride = fn || null; tokenCache = null; }

async function graphGet(url) {
  if (fetchOverride) return fetchOverride(url);
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && !j.error, status: r.status, json: j };
  } catch (e) {
    return { ok: false, status: 0, json: { error: { message: e && e.name === 'AbortError' ? 'timeout' : 'network' } } };
  } finally { clearTimeout(t); }
}
const gErr = (r) => { const e = (r.json && r.json.error) || {}; return `${e.code ? '#' + e.code + ' ' : ''}${e.message || 'http_' + r.status}`.slice(0, 300); };

// ── 페이지 토큰 · 페이지 정보 ──
//   2026-10-13 · 「Messenger API 설정」에서 받은 페이지 토큰은 대화(pages_messaging)는 읽지만
//   페이지 정보(/{page}?fields=name…)는 pages_read_engagement 가 없어 #100 으로 거절된다.
//   → 페이지 정보 조회가 실패해도 멈추지 않는다. 토큰을 그대로 쓰고(경고만 남김) 대화를 읽는다.
//     Instagram 계정 id 를 못 받으면 대화 참여자에서 추정한다(모든 대화에 공통으로 있는 쪽 = 우리 계정).
let tokenCache = null;   // {token, at, page:{name, ig_id, ig_username}, warning}
export async function resolvePage() {
  if (tokenCache && Date.now() - tokenCache.at < 50 * 60000) return tokenCache;
  const tok = baseToken();
  if (!tok) return { error: 'no_token' };
  const base = `https://graph.facebook.com/${apiVer()}/${encodeURIComponent(metaPageId())}`;
  const tries = [
    'name,access_token,instagram_business_account{id,username}',   // 시스템 사용자 토큰 → 페이지 토큰
    'name,instagram_business_account{id,username}',                // 페이지 토큰(정보 권한 있음)
    'name',
  ];
  let j = null, lastErr = null;
  for (const f of tries) {
    const r = await graphGet(`${base}?fields=${f}&access_token=${encodeURIComponent(tok)}`);
    if (r.ok) { j = r.json || {}; break; }
    lastErr = gErr(r);
  }
  if (!j) {
    // 페이지 정보는 못 읽어도 대화를 읽을 수 있으면 그대로 쓴다
    const probe = await graphGet(`${base}/conversations?platform=messenger&limit=1&fields=id&access_token=${encodeURIComponent(tok)}`);
    if (!probe.ok) return { error: lastErr || gErr(probe) };
    tokenCache = { token: tok, at: Date.now(), page: { id: metaPageId(), name: null, ig_id: null, ig_username: null },
      warning: '페이지 이름 · Instagram 계정 정보는 이 토큰으로 읽을 수 없습니다(pages_read_engagement 없음) — 대화는 정상으로 가져옵니다' };
    return tokenCache;
  }
  const ig = j.instagram_business_account || null;
  tokenCache = { token: j.access_token || tok, at: Date.now(),
    page: { id: metaPageId(), name: j.name || null, ig_id: ig ? String(ig.id) : null, ig_username: ig ? ig.username || null : null } };
  return tokenCache;
}

// Instagram 계정 id 추정 — 여러 대화에 공통으로 들어 있는 참여자(우리 계정). 대화가 1건뿐이면 판단하지 않는다.
export function inferBusinessId(convs) {
  const cnt = new Map();
  for (const c of convs || []) for (const p of ((c.participants && c.participants.data) || [])) cnt.set(String(p.id), (cnt.get(String(p.id)) || 0) + 1);
  const n = (convs || []).length;
  if (n < 2) return null;
  const top = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] === n ? top[0] : null;
}

// ── 대화 1건 → 저장할 모양 ──
export function shapeThread(conv, platform, me) {
  const mine = new Set([String(me.id), me.ig_id ? String(me.ig_id) : ''].filter(Boolean));
  const parts = ((conv.participants && conv.participants.data) || []);
  const cust = parts.find((p) => !mine.has(String(p.id))) || parts[0] || {};
  const msgs = (((conv.messages && conv.messages.data) || []))
    .map((m) => ({ at: m.created_time, me: mine.has(String((m.from || {}).id)) || (cust.id && String((m.from || {}).id) !== String(cust.id) && !!(m.from || {}).id), text: String(m.message || '').trim() }))
    .filter((m) => m.at)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const inMsgs = msgs.filter((m) => !m.me && m.text);
  const customerText = inMsgs.map((m) => m.text).join('\n');
  const ex = extractLead(customerText);
  return {
    platform, thread_id: String(conv.id), user_id: cust.id ? String(cust.id) : null,
    name: cust.name || cust.username || null, username: cust.username || null,
    first_at: msgs.length ? msgs[0].at : null, last_at: conv.updated_time || (msgs.length ? msgs[msgs.length - 1].at : null),
    last_in_at: inMsgs.length ? inMsgs[inMsgs.length - 1].at : null,
    msg_count: Number(conv.message_count) || msgs.length, in_count: inMsgs.length,
    messages: msgs.slice(-MSG_KEEP), customer_text: customerText.slice(0, 8000), ex,
  };
}

async function upsertThread(t, q = query) {
  const r = await q(
    `INSERT INTO meta_threads (platform, thread_id, user_id, name, username, first_at, last_at, last_in_at, msg_count, in_count, messages, customer_text,
                               a_tipo, a_tipo_btn, a_state, a_city, a_phone, a_email, a_vehicles, a_parts, a_intent, fetched_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, now(), now())
     ON CONFLICT (thread_id) DO UPDATE SET
       user_id = EXCLUDED.user_id, name = COALESCE(EXCLUDED.name, meta_threads.name), username = COALESCE(EXCLUDED.username, meta_threads.username),
       first_at = LEAST(meta_threads.first_at, EXCLUDED.first_at), last_at = EXCLUDED.last_at, last_in_at = EXCLUDED.last_in_at,
       msg_count = EXCLUDED.msg_count, in_count = EXCLUDED.in_count, messages = EXCLUDED.messages, customer_text = EXCLUDED.customer_text,
       a_tipo = EXCLUDED.a_tipo, a_tipo_btn = EXCLUDED.a_tipo_btn, a_state = EXCLUDED.a_state, a_city = EXCLUDED.a_city,
       a_phone = EXCLUDED.a_phone, a_email = EXCLUDED.a_email, a_vehicles = EXCLUDED.a_vehicles, a_parts = EXCLUDED.a_parts, a_intent = EXCLUDED.a_intent,
       fetched_at = now(), updated_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [t.platform, t.thread_id, t.user_id, t.name, t.username, t.first_at, t.last_at, t.last_in_at, t.msg_count, t.in_count, JSON.stringify(t.messages), t.customer_text,
      t.ex.tipo, t.ex.tipo_btn, t.ex.state, t.ex.city, t.ex.phone, t.ex.email, t.ex.vehicles, t.ex.parts, t.ex.intent]);
  return !!(r.rows[0] && r.rows[0].inserted);
}

// ── WhatsApp(0271) — ERP 의 WhatsApp Cloud API 번호로 받은 대화(wa_messages)를 같은 목록에 ──
//   번호 = 연락처. 사내 수신자(사용자 wa_phone · 신규견적 알림 수신자 · 일일요약 번호)는 뺀다.
const WA_KIND = { image: '(imagen)', audio: '(audio)', video: '(video)', document: '(documento)', sticker: '(sticker)', location: '(ubicación)' };
export async function internalWaPhones(q = query) {
  const set = new Set();
  const add = (v) => { const n = normalizeWaNumber(v); if (n) set.add(n); };
  for (const sql of [`SELECT wa_phone AS p FROM users WHERE wa_phone IS NOT NULL`, `SELECT phone AS p FROM quote_wa_recipients`]) {
    try { for (const r of (await q(sql)).rows) add(r.p); } catch (_) { /* 테이블 없음 */ }
  }
  add(process.env.DAILY_SUMMARY_WA_TO);
  return set;
}
export async function syncWhatsAppThreads({ since = null, full = false, q = query } = {}) {
  const bp = { threads: 0, inserted: 0, error: null };
  try {
    const skip = await internalWaPhones(q);
    // 2026-10-13 hotfix: 기준 시각(마지막 Graph 가져오기)과 무관하게 「목록에 없거나 새 메시지가 생긴 번호」를 읽는다.
    //   (예전엔 since 이후만 → WhatsApp 출처 배포 전 대화가 영영 안 들어왔다) since 는 더 이상 거르는 데 쓰지 않음.
    const phones = (await q(
      `SELECT m.phone, max(m.at) AS last_at FROM wa_messages m
         LEFT JOIN meta_threads t ON t.thread_id = 'wa:' || m.phone
        GROUP BY m.phone, t.last_at
       HAVING bool_or(m.direction = 'in')
          ${full ? '' : 'AND (t.last_at IS NULL OR date_trunc(\'milliseconds\', max(m.at)) > t.last_at)'}
        ORDER BY 2 DESC LIMIT ${MAX_THREADS}`)).rows;
    for (const ph of phones) {
      if (skip.has(ph.phone)) continue;
      const msgs = (await q(`SELECT direction, kind, body, at FROM wa_messages WHERE phone = $1 ORDER BY at DESC LIMIT ${MSG_KEEP}`, [ph.phone])).rows.reverse()
        .map((m) => ({ at: new Date(m.at).toISOString(), me: m.direction === 'out', text: String(m.body || '').trim() || WA_KIND[m.kind] || '' }));
      const who = (await q(`SELECT (SELECT name FROM wa_contacts WHERE phone = $1 AND deleted_at IS NULL LIMIT 1) AS cname,
                                   (SELECT profile_name FROM wa_inbound WHERE wa_from = $1) AS pname`, [ph.phone]).catch(() => ({ rows: [{}] }))).rows[0] || {};
      const inMsgs = msgs.filter((m) => !m.me && m.text);
      const customerText = inMsgs.map((m) => m.text).join('\n');
      const ex = extractLead(customerText);
      const local = String(ph.phone).replace(/\D/g, '').slice(-10);   // 52 · 521 어느 쪽이든 10자리
      ex.phone = [local].concat(ex.phone ? ex.phone.split(', ').filter((x) => x !== local) : []).join(', ');   // WhatsApp 번호 자체가 연락처
      const t = { platform: 'whatsapp', thread_id: 'wa:' + ph.phone, user_id: ph.phone, name: who.cname || who.pname || null, username: null,
        first_at: msgs.length ? msgs[0].at : null, last_at: new Date(ph.last_at).toISOString(), last_in_at: inMsgs.length ? inMsgs[inMsgs.length - 1].at : null,
        msg_count: msgs.length, in_count: inMsgs.length, messages: msgs, customer_text: customerText.slice(0, 8000), ex };
      if (await upsertThread(t, q)) bp.inserted++;
      bp.threads++;
    }
  } catch (e) { bp.error = String((e && e.message) || e).slice(0, 200); }
  return bp;
}

// ── 가져오기 ──
export const syncState = { running: false, started_at: null, progress: null, last: null };

export async function syncMetaLeads({ full = false, trigger = 'manual', userId = null, q = query, onProgress = null } = {}) {
  if (syncState.running) return { error: 'already_running' };
  syncState.running = true; syncState.started_at = new Date().toISOString(); syncState.progress = { threads: 0, inserted: 0, platform: null };
  let runId = null;
  try {
    runId = (await q(`INSERT INTO meta_sync_runs (trigger, full_scan, started_by) VALUES ($1,$2,$3) RETURNING id`, [trigger, !!full, userId])).rows[0].id;
  } catch (_) { /* 0270 전 */ }
  const out = { threads: 0, inserted: 0, by_platform: {}, errors: [] };
  try {
    // 언제까지 내려갈지: 전체 = 최근 N일 · 아니면 마지막 성공 실행 1시간 전까지
    let cutoff = new Date(Date.now() - DAYS() * 86400000);
    if (!full) {
      const last = (await q(`SELECT max(started_at) AS t FROM meta_sync_runs WHERE ok = true`).catch(() => ({ rows: [] }))).rows[0];
      if (last && last.t) cutoff = new Date(new Date(last.t).getTime() - 3600000);
    }
    // ① WhatsApp — ERP 안의 대화라 토큰 없이도 된다
    syncState.progress.platform = 'whatsapp';
    const wa = await syncWhatsAppThreads({ full, q });
    out.by_platform.whatsapp = wa; out.threads += wa.threads; out.inserted += wa.inserted;
    if (wa.error) out.errors.push(`whatsapp: ${wa.error}`);
    // ② Messenger · Instagram — Graph API
    const pg = await resolvePage();
    if (pg.error) throw new Error(pg.error === 'no_token' ? 'no_token' : 'page: ' + pg.error);
    const me = { id: metaPageId(), ig_id: pg.page.ig_id };
    for (const platform of ['messenger', 'instagram']) {
      syncState.progress.platform = platform;
      const bp = { threads: 0, inserted: 0, error: null };
      let url = `https://graph.facebook.com/${apiVer()}/${encodeURIComponent(metaPageId())}/conversations?platform=${platform}`
        + `&fields=id,updated_time,message_count,participants,messages.limit(${MSG_KEEP}){id,created_time,from,message}&limit=25&access_token=${encodeURIComponent(pg.token)}`;
      let stop = false;
      while (url && !stop && out.threads < MAX_THREADS) {
        const r = await graphGet(url);
        if (!r.ok) { bp.error = gErr(r); break; }
        if (platform === 'instagram' && !me.ig_id) {   // 페이지 정보에서 못 받았으면 대화 참여자로 추정
          me.ig_id = inferBusinessId(r.json.data || []);
          if (!me.ig_id && (r.json.data || []).length) { bp.error = 'Instagram 계정을 확인하지 못했습니다(대화가 1건뿐) — 다음 가져오기에 다시 시도'; break; }
        }
        for (const conv of (r.json.data || [])) {
          if (conv.updated_time && new Date(conv.updated_time) < cutoff) { stop = true; break; }
          const t = shapeThread(conv, platform, me);
          const ins = await upsertThread(t, q);
          bp.threads++; out.threads++; if (ins) { bp.inserted++; out.inserted++; }
          syncState.progress.threads = out.threads; syncState.progress.inserted = out.inserted;
        }
        if (onProgress) onProgress(out);
        url = (r.json.paging && r.json.paging.next) || null;
      }
      out.by_platform[platform] = bp;
      if (bp.error) out.errors.push(`${platform}: ${bp.error}`);
    }
    // Messenger 가 실패하면 실패로 본다(Instagram 만 실패는 부분 성공)
    const ok = !(out.by_platform.messenger && out.by_platform.messenger.error);
    if (runId) await q(`UPDATE meta_sync_runs SET finished_at = now(), ok = $2, threads = $3, inserted = $4, by_platform = $5::jsonb, error = $6 WHERE id = $1`,
      [runId, ok, out.threads, out.inserted, JSON.stringify(out.by_platform), out.errors.join(' / ') || null]);
    out.ok = ok;
  } catch (e) {
    out.ok = false; out.error = String((e && e.message) || e).slice(0, 300);
    if (runId) await q(`UPDATE meta_sync_runs SET finished_at = now(), ok = false, threads = $2, inserted = $3, by_platform = $5::jsonb, error = $4 WHERE id = $1`,
      [runId, out.threads, out.inserted, out.error, JSON.stringify(out.by_platform)]).catch(() => {});
  } finally {
    syncState.running = false; syncState.last = { ...out, finished_at: new Date().toISOString() };
    if (out.threads) kickAnalyze();   // 0271 · 바뀐 대화만 AI 분석(기다리지 않음)
  }
  return out;
}

// 규칙을 고친 뒤 저장된 대화에 다시 적용(Graph 호출 없음)
export async function reextractAll(q = query) {
  const rows = (await q(`SELECT id, customer_text FROM meta_threads`)).rows;
  for (const r of rows) {
    const ex = extractLead(r.customer_text || '');
    await q(`UPDATE meta_threads SET a_tipo=$2, a_tipo_btn=$3, a_state=$4, a_city=$5, a_phone=$6, a_email=$7, a_vehicles=$8, a_parts=$9, a_intent=$10 WHERE id=$1`,
      [r.id, ex.tipo, ex.tipo_btn, ex.state, ex.city, ex.phone, ex.email, ex.vehicles, ex.parts, ex.intent]);
  }
  return rows.length;
}

export function startMetaLeadsWorker(app) {
  if (globalThis.__refatrixMetaLeadsWorker) return;
  const tick = async () => {
    if (process.env.META_LEADS_AUTO === '0' || syncState.running) return;
    try {
      const done = (await query(`SELECT count(*)::int AS n FROM meta_sync_runs WHERE ok = true`)).rows[0].n;
      if (!done) return;   // 첫 가져오기는 사람이 화면에서 누른다(토큰 · 권한 확인 겸)
      await syncMetaLeads({ trigger: 'auto' });
    } catch (e) { app && app.log && app.log.warn({ err: String(e && e.message) }, '[meta-leads] auto sync failed'); }
  };
  globalThis.__refatrixMetaLeadsWorker = setInterval(() => { tick(); }, 30 * 60000);
}
