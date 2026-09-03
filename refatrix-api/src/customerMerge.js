// =====================================================================
// Refatrix ERP · 고객 병합(디렉터) — 순수 함수 모듈  build merge-0903
//
//   문제: 같은 RFC 인데 고객번호(C-0034 / C-0052)가 나뉘어 등록된 건이 있다.
//        그 결과 상담·방문 기록이 두 고객에 흩어져, 어느 쪽을 열어도 반쪽만 보인다.
//        0188 인수인계 ⑨ 의 「RFC 중복 정리 화면 — 병합」 후속 항목이 이것이다.
//
//   방침(디렉터 확정 2026-09-03):
//     · **복사가 아니라 이관**이다. customer_id 만 바꾼다.
//       사본을 만들면 녹음 요약에서 자동 등록된 후속조치까지 복제되어
//       영업사원 화면에 같은 할 일이 두 번 뜬다. 원장은 하나여야 한다.
//     · 옮기는 것은 **상담·방문 계열 3종뿐**이다(아래 MERGE_MOVES).
//       견적·매출·미수는 회계 영향이 있어 이 화면에서 건드리지 않는다 —
//       대신 미리보기에서 「남는 것」으로 전부 세어 보여 주고, 디렉터가 확인(ack)해야 실행된다.
//     · 녹음·후속조치는 visit_id / consult_id 로 매달려 있어 **따라온다**(별도 UPDATE 불필요).
//     · place_name / company_name 스냅샷은 **바꾸지 않는다**. 그날 그 이름으로 방문한 것이 사실이고,
//       지점명이 남아 있어야 나중에 왜 나뉘었는지 추적된다.
//
//   이 파일은 「무엇을 옮기는가 · 옮겨도 되는가 · 뭐라고 말할 것인가」만 담는다.
//   실제 UPDATE 는 customerRoutes 의 단일 트랜잭션에서 한다.
// =====================================================================

// 이관 대상 — 순서가 곧 화면 표시 순서다.
export const MERGE_MOVES = [
  {
    key: 'visits', table: 'sales_visits', col: 'customer_id', label: '현장 방문',
    // 자식은 부모 id 로 매달려 있어 자동으로 따라온다(건수만 세어 보여 준다).
    children: [
      { table: 'sales_visit_pendings', fk: 'visit_id', label: '후속조치' },
      { table: 'sales_visit_recordings', fk: 'visit_id', label: '녹음' },
    ],
  },
  {
    key: 'meetings', table: 'customer_meetings', col: 'customer_id', label: '수기 미팅',
    // 체크인이 자동 생성한 `[현장방문]` 미팅도 같이 옮긴다 —
    // 남겨 두면 방문은 옮겨졌는데 그 방문의 미팅만 옛 고객에 남아 단계 이력이 어긋난다.
    children: [],
  },
  {
    key: 'consults', table: 'sales_consults', col: 'customer_id', label: '고객상담',
    children: [
      { table: 'sales_consult_pendings', fk: 'consult_id', label: '후속조치' },
      { table: 'sales_consult_recordings', fk: 'consult_id', label: '녹음' },
    ],
  },
];

// 「남는 것」 집계에서 빼는 테이블 = 이번에 옮기는 부모·자식 전부.
export const MOVED_TABLES = new Set(
  MERGE_MOVES.flatMap((m) => [m.table, ...m.children.map((c) => c.table)]),
);

// 잔여 FK 를 사람 말로 — 모르는 테이블은 이름 그대로 보여 준다(빠뜨리지 않는 게 우선).
const RESIDUAL_LABELS = {
  quotes: '견적', quote_items: '견적 품목',
  sales: '매출', sales_items: '매출 품목',
  invoices: '인보이스', invoice_payments: '입금',
  ar_plans: '수금 계획', ar_plan_lines: '수금 계획 상세',
  customer_documents: '증빙서류',
  customer_change_requests: '수정 요청',
  customer_registration_events: '등록·선점 이력',
  customer_rfc_claims: 'RFC 선점 이관 요청',
  customer_stage_history: '단계 이력',
  customer_ship_addresses: '배송지',
  offer_sheets: '오퍼시트',
  field_surveys: '현장 재고조사',
  exhibition_meetings: '전시회 미팅',
  bank_deposits: '은행 입금',
  transactions: '거래(회계)',
};
export function residualLabel(table) {
  return RESIDUAL_LABELS[table] || table;
}

// 카탈로그에서 읽은 식별자만 쓰지만, 동적 SQL 에 넣기 전에 한 번 더 조인다.
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
export function safeIdent(s) { return IDENT_RE.test(String(s == null ? '' : s)); }

/**
 * 병합 가능 여부. blockers 가 하나라도 있으면 실행하지 않는다.
 * from/into 는 customers 행(id·code·name·rfc·rfc_norm·deleted_at·approval_status·
 * team_id·owner_id·owner_name·team_name·rfc_claim_exempt).
 */
export function checkMerge(from, into) {
  const blockers = []; const warnings = [];
  if (!from) blockers.push({ code: 'from_not_found', note: '옮길 고객을 찾을 수 없습니다.' });
  if (!into) blockers.push({ code: 'into_not_found', note: '남길 고객을 찾을 수 없습니다.' });
  if (blockers.length) return { blockers, warnings };

  if (Number(from.id) === Number(into.id)) {
    blockers.push({ code: 'same_customer', note: '같은 고객입니다 — 옮길 곳과 남길 곳이 달라야 합니다.' });
  }
  if (from.deleted_at) blockers.push({ code: 'from_deleted', note: '옮길 고객이 이미 삭제된 상태입니다.' });
  if (into.deleted_at) blockers.push({ code: 'into_deleted', note: '남길 고객이 삭제된 상태입니다 — 살아 있는 고객으로만 합칠 수 있습니다.' });
  if (String(into.approval_status || 'approved') === 'rejected') {
    blockers.push({ code: 'into_rejected', note: '반려된 고객으로는 합칠 수 없습니다.' });
  }

  // 경고 — 막지는 않되 디렉터가 읽고 판단해야 하는 것들.
  const fr = from.rfc_norm || null; const ir = into.rfc_norm || null;
  if (fr && ir && fr !== ir) {
    warnings.push({ code: 'rfc_differs',
      note: `RFC 가 서로 다릅니다 — 옮길 쪽 ${from.rfc || '—'} · 남길 쪽 ${into.rfc || '—'}. 정말 같은 회사인지 확인하세요.` });
  }
  if (fr && !ir) {
    warnings.push({ code: 'into_rfc_missing',
      note: `남길 고객에 RFC 가 없습니다. 이대로 합치면 RFC ${from.rfc} 가 함께 사라져 선점 보호를 못 받습니다 — `
          + '먼저 남길 고객에 RFC 를 넣고 병합하세요.' });
  }
  if (String(into.approval_status || 'approved') === 'pending') {
    warnings.push({ code: 'into_pending', note: '남길 고객이 아직 등록 승인 대기입니다 — 승인해야 견적·매출에 쓸 수 있습니다.' });
  }
  if (from.team_id != null && into.team_id != null && Number(from.team_id) !== Number(into.team_id)) {
    warnings.push({ code: 'team_differs',
      note: `담당 팀이 다릅니다 — ${from.team_name || '팀 미지정'} → ${into.team_name || '팀 미지정'}. `
          + '병합하면 그 상담·방문 기록이 남길 고객의 팀으로 넘어갑니다.' });
  }
  if (from.owner_id != null && into.owner_id != null && Number(from.owner_id) !== Number(into.owner_id)) {
    warnings.push({ code: 'owner_differs',
      note: `담당자가 다릅니다 — ${from.owner_name || '미지정'} → ${into.owner_name || '미지정'}. `
          + '기록을 남긴 사람(작성자)은 바뀌지 않지만, 커미션 귀속은 남길 고객 기준이 됩니다.' });
  }
  return { blockers, warnings };
}

/** 미리보기 moves 배열 → 합계(부모 기준). 자식은 따라오는 것이라 합계에 넣지 않는다. */
export function moveTotal(moves) {
  return (moves || []).reduce((s, m) => s + (Number(m.cnt) || 0), 0);
}

/** 실행 결과 한 줄 안내. */
export function mergeNote(counts, { fromName, intoName, closed, residualTotal = 0 } = {}) {
  const parts = MERGE_MOVES
    .map((m) => ({ label: m.label, n: Number(counts?.[m.key]) || 0 }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.label} ${x.n}건`);
  const moved = parts.length ? parts.join(' · ') : '옮길 기록이 없었습니다';
  const tail = closed
    ? ` ${fromName} 은(는) 종료 처리했습니다(목록에서 사라집니다).`
    : ` ${fromName} 은(는) 그대로 두었습니다 — 기록만 비워졌습니다.`;
  const res = residualTotal > 0
    ? ` 견적·매출 등 ${residualTotal}건은 옮기지 않았습니다(이 화면의 범위가 아닙니다).`
    : '';
  return `${fromName} → ${intoName} 로 ${moved} 을(를) 옮겼습니다.${tail}${res}`;
}
