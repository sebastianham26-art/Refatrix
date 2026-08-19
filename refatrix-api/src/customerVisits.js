// 고객별 상담·방문 이력 조립 (순수 함수 — 고객 상세 화면 「🗣 상담·방문 이력」)
//
// 소스 두 가지를 한 줄기로 합친다.
//   · sales_visits          : 영업사원 현장 체크인(+AI 녹음요약·펜딩)  → source 'visit'
//   · customer_meetings     : 수기 미팅 기록(‘[현장방문]’ 자동생성분 제외) → source 'meeting'
// 카테고리 단어는 visitTags.js 가 텍스트에서 자동 추출한다(방문 목적 컬럼이 없으므로).

import { visitTags, tagChips, TAG_MAX } from './visitTags.js';

export const AI_MARK = '[AI요약]';

export function clip(s, n) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return '';
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// talk_note = (체크인 시 적은 사전계획) + '[AI요약]' + (AI가 덧붙인 요약)
export function splitPlanAi(talkNote) {
  const talk = String(talkNote || '');
  const i = talk.indexOf(AI_MARK);
  if (i < 0) return { plan: talk.trim() || null, ai: null };
  return { plan: talk.slice(0, i).trim() || null, ai: talk.slice(i + AI_MARK.length).trim() || null };
}

// DATE 컬럼은 pg 가 '로컬 자정 Date' 로 준다 → 로컬 구성요소로 YYYY-MM-DD (TZ 무관하게 안전)
export function d10(v) {
  if (!v) return null;
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

export function parseJsonish(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

// 펜딩 상태 → 한 단어(F/UP)
export function fupOf(pendings, mxToday) {
  const list = pendings || [];
  if (!list.length) return { fup: 'none', total: 0, done: 0, overdue: 0 };
  const done = list.filter((p) => p.done).length;
  const overdue = list.filter((p) => !p.done && p.due_date && d10(p.due_date) < String(mxToday)).length;
  const fup = done === list.length ? 'done' : (overdue ? 'overdue' : 'open');
  return { fup, total: list.length, done, overdue };
}

// ── 조립 ─────────────────────────────────────────────────────────────
// visits    : [{id, visit_date, visit_time, met_person, talk_note, insight_note, by_name}]
// meetings  : [{id, meeting_date, note, by_name, stage_before_name, stage_after_name}]
// pendings  : [{id, visit_id, content, due_date, done}]
// recordings: [{id, visit_id, status, summary_json}]
// mxToday   : 'YYYY-MM-DD'
export function assembleVisitHistory({ visits, meetings, pendings, recordings, mxToday, truncated }) {
  const pendBy = {};
  for (const p of (pendings || [])) {
    const k = Number(p.visit_id);
    (pendBy[k] ||= []).push({
      id: Number(p.id), content: p.content, due_date: d10(p.due_date), done: !!p.done,
      overdue: !!(!p.done && p.due_date && d10(p.due_date) < String(mxToday)),
    });
  }
  // 방문당 — 상태는 '가장 최신 녹음', 요약/rec_id 는 '요약이 있는 가장 최신 녹음'.
  //   (재녹음 중이면 status=transcribing 이 보이고, 번역 토글은 직전 요약을 가리킨다)
  //   recordings 는 id ASC 로 들어온다는 전제(라우트 ORDER BY id ASC).
  const recBy = {};
  for (const r of (recordings || [])) {
    const k = Number(r.visit_id);
    const cur = (recBy[k] ||= { id: null, status: null, summary: null });
    cur.status = r.status;                                   // 마지막(최신) 상태
    const summary = parseJsonish(r.summary_json);
    if (summary) { cur.id = Number(r.id); cur.summary = summary; }   // 최신 요약
  }

  const items = [];

  for (const v of (visits || [])) {
    const vid = Number(v.id);
    const rec = recBy[vid] || null;
    const summary = rec ? rec.summary : null;
    const pl = pendBy[vid] || [];
    const { plan, ai } = splitPlanAi(v.talk_note);
    const f = fupOf(pl, mxToday);
    const tags = visitTags({ talk_note: v.talk_note, insight_note: v.insight_note }, summary, pl);
    items.push({
      key: `v${vid}`, source: 'visit', id: vid,
      date: d10(v.visit_date), time: v.visit_time || null,
      by_name: v.by_name || null, met_person: v.met_person || null,
      tags, tag_chips: tagChips(tags.slice(0, TAG_MAX)), tag_more: Math.max(0, tags.length - TAG_MAX),
      headline: clip((summary && summary.resumen) || ai || plan || v.insight_note, 160) || null,
      plan, insight: (summary && summary.insights) || clip(v.insight_note, 1000) || null,
      summary, has_ai: !!summary,
      rec_id: rec ? rec.id : null, rec_status: rec ? rec.status : null,
      pend_total: f.total, pend_done: f.done, pend_overdue: f.overdue, fup: f.fup,
      pendings: pl,
      stage_move: null,
    });
  }

  for (const m of (meetings || [])) {
    const note = String(m.note || '');
    const tags = visitTags({ talk_note: note }, null, []);
    const move = (m.stage_after_name && m.stage_after_name !== m.stage_before_name)
      ? `${m.stage_before_name || '—'} → ${m.stage_after_name}` : null;
    items.push({
      key: `m${Number(m.id)}`, source: 'meeting', id: Number(m.id),
      date: d10(m.meeting_date), time: null,
      by_name: m.by_name || null, met_person: null,
      tags, tag_chips: tagChips(tags.slice(0, TAG_MAX)), tag_more: Math.max(0, tags.length - TAG_MAX),
      headline: clip(note, 160) || (move ? '단계 이동' : null),
      plan: note.trim() || null, insight: null,
      summary: null, has_ai: false, rec_id: null, rec_status: null,
      pend_total: 0, pend_done: 0, pend_overdue: 0, fup: 'none', pendings: [],
      stage_move: move,
    });
  }

  // 최신순 — 같은 날은 시각 늦은 순, 그 다음 방문(시각 있음) 먼저.
  //   그 밖의 동률은 tie-break 하지 않는다: SQL 이 이미 id DESC 로 내려주고
  //   Array.prototype.sort 는 stable 이므로 원래 순서(최신 id 먼저)가 유지된다.
  //   ('v9' vs 'v10' 같은 문자열 비교로 자르면 오래된 줄이 앞으로 온다)
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1
    : (b.time || '').localeCompare(a.time || '')));

  // 카테고리 요약(고객 전체 기간)
  const tagCount = {};
  for (const it of items) for (const t of it.tags) tagCount[t] = (tagCount[t] || 0) + 1;

  return {
    items,
    truncated: !!truncated,          // 상한(라우트 LIMIT)에 걸려 일부만 담김 → 화면에 안내
    total: items.length,
    visit_cnt: items.filter((i) => i.source === 'visit').length,
    meeting_cnt: items.filter((i) => i.source === 'meeting').length,
    first_date: items.length ? items[items.length - 1].date : null,
    last_date: items.length ? items[0].date : null,
    open_pendings: items.reduce((s, i) => s + (i.pend_total - i.pend_done), 0),
    tag_summary: tagChips(Object.keys(tagCount).sort((a, b) => tagCount[b] - tagCount[a]))
      .map((c) => ({ ...c, cnt: tagCount[c.key] })),
  };
}
