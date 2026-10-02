// 전자결재(0234) — DB·HTTP 에 의존하지 않는 순수 규칙.
//   라우트(routes/approvalRoutes.js)와 테스트가 같은 함수를 쓴다.
//
//   결재 흐름: 기안 → [카테고리 템플릿: 중간결재·합의·경유] → 디렉터 결재
//              → [기준액 이상] 대표이사 사전승인 → 승인완료(집행대기)
//              → 재무 집행(실적 입력) → 대표이사 사후승인 → 완결
//   디렉터 기안: 템플릿 대신 「재무 합의 포함」 토글(include_finance). 본인 결재 칸은 자동 완료.
//   대표이사 기안: 사전승인 생략, 사후승인은 디렉터가 한다(자기 문서 자기 확인 방지).
//   0247 집행 단계 넣기/빼기(exec_required): 빼면 승인완료 시 예정 금액으로 집행완료 → 바로 사후승인(라우트 autoExecute).
import { createHash } from 'node:crypto';
import { cleanFileName } from './txnFiles.js';

export { cleanFileName };

export const APPROVAL_FILE_MAX_BYTES = 20 * 1024 * 1024;       // 파일당 20MB(디렉터 결정 2026-09-29)
export const APPROVAL_FILE_BODY_LIMIT = 29 * 1024 * 1024;      // base64(×4/3) + JSON 여유 — 파일 업로드 라우트 전용
export const KINDS = ['견적서', '계약서', 'Factura XML', 'Factura PDF', '송금증', '영수증', '결재문서', '기타'];
export const EXEC_KINDS = ['Factura XML', 'Factura PDF', '송금증'];   // 집행완료에 필요한 실적 증빙
export const PAY_METHODS = ['계좌이체', '법인카드', '현금', '수표'];
export const IVA_RATE = 0.16;

export const STEP_LABEL = {
  draft: '기안', approve: '중간결재', agree: '합의', pass: '경유', director: '디렉터 결재',
  pre_ceo: '대표이사 사전승인', post_ceo: '대표이사 사후승인',
};
export const REQUEST_KIND = {
  approve: '결재 요청', director: '결재 요청', agree: '합의 요청', pass: '경유 요청',
  pre_ceo: '사전승인 요청', post_ceo: '사후승인 요청',
};

// 확장자 → 표준 MIME. 브라우저가 빈 MIME(application/octet-stream)을 주는 .msg·.heic 도 확장자로 받는다.
export const EXT_MIME = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif',
  xml: 'application/xml',
  zip: 'application/zip',
  eml: 'message/rfc822',
  msg: 'application/vnd.ms-outlook',
};

export const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
export const round2 = (v) => Math.round((n(v) + Number.EPSILON) * 100) / 100;
export const sameId = (a, b) => a != null && b != null && Number(a) === Number(b);

export function fileExt(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  return m ? m[1] : '';
}

// 업로드 검증: data URL(base64) → Buffer. 형식은 확장자 허용목록으로 판단(MIME 은 표준값으로 교정).
export function decodeApprovalFile(dataUrl, fileName, maxBytes = APPROVAL_FILE_MAX_BYTES) {
  if (typeof dataUrl !== 'string' || !dataUrl) return { ok: false, error: 'empty' };
  const m = dataUrl.match(/^data:([^;,]*);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) return { ok: false, error: 'bad_format' };
  const name = cleanFileName(fileName);
  if (!name) return { ok: false, error: 'no_name' };
  const ext = fileExt(name);
  const mime = EXT_MIME[ext];
  if (!mime) return { ok: false, error: 'bad_type', ext };
  const b64 = m[2].replace(/\s+/g, '');
  const pad = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
  const est = Math.floor((b64.length * 3) / 4) - pad;
  if (est <= 0) return { ok: false, error: 'empty_data' };
  if (est > maxBytes) return { ok: false, error: 'too_large', bytes: est };
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return { ok: false, error: 'empty_data' };
  if (buf.length > maxBytes) return { ok: false, error: 'too_large', bytes: buf.length };
  return { ok: true, name, ext, mime, bytes: buf.length, buf };
}

export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

// CFDI(멕시코 전자 세금계산서) XML — 총액·UUID·발행자 RFC 만 뽑는다. 실패하면 null.
export function parseCfdi(text) {
  const s = String(text || '');
  if (!/Comprobante/i.test(s)) return null;
  const tot = s.match(/<(?:cfdi:)?Comprobante\b[^>]*?\sTotal="([\d.]+)"/i);
  const uuid = s.match(/\bUUID="([0-9A-Fa-f-]{20,})"/);
  const rfc = s.match(/<(?:cfdi:)?Emisor\b[^>]*?\sRfc="([^"]+)"/i);
  if (!tot && !uuid) return null;
  return {
    uuid: uuid ? uuid[1].toUpperCase() : null,
    rfc: rfc ? rfc[1] : null,
    total: tot ? round2(tot[1]) : null,
  };
}

export function guessKind(name) {
  const s = String(name || '').toLowerCase();
  if (s.endsWith('.xml')) return 'Factura XML';
  if (/factura|cfdi/.test(s) && s.endsWith('.pdf')) return 'Factura PDF';
  if (/송금|spei|transfer|comprobante/.test(s)) return '송금증';
  if (/견적|cotiz|quote/.test(s)) return '견적서';
  if (/계약|contrato/.test(s)) return '계약서';
  if (/\.(jpe?g|png|heic|heif|webp|gif)$/.test(s)) return '영수증';
  return '기타';
}
export const normKind = (k) => (KINDS.includes(k) ? k : '기타');

// 소계 + IVA 16% → 금액 3종
export function calcAmounts(sub, ivaApplied = true) {
  const s = round2(sub);
  const iva = ivaApplied ? round2(s * IVA_RATE) : 0;
  return { planned_sub: s, planned_iva: iva, planned_total: round2(s + iva) };
}
export const basisAmount = (doc, basis) => n(basis === 'sub' ? doc.planned_sub : doc.planned_total);

// 로그인 사용자의 결재 모듈 내 역할
export function roleCtx(perm, settings) {
  const uid = Number(perm.userId);
  return {
    uid,
    role: perm.role,
    isDirector: perm.role === 'director',
    isCeo: sameId(uid, settings.ceo_user_id),
    isFinance: perm.role === 'treasury' || sameId(uid, settings.finance_user_id),
  };
}

// ── 결재선 생성(상신 시점) ─────────────────────────────────────────────
//   반환: [{step_order, step_type, user_id, status, comment}]  (status: draft=done, 나머지 waiting)
//   오류: { error: 'director_unset' | 'ceo_unset' }
export function buildLines({ drafterId, drafterIsDirector, catSteps = [], doc, customSteps = null }, settings) {
  const dirId = settings.director_user_id != null ? Number(settings.director_user_id) : null;
  const ceoId = settings.ceo_user_id != null ? Number(settings.ceo_user_id) : null;
  const finId = settings.finance_user_id != null ? Number(settings.finance_user_id) : null;
  const me = Number(drafterId);
  const isDir = !!drafterIsDirector || sameId(me, dirId);
  if (!isDir && dirId == null) return { error: 'director_unset' };
  if (ceoId == null) return { error: 'ceo_unset' };

  const lines = [{ step_order: 0, step_type: 'draft', user_id: me, status: 'done', comment: null }];
  let o = 1;
  const add = (type, uid) => {
    if (uid == null) return;
    const u = Number(uid);
    if (u === me) return;                                                 // 본인 칸 생략
    if (lines.some((l) => l.step_type === type && l.user_id === u)) return; // 중복 제거
    lines.push({ step_order: o++, step_type: type, user_id: u, status: 'waiting', comment: null });
  };
  if (isDir) {
    // 디렉터 본인 결재(자동 완료) → 그 뒤 단계: 작성 화면에서 직접 짠 목록(custom_steps) 또는 재무 합의 토글
    lines.push({ step_order: o++, step_type: 'director', user_id: me, status: 'done', comment: '기안자 결재 (디렉터 기안)' });
    if (Array.isArray(customSteps)) customSteps.forEach((st) => add(st.step_type, st.user_id));
    else if (doc.include_finance) add('agree', finId);
  } else {
    [...catSteps].sort((a, b) => n(a.step_order) - n(b.step_order) || n(a.id) - n(b.id))
      .forEach((s) => add(s.step_type, s.user_id));
    lines.push({ step_order: o++, step_type: 'director', user_id: dirId, status: 'waiting', comment: null });
  }
  const ceoDrafter = sameId(me, ceoId);
  const hasPre = lines.some((l) => l.step_type === 'pre_ceo');
  const pre = hasPre || (!ceoDrafter && basisAmount(doc, settings.threshold_basis) >= n(settings.ceo_pre_threshold));
  if (pre && !hasPre) lines.push({ step_order: o++, step_type: 'pre_ceo', user_id: ceoId, status: 'waiting', comment: null });
  // 사후승인 — 대표이사 기안이면 디렉터가 확인
  const postUser = ceoDrafter ? (dirId ?? me) : ceoId;
  lines.push({ step_order: 99, step_type: 'post_ceo', user_id: postUser, status: 'waiting', comment: null });
  return { lines, ceoPre: pre };
}

// 다음 단계 활성화: pending(사후 제외)이 남아 있으면 그대로, 없으면 가장 낮은 순번의 waiting 을 pending 으로.
//   남은 게 없으면 { approved: true }. lines 는 그 자리에서 바뀐다(호출자가 DB 반영).
export function advance(lines) {
  const main = lines.filter((l) => l.step_type !== 'post_ceo');
  if (main.some((l) => l.status === 'pending')) return { approved: false, activated: [] };
  const rem = main.filter((l) => l.status === 'waiting');
  if (!rem.length) return { approved: true, activated: [] };
  const o = Math.min(...rem.map((l) => n(l.step_order)));
  const act = rem.filter((l) => n(l.step_order) === o);
  act.forEach((l) => { l.status = 'pending'; });
  return { approved: false, activated: act };
}

export const postLine = (lines) => lines.find((l) => l.step_type === 'post_ceo') || null;
export const myPending = (ctx, lines) => lines.find((l) => l.status === 'pending' && sameId(l.user_id, ctx.uid)) || null;

// 볼 수 있는 문서인가
export function canSeeDoc(ctx, doc, lines, viewers) {
  if (sameId(doc.drafter_id, ctx.uid)) return true;
  if (doc.status === 'draft') return false;
  if (ctx.isDirector || ctx.isCeo) return true;
  if (ctx.isFinance && doc.status === 'approved') return true;
  if (lines.some((l) => sameId(l.user_id, ctx.uid))) return true;
  for (const v of viewers) {
    if (!sameId(v.user_id, ctx.uid)) continue;
    if (v.kind === 'ref') return true;
    if (v.kind === 'share' && doc.status === 'approved') return true;
  }
  return false;
}

// 내가 처리할 문서인가(결재·합의·사후승인 차례 / 재무 집행 / 이의제기 소명)
export function isTodo(ctx, doc, lines) {
  if (myPending(ctx, lines)) return true;
  if (ctx.isFinance && doc.status === 'approved' && doc.exec_status === 'pending') return true;
  if (doc.post_status === 'flagged' && sameId(doc.drafter_id, ctx.uid)) return true;
  return false;
}

// 게시판 단일 단계 키
export function stageKey(doc, lines) {
  if (doc.status === 'draft') return 'draft';
  if (doc.status === 'rejected') return 'rejected';
  if (doc.status === 'progress') {
    const p = lines.find((l) => l.status === 'pending' && l.step_type !== 'post_ceo');
    return p && p.step_type === 'pre_ceo' ? 'pre' : 'progress';
  }
  if (doc.exec_status !== 'done') return 'execwait';
  if (doc.post_status === 'flagged') return 'flagged';
  if (doc.post_status === 'confirmed') return 'closed';
  return 'postwait';
}

// 파일이 올라가는 시점의 단계
export function fileStage(doc) {
  if (doc.status === 'draft') return 'draft';
  if (doc.status !== 'approved') return 'progress';
  return doc.exec_status === 'done' ? 'post' : 'exec';
}

export function variancePct(doc) {
  if (doc.exec_status !== 'done' || !n(doc.planned_total)) return null;
  return round2(((n(doc.actual_total) - n(doc.planned_total)) / n(doc.planned_total)) * 100);
}

// 회수 가능: 진행 중 + 기안자 + 아직 다른 사람이 아무 처리도 안 함
export function withdrawable(ctx, doc, lines) {
  if (doc.status !== 'progress' || !sameId(doc.drafter_id, ctx.uid)) return false;
  return !lines.some((l) => !['draft', 'post_ceo'].includes(l.step_type) && !sameId(l.user_id, doc.drafter_id)
    && ['done', 'rejected'].includes(l.status));
}

// 화면에 보여줄 버튼 목록
export function allowedActions(ctx, doc, lines) {
  const a = [];
  const mine = myPending(ctx, lines);
  if (mine && doc.status === 'progress') {
    if (mine.step_type === 'pass') a.push('approve');
    else a.push('approve', 'reject');
  }
  if (mine && mine.step_type === 'post_ceo' && doc.post_status === 'pending') a.push('post_confirm', 'flag');
  const pl = postLine(lines);
  if (pl && sameId(pl.user_id, ctx.uid) && doc.post_status === 'flagged') a.push('close_flag');
  // 집행: 재무 담당(디렉터는 재무 부재 시 대행)
  if ((ctx.isFinance || ctx.isDirector) && doc.status === 'approved' && doc.exec_status === 'pending') a.push('execute');
  if (withdrawable(ctx, doc, lines)) a.push('withdraw');
  if (sameId(doc.drafter_id, ctx.uid) && doc.status === 'draft') a.push('edit', 'submit');
  if (sameId(doc.drafter_id, ctx.uid) && doc.status === 'rejected') a.push('resubmit');
  return a;
}

// 파일 권한
export function canDeleteFile(ctx, doc, f) {
  return !f.voided_at && sameId(f.uploaded_by, ctx.uid) && doc.status !== 'approved';
}
export function canVoidFile(ctx, doc, f) {
  return !f.voided_at && doc.status === 'approved' && (sameId(f.uploaded_by, ctx.uid) || ctx.isDirector);
}

// 문서번호
export const docNo = (year, no) => `EXP-${year}-${String(no).padStart(4, '0')}`;

// ── 예정 대비 실적 리포트(모듈 내부 집계 · 재무상태 미반영) ─────────────
//   docs: 승인완료 문서(상신월 = month) · catName(id) → 이름
export function reportRows(docs, catName) {
  const by = new Map();
  for (const d of docs) {
    const k = d.category_id == null ? 0 : Number(d.category_id);
    if (!by.has(k)) by.set(k, { category_id: k, name: catName(k), n: 0, plan: 0, execN: 0, actual: 0, diff: 0, unexec: 0, postOpen: 0 });
    const r = by.get(k);
    r.n += 1; r.plan += n(d.planned_total);
    if (d.exec_status === 'done') {
      r.execN += 1; r.actual += n(d.actual_total); r.diff += n(d.actual_total) - n(d.planned_total);
      if (d.post_status !== 'confirmed') r.postOpen += 1;
    } else r.unexec += n(d.planned_total);
  }
  const rows = [...by.values()].map((r) => ({ ...r, plan: round2(r.plan), actual: round2(r.actual), diff: round2(r.diff), unexec: round2(r.unexec) }));
  rows.sort((a, b) => b.plan - a.plan);
  const total = rows.reduce((t, r) => { for (const k of ['n', 'plan', 'execN', 'actual', 'diff', 'unexec', 'postOpen']) t[k] = round2(t[k] + r[k]); return t; },
    { n: 0, plan: 0, execN: 0, actual: 0, diff: 0, unexec: 0, postOpen: 0 });
  return { rows, total };
}

// 완결성 점검 — docs 는 볼 수 있는 전체 문서(files: [{kind, voided_at, dup_of}])
export function completenessChecks(docs, settings, nowMs = Date.now()) {
  const days = (t) => (t ? (nowMs - new Date(t).getTime()) / 864e5 : 0);
  const tol = n(settings.variance_tolerance_pct);
  const pick = (f) => docs.filter(f).map((d) => ({ id: Number(d.id), doc_no: d.doc_no }));
  return [
    { key: 'exec_no_evidence', label: '집행완료 · 실적증빙 없음',
      items: pick((d) => d.exec_status === 'done' && !(d.files || []).some((f) => !f.voided_at && EXEC_KINDS.includes(f.kind))) },
    { key: 'unexec_7d', label: '승인 후 7일 이상 미집행',
      items: pick((d) => d.status === 'approved' && d.exec_status === 'pending' && days(d.approved_at) > 7) },
    { key: 'post_wait_7d', label: '사후승인 7일 이상 대기',
      items: pick((d) => d.post_status === 'pending' && days(d.exec_at) > 7) },
    { key: 'flagged', label: '이의제기 미종결', items: pick((d) => d.post_status === 'flagged') },
    { key: 'over', label: `실적 초과 (+${tol}% 초과)`, items: pick((d) => { const v = variancePct(d); return v != null && v > tol; }) },
    { key: 'dup', label: '중복 증빙 의심', items: pick((d) => (d.files || []).some((f) => !f.voided_at && f.dup_of)) },
  ];
}

// ═══════════════════════════════════════════════════════════════════════
// 0237 — 통화(USD→MXN 환산) · 결제 방식(일시불/분할/정기) · 본문 그림
// ═══════════════════════════════════════════════════════════════════════
export const CURRENCIES = ['MXN', 'USD'];
export const PAYMENT_TYPES = ['once', 'installment', 'recurring'];
export const PAYMENT_TYPE_LABEL = { once: '일시불', installment: '분할 지급', recurring: '정기 지급' };
export const FREQS = { weekly: '매주', biweekly: '격주', monthly: '매월', quarterly: '분기' };
export const SCHEDULE_MAX = 60;          // 회차 상한(매주 1년 ≈ 52회)

const isYmd = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
export { isYmd };

// start(YYYY-MM-DD) 에서 i 번째 회차 날짜. 월 단위는 말일 보정(1/31 → 2/28 → 3/31).
export function addPeriod(start, freq, i) {
  const [y, m, d] = start.split('-').map(Number);
  let dt;
  if (freq === 'weekly' || freq === 'biweekly') {
    dt = new Date(Date.UTC(y, m - 1, d + i * (freq === 'weekly' ? 7 : 14)));
  } else {
    const months = i * (freq === 'quarterly' ? 3 : 1);
    const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
    dt = new Date(Date.UTC(y, m - 1 + months, Math.min(d, last)));
  }
  return dt.toISOString().slice(0, 10);
}

// 금액을 n 회로 나눔(마지막 회차가 단수 차이 흡수)
export function splitEven(total, count) {
  const per = round2(total / count);
  const rows = Array.from({ length: count }, () => per);
  rows[count - 1] = round2(total - per * (count - 1));
  return rows;
}

// 지급 일정 생성·검증 → { rows:[{seq,due_date,amount}], plan } | { error }
//   total: 문서 통화 IVA 포함 합계.
//   once        : pay_due 1회
//   installment : rows=[{due_date,amount}] 2~60회, 합계 = total(±0.01)
//   recurring   : plan={freq,count,start} → 같은 금액 count 회
export function buildSchedule({ type, total, pay_due, plan, rows }) {
  const tot = round2(total);
  if (type === 'recurring') {
    const freq = plan && plan.freq, count = Number(plan && plan.count), start = plan && plan.start;
    if (!FREQS[freq]) return { error: 'bad_freq' };
    if (!Number.isInteger(count) || count < 2 || count > SCHEDULE_MAX) return { error: 'bad_count' };
    if (!isYmd(start)) return { error: 'bad_start' };
    const amts = splitEven(tot, count);
    return {
      rows: amts.map((a, i) => ({ seq: i + 1, due_date: addPeriod(start, freq, i), amount: a })),
      plan: { freq, count, start, per_sub: plan.per_sub != null ? round2(plan.per_sub) : null },
    };
  }
  if (type === 'installment') {
    if (!Array.isArray(rows) || rows.length < 2 || rows.length > SCHEDULE_MAX) return { error: 'bad_count' };
    const out = [];
    for (const [i, r] of rows.entries()) {
      const a = round2(r && r.amount);
      if (!(a > 0)) return { error: 'bad_amount' };
      if (r.due_date != null && r.due_date !== '' && !isYmd(r.due_date)) return { error: 'bad_date' };
      out.push({ seq: i + 1, due_date: r.due_date || null, amount: a });
    }
    const sum = round2(out.reduce((s, r) => s + r.amount, 0));
    if (Math.abs(sum - tot) > 0.01) return { error: 'schedule_sum', sum, total: tot };
    return { rows: out, plan: null };
  }
  return { rows: [{ seq: 1, due_date: isYmd(pay_due) ? pay_due : null, amount: tot }], plan: null };
}

// 원통화 → MXN. 합계가 정확히 맞도록 IVA 는 합계 − 소계.
export function toMxn({ orig_sub, orig_total }, rate) {
  const r = n(rate) || 1;
  const planned_sub = round2(n(orig_sub) * r);
  const planned_total = round2(n(orig_total) * r);
  return { planned_sub, planned_iva: round2(planned_total - planned_sub), planned_total };
}
// 회차별 MXN — 합계가 planned_total 과 정확히 같도록 마지막 회차가 단수 흡수
export function paymentsMxn(amounts, rate, plannedTotal) {
  const r = n(rate) || 1;
  const out = amounts.map((a) => round2(n(a) * r));
  if (out.length) out[out.length - 1] = round2(n(plannedTotal) - out.slice(0, -1).reduce((s, x) => s + x, 0));
  return out;
}

// ── 본문(문단 + 그림) ──────────────────────────────────────────────────
export const BODY_IMG_MAX = 3 * 1024 * 1024;     // 그림 1장(data URL 길이) — 화면에서 1600px 로 줄여 보냄
export const BODY_TOTAL_MAX = 10 * 1024 * 1024;  // 본문 전체
export const BODY_NODES_MAX = 400;
export const APPROVAL_DOC_BODY_LIMIT = 16 * 1024 * 1024;   // 작성·수정 라우트 전용 bodyLimit
const IMG_SRC_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

// 입력: 배열 또는 JSON 문자열. 출력: { ok, nodes, plain } — 텍스트·그림 외 노드/속성은 버린다.
export function normalizeBodyRich(raw, fallbackText) {
  let arr = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch { return { ok: false, error: 'bad_body' }; } }
  if (arr == null) arr = fallbackText ? [{ t: 'p', v: String(fallbackText) }] : [];
  if (!Array.isArray(arr)) return { ok: false, error: 'bad_body' };
  if (arr.length > BODY_NODES_MAX) return { ok: false, error: 'body_too_long' };
  const nodes = [];
  let size = 0;
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue;
    if (x.t === 'p') {
      const v = String(x.v ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').slice(0, 20000);
      if (!v) continue;
      const prev = nodes[nodes.length - 1];
      if (prev && prev.t === 'p') prev.v = (prev.v + '\n' + v).slice(0, 20000);
      else nodes.push({ t: 'p', v });
      size += v.length;
    } else if (x.t === 'img') {
      const src = String(x.src || '');
      if (!IMG_SRC_RE.test(src)) return { ok: false, error: 'bad_image' };
      if (src.length > BODY_IMG_MAX) return { ok: false, error: 'image_too_large' };
      const w = Number.isInteger(x.w) && x.w > 0 && x.w <= 10000 ? x.w : null;
      const h = Number.isInteger(x.h) && x.h > 0 && x.h <= 10000 ? x.h : null;
      nodes.push({ t: 'img', src, w, h });
      size += src.length;
    }
  }
  if (size > BODY_TOTAL_MAX) return { ok: false, error: 'body_too_large' };
  const imgs = nodes.filter((x) => x.t === 'img').length;
  const plain = nodes.map((x) => (x.t === 'p' ? x.v : '[그림]')).join('\n').slice(0, 20000);
  return { ok: true, nodes, plain, images: imgs };
}

// ═══════════════════════════════════════════════════════════════════════
// 0244 — 결재선 수동 수정(디렉터) · 내용 수정 · 추가 작성
// ═══════════════════════════════════════════════════════════════════════
export const EDIT_STEP_TYPES = ['approve', 'agree', 'director', 'pre_ceo'];   // 내용 수정 가능한 결재 단계(경유 제외)
export const LINE_EDIT_TYPES = ['approve', 'agree', 'pass', 'director', 'pre_ceo'];
const LOCKED = ['done', 'rejected', 'flagged', 'skipped'];

const mainPending = (ctx, lines) => lines.find((l) => l.status === 'pending' && l.step_type !== 'post_ceo' && sameId(l.user_id, ctx.uid)) || null;

// 내용 수정: 진행 중 문서 · (현재 차례인 결재자[경유 제외] 또는 디렉터)
export function canEditContent(ctx, doc, lines) {
  if (doc.status !== 'progress') return false;
  if (ctx.isDirector) return true;
  const m = mainPending(ctx, lines);
  return !!(m && EDIT_STEP_TYPES.includes(m.step_type));
}
// 추가 작성: 진행 중 문서의 현재 차례 결재자(경유 포함) · 디렉터는 상신 이후 언제나
export function canAddend(ctx, doc, lines) {
  if (doc.status === 'draft') return false;
  if (ctx.isDirector) return true;
  return doc.status === 'progress' && !!mainPending(ctx, lines);
}
// 결재선 수정: 디렉터 · 진행 중(남은 단계 전체) 또는 승인 후 사후승인 확인 전(사후승인자만)
// 작성 화면에서 디렉터가 짠 결재선(내 결재 뒤 단계) 검증 → { steps } | { error }
export const CUSTOM_STEP_TYPES = ['approve', 'agree', 'pass', 'pre_ceo'];
export function validateCustomSteps(raw, { drafterId, activeUserIds }) {
  if (raw == null) return { steps: null };
  let arr = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch { return { error: 'bad_custom_steps' }; } }
  if (!Array.isArray(arr) || arr.length > 20) return { error: 'bad_custom_steps' };
  const active = new Set((activeUserIds || []).map(Number));
  const out = [];
  for (const st of arr) {
    const t = st && st.step_type, u = Number(st && st.user_id);
    if (!CUSTOM_STEP_TYPES.includes(t)) return { error: 'bad_step_type' };
    if (!u || (activeUserIds && !active.has(u))) return { error: 'bad_user' };
    if (sameId(u, drafterId)) return { error: 'drafter_in_line' };
    if (out.some((r) => r.step_type === t && r.user_id === u)) return { error: 'duplicate' };
    out.push({ step_type: t, user_id: u });
  }
  if (out.filter((r) => r.step_type === 'pre_ceo').length > 1) return { error: 'pre_ceo_count' };
  const pi = out.findIndex((r) => r.step_type === 'pre_ceo');
  if (pi >= 0 && pi !== out.length - 1) return { error: 'pre_ceo_last' };
  return { steps: out };
}
export function canEditLines(ctx, doc) {
  if (!ctx.isDirector) return false;
  if (doc.status === 'progress') return true;
  return doc.status === 'approved' && doc.post_status !== 'confirmed';
}
// 수정 주체의 단계 표시
export function editorStep(ctx, lines) {
  const m = mainPending(ctx, lines);
  if (m && EDIT_STEP_TYPES.includes(m.step_type)) return m.step_type;
  return ctx.isDirector ? 'director_override' : (m ? m.step_type : null);
}

// 결재선 수정 검증
//   lines: 현재 결재선 · steps: 남은 본 단계 새 목록(순서대로 [{step_type,user_id}]) · postUser: 사후승인자
//   반환 { locked, rows:[{step_order,step_type,user_id}], postUser } | { error }
export function planLineEdit({ lines, steps, postUser, doc, activeUserIds }) {
  const main = lines.filter((l) => l.step_type !== 'post_ceo');
  const locked = main.filter((l) => l.step_type === 'draft' || LOCKED.includes(l.status));
  const list = Array.isArray(steps) ? steps : [];
  const active = new Set((activeUserIds || []).map(Number));
  // 승인 후: 집행 전이면 단계 추가 가능(재결재로 되돌아감) · 집행 후에는 사후승인자만
  if (doc.status === 'approved' && list.length && doc.exec_status === 'done') return { error: 'only_post_editable' };
  const rows = [];
  for (const s of list) {
    const t = s && s.step_type, u = Number(s && s.user_id);
    if (!LINE_EDIT_TYPES.includes(t)) return { error: 'bad_step_type' };
    if (!u || !active.has(u)) return { error: 'bad_user' };
    if (sameId(u, doc.drafter_id) && t !== 'director') return { error: 'drafter_in_line' };
    if (rows.some((r) => r.step_type === t && r.user_id === u)) return { error: 'duplicate' };
    rows.push({ step_type: t, user_id: u });
  }
  const all = [...locked.filter((l) => l.step_type !== 'draft'), ...rows];
  if (doc.status === 'progress' || list.length) {
    if (all.filter((r) => r.step_type === 'director').length !== 1) return { error: 'director_count' };
    if (all.filter((r) => r.step_type === 'pre_ceo').length > 1) return { error: 'pre_ceo_count' };
    const pi = rows.findIndex((r) => r.step_type === 'pre_ceo');
    if (pi >= 0 && pi !== rows.length - 1) return { error: 'pre_ceo_last' };
  }
  const pu = Number(postUser);
  if (!pu || !active.has(pu)) return { error: 'bad_post_user' };
  if (sameId(pu, doc.drafter_id)) return { error: 'drafter_in_line' };
  const base = Math.max(0, ...locked.map((l) => n(l.step_order)));
  return { locked, rows: rows.map((r, i) => ({ ...r, step_order: base + 1 + i })), postUser: pu };
}

// 내용 수정 전/후 비교 → [{field,label,old,new}]
const MONEYF = (v, cur) => (v == null ? '—' : `${cur === 'USD' ? 'US' : ''}$${n(v).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export function schedSummary(type, payments, cur) {
  const ps = payments || [];
  if (!ps.length) return '—';
  if (ps.length === 1) return `${PAYMENT_TYPE_LABEL[type] || '일시불'} · ${ps[0].due_date || '—'} · ${MONEYF(ps[0].amount ?? ps[0].planned_amount, cur)}`;
  const first = ps[0], last = ps[ps.length - 1];
  return `${PAYMENT_TYPE_LABEL[type] || ''} ${ps.length}회 · ${first.due_date || '—'}~${last.due_date || '—'} · 회당 ${MONEYF(first.amount ?? first.planned_amount, cur)}`;
}
export function diffContent(a, b) {
  const out = [];
  const add = (field, label, o, nw) => { if (String(o ?? '') !== String(nw ?? '')) out.push({ field, label, old: o ?? '', new: nw ?? '' }); };
  add('title', '제목', a.title, b.title);
  add('vendor', '거래처', a.vendor, b.vendor);
  add('category', '카테고리', a.category_name, b.category_name);
  add('currency', '통화', a.currency, b.currency);
  add('amount', '합계', MONEYF(a.orig_total, a.currency), MONEYF(b.orig_total, b.currency));
  if (a.currency === 'USD' || b.currency === 'USD') add('amount_mxn', '합계 (MXN)', MONEYF(a.planned_total, 'MXN'), MONEYF(b.planned_total, 'MXN'));
  add('iva', 'IVA', a.iva_applied ? '적용' : '미적용', b.iva_applied ? '적용' : '미적용');
  add('pay_method', '지급 방법', a.pay_method, b.pay_method);
  add('schedule', '지급 일정', schedSummary(a.payment_type, a.payments, a.currency), schedSummary(b.payment_type, b.payments, b.currency));
  const ai = (a.body_nodes || []).filter((x) => x.t === 'img').length, bi = (b.body_nodes || []).filter((x) => x.t === 'img').length;
  const ap = (a.body || '').replace(/\[그림\]/g, '').trim(), bp = (b.body || '').replace(/\[그림\]/g, '').trim();
  if (ap !== bp) out.push({ field: 'body', label: '내용', old: ap.slice(0, 2000), new: bp.slice(0, 2000) });
  if (ai !== bi) out.push({ field: 'images', label: '본문 그림', old: `${ai}장`, new: `${bi}장` });
  return out;
}
export const amountChanged = (changes) => changes.some((c) => ['amount', 'amount_mxn', 'iva', 'schedule', 'currency'].includes(c.field));
