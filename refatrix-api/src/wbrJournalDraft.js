// =====================================================================
// Refatrix ERP · wbrJournalDraft.js
//   WBR 「팀별 주요 이슈」 초안 — 디렉터의 「📝 나의 기록」(calendar_journal, 0182)
//   월~금 기록을 스캔해 5개 조직(영업/영업지원/제품마케팅/창고/경영총괄)의
//   「이번주 / 다음주」 불릿 초안을 JSON 으로 만든다.
//
//   ── 안전·격리 원칙(wbrMbrRoutes 와 동일) ──
//   · 100% 읽기 전용(calendar_journal 을 SELECT 만 한다).
//   · 본인(user_id = 요청자)이 쓴 기록만 재료로 쓴다 — 남의 일지는 조회 경로 자체가 없다.
//   · ANTHROPIC_API_KEY 가 없으면 503(no_api_key) — 호출 시도 안 함.
//   · 모델은 WBR_DRAFT_MODEL 로 교체 가능. 기본 claude-sonnet-4-5.
// =====================================================================

export const ORG_KEYS = ['sales', 'support', 'pm', 'wh', 'mgmt'];

export const ORG_LABEL = {
  sales: '영업',
  support: '영업지원',
  pm: '제품마케팅',
  wh: '창고',
  mgmt: '경영총괄',
};

// 카테고리 배분 기준 — 프롬프트에 그대로 들어간다(사람이 읽고 고칠 수 있게 여기 한 곳에만 둔다).
const ORG_SCOPE = {
  sales: '고객 방문·상담, 견적/가격 협상, 수주, 고객 개발·신규 거래처, 수금·미수 독촉, 영업사원 활동',
  support: '주문 처리, 출고 서류·인보이스·크레딧노트, 고객 등록/RFC, 클레임·반품 처리, CRM·ERP·시스템 작업, 타팀 지원 요청',
  pm: '신제품·품번 개발, 카탈로그·웹카탈로그, 가격표, 경쟁사·시장 조사, 전시회, 마케팅 지출·광고·SNS',
  wh: '입고·출고, 재고·재고실사, 랙/로케이션·창고 이동, 포장·배송·운송, 수입 통관·컨테이너',
  mgmt: '인사·채용·급여·조직, 자금·재무·환율·은행, 본사/투자자 보고, 법무·계약·세무, 전략 결정·전사 이슈',
};

const MAX_CHARS_PER_DAY = 6000;    // 하루 일지 원문 상한(잘릴 때는 앞부분 유지)
const MAX_CHARS_TOTAL = 26000;     // 전체 상한 — 초과분은 오래된 날짜부터 줄인다
export const MAX_RANGE_DAYS = 14;  // 요청 가능한 최대 기간(월~금이 기본이므로 넉넉)
const MAX_THIS = 8;                // 카테고리별 「이번주」 최대 불릿 수
const MAX_NEXT = 6;                // 카테고리별 「다음주」 최대 불릿 수
const MAX_BULLET_LEN = 300;

const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];

// 'YYYY-MM-DD' → '9/1(월)'. Date 객체를 쓰지 않고 문자열로만 계산(타임존 영향 제거).
export function dayLabel(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return String(dateStr || '');
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dow = DOW_KO[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${mo}/${d}(${dow})`;
}

export function isDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const [y, m, d] = String(s).split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function daysBetween(from, to) {
  const a = Date.parse(from + 'T00:00:00Z'), b = Date.parse(to + 'T00:00:00Z');
  return Math.round((b - a) / 86400000) + 1;
}

// 기록 원문을 상한 안으로 압축. 최신 날짜를 우선 보존(회의는 최근 일이 더 중요).
export function condenseEntries(entries) {
  const clipped = entries.map((e) => ({
    date: e.date,
    content: String(e.content || '').slice(0, MAX_CHARS_PER_DAY),
  }));
  let total = clipped.reduce((s, e) => s + e.content.length, 0);
  for (let i = 0; i < clipped.length && total > MAX_CHARS_TOTAL; i++) {
    const over = total - MAX_CHARS_TOTAL;
    const keep = Math.max(400, clipped[i].content.length - over);
    total -= clipped[i].content.length - keep;
    clipped[i].content = clipped[i].content.slice(0, keep) + '\n…(이하 생략)';
  }
  return clipped;
}

export function buildDraftPrompt(entries, from, to) {
  const body = entries
    .map((e) => `### ${dayLabel(e.date)} (${e.date})\n${e.content}`)
    .join('\n\n');
  const cats = ORG_KEYS
    .map((k) => `- "${k}" = ${ORG_LABEL[k]} : ${ORG_SCOPE[k]}`)
    .join('\n');

  return [
    '당신은 멕시코 자동차 부품 유통사 Refatrix 의 주간 비즈니스 리뷰(WBR) 준비를 돕습니다.',
    '아래는 디렉터가 ERP 일정 화면에 직접 쓴 「나의 기록」 원문입니다.',
    `기간: ${from} ~ ${to} (${dayLabel(from)}~${dayLabel(to)})`,
    '',
    '## 나의 기록 원문',
    body,
    '',
    '## 할 일',
    '이 기록을 읽고 조직별 주간 이슈 보드의 초안을 만드세요. 조직 5개는 다음과 같습니다.',
    cats,
    '',
    '각 조직마다 두 칸을 채웁니다.',
    '- "this" (이번주): 이번 주에 실제로 일어난 일 · 처리한 일 · 확인된 사실.',
    '- "next" (다음주): 기록에서 미결·진행중·후속조치로 읽히는 일. 다음 주에 할 일로 다시 쓴다.',
    '',
    '## 작성 규칙',
    '1. 기록에 없는 내용을 지어내지 마세요. 추측·일반론·조언 금지. 근거가 없으면 빈 배열로 둡니다.',
    '2. 숫자·금액·고객명·품번·사람 이름은 기록에 적힌 그대로 옮깁니다(반올림·환산 금지).',
    '3. 불릿 하나는 한 줄, 한국어 40~90자 정도. 회의에서 소리내어 읽을 수 있는 완결된 문장으로.',
    '4. 여러 날에 걸친 같은 사안은 한 줄로 합치고 필요하면 진행을 표시합니다. 예: `9/1 견적 발송 → 9/3 단가 재협상 → 9/4 수주 확정`.',
    '5. 한 사안은 가장 알맞은 조직 한 곳에만 넣습니다(중복 배치 금지).',
    '6. 어느 조직에도 명확히 속하지 않는 전사 사안은 "mgmt"(경영총괄)에 넣습니다.',
    `7. 개수 상한: 조직별 "this" 최대 ${MAX_THIS}개, "next" 최대 ${MAX_NEXT}개. 중요한 것부터.`,
    '8. 사적인 내용·건강·개인 감정 기록은 제외합니다(업무 이슈만).',
    '',
    '## 출력 형식 — 아래 JSON 객체 하나만 출력하세요. 코드펜스·설명·머리말 없이 JSON 만.',
    '{',
    ORG_KEYS.map((k) => `  "${k}": { "this": ["…"], "next": ["…"] }`).join(',\n'),
    '}',
  ].join('\n');
}

// 모델 응답 → 안전한 draft 객체. 실패하면 null(호출측이 502 처리).
export function parseDraft(text) {
  let s = String(text || '').trim();
  if (!s) return null;
  // ```json … ``` 코드펜스 제거
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  // 앞뒤에 설명이 붙어 온 경우 첫 { ~ 마지막 } 만 취한다
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  let obj;
  try { obj = JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const clean = (arr, max) => {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const v of arr) {
      if (typeof v !== 'string') continue;
      const t = v.replace(/\s+/g, ' ').replace(/^[-•*\s]+/, '').trim().slice(0, MAX_BULLET_LEN);
      if (!t) continue;
      if (out.indexOf(t) >= 0) continue;
      out.push(t);
      if (out.length >= max) break;
    }
    return out;
  };

  const draft = {};
  let total = 0;
  for (const k of ORG_KEYS) {
    const src = (obj[k] && typeof obj[k] === 'object') ? obj[k] : {};
    const th = clean(src.this, MAX_THIS);
    const nx = clean(src.next, MAX_NEXT);
    draft[k] = { this: th, next: nx };
    total += th.length + nx.length;
  }
  if (!total) return null;
  return draft;
}

export function draftIsEmpty(draft) {
  return !ORG_KEYS.some((k) => (draft[k].this.length + draft[k].next.length) > 0);
}
