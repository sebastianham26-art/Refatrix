// =====================================================================
// Refatrix ERP · mbrSummary.js — WBR 스냅샷 → MBR AI 요약용 압축·프롬프트 빌더
//   순수 함수만(외부 호출 없음) → 단위 테스트 용이.
//   스냅샷 동결 data(카드·워터폴·견적·SLA·이슈보드·메모)를 사람이 읽는
//   압축 텍스트로 변환해 Anthropic API 프롬프트에 넣는다. 사진은 제외.
// =====================================================================

const ORG_NAMES = { sales: '영업', support: '영업지원', pm: '제품마케팅', wh: '창고', mgmt: '경영총괄' };

function n0(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0; }
function mxn(v) { return 'MX$' + n0(v).toLocaleString('en-US'); }
function clip(s, max) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// 스냅샷 1건의 동결 data → 압축 텍스트(스냅샷당 최대 ~4000자).
export function condenseSnapshot(label, data) {
  data = data || {};
  const L = [];
  L.push(`## 회의 저장본: ${clip(label, 120)}`);
  const ctx = data.ctx || {};
  if (ctx.ctxText) L.push(`컨텍스트: ${clip(ctx.ctxText, 200)}`);

  // 카드 3종
  const c = data.cards || {};
  const s = c.sales || {}, col = c.collection || {}, d = c.pipeline_dev || {};
  if (c.sales || c.collection || c.pipeline_dev) {
    L.push(`[매출] 실적 ${mxn(s.actual)} / 목표 ${mxn(s.target)} (달성 ${s.progress == null ? '-' : s.progress + '%'})`);
    L.push(`[수금] 실적 ${mxn(col.actual)} / 계획 ${mxn(col.plan)} (달성 ${col.progress == null ? '-' : col.progress + '%'})`);
    const dd = d.delta || {};
    L.push(`[고객개발] 견적 ${n0(d.quote)}·협상 ${n0(d.negotiation)}·수주 ${n0(d.won)}` +
      ` (주간변동 견적 ${n0(dd.quote)}/협상 ${n0(dd.negotiation)}/수주 ${n0(dd.won)})`);
  }

  // 워터폴(주차별)
  const wf = data.waterfall || {};
  if (Array.isArray(wf.weeks) && wf.weeks.length) {
    const wks = wf.weeks.map((w) => `${w.label} ${mxn(w.actual)}`).join(', ');
    L.push(`[주차별 매출] ${wks} · 누적 ${mxn(wf.cumActual)} / 월목표 ${mxn(wf.monthTarget)}`);
  }

  // 견적(합계 + 상위 5건)
  const q = Array.isArray(data.quotes) ? data.quotes : [];
  if (q.length) {
    const tot = q.reduce((a, x) => a + Number(x.subtotal_mxn || 0), 0);
    const top = q.slice().sort((a, b) => Number(b.subtotal_mxn || 0) - Number(a.subtotal_mxn || 0)).slice(0, 5)
      .map((x) => `${clip(x.party_name, 40)} ${mxn(x.subtotal_mxn)}(${x.status === 'converted' ? '전환' : '미결'})`).join(', ');
    L.push(`[견적] ${q.length}건 합계 ${mxn(tot)} · 상위: ${top}`);
  }

  // 수주 단계 SLA
  const sla = data.sla || {};
  const stageLbl = { order: '오더확정', packing: '피킹/포장', sat: 'SAT발행', collect: '수금' };
  const slaParts = [];
  for (const k of ['order', 'packing', 'sat', 'collect']) {
    const st = sla[k];
    if (!st) continue;
    slaParts.push(`${stageLbl[k]} 대기 ${n0(st.n)}건(지연 ${n0(st.delayed)}건, ${mxn(st.amount)})`);
  }
  if (slaParts.length) L.push(`[수주 SLA] ${slaParts.join(' / ')}`);

  // 조직별 이슈(이번주/다음주)
  const issues = (data.board && data.board.issues) || {};
  for (const k of Object.keys(ORG_NAMES)) {
    const t = issues[k] || {};
    const th = Array.isArray(t.this) ? t.this : [];
    const nx = Array.isArray(t.next) ? t.next : [];
    if (!th.length && !nx.length) continue;
    if (th.length) L.push(`[${ORG_NAMES[k]}·이번주] ${th.map((x) => clip(x, 160)).join(' | ')}`);
    if (nx.length) L.push(`[${ORG_NAMES[k]}·다음주] ${nx.map((x) => clip(x, 160)).join(' | ')}`);
  }

  // 회의 메모
  const memo = (data.board && data.board.memo) || '';
  if (String(memo).trim()) L.push(`[회의 메모] ${clip(memo, 1200)}`);

  let out = L.join('\n');
  if (out.length > 4000) out = out.slice(0, 4000) + '…';
  return out;
}

// 스냅샷 여러 건 → MBR 요약 프롬프트(한국어).
export function buildMbrPrompt(snaps) {
  const body = snaps.map((sn) => condenseSnapshot(sn.label, sn.data)).join('\n\n');
  return [
    '너는 멕시코에서 자동차부품을 판매하는 한국계 무역회사 REFATRIX의 경영 보좌 애널리스트다.',
    '아래는 이 회사의 주간 비즈니스 리뷰(WBR) 회의 저장본 ' + snaps.length + '건이다(시간순). 통화는 MXN(멕시코 페소).',
    '이 자료만 근거로, 월 1회 열리는 월간 비즈니스 리뷰(MBR)에 쓸 요약 보고서를 한국어 마크다운으로 작성하라.',
    '',
    '작성 규칙:',
    '- 반드시 아래 6개 섹션 제목(### 포함)을 그대로 사용할 것.',
    '- 자료에 없는 사실·숫자를 지어내지 말 것. 자료가 부족한 섹션은 "자료 없음"이라고 쓸 것.',
    '- 표는 쓰지 말고 짧은 문장과 불릿(-)만 사용할 것.',
    '- 주차별 추이(증감·달성률 변화)와 여러 주에 반복 등장하는 미해결 이슈를 특히 강조할 것.',
    '',
    '### 1. 월간 핵심 요약',
    '### 2. 매출·수금 실적 추이',
    '### 3. 고객 개발·견적 현황',
    '### 4. 조직별 주요 이슈 (영업/영업지원/제품마케팅/창고/경영총괄)',
    '### 5. 리스크 및 의사결정 필요 사항',
    '### 6. 다음 달 중점 과제 제안',
    '',
    '=== WBR 회의 저장본 자료 시작 ===',
    body,
    '=== 자료 끝 ===',
  ].join('\n');
}

// Anthropic messages 응답 → 텍스트 추출(안전).
export function extractText(resp) {
  if (!resp || !Array.isArray(resp.content)) return '';
  return resp.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim();
}
