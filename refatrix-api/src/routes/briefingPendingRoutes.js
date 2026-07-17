// =====================================================================
// Refatrix ERP · briefingPendingRoutes.js
//   하루 브리핑 "미결 누적" — Layer 1(결정론). 디렉터 전용. 외부 전송 없음.
//   GET  /api/portal/pending           미결 목록(유형 그룹 + 경과일 + 심각도), 스누즈/무시 반영
//   POST /api/portal/pending/snooze    { item_key, days }  N일 숨김
//   POST /api/portal/pending/dismiss   { item_key }        영구 무시
//   POST /api/portal/pending/restore   { item_key }        스누즈/무시 해제
//   POST /api/portal/pending/auto-todo 지난 일정(미전환)을 할 일로 자동 등록(중복방지)
//   POST /api/portal/briefing-share    { share_socio } 브리핑·미결의 socio 공유 옵션(디렉터만)
//
//   열람: 디렉터(항상) + socio(공유 옵션 ON 시, 열람 전용).
//   조치(스누즈/무시/복원/자동todo/옵션변경)는 디렉터 전용.
//
//   미결 항목은 원천 상태로 라이브 판정 → 완료 시 자동 소멸. 이 라우트는 순수 집계 +
//   디렉터 조치(스누즈/무시/자동todo)만 상태 테이블(briefing_pending_state)에 기록.
// =====================================================================
import { query } from '../db.js';
import { authGuard } from '../middleware/authGuard.js';
import { mxTodayStr } from '../workingHours.js';
import { collectPending, pastEventsForTodo } from '../pendingItems.js';
import { briefingViewer, setShareSocio } from '../briefingShare.js';

const QUOTE_DELAY_DAYS = 3;   // 지연 견적 기준(디렉터 결정)
const PAST_EVENT_DAYS = 7;    // 자동 todo 후보로 볼 지난 일정 범위

const TYPE_META = {
  packing:     { icon: '📦', label: '포장 미완' },
  sat:         { icon: '🧾', label: 'SAT 미발행' },
  ar:          { icon: '💸', label: '미수금' },
  quote_delay: { icon: '📝', label: '지연 견적' },
  mkt:         { icon: '📣', label: '마케팅 미집행' },
  todo:        { icon: '✅', label: '할 일 미완' },
  directive:   { icon: '📌', label: '지시 미완' },
};
const TYPE_ORDER = ['ar', 'sat', 'packing', 'quote_delay', 'mkt', 'todo', 'directive'];

function shiftYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d)); t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

// 상태 테이블 → item_key 맵
async function loadState() {
  const rows = (await query(
    `SELECT item_key, to_char(snooze_until,'YYYY-MM-DD') AS snooze_until, dismissed_at, todo_id
       FROM briefing_pending_state`)).rows;
  const map = {};
  for (const r of rows) map[r.item_key] = r;
  return map;
}

export default async function briefingPendingRoutes(app) {
  // ── 미결 목록 (읽기 전용) ──
  app.get('/api/portal/pending', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const view = await briefingViewer(perm);
    if (!view.allowed) return { enabled: false, role: perm.role };
    const mxToday = mxTodayStr(new Date());

    const [items, state, pastEv] = await Promise.all([
      collectPending(mxToday, QUOTE_DELAY_DAYS),
      loadState(),
      pastEventsForTodo(mxToday, PAST_EVENT_DAYS),
    ]);

    // 스누즈/무시 반영
    const visible = [];
    for (const it of items) {
      const st = state[it.item_key];
      if (st) {
        if (st.dismissed_at) continue;                       // 영구 무시
        if (st.snooze_until && st.snooze_until >= mxToday) continue; // 스누즈 유효
      }
      visible.push(it);
    }

    // 자동 todo 후보 = 지난 일정 중 아직 todo로 안 만든 것(그리고 무시 안 한 것)
    const autoTodoCands = pastEv.filter((e) => {
      const st = state[e.item_key];
      return !(st && (st.todo_id || st.dismissed_at));
    });

    // 유형 그룹
    const byType = {};
    for (const it of visible) (byType[it.type] = byType[it.type] || []).push(it);
    const groups = TYPE_ORDER.filter((t) => byType[t] && byType[t].length).map((t) => {
      const list = byType[t].slice().sort((a, b) => b.age_days - a.age_days);
      return {
        type: t, icon: TYPE_META[t].icon, label: TYPE_META[t].label,
        count: list.length,
        amount: list.reduce((s, x) => s + (Number(x.amount) || 0), 0),
        items: list,
      };
    });

    const bySev = { info: 0, warn: 0, bad: 0 };
    for (const it of visible) bySev[it.severity] = (bySev[it.severity] || 0) + 1;

    return {
      enabled: true, mx_date: mxToday, total: visible.length,
      role: view.role, share_socio: view.share_socio, can_toggle: view.can_toggle, read_only: view.read_only,
      by_severity: bySev, groups,
      auto_todo_candidates: autoTodoCands.length,
      auto_todo_preview: autoTodoCands.slice(0, 5).map((e) => ({ ev_date: e.ev_date, content: e.content })),
    };
  });

  // ── 스누즈 (N일 숨김) ──
  app.post('/api/portal/pending/snooze', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    if (perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const key = String((req.body && req.body.item_key) || '').trim();
    const days = Math.max(1, Math.min(90, Number(req.body && req.body.days) || 3));
    if (!key) return reply.code(400).send({ error: 'item_key_required' });
    const until = shiftYmd(mxTodayStr(new Date()), days);
    await query(
      `INSERT INTO briefing_pending_state (item_key, snooze_until, acked_by, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (item_key) DO UPDATE SET snooze_until=EXCLUDED.snooze_until, dismissed_at=NULL, acked_by=EXCLUDED.acked_by, updated_at=now()`,
      [key, until, perm.userId]);
    return { ok: true, item_key: key, snooze_until: until };
  });

  // ── 영구 무시 ──
  app.post('/api/portal/pending/dismiss', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    if (perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const key = String((req.body && req.body.item_key) || '').trim();
    if (!key) return reply.code(400).send({ error: 'item_key_required' });
    await query(
      `INSERT INTO briefing_pending_state (item_key, dismissed_at, acked_by, updated_at)
       VALUES ($1,now(),$2,now())
       ON CONFLICT (item_key) DO UPDATE SET dismissed_at=now(), snooze_until=NULL, acked_by=EXCLUDED.acked_by, updated_at=now()`,
      [key, perm.userId]);
    return { ok: true, item_key: key };
  });

  // ── 스누즈/무시 해제 ──
  app.post('/api/portal/pending/restore', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    if (perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const key = String((req.body && req.body.item_key) || '').trim();
    if (!key) return reply.code(400).send({ error: 'item_key_required' });
    await query(
      `UPDATE briefing_pending_state SET snooze_until=NULL, dismissed_at=NULL, updated_at=now() WHERE item_key=$1`, [key]);
    return { ok: true, item_key: key };
  });

  // ── 지난 일정 → 할 일 자동 등록(중복방지) ──
  app.post('/api/portal/pending/auto-todo', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    if (perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const mxToday = mxTodayStr(new Date());
    const cands = await pastEventsForTodo(mxToday, PAST_EVENT_DAYS);
    const state = await loadState();

    let created = 0;
    const madeTodoIds = [];
    for (const e of cands) {
      const st = state[e.item_key];
      if (st && (st.todo_id || st.dismissed_at)) continue;  // 이미 등록됐거나 무시됨
      const title = `[일정 F/UP] ${String(e.content).slice(0, 120)}`;
      const detail = `${e.ev_date} 일정에서 자동 등록(미완 확인). 완료 시 체크하면 미결에서 사라집니다.`;
      const tr = (await query(
        `INSERT INTO todos (title, detail, assignee_id, due_date, kind, scope, level, created_by)
         VALUES ($1,$2,$3,$4,'briefing_auto','user','self',$3) RETURNING id`,
        [title, detail, perm.userId, mxToday])).rows[0];
      await query(
        `INSERT INTO briefing_pending_state (item_key, todo_id, acked_by, updated_at)
         VALUES ($1,$2,$3,now())
         ON CONFLICT (item_key) DO UPDATE SET todo_id=EXCLUDED.todo_id, acked_by=EXCLUDED.acked_by, updated_at=now()`,
        [e.item_key, Number(tr.id), perm.userId]);
      created++; madeTodoIds.push(Number(tr.id));
    }
    return { ok: true, created, todo_ids: madeTodoIds };
  });

  // ── 브리핑·미결 socio 공유 옵션(디렉터 전용) ──
  app.post('/api/portal/briefing-share', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    if (perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const v = !!(req.body && (req.body.share_socio === true || req.body.share_socio === 'true' || req.body.share_socio === 1));
    const saved = await setShareSocio(v, perm.userId);
    return { ok: true, share_socio: saved };
  });
}
