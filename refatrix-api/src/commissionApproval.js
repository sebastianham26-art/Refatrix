// =====================================================================
// Refatrix ERP · commissionApproval.js  (0287 · 2026-10-19)
//   재무 › 커미션 ↔ 전자결재 연동 — 순수 함수 + 작은 DB 헬퍼.
//
//   · buildSnapshot   : 지급 대상(확정·미지급 인보이스 + 성과급 + 지급 후 조정)을 문서에 박제할 JSON 으로.
//   · compareSnapshot : 수령증 업로드 시점의 지급 대상이 결재받은 내역과 같은가(다르면 지급 차단).
//   · docTitle / bodyNodes : 자동 생성 문서의 제목·본문(요약 문단). 상세 표는 snapshot 으로 화면·인쇄에서 그린다.
//   · resolveCurrentDoc : 연결된 원문서 → 재기안 최신 버전(parent_id 체인).
//   · linkForDoc      : 어떤 문서(재기안 버전 포함)가 커미션 문서인가 → 연결 행.
//   라우트(commissionRoutes · approvalRoutes)는 이 파일만 가져다 쓴다.
// =====================================================================

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => (v == null || v === '' ? null : Number(v));

export const COMMISSION_CATEGORY = '영업 커미션';

// 'YYYY-MM' → 'YYYY년 M월'
export function ymLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  return m ? `${m[1]}년 ${Number(m[2])}월` : String(ym || '');
}

// 지급 대상 → 스냅샷(순수). lines 는 payableLines() 결과, bonus 는 payableBonus(), adjustments 는 pendingAdjustments().
export function buildSnapshot({ agentId, agentName, settleYm, payDate, lines = [], bonus = null, adjustments = [] }) {
  const L = lines.map((l) => ({
    invoice_id: Number(l.invoice_id),
    sat_no: l.sat_no || null,
    inv_date: l.inv_date ? String(l.inv_date).slice(0, 10) : null,
    customer_name: l.customer_name || '',
    customer_code: l.customer_code || null,
    basis: l.basis === 'revenue' ? 'revenue' : 'collection',
    mode: l.mode || null,
    rate: num(l.rate) ?? 0,
    base: r2(l.base),                                   // 인보이스 순매출(ex-IVA · NC 차감)
    collected_base: l.collected_base == null ? null : r2(l.collected_base),   // 수금일 판정: 기간 안 수금분(ex-IVA)
    paid_amount: l.paid_amount == null ? null : r2(l.paid_amount),            // 현금 수금 합계(IVA 포함)
    last_pay_date: l.last_pay_date ? String(l.last_pay_date).slice(0, 10) : null,
    commission_base: r2(l.mode === 'payment' && l.collected_base != null ? l.collected_base : l.base),
    expected: r2(l.expected),
  }));
  const adj = adjustments.map((a) => ({
    invoice_id: Number(a.invoice_id), sat_no: a.sat_no || null, inv_date: a.inv_date || null,
    customer_name: a.customer_name || '', reason: a.reason || null,
    paid_base: r2(a.paid_base), new_base: r2(a.new_base), paid_amount: r2(a.paid_amount), amount: r2(a.amount),
  }));
  const commissionTotal = r2(L.reduce((s, l) => s + l.expected, 0));
  const adjustmentTotal = r2(adj.reduce((s, a) => s + a.amount, 0));
  const bonusAmt = bonus ? r2(bonus.amount) : 0;
  const total = r2(commissionTotal + bonusAmt + adjustmentTotal);
  const dates = (arr) => arr.filter(Boolean).sort();
  const inv = dates(L.map((l) => l.inv_date));
  const pay = dates(L.map((l) => l.last_pay_date));
  return {
    v: 1,
    agent_id: Number(agentId), agent_name: agentName || '',
    settle_ym: settleYm, pay_date: payDate || null,
    period: {
      inv_from: inv[0] || null, inv_to: inv[inv.length - 1] || null,
      pay_from: pay[0] || null, pay_to: pay[pay.length - 1] || null,
    },
    lines: L,
    bonus: bonus ? {
      id: Number(bonus.id), amount: bonusAmt, basis: bonus.basis || null,
      target_amount: num(bonus.target_amount), actual_amount: num(bonus.actual_amount), achieved_rate: num(bonus.achieved_rate),
    } : null,
    adjustments: adj,
    commission_total: commissionTotal, bonus_total: bonusAmt, adjustment_total: adjustmentTotal, total,
    invoice_count: L.length,
  };
}

export function parseSnapshot(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

// 결재받은 내역(snap) vs 지금 지급 대상(cur, buildSnapshot 결과). 반환 { ok, diffs: [문장] }.
//   같은 인보이스 집합·같은 커미션 금액·같은 성과급·같은 조정·같은 합계여야 ok.
export function compareSnapshot(snap, cur) {
  const diffs = [];
  if (!snap || !cur) return { ok: false, diffs: ['비교할 내역이 없습니다.'] };
  const key = (l) => String(l.invoice_id);
  const a = new Map((snap.lines || []).map((l) => [key(l), l]));
  const b = new Map((cur.lines || []).map((l) => [key(l), l]));
  for (const [k, l] of a) {
    if (!b.has(k)) diffs.push(`결재 내역의 인보이스 ${l.sat_no || '#' + k} 가 지금 지급 대상에 없습니다(이미 지급·취소·조정).`);
    else if (Math.abs(r2(b.get(k).expected) - r2(l.expected)) > 0.009) diffs.push(`인보이스 ${l.sat_no || '#' + k} 커미션 ${r2(l.expected)} → ${r2(b.get(k).expected)}`);
  }
  for (const [k, l] of b) if (!a.has(k)) diffs.push(`결재 후 지급 대상에 인보이스 ${l.sat_no || '#' + k} (${l.customer_name}) 커미션 ${r2(l.expected)} 이 추가됐습니다.`);
  const sb = snap.bonus ? r2(snap.bonus.amount) : 0, cb = cur.bonus ? r2(cur.bonus.amount) : 0;
  if (Math.abs(sb - cb) > 0.009) diffs.push(`성과급 ${sb} → ${cb}`);
  const sa = r2(snap.adjustment_total), ca = r2(cur.adjustment_total);
  if (Math.abs(sa - ca) > 0.009) diffs.push(`지급 후 조정 ${sa} → ${ca}`);
  if (!diffs.length && Math.abs(r2(snap.total) - r2(cur.total)) > 0.009) diffs.push(`지급 합계 ${r2(snap.total)} → ${r2(cur.total)}`);
  return { ok: diffs.length === 0, diffs };
}

export function docTitle(snap) {
  return `커미션 지급 승인 · ${snap.agent_name || '영업사원'} · ${ymLabel(snap.settle_ym)} 반제분`;
}

const fm = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// 본문 요약 문단(평문 검색·엑셀용). 인보이스별 표는 snapshot 으로 상세·인쇄에 그린다.
export function bodyNodes(snap) {
  const p = snap.period || {};
  const lines = [
    `■ 지급 대상: ${snap.agent_name}`,
    `■ 기간: ${ymLabel(snap.settle_ym)} 반제(완납) 확정분${p.inv_from ? ` · 인보이스 발행 ${p.inv_from} ~ ${p.inv_to}` : ''}${p.pay_from ? ` · 수금 ${p.pay_from} ~ ${p.pay_to}` : ''}`,
    `■ 내역: 인보이스 ${snap.invoice_count}건 · 커미션 MXN ${fm(snap.commission_total)}`
      + (snap.bonus ? ` · 성과급 MXN ${fm(snap.bonus.amount)}` : '')
      + ((snap.adjustments || []).length ? ` · 지급 후 조정 ${snap.adjustment_total < 0 ? '−' : '+'}MXN ${fm(Math.abs(snap.adjustment_total))}` : ''),
    `■ 지급 합계: MXN ${fm(snap.total)} (현금 지급 · IVA 없음)`,
    `■ 지급 방법: 결재 승인 후 현금 지급 → 수령인이 수령증(Recibo)에 서명 → 서명본 스캔을 커미션 화면에서 올리면 지급 전표(반제)와 이 문서의 집행이 함께 마감됩니다.`,
    `※ 인보이스별 고객·매출/수금·율·커미션은 아래 「커미션 지급 내역」 표(재무 › 커미션에서 자동 생성)를 참고하세요.`,
  ];
  return lines.map((v) => ({ t: 'p', v }));
}

// 문서 상태 → 커미션 화면 표시용 단계
//   none · draft · progress · rejected · approved(지급 대기) · settled(지급·마감) · deleted
export function docPhase(doc, link) {
  if (!doc) return 'none';
  if (link && link.commission_payment_id) return 'settled';
  if (doc.deleted_at) return 'deleted';
  if (doc.status === 'draft') return 'draft';
  if (doc.status === 'progress') return 'progress';
  if (doc.status === 'rejected') return 'rejected';
  if (doc.status === 'approved') return 'approved';
  return 'none';
}
// 새 문서를 만들 수 있나: 연결이 없거나, 최신 문서가 삭제·반려됐거나, 이미 지급·마감됐을 때(그 뒤 새로 확정된 분)만 — 이중 결재 방지
export const canCreateAgain = (phase) => ['none', 'deleted', 'rejected', 'settled'].includes(phase);

// ── DB 헬퍼 (q = query 함수) ───────────────────────────────────────────
let _ready = { v: null, at: 0 };
export async function commissionApprovalReady(q) {
  if (_ready.v === true) return true;
  if (_ready.v === false && Date.now() - _ready.at < 60000) return false;
  const r = await q(`SELECT 1 FROM information_schema.tables WHERE table_name='commission_approval_docs'`);
  _ready = { v: r.rows.length > 0, at: Date.now() };
  return _ready.v;
}

// 재기안 체인의 최신 버전(삭제 포함) — 원문서 id 로부터
export async function resolveCurrentDoc(q, docId) {
  let cur = Number(docId);
  for (let i = 0; i < 20; i++) {
    const kid = (await q(`SELECT id FROM approval_documents WHERE parent_id=$1 ORDER BY version DESC, id DESC LIMIT 1`, [cur])).rows[0];
    if (!kid) break;
    cur = Number(kid.id);
  }
  return cur;
}

// 이 문서(또는 재기안 원문서)가 커미션 문서면 연결 행
export async function linkForDoc(q, docId) {
  let cur = Number(docId);
  for (let i = 0; i < 20 && cur; i++) {
    const l = (await q(`SELECT * FROM commission_approval_docs WHERE document_id=$1`, [cur])).rows[0];
    if (l) return normLink(l);
    const p = (await q(`SELECT parent_id FROM approval_documents WHERE id=$1`, [cur])).rows[0];
    cur = p && p.parent_id ? Number(p.parent_id) : 0;
  }
  return null;
}

export function normLink(l) {
  if (!l) return null;
  return {
    id: Number(l.id), document_id: Number(l.document_id), agent_id: Number(l.agent_id), settle_ym: l.settle_ym,
    total: Number(l.total), snapshot: parseSnapshot(l.snapshot),
    created_by: num(l.created_by), created_at: l.created_at,
    commission_payment_id: num(l.commission_payment_id), settled_document_id: num(l.settled_document_id),
    settled_at: l.settled_at || null, settled_by: num(l.settled_by),
  };
}
