// =====================================================================
// Refatrix ERP · dailySummaryRoutes.js — 디렉터 전용 「오늘 요약」
//   선택한 날짜(다중)의 ERP 전체 기록을 모아 AI 로 하루 요약을 만들고,
//   일자별(날짜당 1건, 재생성=갱신)로 누적 보관한다. 원본 digest 병기 저장.
//
//   POST   /api/daily-summary/generate   {dates:[YYYY-MM-DD…]} 날짜별 수집→AI→저장 (디렉터)
//   GET    /api/daily-summary/list       보관함 목록(메타+헤드라인 수치) (디렉터)
//   GET    /api/daily-summary/:date      1건 전체(content_md + digest 원본) (디렉터)
//   PUT    /api/daily-summary/:date/memo 날짜별 자유 메모 저장 (디렉터)
//   DELETE /api/daily-summary/:date      삭제 (디렉터)
//
//   ── 안전·격리 원칙(wbrMbrRoutes 와 동일) ──
//   · 100% 읽기 전용 수집(다른 테이블에 영향 없음) + daily_summaries 만 기록.
//   · ANTHROPIC_API_KEY 필요(없으면 503 no_api_key). 끄려면 DAILY_SUMMARY_ENABLED=0.
//   · API 로는 압축 텍스트만 전송(사진·첨부·고객DB 원본 미전송).
//   · 날짜 경계는 MX 현지(UTC-6) 기준 — 브리핑·외상판정과 동일 규칙.
// =====================================================================
import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { MX_OFFSET_MIN } from '../workingHours.js';
import { buildDailyPrompt, digestStats, extractText, clip } from '../dayDigest.js';

const MODEL = process.env.DAILY_SUMMARY_MODEL || 'claude-sonnet-4-5-20250929';
const MAX_DATES = 7;               // 한 번에 생성할 최대 날짜 수(순차 처리)
const MAX_OUTPUT_TOKENS = 2500;
const API_TIMEOUT_MS = 120000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function aiEnabled() {
  if (process.env.DAILY_SUMMARY_ENABLED === '0') return false;
  return !!process.env.ANTHROPIC_API_KEY;
}

// ── 날짜 헬퍼 (MX 현지 하루 = UTC 로는 [D 00:00−offset, 다음날 00:00−offset)) ──
function shiftYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
function mxDayUtcRange(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const startMs = Date.UTC(y, m - 1, d) - MX_OFFSET_MIN * 60000;   // MX 00:00 → UTC
  return { from: new Date(startMs).toISOString(), to: new Date(startMs + 86400000).toISOString() };
}
function mxDateOf(iso) {
  if (!iso) return null;
  const t = new Date(iso);
  if (isNaN(t.getTime())) return null;
  return new Date(t.getTime() + MX_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}
function mxHmOf(iso) {
  if (!iso) return null;
  const t = new Date(iso);
  if (isNaN(t.getTime())) return null;
  const m = new Date(t.getTime() + MX_OFFSET_MIN * 60000);
  return String(m.getUTCHours()).padStart(2, '0') + ':' + String(m.getUTCMinutes()).padStart(2, '0');
}
function d10(v) { if (!v) return null; if (v instanceof Date) return v.toISOString().slice(0, 10); return String(v).slice(0, 10); }
function n(v) { return Number(v) || 0; }
function idList(rows, key) {
  return [...new Set(rows.map((r) => Number(r[key])).filter(Number.isInteger))];
}

// ─────────────────────────────────────────────────────────────────────
// 하루치 ERP 기록 수집 — 섹션별 독립 방어(하나가 실패해도 나머지는 수집)
// ─────────────────────────────────────────────────────────────────────
export async function collectDayDigest(dateStr) {
  const { from, to } = mxDayUtcRange(dateStr);
  const dg = { date: dateStr, errors: [] };
  async function safe(key, fn) {
    try { return await fn(); }
    catch (e) { dg.errors.push(key); return null; }
  }

  // ① 일정 — 전 직원·전 scope(개인 포함). 타임드는 event_at 의 MX 날짜로 판정(±1일 조회 후 필터).
  dg.schedule = (await safe('schedule', async () => {
    const rows = (await query(
      `SELECT e.id, e.event_date, e.event_time, e.event_at, e.content, e.scope,
              ow.name AS owner_name, cb.name AS created_by_name, st.name AS team_name
         FROM calendar_events e
         LEFT JOIN users ow ON ow.id = e.owner_id
         LEFT JOIN users cb ON cb.id = e.created_by
         LEFT JOIN sales_teams st ON st.id = e.team_id
        WHERE e.deleted_at IS NULL
          AND e.event_date >= $1 AND e.event_date <= $2
        ORDER BY e.id`, [shiftYmd(dateStr, -1), shiftYmd(dateStr, 1)])).rows;
    const items = [];
    for (const r of rows) {
      const iso = r.event_at ? new Date(r.event_at).toISOString() : null;
      const dkey = iso ? mxDateOf(iso) : d10(r.event_date);
      if (dkey !== dateStr) continue;
      items.push({
        id: Number(r.id),
        time: iso ? mxHmOf(iso) : (r.event_time ? String(r.event_time).slice(0, 5) : null),
        content: clip(r.content, 300), scope: r.scope || 'personal',
        team: r.team_name || null,
        owner: r.owner_name || null, created_by: r.created_by_name || null,
        targets: [], memo_count: 0,
      });
    }
    const ids = idList(items, 'id');
    if (ids.length) {
      const inIds = ids.join(',');
      try {
        const trows = (await query(
          `SELECT ct.event_id, u.name FROM calendar_event_targets ct
             JOIN users u ON u.id = ct.user_id WHERE ct.event_id IN (${inIds})`)).rows;
        for (const t of trows) {
          const it = items.find((x) => x.id === Number(t.event_id));
          if (it && t.name) it.targets.push(t.name);
        }
      } catch (_) { /* 0094 미적용 시 무시 */ }
      try {
        const mrows = (await query(
          `SELECT event_id, COUNT(*) AS cnt FROM calendar_event_memos
            WHERE deleted_at IS NULL AND event_id IN (${inIds}) GROUP BY event_id`)).rows;
        for (const m of mrows) {
          const it = items.find((x) => x.id === Number(m.event_id));
          if (it) it.memo_count = n(m.cnt);
        }
      } catch (_) { /* 0109 미적용 시 무시 */ }
    }
    items.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
    return items;
  })) || [];

  // ①-b 이날 작성된 일정 메모(댓글)
  dg.calendar_memos = (await safe('calendar_memos', async () => {
    const rows = (await query(
      `SELECT m.body, m.created_at, u.name AS author, e.content AS event_content
         FROM calendar_event_memos m
         JOIN calendar_events e ON e.id = m.event_id
         LEFT JOIN users u ON u.id = m.author_id
        WHERE m.deleted_at IS NULL AND m.created_at >= $1 AND m.created_at < $2
        ORDER BY m.created_at`, [from, to])).rows;
    return rows.map((r) => ({
      author: r.author || null, body: clip(r.body, 400),
      event_content: clip(r.event_content, 120), time: mxHmOf(r.created_at),
    }));
  })) || [];

  // ② 할일 — 신규(이날 등록)·이날 마감·이날 완료 + 이날 릴레이 메모
  dg.todos = (await safe('todos', async () => {
    async function withAssignees(rows) {
      const list = rows.map((r) => ({
        id: Number(r.id), title: clip(r.title, 200), detail: clip(r.detail, 300),
        level: r.level || null, scope: r.scope || null,
        due_date: d10(r.due_date), status: r.status || null,
        done_note: clip(r.done_note, 300) || null,
        created_by: r.created_by_name || null,
        assignees: r.assignee_name ? [r.assignee_name] : [],
      }));
      const ids = idList(list, 'id');
      if (ids.length) {
        try {
          const arows = (await query(
            `SELECT ta.todo_id, u.name FROM todo_assignees ta
               JOIN users u ON u.id = ta.user_id WHERE ta.todo_id IN (${ids.join(',')})`)).rows;
          for (const a of arows) {
            const it = list.find((x) => x.id === Number(a.todo_id));
            if (it && a.name && !it.assignees.includes(a.name)) it.assignees.push(a.name);
          }
        } catch (_) { /* 0129 미적용 시 대표 담당자만 */ }
      }
      return list;
    }
    const base = `SELECT t.id, t.title, t.detail, t.level, t.scope, t.due_date, t.status, t.done_note,
                         cb.name AS created_by_name, au.name AS assignee_name
                    FROM todos t
                    LEFT JOIN users cb ON cb.id = t.created_by
                    LEFT JOIN users au ON au.id = t.assignee_id
                   WHERE t.deleted_at IS NULL
                     AND COALESCE(t.kind,'') NOT IN ('dev_review','dev_complete')`;
    const created = await withAssignees((await query(
      `${base} AND t.created_at >= $1 AND t.created_at < $2 ORDER BY t.id`, [from, to])).rows);
    const due = await withAssignees((await query(
      `${base} AND t.due_date = $1 ORDER BY t.id`, [dateStr])).rows);
    const done = await withAssignees((await query(
      `${base} AND t.done_at >= $1 AND t.done_at < $2 ORDER BY t.id`, [from, to])).rows);
    let memos = [];
    try {
      memos = (await query(
        `SELECT m.body, u.name AS author, t.title AS todo_title
           FROM todo_memos m
           JOIN todos t ON t.id = m.todo_id
           LEFT JOIN users u ON u.id = m.author_id
          WHERE m.deleted_at IS NULL AND m.created_at >= $1 AND m.created_at < $2
          ORDER BY m.created_at`, [from, to])).rows
        .map((r) => ({ author: r.author || null, body: clip(r.body, 300), todo_title: clip(r.todo_title, 120) }));
    } catch (_) { /* 0050 미적용 시 무시 */ }
    return { created, due, done, memos };
  })) || { created: [], due: [], done: [], memos: [] };

  // ③ 공지(이날 작성)
  dg.notices = (await safe('notices', async () => {
    const rows = (await query(
      `SELECT nt.title, nt.pinned, u.name AS author
         FROM notices nt LEFT JOIN users u ON u.id = nt.created_by
        WHERE nt.deleted_at IS NULL AND nt.created_at >= $1 AND nt.created_at < $2
        ORDER BY nt.id`, [from, to])).rows;
    return rows.map((r) => ({ title: clip(r.title, 200), pinned: !!r.pinned, author: r.author || null }));
  })) || [];

  // ④ 견적(quote_date = 이날, 가격표 제외)
  dg.quotes = (await safe('quotes', async () => {
    const rows = (await query(
      `SELECT q.total_mxn, q.sku_count, q.total_qty, q.status, q.guest_name,
              c.name AS customer_name, u.name AS by_name
         FROM quotes q
         LEFT JOIN customers c ON c.id = q.customer_id
         LEFT JOIN users u ON u.id = q.created_by
        WHERE q.deleted_at IS NULL AND q.status <> 'pricelist' AND q.quote_date = $1
        ORDER BY q.id`, [dateStr])).rows;
    let sku = 0, tqty = 0, amt = 0;
    const items = rows.map((r) => {
      sku += n(r.sku_count); tqty += n(r.total_qty); amt += n(r.total_mxn);
      return {
        customer: r.customer_name || r.guest_name || '불특정 고객',
        total_mxn: Math.round(n(r.total_mxn)), sku_count: n(r.sku_count),
        status: r.status || null, by: r.by_name || null,
      };
    });
    return { count: rows.length, total_mxn: Math.round(amt), sku_count: sku, total_qty: tqty, items: items.slice(0, 30) };
  })) || { count: 0, total_mxn: 0, sku_count: 0, total_qty: 0, items: [] };

  // ⑤ 영업활동(미팅·방문 기록)
  dg.meetings = (await safe('meetings', async () => {
    const rows = (await query(
      `SELECT m.note, c.name AS customer_name, u.name AS by_name,
              sb.name AS stage_before_name, sa.name AS stage_after_name,
              m.stage_before, m.stage_after
         FROM customer_meetings m
         LEFT JOIN customers c ON c.id = m.customer_id
         LEFT JOIN users u ON u.id = m.created_by
         LEFT JOIN stages sb ON sb.id = m.stage_before
         LEFT JOIN stages sa ON sa.id = m.stage_after
        WHERE m.meeting_date = $1
        ORDER BY m.id`, [dateStr])).rows;
    const items = rows.map((r) => ({
      customer: r.customer_name || '—', by: r.by_name || null,
      note: clip(r.note, 300) || null,
      stage_move: (r.stage_after != null && String(r.stage_before) !== String(r.stage_after))
        ? `${r.stage_before_name || '?'}→${r.stage_after_name || '?'}` : null,
    }));
    return { count: rows.length, items: items.slice(0, 30) };
  })) || { count: 0, items: [] };

  // ⑥ 매출 인보이스(inv_date = 이날)
  dg.invoices = (await safe('invoices', async () => {
    const rows = (await query(
      `SELECT si.sat_no, si.total_mxn, c.name AS customer_name, u.name AS owner_name
         FROM sales_invoices si
         LEFT JOIN customers c ON c.id = si.customer_id
         LEFT JOIN users u ON u.id = si.owner_id
        WHERE si.deleted_at IS NULL AND si.status <> 'deleted' AND si.inv_date = $1
        ORDER BY si.id`, [dateStr])).rows;
    let amt = 0;
    const items = rows.map((r) => {
      amt += n(r.total_mxn);
      return { sat_no: r.sat_no || null, customer: r.customer_name || '—', total_mxn: Math.round(n(r.total_mxn)), owner: r.owner_name || null };
    });
    return { count: rows.length, total_mxn: Math.round(amt), items: items.slice(0, 25) };
  })) || { count: 0, total_mxn: 0, items: [] };

  // ⑦ 입출금(확정 거래, txn_date = 이날)
  dg.transactions = (await safe('transactions', async () => {
    const rows = (await query(
      `SELECT t.direction, t.amount_mxn, t.approved, t.memo, t.category_code, cat.name AS category_name
         FROM transactions t
         LEFT JOIN categories cat ON cat.code = t.category_code
        WHERE t.deleted_at IS NULL AND t.status = 'actual' AND t.txn_date = $1
        ORDER BY t.amount_mxn DESC`, [dateStr])).rows;
    let inAmt = 0, outAmt = 0, inCnt = 0, outCnt = 0;
    for (const r of rows) {
      if (r.direction === 'in') { inAmt += n(r.amount_mxn); inCnt++; }
      else { outAmt += n(r.amount_mxn); outCnt++; }
    }
    const items = rows.slice(0, 20).map((r) => ({
      direction: r.direction, amount_mxn: Math.round(n(r.amount_mxn)),
      category: r.category_name || r.category_code || null,
      memo: clip(r.memo, 120) || null, approved: !!r.approved,
    }));
    return { in_mxn: Math.round(inAmt), out_mxn: Math.round(outAmt), in_count: inCnt, out_count: outCnt, items };
  })) || { in_mxn: 0, out_mxn: 0, in_count: 0, out_count: 0, items: [] };

  // ⑧ 신규 고객(이날 등록)
  dg.new_customers = (await safe('new_customers', async () => {
    const rows = (await query(
      `SELECT c.code, c.name, ow.name AS owner_name, cb.name AS by_name
         FROM customers c
         LEFT JOIN users ow ON ow.id = c.owner_id
         LEFT JOIN users cb ON cb.id = c.created_by
        WHERE c.deleted_at IS NULL AND c.created_at >= $1 AND c.created_at < $2
        ORDER BY c.id`, [from, to])).rows;
    return rows.map((r) => ({ code: r.code || null, name: clip(r.name, 100), owner: r.owner_name || null, by: r.by_name || null }));
  })) || [];

  // ⑨ 마케팅(이날 행사 + 이날 집행 예정 라인, 승인 계획)
  dg.marketing = (await safe('marketing', async () => {
    const KIND = { adv: '선지급금', mid: '중도금', fin: '잔금', one: '일시불' };
    let events = [], lines = [];
    try {
      events = (await query(
        `SELECT title, category FROM marketing_spend_plans
          WHERE status='approved' AND deleted_at IS NULL AND event_date = $1
          ORDER BY id`, [dateStr])).rows
        .map((r) => ({ title: clip(r.title, 120), category: r.category || null }));
      lines = (await query(
        `SELECT l.kind, l.amount, p.title AS plan_title, i.name AS item_name
           FROM marketing_spend_lines l
           JOIN marketing_spend_plans p ON p.id = l.plan_id
           LEFT JOIN marketing_spend_items i ON i.id = l.item_id
          WHERE p.status='approved' AND p.deleted_at IS NULL AND l.due_date = $1
          ORDER BY l.id`, [dateStr])).rows
        .map((r) => ({ plan: clip(r.plan_title, 100), item: clip(r.item_name, 60) || '기본 집행', kind_label: KIND[r.kind] || '일시불', amount: Math.round(n(r.amount)) }));
    } catch (_) { /* 0115/0116 미적용 시 무시 */ }
    return { events, lines };
  })) || { events: [], lines: [] };

  // ⑩ 시스템 활동(감사로그) — 직원별·액션별 집계(page_view 제외)
  dg.activity = (await safe('activity', async () => {
    const rows = (await query(
      `SELECT a.user_id, u.name, u.dept, a.action, COUNT(*) AS cnt
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE a.occurred_at >= $1 AND a.occurred_at < $2 AND a.action <> 'page_view'
        GROUP BY a.user_id, u.name, u.dept, a.action
        ORDER BY a.user_id`, [from, to])).rows;
    const byUser = {};
    let total = 0;
    for (const r of rows) {
      const key = String(r.user_id || '0');
      const u = byUser[key] || (byUser[key] = { name: r.name || '(시스템)', dept: r.dept || null, total: 0, by_action: {} });
      const c = n(r.cnt);
      u.total += c; total += c;
      u.by_action[r.action] = (u.by_action[r.action] || 0) + c;
    }
    const users = Object.values(byUser).sort((a, b) => b.total - a.total).slice(0, 30);
    return { total, users };
  })) || { total: 0, users: [] };

  return dg;
}

// ── Anthropic 호출(wbrMbrRoutes 와 동일 패턴) ──
async function callAnthropic(prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    });
    const data = await resp.json();
    if (!resp.ok) {
      const msg = (data && data.error && data.error.message) || ('http_' + resp.status);
      return { ok: false, error: msg };
    }
    return { ok: true, text: extractText(data) };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally { clearTimeout(timer); }
}

// 날짜당 1건 유지: UPDATE 먼저, 없으면 INSERT (pg-mem 호환 위해 ON CONFLICT 미사용)
async function upsertSummary(dateStr, content, digest, uid) {
  const dj = JSON.stringify(digest);
  const upd = (await query(
    `UPDATE daily_summaries
        SET content_md=$2, digest=$3, model=$4, created_by=$5, updated_at=now()
      WHERE summary_date=$1
      RETURNING id, created_at, updated_at`, [dateStr, content, dj, MODEL, uid])).rows[0];
  if (upd) return { id: Number(upd.id), regenerated: true, updated_at: upd.updated_at };
  const ins = (await query(
    `INSERT INTO daily_summaries (summary_date, content_md, digest, model, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at, updated_at`,
    [dateStr, content, dj, MODEL, uid])).rows[0];
  return { id: Number(ins.id), regenerated: false, updated_at: ins.updated_at };
}

export default async function dailySummaryRoutes(app) {
  // ── 생성(다중 날짜, 순차) — 디렉터 전용 ──
  app.post('/api/daily-summary/generate', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    if (!aiEnabled()) {
      return reply.code(503).send({ error: 'no_api_key', note: 'Railway 환경변수 ANTHROPIC_API_KEY 를 설정해야 AI 요약을 사용할 수 있습니다.' });
    }
    const b = req.body || {};
    const dates = Array.isArray(b.dates)
      ? [...new Set(b.dates.map((s) => String(s || '').trim()).filter((s) => DATE_RE.test(s)))].sort()
      : [];
    if (!dates.length) return reply.code(400).send({ error: 'no_dates' });
    if (dates.length > MAX_DATES) return reply.code(400).send({ error: 'too_many_dates', max: MAX_DATES });

    const uid = req.ctx.perm.userId;
    const results = [];
    for (const d of dates) {              // 순차 — API rate limit·DB 부하 방지
      try {
        const digest = await collectDayDigest(d);
        const ai = await callAnthropic(buildDailyPrompt(d, digest));
        if (!ai.ok) { results.push({ date: d, ok: false, error: 'ai_failed', detail: ai.error }); continue; }
        const content = (ai.text || '').trim();
        if (!content) { results.push({ date: d, ok: false, error: 'ai_empty' }); continue; }
        const saved = await upsertSummary(d, content, digest, uid);
        logEvent({ userId: uid, deviceId: req.ctx.deviceId, action: 'create', target: `daily_summary:${d}`, detail: { regenerated: saved.regenerated } });
        results.push({ date: d, ok: true, id: saved.id, regenerated: saved.regenerated, stats: digestStats(digest) });
      } catch (e) {
        req.log.error({ err: e, date: d }, 'daily summary generate failed');
        results.push({ date: d, ok: false, error: 'generate_failed' });
      }
    }
    return { model: MODEL, results };
  });

  // ── 보관함 목록 — 디렉터 전용. ?limit=N(기본 180) ──
  app.get('/api/daily-summary/list', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 180, 1), 400);
    const rows = (await query(
      `SELECT s.id, s.summary_date, s.digest, s.model, s.memo, s.created_at, s.updated_at, u.name AS created_by_name
         FROM daily_summaries s
         LEFT JOIN users u ON u.id = s.created_by
        ORDER BY s.summary_date DESC
        LIMIT ${limit}`)).rows;
    return {
      ai_enabled: aiEnabled(),
      items: rows.map((r) => ({
        id: Number(r.id), summary_date: d10(r.summary_date), model: r.model,
        has_memo: !!(r.memo && String(r.memo).trim()),
        created_by_name: r.created_by_name || null,
        created_at: r.created_at, updated_at: r.updated_at,
        stats: digestStats(typeof r.digest === 'string' ? safeParse(r.digest) : r.digest),
      })),
    };
  });

  // ── 1건 전체(요약 + 원본 digest) — 디렉터 전용 ──
  app.get('/api/daily-summary/:date', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const d = String(req.params.date || '');
    if (!DATE_RE.test(d)) return reply.code(400).send({ error: 'bad_date' });
    const r = (await query(
      `SELECT s.id, s.summary_date, s.content_md, s.digest, s.model, s.memo, s.created_at, s.updated_at, u.name AS created_by_name
         FROM daily_summaries s LEFT JOIN users u ON u.id = s.created_by
        WHERE s.summary_date=$1`, [d])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return {
      id: Number(r.id), summary_date: d10(r.summary_date),
      content_md: r.content_md, model: r.model, memo: r.memo || '',
      digest: typeof r.digest === 'string' ? safeParse(r.digest) : (r.digest || {}),
      created_by_name: r.created_by_name || null,
      created_at: r.created_at, updated_at: r.updated_at,
    };
  });

  // ── 날짜별 자유 메모 — 디렉터 전용 ──
  app.put('/api/daily-summary/:date/memo', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const d = String(req.params.date || '');
    if (!DATE_RE.test(d)) return reply.code(400).send({ error: 'bad_date' });
    const b = req.body || {};
    let memo = b.memo;
    if (memo != null && typeof memo !== 'string') return reply.code(400).send({ error: 'bad_memo' });
    if (memo != null && memo.length > 20000) return reply.code(413).send({ error: 'memo_too_large' });
    const r = (await query(
      `UPDATE daily_summaries SET memo=$2, updated_at=now() WHERE summary_date=$1 RETURNING id`,
      [d, (memo && memo.trim()) ? memo : null])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return { ok: true, id: Number(r.id) };
  });

  // ── 삭제 — 디렉터 전용 ──
  app.delete('/api/daily-summary/:date', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const d = String(req.params.date || '');
    if (!DATE_RE.test(d)) return reply.code(400).send({ error: 'bad_date' });
    const r = (await query(`DELETE FROM daily_summaries WHERE summary_date=$1 RETURNING id`, [d])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    logEvent({ userId: req.ctx.perm.userId, deviceId: req.ctx.deviceId, action: 'delete', target: `daily_summary:${d}` });
    return { ok: true, id: Number(r.id) };
  });
}

function safeParse(s) { try { return JSON.parse(s); } catch (_) { return {}; } }
