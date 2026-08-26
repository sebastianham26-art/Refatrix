// =====================================================================
// Refatrix ERP · exhibitionAi.js — 「영업 > 고객상담 > 🎪 전시회」 순수 함수 모음
//   · 시간표 축 계산 (1st/2nd/3rd day × 08:00~18:00 1시간 슬롯)
//   · 미팅 담당자별 색상 배정(자동 · 범례와 셀이 항상 같은 색을 쓰도록 서버에서 계산)
//   · 목표/달성 금액 집계 (견적수주 · 수주확정)
//   · 정성목표 달성 판단 프롬프트/파서 (녹음 AI 요약을 근거로)
//   네트워크 호출 없음 — exhibitionRoutes.js 가 사용. 전부 단위 테스트 가능.
//
//   ※ 고객상담(consultAi.js) · 방문(visitAi.js) 계열은 건드리지 않는다.
// =====================================================================

export function clip(s, n) {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// 금액 정규화 — node-pg 는 NUMERIC 을 문자열로 돌려준다. 항상 숫자로 바꾼다.
export function num(v, dflt = 0) {
  if (v == null || v === '') return dflt;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : dflt;
}

// ── ① 시간표 축 ─────────────────────────────────────────────────────
export function ordinalDay(n) {
  const i = Number(n);
  if (!Number.isInteger(i) || i < 1) return '';
  const v = i % 100;
  const s = (v >= 11 && v <= 13) ? 'th' : (['th', 'st', 'nd', 'rd'][i % 10] || 'th');
  return i + s + ' day';
}

export function shiftYmd(ymd, days) {
  const p = String(ymd).split('-').map(Number);
  const t = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  t.setUTCDate(t.getUTCDate() + Number(days || 0));
  return t.toISOString().slice(0, 10);
}

const WD_KO = ['일', '월', '화', '수', '목', '금', '토'];
export function weekdayKo(ymd) {
  const p = String(ymd).split('-').map(Number);
  if (p.length !== 3 || !Number.isInteger(p[0])) return '';
  return WD_KO[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()] || '';
}

// 가로축 — [{day_no, date, label:'1st day', weekday:'수'}]
export function dayAxis(startDate, dayCount) {
  const n = Math.min(Math.max(Number(dayCount) || 1, 1), 10);
  const out = [];
  for (let i = 0; i < n; i++) {
    const date = shiftYmd(startDate, i);
    out.push({ day_no: i + 1, date, label: ordinalDay(i + 1), weekday: weekdayKo(date) });
  }
  return out;
}

// 세로축 — [{hour:8, label:'08:00', range:'08:00–09:00'}]  (end_hour 는 종료시각이라 칸에 포함하지 않는다)
export function hourAxis(startHour, endHour) {
  const s = Math.min(Math.max(Number(startHour) === 0 ? 0 : (Number(startHour) || 8), 0), 23);
  const e = Math.min(Math.max(Number(endHour) || 18, s + 1), 24);
  const hh = (h) => String(h).padStart(2, '0') + ':00';
  const out = [];
  for (let h = s; h < e; h++) out.push({ hour: h, label: hh(h), range: hh(h) + '–' + hh(h + 1) });
  return out;
}

// ── ② 담당자 색상(자동 배정) ────────────────────────────────────────
//   [배경, 글자, 테두리] — 밝은 배경 + 진한 글자라 셀에 글자가 얹혀도 읽힌다.
export const OWNER_PALETTE = [
  ['#E3ECFB', '#1F3F8F', '#B9CDF0'],   // blue
  ['#DFF1EA', '#0F6E56', '#B4DCCC'],   // green
  ['#FBEEDA', '#8A6512', '#EBD5A6'],   // amber
  ['#F9DEDE', '#9A1F1F', '#EEBDBD'],   // red
  ['#EFE4FB', '#5B21B6', '#D6C2F0'],   // purple
  ['#DDEFF5', '#0E6E85', '#B4DAE6'],   // teal
  ['#FAE5D8', '#A6501C', '#EDC7B0'],   // orange
  ['#E9F2D9', '#4B7A16', '#CFE1B0'],   // olive
  ['#FBE1EE', '#A61E63', '#F0BFD7'],   // pink
  ['#E7EBEE', '#41525C', '#C9D2D8'],   // slate
];
export const OWNER_UNSET = ['#F2F0EA', '#6B6B6B', '#DED9CE'];  // 담당자 미지정
// 부스 직접 방문 — 담당자와 무관하게 공통 회색(약속 미팅과 한눈에 구분되도록)
export const BOOTH_COLOR = ['#EDEBE4', '#5B5B57', '#D8D3C6'];
export const MEETING_KINDS = ['meeting', 'booth'];
export function normKind(v) { return String(v) === 'booth' ? 'booth' : 'meeting'; }

// 사용자 id 로 결정적 배정(같은 사람 = 항상 같은 색). 충돌하면 다음 빈 색으로.
export function ownerColorMap(ownerIds) {
  const ids = Array.from(new Set((Array.isArray(ownerIds) ? ownerIds : [])
    .map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))).sort((a, b) => a - b);
  const used = new Set();
  const map = {};
  for (const id of ids) {
    let idx = id % OWNER_PALETTE.length;
    for (let k = 0; k < OWNER_PALETTE.length && used.has(idx); k++) idx = (idx + 1) % OWNER_PALETTE.length;
    used.add(idx);
    const c = OWNER_PALETTE[idx];
    map[id] = { idx, bg: c[0], fg: c[1], border: c[2] };
  }
  return map;
}

// ── ③ 목표/달성 집계 ────────────────────────────────────────────────
//   달성액은 「입력된 값이 있으면 그 값」. 수주확정 달성률은 목표가 0이면 null(나눗셈 회피).
export function meetingTotals(items) {
  const list = Array.isArray(items) ? items : [];
  const live = list.filter((m) => m && m.status !== 'cancelled');
  const sum = (f) => live.reduce((s, m) => s + num(m[f]), 0);
  const target_quote = sum('target_quote');
  const target_order = sum('target_order');
  const actual_quote = sum('actual_quote');
  const actual_order = sum('actual_order');
  const rate = (a, t) => (t > 0 ? Math.round((a / t) * 1000) / 10 : null);
  const q = { achieved: 0, partial: 0, missed: 0 };
  for (const m of live) if (m && q[m.qual_result] !== undefined) q[m.qual_result]++;
  // 약속 미팅과 부스 직접 방문을 나눠 센다. 확정 여부는 약속 미팅에만 의미가 있다.
  const appts = live.filter((m) => normKind(m.kind) === 'meeting');
  const booth = live.filter((m) => normKind(m.kind) === 'booth');
  return {
    total: live.length,
    meeting: appts.length,
    booth: booth.length,
    confirmed: appts.filter((m) => m.is_confirmed).length,
    unconfirmed: appts.filter((m) => !m.is_confirmed && m.status === 'planned').length,
    planned: live.filter((m) => m.status === 'planned').length,
    done: live.filter((m) => m.status === 'done').length,
    noshow: live.filter((m) => m.status === 'noshow').length,
    walkin: live.filter((m) => m.is_walkin).length,
    cancelled: list.length - live.length,
    recorded: live.filter((m) => m.has_ai).length,
    target_quote, target_order, actual_quote, actual_order,
    rate_quote: rate(actual_quote, target_quote),
    rate_order: rate(actual_order, target_order),
    qual: q,
  };
}

// 담당자별 집계(범례 옆 요약)
export function ownerTotals(items) {
  const by = new Map();
  for (const m of (Array.isArray(items) ? items : [])) {
    if (!m || m.status === 'cancelled') continue;
    const id = Number(m.owner_user_id) || 0;
    const cur = by.get(id) || { owner_user_id: id || null, count: 0, booth: 0, target_quote: 0, target_order: 0, actual_quote: 0, actual_order: 0 };
    cur.count++;
    if (normKind(m.kind) === 'booth') cur.booth++;
    cur.target_quote += num(m.target_quote);
    cur.target_order += num(m.target_order);
    cur.actual_quote += num(m.actual_quote);
    cur.actual_order += num(m.actual_order);
    by.set(id, cur);
  }
  return Array.from(by.values()).sort((a, b) => (b.count - a.count) || ((a.owner_user_id || 0) - (b.owner_user_id || 0)));
}

// ── ④ 정성목표 달성 판단 ────────────────────────────────────────────
export const QUAL_RESULTS = ['achieved', 'partial', 'missed'];
export const QUAL_KO = { achieved: '달성', partial: '부분 달성', missed: '미달성' };

export function normQual(v) {
  const raw = String(v == null ? '' : v).trim().toLowerCase();
  if (QUAL_RESULTS.includes(raw)) return raw;
  // 부정형("no logrado")이 긍정형에 먹히지 않도록 부정 → 부분 → 긍정 순서로 본다.
  if (/(no\s*logrado|no\s*cumplido|fallido|미달|실패|못\s*했)/.test(raw)) return 'missed';
  if (/(parcial|부분|일부)/.test(raw)) return 'partial';
  if (/(^|[^a-z])(logrado|cumplido|완전|달성)/.test(raw)) return 'achieved';
  return null;
}

// 요약(스페인어 원문 또는 한국어)을 프롬프트용 텍스트로 눌러 담는다.
export function summaryToText(summary) {
  const s = summary || {};
  const out = [];
  if (s.resumen) out.push('요약: ' + clip(s.resumen, 1200));
  for (const b of (Array.isArray(s.bullets) ? s.bullets : []).slice(0, 20)) {
    const t = clip(b && (b.text || b), 300);
    if (t) out.push('- [' + clip((b && b.category) || 'otros', 30) + '] ' + t);
  }
  if (s.insights) out.push('파악: ' + clip(s.insights, 800));
  for (const a of (Array.isArray(s.action_items) ? s.action_items : []).slice(0, 20)) {
    const c = clip(a && (a.content || a), 300);
    if (c) out.push('- 후속조치: ' + c + (a && a.due_date ? ' (' + a.due_date + ')' : ''));
  }
  if (Array.isArray(s.products) && s.products.length) out.push('언급 제품: ' + s.products.slice(0, 30).join(', '));
  if (s.next_step) out.push('다음: ' + clip(s.next_step, 400));
  return out.join('\n');
}

export function buildQualEvalPrompt(m) {
  const cur = m.currency || 'MXN';
  const ctx = [];
  ctx.push(`- 전시회: ${m.exhibition_name || '-'}${m.venue ? ' (' + m.venue + ')' : ''}`);
  ctx.push(`- 일자/시간: ${m.meet_date || '-'} ${String(m.slot_hour ?? '').toString().padStart(2, '0')}:00`);
  ctx.push(`- 고객사: ${m.company_name || '미상'}${m.contact_name ? ' / ' + m.contact_name : ''}`);
  ctx.push(`- 미팅 담당자: ${m.owner_name || '-'}`);
  ctx.push(`- 정량목표: 견적수주 ${num(m.target_quote).toLocaleString('en-US')} ${cur} · 수주확정 ${num(m.target_order).toLocaleString('en-US')} ${cur}`);
  ctx.push(`- 정성목표(담당자가 직접 적은 것): ${m.goal_note ? String(m.goal_note).trim() : '(없음)'}`);
  if (m.memo) ctx.push(`- 미팅 간단 메모: ${clip(m.memo, 800)}`);

  return [
    '너는 자동차부품 유통회사(멕시코) 전시회 미팅 코치다.',
    '아래 미팅의 **정성목표가 달성되었는지**를 녹음 요약(또는 전사문)을 근거로 판단하고 JSON 하나로만 답하라.',
    '',
    '[미팅 정보]',
    ctx.join('\n'),
    '',
    '[녹음 AI 요약]',
    (m.summary_text || '').trim() || '(요약 없음)',
    '',
    '[전사문 발췌]',
    clip(m.transcript, 6000) || '(없음)',
    '',
    '[판단 기준]',
    '- achieved : 정성목표에 해당하는 내용이 실제로 대화에서 다뤄졌고 상대의 긍정적 반응·합의·다음 단계가 확인된다.',
    '- partial  : 다뤄지긴 했으나 합의·확답이 없거나 일부만 충족됐다.',
    '- missed   : 대화에서 다뤄지지 않았거나 명확히 거절/무산됐다.',
    '- 정성목표가 비어 있으면 result 는 null 로 두고 reason 에 "정성목표 미입력"이라고 적어라.',
    '',
    '[출력 규칙]',
    '- 반드시 아래 형태의 JSON 객체 하나만 출력(설명·마크다운 금지):',
    '{"result":"achieved|partial|missed|null",',
    ' "reason":"판단 이유 2~3문장",',
    ' "evidence":["요약/전사문에서 근거가 된 문장 또는 요점(최대 5개)"],',
    ` "quote_amount":숫자 또는 null,   // 대화에서 확인된 견적 금액(${cur}), 없으면 null`,
    ` "order_amount":숫자 또는 null,   // 대화에서 확인된 확정 수주 금액(${cur}), 없으면 null`,
    ' "next_step":"이 고객을 목표까지 끌고 가기 위한 다음 조치 한 줄"}',
    '- 근거 없는 내용을 지어내지 마라. 금액은 대화에서 명시된 경우에만 숫자로 적는다(통화기호·쉼표 없이).',
    '- 출력 언어는 한국어(제품 코드·회사명·사람 이름은 원문 유지).',
  ].join('\n');
}

export function parseQualEvalJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(raw.slice(start, end + 1)); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const money = (v) => {
    if (v == null || v === '' || v === 'null') return null;
    const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
  };
  const out = {
    result: normQual(obj.result),
    reason: clip(obj.reason, 1200),
    evidence: (Array.isArray(obj.evidence) ? obj.evidence : [])
      .map((x) => clip(typeof x === 'string' ? x : (x && x.text), 400)).filter(Boolean).slice(0, 5),
    quote_amount: money(obj.quote_amount),
    order_amount: money(obj.order_amount),
    next_step: clip(obj.next_step, 400),
  };
  if (!out.result && !out.reason && !out.evidence.length && !out.next_step) return null;
  return out;
}
