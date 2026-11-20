// =====================================================================
// Refatrix ERP · metaReply.js — 「💬 답장 필요」 · 「● 새 메시지」 (0331 · 2026-11-19)
//   디렉터: 영업사원이 답하면 손님 답은 한참 뒤에 온다. 손님이 답을 남겨 우리 대답이 필요한 대화를
//          목록에서부터 표시 — WhatsApp 에서 안 본 대화에 표시가 있는 것처럼.
//
//   대화마다 저장(meta_threads.reply_*): 손님 마지막 메시지 · 우리 사람 답장 마지막 · 그 뒤 손님 메시지 수
//     · Messenger = Graph 로 가져온 대화 + 웹훅으로 바로 받은 메시지(meta_page_messages)를 합쳐서
//     · WhatsApp(ERP 번호) = 받은/보낸 메시지(wa_messages) — ERP 자동응답 · 동의 요청 · 정기 발송은 사람 답장 아님
//     · 광고 자동 응답 · Meta 기록 · 정해진 안내문(봇)은 사람 답장이 아님
//   갱신: 웹훅 · 답장 직후 바로(2초 모아서) + 1분마다 바뀐 대화
// =====================================================================
import { query } from './db.js';
import { markMetaKinds, mergeConversation, liveMessages } from './leadPortal.js';
import { isBotText } from './metaLeadsAi.js';

// 목록 SQL(t 별칭) — 답장 필요
export const NEED_SQL = `(t.reply_last_in IS NOT NULL AND t.reply_last_in > COALESCE(t.reply_last_out, '-infinity'::timestamptz)
  AND t.reply_last_in > now() - interval '30 days' AND t.status NOT IN ('venta','descartado'))`;
// 새 메시지(이 사람이 마지막으로 연 뒤 손님이 보냄) — $uid 자리에 사용자 id
export const unreadSql = (uidParam) => `(${NEED_SQL} AND NOT EXISTS (SELECT 1 FROM meta_lead_seen sn WHERE sn.thread_id = t.id AND sn.user_id = ${uidParam} AND sn.seen_at >= t.reply_last_in))`;

let ready = null; let probeAt = 0;
export async function replyReady(q = query) {
  if (ready !== null && Date.now() - probeAt < 60000) return ready;
  try { ready = (await q(`SELECT 1 FROM information_schema.columns WHERE table_name='meta_threads' AND column_name='reply_last_in'`)).rows.length > 0
    && (await q(`SELECT to_regclass('public.meta_lead_seen') AS t`)).rows[0].t != null; } catch (_) { ready = false; }
  probeAt = Date.now();
  return ready;
}
export function resetReplyReady() { ready = null; probeAt = 0; }

// 대화 → {last_in, last_out, pending_n}
export function replyStateOf(messages) {
  const ms = Array.isArray(messages) ? messages : [];
  let lastIn = null, lastOut = null;
  const human = (m) => m.me && m.kind !== 'auto' && m.kind !== 'event' && !m.bot && !isBotText(m.text);
  for (const m of ms) {
    if (!m || !m.at) continue;
    const t = new Date(m.at).getTime(); if (!Number.isFinite(t)) continue;
    if (!m.me && m.kind !== 'event') { if (lastIn == null || t > lastIn) lastIn = t; }
    else if (human(m)) { if (lastOut == null || t > lastOut) lastOut = t; }
  }
  const pending = ms.filter((m) => m && m.at && !m.me && m.kind !== 'event' && (lastOut == null || new Date(m.at).getTime() > lastOut)).length;
  return { last_in: lastIn != null ? new Date(lastIn).toISOString() : null, last_out: lastOut != null ? new Date(lastOut).toISOString() : null,
    pending_n: lastIn != null && (lastOut == null || lastIn > lastOut) ? pending : 0 };
}

async function messagesFor(t, q) {
  if (t.platform === 'messenger') return mergeConversation(t.messages, await liveMessages(t.user_id).catch(() => []));
  const ms = markMetaKinds((Array.isArray(t.messages) ? t.messages : []).map((m) => ({ ...m })));
  if (t.platform === 'whatsapp' && String(t.thread_id || '').startsWith('wa:')) {
    // ERP 자동응답 · 동의 요청 · 정기 발송 = 봇(사람 답장 아님)
    try {
      const bots = (await q(`SELECT at FROM wa_messages WHERE phone=$1 AND direction='out' AND source IN ('autoreply','consent','campaign','test') AND at > now() - interval '60 days'`, [t.user_id])).rows
        .map((r) => new Date(r.at).getTime());
      for (const m of ms) if (m.me && bots.some((b) => Math.abs(b - new Date(m.at).getTime()) < 1500)) m.bot = true;
    } catch (_) { /* 표 없음 */ }
  }
  return ms;
}

// 바뀐 대화의 표시를 다시 계산. ids 를 주면 그 문의만
export async function refreshReplyState({ ids = null, limit = 400, q = query } = {}) {
  if (!(await replyReady(q))) return { updated: 0 };
  const args = []; let cond;
  if (ids && ids.length) { args.push(ids.map(Number)); cond = `t.id = ANY($1::bigint[])`; }
  else cond = `t.last_at > now() - interval '60 days' AND (t.reply_calc_at IS NULL OR t.reply_calc_at < t.last_at
      OR (t.platform = 'messenger' AND EXISTS (SELECT 1 FROM meta_page_messages pm WHERE pm.psid = t.user_id AND pm.created_at > t.reply_calc_at)))`;
  const rows = (await q(`SELECT t.id, t.platform, t.thread_id, t.user_id, t.messages FROM meta_threads t WHERE ${cond} ORDER BY t.last_at DESC NULLS LAST LIMIT ${Number(limit) || 400}`, args)).rows;
  for (const t of rows) {
    const st = replyStateOf(await messagesFor(t, q));
    await q(`UPDATE meta_threads SET reply_last_in=$2, reply_last_out=$3, reply_pending_n=$4, reply_calc_at=now() WHERE id=$1`, [t.id, st.last_in, st.last_out, st.pending_n]);
  }
  return { updated: rows.length };
}

// 웹훅 · 답장 직후 — 2초 모아서 바로
const timers = new Map();
function debounce(key, fn) { clearTimeout(timers.get(key)); const h = setTimeout(() => { timers.delete(key); fn().catch(() => {}); }, Number(process.env.META_REPLY_DELAY_MS || 2000)); if (h.unref) h.unref(); timers.set(key, h); }
export function kickReplyForPsid(psid) {
  if (!psid) return;
  debounce('p:' + psid, async () => {
    const ids = (await query(`SELECT id FROM meta_threads WHERE platform IN ('messenger','instagram') AND user_id=$1`, [String(psid)])).rows.map((r) => Number(r.id));
    if (ids.length) await refreshReplyState({ ids });
  });
}
export function kickReplyForTid(threadId) {
  if (!threadId) return;
  debounce('t:' + threadId, async () => {
    const ids = (await query(`SELECT id FROM meta_threads WHERE thread_id=$1`, [String(threadId)])).rows.map((r) => Number(r.id));
    if (ids.length) await refreshReplyState({ ids });
  });
}
// 문의를 열면 「본 것」
export async function markSeen(threadId, userId) {
  if (!threadId || !userId || !(await replyReady())) return;
  await query(`INSERT INTO meta_lead_seen (thread_id, user_id, seen_at) VALUES ($1,$2,now())
               ON CONFLICT (thread_id, user_id) DO UPDATE SET seen_at = now()`, [threadId, userId]).catch(() => {});
}

export function startReplyWorker(app) {
  if (globalThis.__refatrixReplyWorker || process.env.META_REPLY_WORKER === '0') return;
  const tick = async () => { try { await refreshReplyState(); } catch (e) { app && app.log && app.log.warn({ err: String(e && e.message) }, '[meta-reply] tick failed'); } };
  globalThis.__refatrixReplyWorker = setInterval(tick, 60000);
  const t0 = setTimeout(tick, 15000);
  if (globalThis.__refatrixReplyWorker.unref) { globalThis.__refatrixReplyWorker.unref(); t0.unref(); }
}
