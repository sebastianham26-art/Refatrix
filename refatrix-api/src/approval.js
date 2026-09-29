// 전자결재(0234) — DB·HTTP 에 의존하지 않는 순수 규칙.
//   라우트(routes/approvalRoutes.js)와 테스트가 같은 함수를 쓴다.
//
//   결재 흐름: 기안 → [카테고리 템플릿: 중간결재·합의·경유] → 디렉터 결재
//              → [기준액 이상] 대표이사 사전승인 → 승인완료(집행대기)
//              → 재무 집행(실적 입력) → 대표이사 사후승인 → 완결
//   디렉터 기안: 템플릿 대신 「재무 합의 포함」 토글(include_finance). 본인 결재 칸은 자동 완료.
//   대표이사 기안: 사전승인 생략, 사후승인은 디렉터가 한다(자기 문서 자기 확인 방지).
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
export function buildLines({ drafterId, drafterIsDirector, catSteps = [], doc }, settings) {
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
    if (doc.include_finance) add('agree', finId);
    lines.push({ step_order: o++, step_type: 'director', user_id: me, status: 'done', comment: '기안자 결재 (디렉터 기안)' });
  } else {
    [...catSteps].sort((a, b) => n(a.step_order) - n(b.step_order) || n(a.id) - n(b.id))
      .forEach((s) => add(s.step_type, s.user_id));
    lines.push({ step_order: o++, step_type: 'director', user_id: dirId, status: 'waiting', comment: null });
  }
  const ceoDrafter = sameId(me, ceoId);
  const pre = !ceoDrafter && basisAmount(doc, settings.threshold_basis) >= n(settings.ceo_pre_threshold);
  if (pre) lines.push({ step_order: o++, step_type: 'pre_ceo', user_id: ceoId, status: 'waiting', comment: null });
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
