// =====================================================================
// Refatrix ERP · metaAssign.js — Meta 광고 문의 영업사원 배분 · 하루 목표 · 실적 (0329 · 2026-11-19)
//
//   2026-11-19 디렉터:
//     「ERP 에 들어오는 문의를 영업사원에게 배분해서 대화하게 하고, 하루 목표를 지정하고 싶다.
//      개인별로 할당받은 대화 상대와 대화하고, 고객별 메모를 남긴다. 지정받지 않은 수량은 자동으로 분배된다.
//      나는 개인별 · 팀 전체 대화 할당 수량 대비 실적을 본다. 대화할 사람은 내가 클릭으로 고른다.」
//
//   규칙
//   · 대상자 = 디렉터가 고른 사람(meta_assign_members.active) · 사람마다 하루 목표(daily_target)
//   · 자동 분배 = 오늘(멕시코시티) 맡은 건수가 목표보다 적은 사람에게, 아직 아무도 안 맡은 문의를 나눈다
//       문의 후보: 상태 「신규」 · 손님 메시지 있음 · 최근 pool_days 일 · 사내 번호 아님 · 담당 없음
//       순서: ① 손님 말이 마지막인 것(아직 답 안 함) ② 최근 것 — 남은 목표가 가장 많은 사람부터 한 건씩 번갈아
//       근무 시간(work_start ~ work_end 시) 안에서 5분마다 · 「지금 자동 분배」 버튼은 시간과 관계없이
//   · 대화함(실적) = 맡은 뒤 ① 사람의 답장(ERP · Business Suite · WhatsApp 답장)이 나감 ② 상태를 바꿈 ③ 「📞 전화함」
//       답장은 누가 보냈든 담당자 실적으로 센다(Business Suite 답장은 보낸 직원을 Meta 가 알려 주지 않음)
//   · 다른 사람에게 넘기면 앞 할당은 끝(ended_at) — 이미 대화함이면 그대로 앞 사람 실적
// =====================================================================
import { query, withTx } from './db.js';
import { markMetaKinds, portalHideInfo, isInternalPhone, mergeConversation, liveMessages } from './leadPortal.js';
import { isBotText } from './metaLeadsAi.js';

const MX_TODAY = `(now() AT TIME ZONE 'America/Mexico_City')::date`;
const LOCK_KEY = 329001;

let ready = null; let probeAt = 0;
export async function assignReady(q = query) {
  if (ready && Date.now() - probeAt < 60000) return ready;
  try { ready = !!(await q(`SELECT to_regclass('public.meta_assignments') AS t`)).rows[0].t; } catch (_) { ready = false; }
  probeAt = Date.now();
  return ready;
}
export function resetAssignReady() { ready = null; probeAt = 0; }

export async function getSettings(q = query) {
  // 0330 · mode(비율 · 목표) — 마이그레이션 전에도 돌게 to_jsonb 로 읽음
  const r = (await q(`SELECT auto, default_target, pool_days, work_start, work_end, updated_at, COALESCE(to_jsonb(s)->>'mode', 'target') AS mode FROM meta_assign_settings s WHERE id=1`)).rows[0];
  return r || { auto: true, default_target: 20, pool_days: 7, work_start: 8, work_end: 19, mode: 'target' };
}
export async function getMembers(q = query) {
  return (await q(
    `SELECT m.user_id, u.name, u.role, m.daily_target, m.active, COALESCE((to_jsonb(m)->>'share_pct')::numeric, 0)::float AS share_pct,
            (SELECT count(*)::int FROM meta_assignments a WHERE a.user_id = m.user_id AND a.day = ${MX_TODAY} AND NOT (a.ended_at IS NOT NULL AND a.done_at IS NULL)) AS today_assigned,
            (SELECT count(*)::int FROM meta_assignments a WHERE a.user_id = m.user_id AND a.day = ${MX_TODAY} AND a.done_at IS NOT NULL) AS today_done,
            (SELECT count(*)::int FROM meta_assignments a WHERE a.user_id = m.user_id AND a.done_at IS NULL AND a.ended_at IS NULL) AS open_n
       FROM meta_assign_members m JOIN users u ON u.id = m.user_id
      WHERE u.deleted_at IS NULL ORDER BY m.active DESC, u.name`)).rows
    .map((r) => ({ ...r, user_id: Number(r.user_id) }));
}

// 한 문의를 한 사람에게(userId=null 이면 배정 풀기)
export async function assignThread(threadId, userId, { by = null, how = 'manual' } = {}, q = query) {
  const t = (await q(`SELECT id, status, assigned_to FROM meta_threads WHERE id=$1`, [threadId])).rows[0];
  if (!t) return { ok: false, error: 'not_found' };
  if (userId != null && Number(t.assigned_to) === Number(userId)) return { ok: true, unchanged: true };
  await q(`UPDATE meta_assignments SET ended_at = now() WHERE thread_id=$1 AND ended_at IS NULL AND done_at IS NULL`, [threadId]);
  if (userId == null) {
    await q(`UPDATE meta_threads SET assigned_to = NULL, assigned_at = NULL WHERE id=$1`, [threadId]);
    return { ok: true, unassigned: true };
  }
  await q(`INSERT INTO meta_assignments (thread_id, user_id, day, how, assigned_by, status0) VALUES ($1,$2,${MX_TODAY},$3,$4,$5)`,
    [threadId, userId, how, by, t.status]);
  await q(`UPDATE meta_threads SET assigned_to=$2, assigned_at=now() WHERE id=$1`, [threadId, userId]);
  return { ok: true };
}

// 손님 말이 마지막인가(사람 답장 없음) — 자동 응답 · Meta 기록은 답장으로 안 침
export function awaitingReply(messages) {
  const ms = markMetaKinds((Array.isArray(messages) ? messages : []).map((m) => ({ ...m })));
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i];
    if (m.kind === 'event' || m.kind === 'auto') continue;
    return !m.me;
  }
  return false;
}

// 나눌 문의 후보(순서대로)
export async function poolCandidates(q = query, { limit = 2000 } = {}) {
  const s = await getSettings(q);
  const hi = await portalHideInfo();
  const rows = (await q(
    `SELECT t.id, t.platform, t.user_id, COALESCE(t.m_phone, t.ai_phone, t.a_phone) AS phone, t.messages,
            COALESCE(t.last_in_at, t.last_at) AS at
       FROM meta_threads t
      WHERE t.assigned_to IS NULL AND t.status = 'nuevo' AND COALESCE(t.in_count, 0) > 0
        AND COALESCE(t.last_in_at, t.last_at) > now() - ($1 || ' days')::interval
      ORDER BY COALESCE(t.last_in_at, t.last_at) DESC LIMIT ${Number(limit) || 2000}`, [String(s.pool_days)])).rows;
  return rows
    .filter((r) => !(r.platform === 'whatsapp' && (isInternalPhone(r.user_id, hi.phones) || isInternalPhone(r.phone, hi.phones))))
    .map((r) => ({ id: Number(r.id), at: r.at, waiting: awaitingReply(r.messages) }))
    .sort((a, b) => (Number(b.waiting) - Number(a.waiting)) || (new Date(b.at) - new Date(a.at)));
}

const inHours = (s, now = new Date()) => {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', hour: '2-digit', hour12: false }).format(now)) % 24;
  return h >= Number(s.work_start) && h < Number(s.work_end);
};

// 자동 분배 — 반환 {ok, assigned, by_user:{id:n}, skipped?}
export async function autoDistribute({ force = false, now = new Date() } = {}) {
  if (!(await assignReady())) return { ok: false, skipped: 'migration_required' };
  return withTx(async (c) => {
    const q = (sql, a) => c.query(sql, a);
    const lock = (await q(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [LOCK_KEY])).rows[0].ok;
    if (!lock) return { ok: false, skipped: 'busy' };
    const s = await getSettings(q);
    if (!force && !s.auto) return { ok: true, skipped: 'auto_off', assigned: 0 };
    if (!force && !inHours(s, now)) return { ok: true, skipped: 'off_hours', assigned: 0 };
    const mem = (await getMembers(q)).filter((m) => m.active);
    if (s.mode === 'share') return distributeShare(q, mem);
    const need = new Map(mem.map((m) => [m.user_id, Math.max(0, Number(m.daily_target) - Number(m.today_assigned))]));
    const total = [...need.values()].reduce((a, b) => a + b, 0);
    if (!total) return { ok: true, assigned: 0, by_user: {}, skipped: mem.length ? 'targets_full' : 'no_members' };
    const pool = await poolCandidates(q, { limit: Math.max(total * 3, 200) });
    const byUser = {}; let n = 0;
    for (const p of pool) {
      // 남은 목표가 가장 많은 사람(같으면 이름순 = 목록 순서)
      let best = null;
      for (const m of mem) { const v = need.get(m.user_id); if (v > 0 && (!best || v > need.get(best))) best = m.user_id; }
      if (!best) break;
      const r = await assignThread(p.id, best, { how: 'auto' }, q);
      if (!r.ok || r.unchanged) continue;
      need.set(best, need.get(best) - 1); byUser[best] = (byUser[best] || 0) + 1; n++;
    }
    return { ok: true, assigned: n, by_user: byUser, pool_left: Math.max(0, pool.length - n) };
  });
}

// 0330 · 비율(%) — 나눌 문의를 남김없이. 오늘(멕시코시티) 맡은 수까지 합쳐 비율이 맞게:
//   다음 한 건 = (내 비율 × (오늘 전체 + 1)) − 오늘 내 수 가 가장 큰 사람 · 비율 0 인 사람은 안 받음
export function pickByShare(mem, cnt, total) {
  const sum = mem.reduce((a, m) => a + Math.max(0, Number(m.share_pct) || 0), 0);
  if (sum <= 0) return null;
  let best = null; let bestGap = -Infinity;
  for (const m of mem) {
    const sh = Math.max(0, Number(m.share_pct) || 0) / sum; if (sh <= 0) continue;
    const gap = sh * (total + 1) - (cnt.get(m.user_id) || 0);
    if (gap > bestGap + 1e-9 || (Math.abs(gap - bestGap) <= 1e-9 && sh > (Number(best.share_pct) || 0) / sum)) { best = m; bestGap = gap; }
  }
  return best;
}
async function distributeShare(q, mem) {
  const live = mem.filter((m) => Number(m.share_pct) > 0);
  if (!live.length) return { ok: true, assigned: 0, by_user: {}, skipped: mem.length ? 'no_share' : 'no_members' };
  const cnt = new Map(live.map((m) => [m.user_id, Number(m.today_assigned) || 0]));
  let total = [...cnt.values()].reduce((a, b) => a + b, 0);
  const pool = await poolCandidates(q, { limit: 5000 });
  const byUser = {}; let n = 0;
  for (const p of pool) {
    const m = pickByShare(live, cnt, total); if (!m) break;
    const r = await assignThread(p.id, m.user_id, { how: 'auto' }, q);
    if (!r.ok || r.unchanged) continue;
    cnt.set(m.user_id, (cnt.get(m.user_id) || 0) + 1); total++; byUser[m.user_id] = (byUser[m.user_id] || 0) + 1; n++;
  }
  return { ok: true, assigned: n, by_user: byUser, pool_left: Math.max(0, pool.length - n), mode: 'share', skipped: n ? undefined : 'pool_empty' };
}

// 맡은 뒤 대화했는지 — 열린 할당을 훑어 done 표시. threadIds 를 주면 그 문의만
export async function refreshDone({ threadIds = null, q = query } = {}) {
  if (!(await assignReady(q))) return { checked: 0, done: 0 };
  const args = []; let cond = `a.done_at IS NULL AND a.ended_at IS NULL AND a.assigned_at > now() - interval '30 days'`;
  if (threadIds && threadIds.length) { args.push(threadIds.map(Number)); cond += ` AND a.thread_id = ANY($1::bigint[])`; }
  const open = (await q(
    `SELECT a.id, a.thread_id, a.assigned_at, a.status0, t.status, t.platform, t.thread_id AS tid, t.user_id, t.messages
       FROM meta_assignments a JOIN meta_threads t ON t.id = a.thread_id WHERE ${cond}`, args)).rows;
  let done = 0;
  for (const a of open) {
    const since = new Date(a.assigned_at).getTime();
    let how = null;
    if (a.status !== (a.status0 || 'nuevo')) how = 'status';
    if (!how) {
      // Messenger 는 웹훅으로 받은 메시지(Business Suite 답장 에코 · ERP 답장)까지 합쳐서 본다
      const live = a.platform === 'messenger' ? await liveMessages(a.user_id).catch(() => []) : [];
      const ms = a.platform === 'messenger' ? mergeConversation(a.messages, live) : markMetaKinds((Array.isArray(a.messages) ? a.messages : []).map((m) => ({ ...m })));
      if (ms.some((m) => m.me && m.kind !== 'auto' && m.kind !== 'event' && !isBotText(m.text) && new Date(m.at).getTime() > since)) how = 'reply';
    }
    if (!how && a.platform === 'whatsapp' && String(a.tid).startsWith('wa:')) {
      const r = (await q(`SELECT 1 FROM wa_messages WHERE phone=$1 AND direction='out' AND source='manual' AND ok IS NOT FALSE AND at > $2 LIMIT 1`, [a.user_id, a.assigned_at]).catch(() => ({ rows: [] }))).rows;
      if (r.length) how = 'reply';
    }
    if (how) { await q(`UPDATE meta_assignments SET done_at=now(), done_how=$2 WHERE id=$1 AND done_at IS NULL`, [a.id, how]); done++; }
  }
  return { checked: open.length, done };
}

// 「📞 전화함」 — 열린 할당을 대화함으로
export async function markCalled(threadId, q = query) {
  const r = (await q(`UPDATE meta_assignments SET done_at=now(), done_how='call' WHERE thread_id=$1 AND done_at IS NULL AND ended_at IS NULL RETURNING id`, [threadId])).rows;
  return { ok: r.length > 0 };
}

// 기간 실적 — 사람별 + 팀 전체. from/to = YYYY-MM-DD(멕시코시티 날짜, 맡은 날 기준)
export async function performance({ from, to, userId = null }, q = query) {
  const args = [from, to]; let uc = '';
  if (userId) { args.push(userId); uc = ` AND a.user_id = $3`; }
  const rows = (await q(
    `SELECT a.user_id, u.name,
            -- 할당 = 넘기거나 풀지 않은 것(넘기기 전에 대화했으면 그 사람 것) · 넘긴 것은 moved 로 따로
            count(*) FILTER (WHERE NOT (a.ended_at IS NOT NULL AND a.done_at IS NULL))::int AS assigned,
            count(*) FILTER (WHERE a.how='auto' AND NOT (a.ended_at IS NOT NULL AND a.done_at IS NULL))::int AS auto_n,
            count(*) FILTER (WHERE a.done_at IS NOT NULL)::int AS done,
            count(*) FILTER (WHERE a.done_how='reply')::int AS by_reply,
            count(*) FILTER (WHERE a.done_how='status')::int AS by_status,
            count(*) FILTER (WHERE a.done_how='call')::int AS by_call,
            count(*) FILTER (WHERE a.done_at IS NULL AND a.ended_at IS NULL)::int AS pending,
            count(*) FILTER (WHERE a.done_at IS NULL AND a.ended_at IS NOT NULL)::int AS moved,
            count(*) FILTER (WHERE NOT (a.ended_at IS NOT NULL AND a.done_at IS NULL) AND t.status IN ('contactado','derivado','venta'))::int AS contacted,
            count(*) FILTER (WHERE NOT (a.ended_at IS NOT NULL AND a.done_at IS NULL) AND t.status = 'derivado')::int AS derivado,
            count(*) FILTER (WHERE NOT (a.ended_at IS NOT NULL AND a.done_at IS NULL) AND t.status = 'venta')::int AS venta,
            count(DISTINCT a.day)::int AS days_worked,
            round(avg(EXTRACT(EPOCH FROM (a.done_at - a.assigned_at)) / 60) FILTER (WHERE a.done_at IS NOT NULL))::int AS avg_min
       FROM meta_assignments a JOIN users u ON u.id = a.user_id JOIN meta_threads t ON t.id = a.thread_id
      WHERE a.day BETWEEN $1::date AND $2::date${uc}
      GROUP BY a.user_id, u.name ORDER BY u.name`, args)).rows.map((r) => ({ ...r, user_id: Number(r.user_id) }));
  // 목표 = 하루 목표 × 기간 안의 날 수(오늘까지 · 주말 포함) — 지금 대상자 기준
  const days = Number((await q(`SELECT GREATEST(0, (LEAST($2::date, ${MX_TODAY}) - $1::date) + 1)::int AS n`, [from, to])).rows[0].n);
  const mem = await getMembers(q);
  const st = await getSettings(q);
  const byId = new Map(rows.map((r) => [r.user_id, r]));
  const zero = { assigned: 0, auto_n: 0, done: 0, by_reply: 0, by_status: 0, by_call: 0, pending: 0, moved: 0, contacted: 0, derivado: 0, venta: 0, days_worked: 0, avg_min: null };
  for (const m of mem) if (m.active && !byId.has(m.user_id) && (!userId || m.user_id === Number(userId))) byId.set(m.user_id, { ...zero, user_id: m.user_id, name: m.name });
  // 0330 · 비율 방식이면 목표 = 내 비율 × 기간 안의 팀 전체 할당
  const shareSum = mem.filter((m) => m.active).reduce((a, m) => a + (Number(m.share_pct) || 0), 0);
  const teamAssigned = [...byId.values()].reduce((a, r) => a + (Number(r.assigned) || 0), 0);
  const people = [...byId.values()].map((r) => {
    const m = mem.find((x) => x.user_id === r.user_id);
    const target = !(m && m.active) ? null
      : st.mode === 'share' ? (shareSum > 0 ? Math.round((Number(m.share_pct) / shareSum) * teamAssigned) : null)
        : Number(m.daily_target) * days;
    return { ...r, member: !!(m && m.active), daily_target: m ? Number(m.daily_target) : null, share_pct: m ? Number(m.share_pct) : null, target,
      rate: r.assigned ? Math.round((r.done / r.assigned) * 1000) / 10 : null,
      target_rate: target ? Math.round((r.done / target) * 1000) / 10 : null };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const sum = (k) => people.reduce((x, p) => x + (Number(p[k]) || 0), 0);
  const team = { assigned: sum('assigned'), done: sum('done'), pending: sum('pending'), moved: sum('moved'), by_reply: sum('by_reply'), by_status: sum('by_status'), by_call: sum('by_call'),
    contacted: sum('contacted'), derivado: sum('derivado'), venta: sum('venta'), target: people.some((p) => p.target != null) ? sum('target') : null };
  team.rate = team.assigned ? Math.round((team.done / team.assigned) * 1000) / 10 : null;
  team.target_rate = team.target ? Math.round((team.done / team.target) * 1000) / 10 : null;
  // 날짜별(팀)
  const daily = (await q(
    `SELECT to_char(a.day, 'YYYY-MM-DD') AS day, count(*) FILTER (WHERE NOT (a.ended_at IS NOT NULL AND a.done_at IS NULL))::int AS assigned, count(*) FILTER (WHERE a.done_at IS NOT NULL)::int AS done
       FROM meta_assignments a WHERE a.day BETWEEN $1::date AND $2::date${uc} GROUP BY a.day ORDER BY a.day`, args)).rows;
  return { from, to, days, people, team, daily, mode: st.mode };
}

// 5분마다 — 대화함 확인 + 자동 분배
export function startMetaAssignWorker(app) {
  if (globalThis.__refatrixMetaAssignWorker || process.env.META_ASSIGN_WORKER === '0') return;
  const tick = async () => {
    try {
      if (!(await assignReady())) return;
      await refreshDone();
      await autoDistribute();
    } catch (e) { app && app.log && app.log.warn({ err: String(e && e.message) }, '[meta-assign] tick failed'); }
  };
  globalThis.__refatrixMetaAssignWorker = setInterval(tick, 5 * 60000);
  const t0 = setTimeout(tick, 20000);
  if (globalThis.__refatrixMetaAssignWorker.unref) { globalThis.__refatrixMetaAssignWorker.unref(); t0.unref(); }
}
