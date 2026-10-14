// =====================================================================
// Refatrix ERP · dayDigest.js — 「오늘 요약」(디렉터 전용) 압축·프롬프트 빌더
//   순수 함수만(외부 호출·DB 접근 없음) → 단위 테스트 용이.
//   dailySummaryRoutes 의 collectDayDigest() 가 만든 하루치 digest JSON 을
//   ① 사람이 읽는 압축 텍스트(condenseDigest)로 변환하고
//   ② Anthropic API 프롬프트(buildDailyPrompt)를 조립한다.
//   특히 직원들이 기록한 일정(calendar)·할일(todo)·메모가 핵심이므로
//   해당 섹션은 건별로 작성자 이름과 함께 최대한 보존한다.
// =====================================================================

function n0(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0; }
function mxn(v) { return 'MX$' + n0(v).toLocaleString('en-US'); }
export function clip(s, max) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
export function krDate(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  if (!y || !m || !d) return String(ymd || '');
  const w = DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y}년 ${m}월 ${d}일 (${w})`;
}
const SCOPE_LBL = { company: '회사전체', team: '팀', personal: '개인', shared: '지정공유' };
const TODO_LEVEL = { assigned: '지시', self: '자가등록', coop: '협조요청' };
const ACTION_LBL = {
  create: '생성', update: '수정', delete: '삭제', print: '출력', export: '내보내기',
  login: '로그인', login_fail: '로그인실패', price_change: '가격변경', permission_change: '권한변경',
  delete_request: '삭제요청', delete_approve: '삭제승인', delete_reject: '삭제반려',
  change_request: '수정요청', approve_change: '수정승인', period_close: '마감',
};

function listLines(arr, fn, max) {
  const out = [];
  const list = Array.isArray(arr) ? arr : [];
  for (const it of list.slice(0, max)) out.push('  - ' + fn(it));
  if (list.length > max) out.push(`  - (외 ${list.length - max}건)`);
  return out;
}

// ── 팀 업무(직원 업무일지) ────────────────────────────────────────────
//   dg.workplan = { members: [{ name, plan_hm, plan_late, done_hm, done_late, extra_done,
//                               items: [{ title, status, note, carry_count, added_late }] }],
//                   missing: [이름…] }   (collectDayDigest 가 만든다)
const WP_ST = { done: '완료', partial: '일부', missed: '못함', open: '미체크' };
export function workplanCounts(wp) {
  const members = (wp && Array.isArray(wp.members)) ? wp.members : [];
  const c = { members: members.length, items: 0, done: 0, partial: 0, missed: 0, open: 0,
    missing: (wp && Array.isArray(wp.missing)) ? wp.missing.length : 0 };
  for (const m of members) {
    for (const it of (Array.isArray(m.items) ? m.items : [])) {
      c.items++;
      const s = WP_ST[it.status] ? it.status : 'open';
      c[s]++;
    }
  }
  return c;
}
export function condenseWorkplan(wp) {
  const L = [];
  const members = (wp && Array.isArray(wp.members)) ? wp.members : [];
  const missing = (wp && Array.isArray(wp.missing)) ? wp.missing : [];
  if (!members.length && !missing.length) { L.push('[팀 업무] 기록 없음'); return L; }
  const c = workplanCounts(wp);
  L.push(`[팀 업무] 작성 ${c.members}명 · 항목 ${c.items} (완료 ${c.done} · 일부 ${c.partial} · 못함 ${c.missed} · 미체크 ${c.open})${missing.length ? ` · 미작성 ${missing.length}명` : ''}`);
  for (const m of members.slice(0, 25)) {
    const head = [];
    head.push(m.plan_hm ? `할 일 ${m.plan_hm} 작성${m.plan_late ? '(지연)' : ''}` : '할 일 미작성');
    head.push(m.done_hm ? `한 일 ${m.done_hm} 작성${m.done_late ? '(지연)' : ''}` : '한 일 미작성');
    L.push(`  · ${m.name || '?'} — ${head.join(' / ')}`);
    const items = Array.isArray(m.items) ? m.items : [];
    for (const it of items.slice(0, 15)) {
      const extra = [];
      if (n0(it.carry_count) > 0) extra.push(`이월 ${n0(it.carry_count)}회`);
      if (it.added_late) extra.push('마감 후 추가');
      L.push(`    - [${WP_ST[it.status] || '미체크'}] ${clip(it.title, 120)}${it.note ? ' — ' + clip(it.note, 120) : ''}${extra.length ? ' (' + extra.join(', ') + ')' : ''}`);
    }
    if (items.length > 15) L.push(`    - (외 ${items.length - 15}건)`);
    if (m.extra_done && String(m.extra_done).trim()) L.push(`    - 계획 외 한 일: ${clip(m.extra_done, 300)}`);
  }
  if (members.length > 25) L.push(`  · (외 ${members.length - 25}명)`);
  if (missing.length) L.push(`  · 미작성: ${missing.slice(0, 30).join(', ')}`);
  return L;
}

// 하루치 digest JSON → 압축 텍스트(프롬프트 삽입용, 최대 ~9천자)
export function condenseDigest(dateStr, dg) {
  dg = dg || {};
  const L = [];
  L.push(`## ${krDate(dateStr)} ERP 기록 원본`);

  // ⓪ 나의 기록(일정 화면 「📝 나의 기록」 = calendar_journal) — 디렉터 본인이 손으로 쓴 일지.
  //    ERP 자동 기록이 담지 못하는 맥락·판단·감정이 들어 있어 요약의 뼈대가 된다 → 최상단·최대 보존.
  const jr = Array.isArray(dg.journal) ? dg.journal : [];
  if (jr.length) {
    L.push(`[나의 기록] ${jr.length}건 — 디렉터가 직접 쓴 그날의 일지(원문)`);
    for (const j of jr.slice(0, 3)) {
      L.push(`  · ${j.author || '디렉터'} 작성:`);
      L.push('    ' + clip(j.content, 2500));
    }
    if (jr.length > 3) L.push(`  · (외 ${jr.length - 3}건)`);
  } else {
    L.push('[나의 기록] 없음');
  }

  // ⓪-b 팀 업무(직원 업무일지 workplan, 0263) — 직원별 「오늘 할 일」 체크리스트 · 실적 · 계획 외 한 일 · 미작성자
  L.push(...condenseWorkplan(dg.workplan));

  // ① 일정 (직원 작성 — 최우선 보존)
  const sch = Array.isArray(dg.schedule) ? dg.schedule : [];
  L.push(`[일정] ${sch.length}건`);
  L.push(...listLines(sch, (e) => {
    const who = e.owner || e.created_by || '?';
    const tgt = (Array.isArray(e.targets) && e.targets.length) ? ` 공유대상:${e.targets.join(',')}` : '';
    const memoN = n0(e.memo_count) ? ` 메모${n0(e.memo_count)}개` : '';
    return `${e.time || '종일'} [${SCOPE_LBL[e.scope] || e.scope || '개인'}] ${clip(e.content, 160)} (작성:${who}${e.owner && e.created_by && e.owner !== e.created_by ? '·등록:' + e.created_by : ''}${tgt}${memoN})`;
  }, 40));

  // ①-b 일정 메모(이날 작성된 댓글)
  const cm = Array.isArray(dg.calendar_memos) ? dg.calendar_memos : [];
  if (cm.length) {
    L.push(`[일정 메모] ${cm.length}건`);
    L.push(...listLines(cm, (m) => `${m.author || '?'} → 일정「${clip(m.event_content, 60)}」: ${clip(m.body, 200)}`, 20));
  }

  // ② 할일 (생성/마감/완료 — 직원 기록 최우선 보존)
  const td = dg.todos || {};
  const cr = Array.isArray(td.created) ? td.created : [];
  const due = Array.isArray(td.due) ? td.due : [];
  const done = Array.isArray(td.done) ? td.done : [];
  const tm = Array.isArray(td.memos) ? td.memos : [];
  L.push(`[할일] 신규 ${cr.length} · 이날 마감 ${due.length} · 완료 ${done.length}`);
  if (cr.length) {
    L.push('  · 신규 등록:');
    L.push(...listLines(cr, (t) => `${clip(t.title, 100)}${t.detail ? ' — ' + clip(t.detail, 120) : ''} (담당:${(t.assignees || []).join(',') || '전체'} · ${TODO_LEVEL[t.level] || t.level || ''} · 등록:${t.created_by || '?'}${t.due_date ? ' · 마감 ' + t.due_date : ''})`, 25));
  }
  if (due.length) {
    L.push('  · 이날 마감 예정:');
    L.push(...listLines(due, (t) => `${clip(t.title, 100)} (담당:${(t.assignees || []).join(',') || '전체'} · 상태:${t.status === 'done' ? '완료' : '미완'})`, 20));
  }
  if (done.length) {
    L.push('  · 완료 처리:');
    L.push(...listLines(done, (t) => `${clip(t.title, 100)} (담당:${(t.assignees || []).join(',') || '전체'}${t.done_note ? ' · 완료메모: ' + clip(t.done_note, 120) : ''})`, 20));
  }
  if (tm.length) {
    L.push('  · 할일 메모(릴레이):');
    L.push(...listLines(tm, (m) => `${m.author || '?'} → 「${clip(m.todo_title, 60)}」: ${clip(m.body, 160)}`, 20));
  }

  // ③ 공지
  const nt = Array.isArray(dg.notices) ? dg.notices : [];
  if (nt.length) {
    L.push(`[공지] ${nt.length}건`);
    L.push(...listLines(nt, (x) => `${clip(x.title, 100)} (작성:${x.author || '?'}${x.pinned ? ' · 고정' : ''})`, 10));
  }

  // ④ 견적
  const q = dg.quotes || {};
  const qi = Array.isArray(q.items) ? q.items : [];
  L.push(`[견적] ${n0(q.count)}건 · 합계 ${mxn(q.total_mxn)} · ${n0(q.sku_count)} SKU · ${n0(q.total_qty)}개`);
  L.push(...listLines(qi, (x) => `${clip(x.customer, 50)} ${mxn(x.total_mxn)} (${n0(x.sku_count)}SKU · 상태:${x.status || '-'} · 작성:${x.by || '?'})`, 15));

  // ⑤ 영업활동(미팅·방문)
  const mt = dg.meetings || {};
  const mi = Array.isArray(mt.items) ? mt.items : [];
  L.push(`[영업활동] ${n0(mt.count)}건`);
  L.push(...listLines(mi, (x) => `${clip(x.customer, 50)} (담당:${x.by || '?'}${x.stage_move ? ' · 단계 ' + x.stage_move : ''}${x.note ? ' · 내용: ' + clip(x.note, 160) : ''})`, 15));

  // ⑥ 매출(인보이스)
  const inv = dg.invoices || {};
  const ii = Array.isArray(inv.items) ? inv.items : [];
  L.push(`[매출 인보이스] ${n0(inv.count)}건 · 합계 ${mxn(inv.total_mxn)}`);
  L.push(...listLines(ii, (x) => `${x.sat_no || '(번호없음)'} ${clip(x.customer, 50)} ${mxn(x.total_mxn)}${x.owner ? ' (담당:' + x.owner + ')' : ''}`, 12));

  // ⑦ 입출금(확정 거래)
  const tx = dg.transactions || {};
  const ti = Array.isArray(tx.items) ? tx.items : [];
  L.push(`[입출금(확정)] 입금 ${mxn(tx.in_mxn)}(${n0(tx.in_count)}건) · 출금 ${mxn(tx.out_mxn)}(${n0(tx.out_count)}건)`);
  L.push(...listLines(ti, (x) => `${x.direction === 'in' ? '입금' : '출금'} ${mxn(x.amount_mxn)} ${clip(x.category, 40)}${x.memo ? ' — ' + clip(x.memo, 80) : ''}${x.approved === false ? ' (승인대기)' : ''}`, 15));

  // ⑧ 신규 고객
  const nc = Array.isArray(dg.new_customers) ? dg.new_customers : [];
  if (nc.length) {
    L.push(`[신규 고객] ${nc.length}건`);
    L.push(...listLines(nc, (x) => `${x.code || ''} ${clip(x.name, 60)} (담당:${x.owner || '?'} · 등록:${x.by || '?'})`, 10));
  }

  // ⑨ 마케팅
  const mk = dg.marketing || {};
  const ev = Array.isArray(mk.events) ? mk.events : [];
  const ln = Array.isArray(mk.lines) ? mk.lines : [];
  if (ev.length || ln.length) {
    L.push(`[마케팅] 이날 행사 ${ev.length}건 · 집행 예정 ${ln.length}건`);
    L.push(...listLines(ev, (x) => `행사: ${clip(x.title, 80)}${x.category ? ' (' + x.category + ')' : ''}`, 6));
    L.push(...listLines(ln, (x) => `집행: ${clip(x.plan, 60)}·${clip(x.item, 40)} ${x.kind_label || ''} ${mxn(x.amount)}`, 8));
  }

  // ⑩ 시스템 활동(감사로그 — 그날 누가 무엇을 얼마나 했는지)
  const act = dg.activity || {};
  const au = Array.isArray(act.users) ? act.users : [];
  L.push(`[시스템 활동] 총 ${n0(act.total)}건 (page_view 제외) · 활동 직원 ${au.length}명`);
  L.push(...listLines(au, (u) => {
    const parts = Object.entries(u.by_action || {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${ACTION_LBL[k] || k} ${n0(v)}`).join('·');
    return `${u.name || '?'}${u.dept ? '(' + u.dept + ')' : ''}: ${n0(u.total)}건 — ${parts || '-'}`;
  }, 20));

  let text = L.join('\n');
  // 「나의 기록」이 맨 앞에 오므로 잘려도 일지 원문은 항상 보존된다.
  if (text.length > 13000) text = text.slice(0, 13000) + '\n…(이하 생략)';
  return text;
}

// Anthropic API 프롬프트 — 한국어 6섹션 고정, 자료 밖 내용 금지
export function buildDailyPrompt(dateStr, dg) {
  const body = condenseDigest(dateStr, dg);
  return [
    '너는 Refatrix ERP(멕시코 자동차부품 유통, 통화 MXN, IVA 16%)의 경영 비서다.',
    `아래는 ${krDate(dateStr)} 하루 동안 ERP에 기록된 원본 데이터 전체다.`,
    '디렉터가 그날 회사에서 무슨 일이 있었는지 한눈에 파악할 수 있도록 한국어 일일 요약 보고서를 마크다운으로 작성하라.',
    '',
    '반드시 아래 6개 섹션 구조를 그대로 사용하고, 각 섹션의 내용은 모두 불릿(- )으로 정리할 것:',
    '### 오늘 한눈에',
    '(그날의 핵심을 3~5개 불릿으로 — 숫자 포함. 「나의 기록」이 있으면 그 관점을 먼저 반영)',
    '### 일정·할일 활동',
    '(가장 중요한 섹션. 「팀 업무」(직원 업무일지)를 먼저 — 직원별 계획 대비 완료·일부·못함, 계획 외 한 일, 지연·미작성자를 이름을 들어 정리하고,',
    ' 이어서 누가 어떤 일정·할일·메모를 기록/완료했는지 구체적으로 정리)',
    '### 영업 활동',
    '(견적·미팅/방문·단계 이동·신규 고객)',
    '### 매출·자금',
    '(인보이스 발행·입출금 확정 내역)',
    '### 마케팅·기타 기록',
    '(마케팅 행사/집행, 공지, 시스템 활동 특이점 — 해당 없으면 "특이 기록 없음" 한 줄)',
    '### 특이사항·팔로업 제안',
    '(이상 징후·누락·병목 등 디렉터가 챙길 일 2~4개. 「나의 기록」에 적힌 다짐·숙제도 여기에 반영)',
    '',
    '규칙:',
    '- 자료에 없는 내용을 지어내지 말 것. 수치는 원본 그대로 사용.',
    '- **「나의 기록」은 디렉터가 직접 쓴 일지다.** ERP 자동 기록보다 맥락이 풍부하므로,',
    '  별도 섹션을 만들지 말고 위 6개 섹션의 해당 위치에 자연스럽게 녹여 쓸 것.',
    '  일지에만 있고 ERP 기록에는 없는 내용도 반드시 포함하고, 그 경우 "(기록)" 을 붙여 출처를 표시할 것.',
    '  일지와 ERP 기록이 어긋나면 양쪽을 함께 적고 어긋난다는 점을 「특이사항」에 남길 것.',
    '- 직원 이름은 원본 표기 그대로. 개인 일정도 디렉터 열람용이므로 포함.',
    '- 기록이 전혀 없는 섹션은 "기록 없음" 한 줄로 처리.',
    '- 전체 길이는 A4 한 장 안팎(과도하게 길게 쓰지 말 것).',
    '',
    '── 원본 데이터 ──',
    body,
  ].join('\n');
}

// ── 기간 묶음(주간) 요약 ────────────────────────────────────────────────
// 이미 만들어 둔 일자별 요약 본문을 시간순으로 이어 붙여 2차 요약한다(토큰 절약).
// parts: [{ date, content_md, journal: [{author, content}] , stats }]
export function condensePeriodParts(parts) {
  const list = Array.isArray(parts) ? parts : [];
  const L = [];
  const PER_DAY = Math.max(1200, Math.floor(38000 / Math.max(list.length, 1)));
  for (const p of list) {
    L.push(`===== ${krDate(p.date)} =====`);
    const jr = Array.isArray(p.journal) ? p.journal : [];
    if (jr.length) {
      L.push('[이 날 나의 기록 원문]');
      for (const j of jr.slice(0, 3)) L.push(clip(j.content, 1800));
    }
    L.push('[이 날 일일 요약]');
    L.push(clipMulti(p.content_md, PER_DAY));
    L.push('');
  }
  let text = L.join('\n');
  if (text.length > 60000) text = text.slice(0, 60000) + '\n…(이하 생략)';
  return text;
}

// 줄바꿈을 살린 클립(요약 본문용 — condense 의 clip 은 공백을 접어버린다)
function clipMulti(s, max) {
  s = String(s == null ? '' : s).trim();
  return s.length > max ? s.slice(0, max) + '\n…(이하 생략)' : s;
}

export function periodLabel(dates) {
  const d = (Array.isArray(dates) ? dates : []).slice().sort();
  if (!d.length) return '';
  if (d.length === 1) return krDate(d[0]);
  const contiguous = d.every((v, i) => {
    if (i === 0) return true;
    const [y, m, dd] = d[i - 1].split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, dd));
    t.setUTCDate(t.getUTCDate() + 1);
    return t.toISOString().slice(0, 10) === v;
  });
  return contiguous
    ? `${krDate(d[0])} ~ ${krDate(d[d.length - 1])} (${d.length}일)`
    : `${d.join(', ')} (${d.length}일 · 선택 날짜)`;
}

// 여러 날짜를 하나의 스토리로 묶는 프롬프트 — 일일 요약과 같은 6섹션 골격 유지
export function buildPeriodPrompt(dates, parts) {
  const body = condensePeriodParts(parts);
  const label = periodLabel(dates);
  return [
    '너는 Refatrix ERP(멕시코 자동차부품 유통, 통화 MXN, IVA 16%)의 경영 비서다.',
    `아래는 ${label} 동안의 일자별 요약과, 디렉터가 그날그날 직접 쓴 「나의 기록」 원문이다.`,
    '이것들을 날짜별로 나열하지 말고, **하나로 이어지는 기간 스토리**로 다시 써라.',
    '즉 "무슨 일이 시작되어 어떻게 이어졌고 어디서 끝났는지"가 읽히도록 흐름을 복원해야 한다.',
    '',
    '출력 형식(마크다운):',
    '1) 맨 위에 이 기간의 흐름을 3~4문장짜리 **한 문단**으로 서술(불릿 아님, 제목 없음).',
    '2) 그 다음 반드시 아래 6개 섹션을 이 순서·이 제목 그대로 사용하고, 내용은 전부 불릿(- )으로 정리:',
    '### 기간 한눈에',
    '(이 기간의 핵심 5~7개 불릿 — 합계 숫자와 변화를 포함)',
    '### 일정·할일 활동',
    '(직원별로 이 기간에 무엇을 했고 무엇이 끝났고 무엇이 남았는지. 여러 날에 걸친 건은 한 줄로 묶어 경과를 쓸 것)',
    '### 영업 활동',
    '(고객·견적·미팅·단계 이동을 고객 단위로 묶어 진행 경과로 정리)',
    '### 매출·자금',
    '(기간 합계와 큰 건. 날짜별 나열이 아니라 추세로)',
    '### 마케팅·기타 기록',
    '(마케팅 행사/집행, 공지, 시스템 활동 특이점 — 없으면 "특이 기록 없음" 한 줄)',
    '### 특이사항·팔로업 제안',
    '(이 기간에 드러난 리스크·병목·미결과 다음 기간에 챙길 일 3~5개)',
    '',
    '규칙:',
    '- 자료에 없는 내용을 지어내지 말 것. 수치는 원본 그대로 쓰고, 합계는 더한 값만 제시.',
    '- 여러 날에 걸쳐 이어진 사안은 반드시 한 항목으로 합쳐 "8/24 시작 → 8/26 진행 → 8/27 완료" 처럼 경과를 표기.',
    '- 날짜를 표기할 때는 M/D 형식(예: 8/26)을 사용.',
    '- **「나의 기록」은 디렉터 본인이 쓴 일지다.** 별도 섹션을 만들지 말고 각 섹션에 녹이되,',
    '  일지에만 있는 내용에는 "(기록)" 을 붙여 출처를 표시할 것.',
    '- 기록이 전혀 없는 섹션은 "기록 없음" 한 줄로 처리.',
    '- 전체 길이는 A4 1~2장(과도하게 길게 쓰지 말 것).',
    '',
    '── 일자별 자료 ──',
    body,
  ].join('\n');
}

// 보관함 목록에 보여줄 헤드라인 수치(저장 digest 에서 계산)
export function digestStats(dg) {
  dg = dg || {};
  const td = dg.todos || {};
  return {
    journal: (Array.isArray(dg.journal) ? dg.journal : []).length,
    workplan: workplanCounts(dg.workplan).members,
    schedule: (Array.isArray(dg.schedule) ? dg.schedule : []).length,
    todos: (Array.isArray(td.created) ? td.created.length : 0) + (Array.isArray(td.done) ? td.done.length : 0),
    quotes: n0((dg.quotes || {}).count),
    invoices: n0((dg.invoices || {}).count),
    txn_in: n0((dg.transactions || {}).in_mxn),
    txn_out: n0((dg.transactions || {}).out_mxn),
    activity: n0((dg.activity || {}).total),
  };
}

// Anthropic 응답 → 텍스트
export function extractText(resp) {
  if (!resp || !Array.isArray(resp.content)) return '';
  return resp.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim();
}

// =====================================================================
// 1014 · 「오늘 요약」 WhatsApp 템플릿(24시간 창 밖에서도 내용이 가는 형식)
//   디렉터 지시(2026-10-14): "템플릿이 없어 24시간 룰에 해당할 때만 발송된다 → 템플릿으로 보내되
//   발송 내용은 그날 팀 업무 · 나의 기록 · ERP 당일 기록을 스캔해서 작성".
//
//   Meta 템플릿 규칙 → 이 형식이 된 이유
//   · 변수에는 줄바꿈·탭·연속 공백 4칸 이상 금지(#132018) → 섹션마다 변수 1개, 항목은 「 | 」로 한 줄.
//   · 변수를 채운 본문 전체가 1,024자를 넘으면 거절(#132005) → 섹션별 글자 예산 + 합계 상한.
//   · 그래서 템플릿은 「요약본」, 전체 요약(A4 한 장)은 템플릿의 「전체 보기」 버튼을 누르면
//     웹훅으로 그 자리에서 보낸다(버튼을 누르면 24시간 창이 열리므로 자유 텍스트가 도착한다).
//
//   Meta 에 승인받을 템플릿(카테고리 유틸리티 · 언어 Korean · 이름 기본 daily_summary_ko):
//     본문 = DAILY_WA_TPL_BODY 그대로 · 빠른 답장 버튼 1개 「전체 보기」
// =====================================================================
export const DAILY_WA_TPL_BODY = [
  '📋 Refatrix 오늘 요약 · {{1}}',
  '',
  '👥 팀 업무: {{2}}',
  '',
  '📝 나의 기록: {{3}}',
  '',
  '📊 ERP 기록: {{4}}',
  '',
  '⚠️ 챙길 일: {{5}}',
  '',
  '전체 요약은 아래 「전체 보기」 버튼을 누르면 바로 보내 드립니다.',
].join('\n');
export const DAILY_WA_BUTTON_PREFIX = 'DSUM:';     // 빠른 답장 버튼 payload = DSUM:YYYY-MM-DD
const WA_BODY_MAX = 1024;
const WA_SAFETY = 24;                               // 이모지·서로게이트 등 글자 셈 차이 여유
export const DAILY_WA_SECTION_KEYS = ['team', 'journal', 'erp', 'followup'];
export const DAILY_WA_BUDGET = Object.freeze({ team: 300, journal: 190, erp: 220, followup: 150 });
const SECTION_LBL = { team: '팀 업무', journal: '나의 기록', erp: 'ERP 기록', followup: '챙길 일' };

// 템플릿 변수 1개로 쓸 수 있게: 줄바꿈·탭 → 「 | 」, 공백 정리, 마크다운 기호 제거, 길이 제한
export function waOneLine(s, max = 1024) {
  let t = String(s == null ? '' : s)
    .replace(/\r/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[\n\t]+/g, ' | ')
    .replace(/\s{2,}/g, ' ')
    .replace(/(\s*\|\s*){2,}/g, ' | ')
    .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
    .trim();
  if ([...t].length > max) t = [...t].slice(0, Math.max(1, max - 1)).join('').replace(/\s*\|?\s*$/, '') + '…';
  return t;
}

// 섹션 4개를 예산 안으로 맞추고, 본문 전체(1,024자) 상한도 지킨다. 빈 값은 Meta 가 거절하므로 대체 문구.
export function fitWaSections(sec, dateLabel = '') {
  const out = {};
  for (const k of DAILY_WA_SECTION_KEYS) {
    out[k] = waOneLine(sec && sec[k], DAILY_WA_BUDGET[k]) || (k === 'followup' ? '특이사항 없음' : '기록 없음');
  }
  const date = waOneLine(dateLabel, 40) || '-';
  const staticLen = [...DAILY_WA_TPL_BODY.replace(/\{\{\d\}\}/g, '')].length;
  const room = WA_BODY_MAX - WA_SAFETY - staticLen - [...date].length;
  let total = DAILY_WA_SECTION_KEYS.reduce((a, k) => a + [...out[k]].length, 0);
  // 넘치면 가장 긴 섹션부터 깎는다
  while (total > room) {
    const k = DAILY_WA_SECTION_KEYS.slice().sort((a, b) => [...out[b]].length - [...out[a]].length)[0];
    const len = [...out[k]].length;
    const cut = Math.max(20, len - (total - room));
    if (cut >= len) break;
    out[k] = waOneLine(out[k], cut);
    total = DAILY_WA_SECTION_KEYS.reduce((a, kk) => a + [...out[kk]].length, 0);
  }
  return { date, ...out };
}

// 템플릿 본문 변수 순서({{1}}~{{5}})
export function waSectionParams(fitted) {
  return [fitted.date, fitted.team, fitted.journal, fitted.erp, fitted.followup];
}

// 미리보기·테스트용: 변수를 채운 실제 본문
export function renderDailyWaBody(params) {
  return DAILY_WA_TPL_BODY.replace(/\{\{(\d)\}\}/g, (_, i) => String(params[Number(i) - 1] ?? ''));
}

// AI 로 섹션 4개 작성 — 원본 기록(팀 업무 · 나의 기록 · ERP)과 이미 만든 전체 요약을 함께 준다
export function buildWaSectionsPrompt(dateStr, dg, contentMd) {
  const B = DAILY_WA_BUDGET;
  return [
    '너는 Refatrix ERP(멕시코 자동차부품 유통, 통화 MXN)의 경영 비서다.',
    `${krDate(dateStr)} 하루를 디렉터에게 WhatsApp 한 통으로 보고할 「요약본」을 만든다.`,
    '아래 원본 기록과 전체 일일 요약을 읽고, 4개 칸을 JSON 으로만 출력하라(설명·코드블록 없이 JSON 한 개).',
    '',
    `{"team": "...", "journal": "...", "erp": "...", "followup": "..."}`,
    '',
    `- team (${B.team}자 이내): 「팀 업무」(직원 업무일지) 중심. 직원별로 "이름: 핵심 한 일(완료/일부/못함)" 형식,`,
    '  계획 외 한 일·지연·미작성자도 짧게. 업무일지가 없으면 일정·할일 기록으로 대신.',
    `- journal (${B.journal}자 이내): 「나의 기록」(디렉터 일지)의 핵심 판단·결정·숙제. 없으면 "기록 없음".`,
    `- erp (${B.erp}자 이내): ERP 당일 기록 — 견적·영업활동·매출 인보이스·입출금·신규 고객 등 수치 위주.`,
    `- followup (${B.followup}자 이내): 디렉터가 챙길 일 1~3개(지연·미결·이상 징후·일지의 숙제).`,
    '',
    '형식 규칙(어기면 WhatsApp 이 거절한다):',
    '- 각 칸은 한 줄. 줄바꿈·탭 금지. 항목 사이는 " | " 로 구분.',
    '- 마크다운 기호(**, #, -) 금지. 이모지 금지.',
    '- 자료에 없는 내용은 쓰지 말 것. 숫자는 원본 그대로. 직원 이름은 원본 표기 그대로.',
    '- 한국어로.',
    '',
    '── 전체 일일 요약 ──',
    String(contentMd || '(없음)').slice(0, 6000),
    '',
    '── 원본 기록 ──',
    condenseDigest(dateStr, dg),
  ].join('\n');
}

// AI 응답에서 JSON 4칸 꺼내기. 실패하면 null
export function parseWaSections(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let o;
  try { o = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const out = {};
  let any = false;
  for (const k of DAILY_WA_SECTION_KEYS) {
    const v = o[k];
    out[k] = typeof v === 'string' ? v : (Array.isArray(v) ? v.join(' | ') : '');
    if (out[k].trim()) any = true;
  }
  return any ? out : null;
}

// AI 를 못 쓸 때(키 없음·오류) 원본 기록에서 바로 만든다
export function fallbackWaSections(dg) {
  dg = dg || {};
  const wp = dg.workplan || {};
  const members = Array.isArray(wp.members) ? wp.members : [];
  const team = [];
  for (const m of members) {
    const items = Array.isArray(m.items) ? m.items : [];
    const done = items.filter((i) => i.status === 'done');
    const part = items.filter((i) => i.status === 'partial').length;
    const miss = items.filter((i) => i.status === 'missed').length;
    const titles = done.slice(0, 2).map((i) => clip(i.title, 40)).join(', ');
    team.push(`${m.name || '?'}: 완료 ${done.length}/${items.length}${part ? ` 일부 ${part}` : ''}${miss ? ` 못함 ${miss}` : ''}${titles ? ` (${titles})` : ''}`);
  }
  if (Array.isArray(wp.missing) && wp.missing.length) team.push(`미작성: ${wp.missing.join(', ')}`);
  if (!team.length) {
    const sch = Array.isArray(dg.schedule) ? dg.schedule : [];
    for (const e of sch.slice(0, 4)) team.push(`${e.owner || e.created_by || '?'}: ${clip(e.content, 50)}`);
  }
  const jr = Array.isArray(dg.journal) ? dg.journal : [];
  const journal = jr.length ? jr.map((j) => clip(j.content, 180)).join(' | ') : '';
  const st = digestStats(dg);
  const erp = [];
  if (st.quotes) erp.push(`견적 ${st.quotes}건 ${mxn((dg.quotes || {}).total_mxn)}`);
  const mt = n0((dg.meetings || {}).count); if (mt) erp.push(`영업활동 ${mt}건`);
  if (st.invoices) erp.push(`매출 인보이스 ${st.invoices}건 ${mxn((dg.invoices || {}).total_mxn)}`);
  if (st.txn_in || st.txn_out) erp.push(`입금 ${mxn(st.txn_in)} · 출금 ${mxn(st.txn_out)}`);
  const nc = Array.isArray(dg.new_customers) ? dg.new_customers.length : 0; if (nc) erp.push(`신규 고객 ${nc}`);
  const td = dg.todos || {};
  const tdn = (Array.isArray(td.created) ? td.created.length : 0); if (tdn) erp.push(`할일 신규 ${tdn}`);
  const follow = [];
  const c = workplanCounts(wp);
  if (c.missing) follow.push(`업무일지 미작성 ${c.missing}명`);
  if (c.missed) follow.push(`못한 일 ${c.missed}건`);
  return { team: team.join(' | '), journal, erp: erp.join(' | '), followup: follow.join(' | ') || '상세는 「전체 보기」' };
}

// 긴 텍스트를 WhatsApp 한 통(4,096자) 이하로 줄 단위 분할
export function splitWaText(text, max = 3800) {
  const lines = String(text || '').split('\n');
  const parts = [];
  let cur = '';
  for (const line of lines) {
    const piece = line.length > max ? line.slice(0, max) : line;
    if (cur && (cur.length + 1 + piece.length) > max) { parts.push(cur); cur = piece; }
    else cur = cur ? cur + '\n' + piece : piece;
  }
  if (cur.trim()) parts.push(cur);
  return parts.length ? parts : [''];
}
