// =====================================================================
// Refatrix ERP · visitAi.js — 방문 상담 녹음 AI 파이프라인 순수 함수 모음
//   (전사 프롬프트 조립 · 요약 JSON 파싱/정제 · 방문 노트 병합 ·
//    영업사원 아침 브리핑 텍스트 조립(스페인어))
//   네트워크 호출 없음 — visitRecRoutes.js 가 사용. 전부 단위 테스트 가능.
// =====================================================================

export function clip(s, n) {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// ── ① Claude 요약 프롬프트 ────────────────────────────────────────────
//   transcript 는 대부분 스페인어(멕시코 현장). resumen/insights 는 대화 언어
//   그대로, 분류 구조(JSON 키)는 고정. 지어내기 금지·상대 날짜는 visitDate 기준.
export function buildSummaryPrompt({ transcript, customerName, placeName, metPerson, visitDate, mode }) {
  const ctx = [];
  ctx.push(`- 방문일: ${visitDate}`);
  ctx.push(`- 방문처: ${customerName || placeName || '미상'}`);
  if (metPerson) ctx.push(`- 만난 사람: ${metPerson}`);
  ctx.push(`- 녹음 종류: ${mode === 'full' ? '상담 전체 녹음' : '미팅 직후 음성 메모'}`);
  return [
    '너는 자동차부품 유통회사(멕시코) 영업 상담 기록 비서다.',
    '아래는 영업사원이 고객 방문에서 녹음한 음성의 전사문이다. 내용을 분류해 JSON 하나로만 답하라.',
    '',
    '[방문 정보]',
    ctx.join('\n'),
    '',
    '[전사문]',
    String(transcript || '').trim(),
    '',
    '[출력 규칙]',
    '- 반드시 아래 형태의 JSON 객체 하나만 출력(설명·마크다운 금지):',
    '{"resumen":"무슨 이야기를 했는지 요약(대화 언어 그대로, 5문장 이내)",',
    ' "insights":"새로 배운/파악한 내용(고객 상황·경쟁사·재고·불만 등, 없으면 빈 문자열)",',
    ' "action_items":[{"content":"해야 할 일(대화 언어 그대로, 한 건씩 구체적으로)","due_date":"YYYY-MM-DD 또는 null"}],',
    ' "products":["언급된 제품 코드/품명(없으면 빈 배열)"],',
    ' "next_step":"다음 방문/연락 계획 한 줄(없으면 빈 문자열)"}',
    '- 전사문에 없는 내용을 지어내지 마라. 불확실하면 비워라.',
    `- 상대 날짜("mañana", "다음 주" 등)는 방문일 ${visitDate} 기준으로 YYYY-MM-DD 로 환산하고, 날짜 언급이 없으면 null.`,
    '- action_items 는 최대 10건. 잡담·인사말은 제외.',
  ].join('\n');
}

// ── ② Claude 응답 → 요약 객체(방어적 파싱) ───────────────────────────
export function parseSummaryJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(raw.slice(start, end + 1)); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const items = Array.isArray(obj.action_items) ? obj.action_items : [];
  const actionItems = [];
  for (const it of items.slice(0, 10)) {
    const content = clip(it && it.content, 300);
    if (!content) continue;
    const due = (it && typeof it.due_date === 'string' && YMD.test(it.due_date)) ? it.due_date : null;
    actionItems.push({ content, due_date: due });
  }
  const products = (Array.isArray(obj.products) ? obj.products : [])
    .map((p) => clip(p, 80)).filter(Boolean).slice(0, 30);
  return {
    resumen: clip(obj.resumen, 4000),
    insights: clip(obj.insights, 2000),
    action_items: actionItems,
    products,
    next_step: clip(obj.next_step, 300),
  };
}

// ── ③ 요약 → 방문 노트 병합(기존 수기 입력 보존, [AI요약] 블록 추가) ──
export const AI_MARK = '[AI요약]';
export function mergeNote(existing, aiText) {
  const base = String(existing || '').trim();
  const add = String(aiText || '').trim();
  if (!add) return base || null;
  // 이미 AI 블록이 있으면 교체(재처리 시 중복 방지)
  const idx = base.indexOf(AI_MARK);
  const kept = idx >= 0 ? base.slice(0, idx).trim() : base;
  const block = `${AI_MARK} ${add}`;
  return kept ? `${kept}\n${block}` : block;
}
export function summaryToNotes(summary) {
  const s = summary || {};
  const talkParts = [s.resumen];
  if (s.products && s.products.length) talkParts.push('제품: ' + s.products.join(', '));
  if (s.next_step) talkParts.push('다음: ' + s.next_step);
  return {
    talkAppend: talkParts.filter(Boolean).join(' · '),
    insightAppend: s.insights || '',
  };
}

// ── ④ 영업사원 아침 브리핑(스페인어 WhatsApp 텍스트) ─────────────────
const DOW_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
export function esDateLabel(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const w = DOW_ES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${w} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

// data = { name, mxToday, schedule:[{time,content}], pendings:{overdue:[],today:[],upcoming:[]},
//          todos:[{title,due_date,overdue}], yesterdayVisits:[{place,resumen}] }
export function buildBriefingText(data) {
  const d = data || {};
  const L = [];
  L.push(`*📋 Buenos días, ${d.name || ''} — ${esDateLabel(d.mxToday)}*`);

  const sch = d.schedule || [];
  L.push('', `*■ Agenda de hoy* (${sch.length})`);
  if (!sch.length) L.push('• Sin eventos registrados.');
  for (const e of sch.slice(0, 10)) L.push(`• ${e.time ? e.time + ' ' : ''}${clip(e.content, 120)}`);
  if (sch.length > 10) L.push(`… y ${sch.length - 10} más`);

  const p = d.pendings || {};
  const ov = p.overdue || [], td = p.today || [], up = p.upcoming || [];
  L.push('', `*■ Pendientes de visitas* (${ov.length + td.length + up.length})`);
  if (!ov.length && !td.length && !up.length) L.push('• Sin pendientes abiertos.');
  for (const x of ov.slice(0, 8)) L.push(`• ⚠ VENCIDO (+${x.overdue}d) ${clip(x.content, 100)} — ${clip(x.place, 40)}`);
  for (const x of td.slice(0, 8)) L.push(`• 🔔 HOY ${clip(x.content, 100)} — ${clip(x.place, 40)}`);
  for (const x of up.slice(0, 8)) L.push(`• ${x.due_date} ${clip(x.content, 100)} — ${clip(x.place, 40)}`);

  const todos = d.todos || [];
  if (todos.length) {
    L.push('', `*■ Tareas ERP* (${todos.length})`);
    for (const t of todos.slice(0, 8)) L.push(`• ${t.overdue ? '⚠ ' : ''}${t.due_date ? t.due_date + ' ' : ''}${clip(t.title, 100)}`);
  }

  const yv = d.yesterdayVisits || [];
  L.push('', `*■ Visitas de ayer* (${yv.length})`);
  if (!yv.length) L.push('• Sin visitas registradas.');
  for (const v of yv.slice(0, 8)) L.push(`• ${clip(v.place, 40)}${v.resumen ? ' — ' + clip(v.resumen, 150) : ''}`);

  L.push('', '_Registra tus visitas y pendientes en ERP → Ventas → Actividad → 🧭 Visitas._');
  let text = L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > 3800) text = text.slice(0, 3800) + '\n…';
  return text;
}

// 템플릿 폴백 헤드라인(줄바꿈 금지)
export function briefingHeadline(data) {
  const d = data || {};
  const p = d.pendings || {};
  const parts = [];
  const sch = (d.schedule || []).length, ov = (p.overdue || []).length,
    td = (p.today || []).length, yv = (d.yesterdayVisits || []).length;
  if (sch) parts.push(`agenda ${sch}`);
  if (ov) parts.push(`vencidos ${ov}`);
  if (td) parts.push(`hoy ${td}`);
  if (yv) parts.push(`visitas ayer ${yv}`);
  const body = parts.length ? parts.join(' · ') : 'sin pendientes';
  return `[Refatrix] Briefing ${esDateLabel(d.mxToday)} — ${body} (detalle en ERP)`.slice(0, 950);
}
