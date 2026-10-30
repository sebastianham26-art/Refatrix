// =====================================================================
// Refatrix ERP · 소개(Referencia) 커미션 라우트 (0307 · 2026-10-29)
//   · 디렉터: 소개 계약 등록·수정·해지 · B 정보(계약서 제1조 표) · 제출 서류(제2조) 올리기·삭제
//   · 소개자(A): 계약서 읽기 → 손서명 + 본인 PIN 으로 전자서명(수정·삭제 불가 기록)
//   · 소개자(A): B 의 매출·수금·고객별 실적과 자기 소개 커미션(조회 전용 · 원가·마진·할인율 없음)
//   · 전체열람(디렉터·재무·소시오): 현황·미리보기·서명 원문
//   지급은 커미션 지급 전표·전자결재에 같이 들어간다(commissionRoutes.preparePayment).
// =====================================================================
import { query, withTx } from '../db.js';
import { authGuard } from '../middleware/authGuard.js';
import { verifyPin } from '../auth.js';
import { logEvent } from '../audit.js';
import { decodeContractFile, deviceLabel } from './commissionAgreementRoutes.js';
import { validateReferral, decodeSignature, DOC_TYPES, summarizeReferral, normInfo, referrerInfo } from '../commissionReferral.js';
import {
  referralsReady, loadReferral, listReferrals, currentDoc, referralState, recomputeDocsComplete, referralLines,
} from '../commissionReferralData.js';

const SEE_ALL_ROLES = ['director', 'treasury', 'socio'];
const canSeeAll = (perm) => SEE_ALL_ROLES.includes(perm.role);
const isDirector = (perm) => perm.role === 'director';
const MIG = { error: 'migration_required', migration: '0307', note: '서버에서 npm run migrate(0307)를 먼저 실행하세요.' };
const BODY_LIMIT = 22 * 1024 * 1024;

// PIN 오입력 제한 — 사람당 15분에 5회 (합의 화면과 같은 규칙)
const fails = new Map();
function tooManyFails(uid) {
  const now = Date.now();
  const arr = (fails.get(uid) || []).filter((t) => now - t < 15 * 60 * 1000);
  fails.set(uid, arr);
  return arr.length >= 5;
}
function noteFail(uid) { const arr = fails.get(uid) || []; arr.push(Date.now()); fails.set(uid, arr); }
export function _resetReferralPinFails() { fails.clear(); }

// 화면용 요약 한 건
async function refOut(ref, perm, { withDoc = false } = {}) {
  const st = await referralState(ref);
  const seeDocs = canSeeAll(perm);
  const me = Number(perm.userId);
  const isOwner = me === ref.referrer_id;
  // A 가 볼 수 있는 파일 = A 서류 + A 가 직접 올린 파일
  const aSees = (d) => !!d && (d.party === 'referrer' || Number(d.uploaded_by) === me);
  const out = {
    ...ref, version: st.version, sign_status: st.sign_status, first_signed_on: st.first_signed_on,
    effective_from: st.effective_from,
    docs: {
      complete: st.docs_status.complete, missing: st.docs_status.missing,
      items: st.docs_status.items.map((x) => ({
        party: x.party, type: x.type, label_es: x.label_es, label_ko: x.label_ko, ok: x.ok, stale: x.stale,
        doc: x.doc ? { id: x.doc.id, file_name: seeDocs || aSees(x.doc) ? x.doc.file_name : null, issued_date: x.doc.issued_date, uploaded_on: x.doc.uploaded_on,
          can_open: isDirector(perm) || (isOwner && aSees(x.doc)),
          can_delete: isDirector(perm) || (isOwner && !ref.approved && Number(x.doc.uploaded_by) === me) } : null,
      })),
    },
    signatures: st.signatures.map((s) => ({ id: s.id, version: s.version, signed_at: s.signed_at, device: deviceLabel(s.user_agent), current: s.version === st.version })),
    // 0309 본인 작성 — 승인 전에는 소개자가 정보·서류를 고칠 수 있다
    can_edit: isDirector(perm) || (isOwner && ref.active && !ref.approved),
    self_requested: ref.requested_by != null && ref.requested_by === ref.referrer_id,
  };
  if (seeDocs) out.files = st.docs.map((d) => ({ id: d.id, party: d.party, doc_type: d.doc_type, file_name: d.file_name, file_size: d.file_size, issued_date: d.issued_date, uploaded_at: d.uploaded_at_local }));
  if (withDoc) { const { doc } = await currentDoc(ref); out.doc = doc; }
  return out;
}

// 0308 captured_by 열(대면 서명) 적용 여부 — 60초 캐시
let _capReady = { v: null, at: 0 };
async function capturedReady() {
  if (_capReady.v === true) return true;
  if (_capReady.v === false && Date.now() - _capReady.at < 60000) return false;
  const r = await query(`SELECT 1 FROM information_schema.columns WHERE table_name='commission_referral_signatures' AND column_name='captured_by'`);
  _capReady = { v: r.rows.length > 0, at: Date.now() };
  return _capReady.v;
}

// 0309 본인 작성 열 적용 여부 — 60초 캐시
let _selfReady = { v: null, at: 0 };
async function selfReady() {
  if (_selfReady.v === true) return true;
  if (_selfReady.v === false && Date.now() - _selfReady.at < 60000) return false;
  const r = await query(`SELECT 1 FROM information_schema.columns WHERE table_name='commission_referrals' AND column_name='approved_at'`);
  _selfReady = { v: r.rows.length > 0, at: Date.now() };
  return _selfReady.v;
}
const MIG9 = { error: 'migration_required', migration: '0309', note: 'Esta función aún no está activa en el servidor. (npm run migrate 0309)' };
const today = () => new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);

// 0310 초대 테이블 적용 여부 — 60초 캐시
let _invReady = { v: null, at: 0 };
async function invitesReady() {
  if (_invReady.v === true) return true;
  if (_invReady.v === false && Date.now() - _invReady.at < 60000) return false;
  const r = await query(`SELECT 1 FROM information_schema.tables WHERE table_name='commission_referral_invites'`);
  _invReady = { v: r.rows.length > 0, at: Date.now() };
  return _invReady.v;
}
async function isInvited(uid) {
  if (!(await invitesReady())) return false;
  return (await query(`SELECT 1 FROM commission_referral_invites WHERE user_id=$1 AND active`, [Number(uid)])).rows.length > 0;
}

// 이 사람이 이 계약을 볼 수 있나: 전체열람자 또는 소개자 본인
const canView = (perm, ref) => canSeeAll(perm) || Number(perm.userId) === ref.referrer_id;

export default async function commissionReferralRoutes(app) {
  // ── 목록 — 전체열람자: 전부(referrer_id 로 거르기) / 그 외: 내가 소개자인 계약 ──
  app.get('/api/commission/referrals', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    if (!(await referralsReady())) return { migrated: false, items: [], is_director: isDirector(perm), see_all: canSeeAll(perm) };
    const referrerId = canSeeAll(perm) ? (Number(req.query.referrer_id || 0) || null) : Number(perm.userId);
    const items = [];
    for (const r of await listReferrals({ referrerId })) {
      if (!canSeeAll(perm) && !r.active) continue;
      items.push(await refOut(r, perm));
    }
    return { migrated: true, items, is_director: isDirector(perm), see_all: canSeeAll(perm) };
  });

  // ── 사용자 목록(선택용) — 디렉터 ──
  app.get('/api/commission/referrals/users', { preHandler: [authGuard] }, async (req, reply) => {
    if (!isDirector(req.ctx.perm)) return reply.code(403).send({ error: 'forbidden' });
    const rows = (await query(
      `SELECT u.id, u.name, u.role, t.name AS team_name,
              EXISTS (SELECT 1 FROM commission_agents ca WHERE ca.user_id=u.id AND ca.active) AS is_agent,
              EXISTS (SELECT 1 FROM user_page_access a WHERE a.user_id=u.id AND a.page_key='guiacom') AS is_com
         FROM users u LEFT JOIN sales_teams t ON t.id=u.team_id
        WHERE u.deleted_at IS NULL AND u.role IN ('sales','sales_support')
        ORDER BY t.sort_order NULLS LAST, u.name`)).rows;
    return { items: rows.map((r) => ({ id: Number(r.id), name: r.name, role: r.role, team_name: r.team_name, is_agent: r.is_agent, is_com: r.is_com })) };
  });

  // ── 등록 (디렉터) ──
  app.post('/api/commission/referrals', { preHandler: [authGuard] }, async (req, reply) => {
    if (!isDirector(req.ctx.perm)) return reply.code(403).send({ error: 'forbidden', note: '디렉터만 등록할 수 있습니다.' });
    if (!(await referralsReady())) return reply.code(503).send(MIG);
    const v = validateReferral(req.body || {});
    if (!v.ok) return reply.code(400).send({ error: v.error, note: v.note });
    const x = v.value; const dir = Number(req.ctx.perm.userId);
    const users = (await query(`SELECT id FROM users WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`, [[x.referrer_id, x.referred_id]])).rows;
    if (users.length !== 2) return reply.code(400).send({ error: 'user_not_found', note: '사용자를 찾을 수 없습니다.' });
    const dup = (await query(`SELECT r.id, u.name FROM commission_referrals r JOIN users u ON u.id=r.referrer_id WHERE r.referred_id=$1 AND r.active`, [x.referred_id])).rows[0];
    if (dup) return reply.code(409).send({ error: 'already_referred', referral_id: Number(dup.id), note: `이 커미셔너는 이미 ${dup.name} 님의 소개 계약(#${dup.id})에 있습니다. 그 계약을 수정하거나 해지한 뒤 등록하세요.` });
    const sr = await selfReady();
    const ri = referrerInfo((req.body || {}).referrer_info);
    const r = (await query(sr
      ? `INSERT INTO commission_referrals (referrer_id, referred_id, rate, start_date, end_date, referred_info, note, created_by, updated_by, referrer_info, approved_at, approved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,now(),$8) RETURNING id`
      : `INSERT INTO commission_referrals (referrer_id, referred_id, rate, start_date, end_date, referred_info, note, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
      sr ? [x.referrer_id, x.referred_id, x.rate, x.start_date, x.end_date, JSON.stringify(x.referred_info), x.note, dir, JSON.stringify(ri || {})]
         : [x.referrer_id, x.referred_id, x.rate, x.start_date, x.end_date, JSON.stringify(x.referred_info), x.note, dir])).rows[0];
    await logEvent({ userId: dir, action: 'create', target: `commission_referral:${r.id}`, detail: { referrer_id: x.referrer_id, referred_id: x.referred_id, rate: x.rate, start: x.start_date } });
    return { ok: true, item: await refOut(await loadReferral(r.id), req.ctx.perm) };
  });

  // ── 수정 (디렉터) — 조건이 바뀌면 소개자에게 재서명 요청이 뜬다 ──
  app.put('/api/commission/referrals/:id', { preHandler: [authGuard] }, async (req, reply) => {
    if (!isDirector(req.ctx.perm)) return reply.code(403).send({ error: 'forbidden' });
    if (!(await referralsReady())) return reply.code(503).send(MIG);
    const ref = await loadReferral(req.params.id);
    if (!ref) return reply.code(404).send({ error: 'not_found' });
    if (!ref.active) return reply.code(409).send({ error: 'inactive', note: '해지된 계약은 수정할 수 없습니다.' });
    const v = validateReferral({ ...req.body, referrer_id: ref.referrer_id, referred_id: ref.referred_id }, { allowNoReferred: true });
    if (!v.ok) return reply.code(400).send({ error: v.error, note: v.note });
    const x = v.value; const dir = Number(req.ctx.perm.userId);
    await withTx(async (cx) => {
      await cx.query(`UPDATE commission_referrals SET rate=$2, start_date=$3, end_date=$4, referred_info=$5, note=$6, updated_by=$7, updated_at=now() WHERE id=$1`,
        [ref.id, x.rate, x.start_date, x.end_date, JSON.stringify(x.referred_info), x.note, dir]);
      if (req.body && req.body.referrer_info !== undefined && await selfReady()) {
        await cx.query(`UPDATE commission_referrals SET referrer_info=$2 WHERE id=$1`, [ref.id, JSON.stringify(referrerInfo(req.body.referrer_info) || {})]);
      }
      await recomputeDocsComplete(cx.query.bind(cx), ref.id);   // 개인↔법인 변경 시 필수 서류가 달라진다
    });
    await logEvent({ userId: dir, action: 'update', target: `commission_referral:${ref.id}`, detail: { rate: x.rate, start: x.start_date, end: x.end_date } });
    return { ok: true, item: await refOut(await loadReferral(ref.id), req.ctx.perm) };
  });

  // ── 해지 (디렉터) — 이미 지급한 기록은 남고, 이후 소개 커미션이 생기지 않는다 ──
  app.post('/api/commission/referrals/:id/deactivate', { preHandler: [authGuard] }, async (req, reply) => {
    if (!isDirector(req.ctx.perm)) return reply.code(403).send({ error: 'forbidden' });
    if (!(await referralsReady())) return reply.code(503).send(MIG);
    const r = (await query(`UPDATE commission_referrals SET active=false, updated_by=$2, updated_at=now() WHERE id=$1 AND active RETURNING id`, [Number(req.params.id), Number(req.ctx.perm.userId)])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `commission_referral:${r.id}`, detail: { active: false } });
    return { ok: true };
  });

  // ── 서류 올리기 (디렉터) ──
  //   0309: 소개자(A) 본인도 자기 계약의 서류(A·B 모두)를 올릴 수 있다.
  app.post('/api/commission/referrals/:id/docs', { preHandler: [authGuard], bodyLimit: BODY_LIMIT }, async (req, reply) => {
    if (!(await referralsReady())) return reply.code(503).send(MIG);
    const ref = await loadReferral(req.params.id);
    if (!ref) return reply.code(404).send({ error: 'not_found' });
    const owner = Number(req.ctx.perm.userId) === ref.referrer_id;
    if (!isDirector(req.ctx.perm) && !(owner && ref.active)) return reply.code(403).send({ error: 'forbidden', note: 'No puedes subir documentos a este contrato.' });
    const b = req.body || {};
    const party = b.party === 'referrer' ? 'referrer' : (b.party === 'referred' ? 'referred' : null);
    if (!party || !DOC_TYPES[b.doc_type]) return reply.code(400).send({ error: 'bad_doc_type', note: '대상(A/B)과 서류 종류를 선택하세요. (Tipo de documento no válido)' });
    if (party === 'referrer' && ['acta', 'poder'].includes(b.doc_type)) return reply.code(400).send({ error: 'bad_doc_type', note: '정관·위임장은 피소개 커미셔너(B) 서류입니다. (Documento del comisionista referido)' });
    if (party === 'referred' && b.doc_type === 'banco') return reply.code(400).send({ error: 'bad_doc_type', note: '은행계좌 증빙은 소개자(A) 서류입니다. (Documento de EL REFERIDOR)' });
    const issued = /^\d{4}-\d{2}-\d{2}$/.test(String(b.issued_date || '')) ? b.issued_date : null;
    const dec = decodeContractFile(b.data_url, b.file_name);
    if (!dec.ok) return reply.code(400).send({ error: dec.error, note: dec.note });
    const dir = Number(req.ctx.perm.userId);
    const res = await withTx(async (cx) => {
      const q = cx.query.bind(cx);
      const dup = (await q(`SELECT id FROM commission_referral_docs WHERE referral_id=$1 AND sha256=$2 AND deleted_at IS NULL`, [ref.id, dec.sha256])).rows[0];
      if (dup) return { dup: true };
      const d = (await q(
        `INSERT INTO commission_referral_docs (referral_id, party, doc_type, issued_date, file_name, mime_type, file_size, sha256, file_data, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [ref.id, party, b.doc_type, issued, dec.name, dec.mime, dec.buf.length, dec.sha256, dec.buf, dir])).rows[0];
      const complete = await recomputeDocsComplete(q, ref.id);
      return { id: Number(d.id), complete };
    });
    if (res.dup) return reply.code(409).send({ error: 'duplicate', note: owner ? 'Ese archivo ya está cargado.' : '같은 파일이 이미 올라가 있습니다.' });
    await logEvent({ userId: dir, action: 'create', target: `commission_referral_doc:${res.id}`, detail: { referral_id: ref.id, party, doc_type: b.doc_type, size: dec.buf.length } });
    return { ok: true, id: res.id, docs_complete_on: res.complete, item: await refOut(await loadReferral(ref.id), req.ctx.perm) };
  });

  // ── 서류 파일 열람 — 디렉터 전부 / 소개자는 본인(A) 서류만 ──
  app.get('/api/commission/referrals/docs/:docId/file', { preHandler: [authGuard] }, async (req, reply) => {
    if (!(await referralsReady())) return reply.code(404).send({ error: 'not_found' });
    const perm = req.ctx.perm;
    const d = (await query(
      `SELECT d.party, d.file_name, d.mime_type, d.file_data, d.uploaded_by, r.referrer_id, r.id AS referral_id
         FROM commission_referral_docs d JOIN commission_referrals r ON r.id=d.referral_id
        WHERE d.id=$1 AND d.deleted_at IS NULL`, [Number(req.params.docId)])).rows[0];
    if (!d) return reply.code(404).send({ error: 'not_found' });
    const own = Number(d.referrer_id) === Number(perm.userId) && (d.party === 'referrer' || Number(d.uploaded_by) === Number(perm.userId));
    if (!isDirector(perm) && !own) return reply.code(403).send({ error: 'forbidden' });
    await logEvent({ userId: perm.userId, action: 'export', target: `commission_referral_doc:${req.params.docId}`, detail: { referral_id: Number(d.referral_id), kind: 'view' } });
    const fn = String(d.file_name || 'documento').replace(/["\r\n]/g, '');
    reply.header('Content-Type', d.mime_type || 'application/octet-stream');
    reply.header('Content-Disposition', `inline; filename="${fn.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fn)}`);
    reply.header('Cache-Control', 'private, no-store');
    return reply.send(Buffer.isBuffer(d.file_data) ? d.file_data : Buffer.from(d.file_data));
  });

  // ── 서류 삭제 (디렉터 · 소프트) — 필수 서류가 빠지면 서류 완비일이 비워진다 ──
  //   0309: 소개자는 승인 전, 자기가 올린 파일만 지울 수 있다.
  app.delete('/api/commission/referrals/docs/:docId', { preHandler: [authGuard] }, async (req, reply) => {
    if (!(await referralsReady())) return reply.code(404).send({ error: 'not_found' });
    const dir = Number(req.ctx.perm.userId);
    if (!isDirector(req.ctx.perm)) {
      const d0 = (await query(`SELECT d.uploaded_by, d.referral_id FROM commission_referral_docs d WHERE d.id=$1 AND d.deleted_at IS NULL`, [Number(req.params.docId)])).rows[0];
      const ref0 = d0 ? await loadReferral(d0.referral_id) : null;
      if (!d0 || !ref0 || ref0.referrer_id !== dir || Number(d0.uploaded_by) !== dir || ref0.approved) return reply.code(403).send({ error: 'forbidden', note: 'Solo puedes borrar archivos que tú cargaste, antes de la aprobación.' });
    }
    const res = await withTx(async (cx) => {
      const q = cx.query.bind(cx);
      const d = (await q(`UPDATE commission_referral_docs SET deleted_at=now(), deleted_by=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING referral_id`, [Number(req.params.docId), dir])).rows[0];
      if (!d) return null;
      return { referral_id: Number(d.referral_id), complete: await recomputeDocsComplete(q, Number(d.referral_id)) };
    });
    if (!res) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: dir, action: 'delete', target: `commission_referral_doc:${req.params.docId}`, detail: { referral_id: res.referral_id } });
    return { ok: true, docs_complete_on: res.complete };
  });

  // ══ 0309 소개자 본인 작성 ══════════════════════════════════════════
  // 선택 가능한 피소개 커미셔너(B) — 영업 계정 중 본인 제외 · 이미 소개된 사람 제외. 이름만.
  app.get('/api/commission/referrals/candidates', { preHandler: [authGuard] }, async (req) => {
    const me = Number(req.ctx.perm.userId);
    if (!(await referralsReady())) return { migrated: false, items: [] };
    // 0311: 다른 사람 이름(계정 목록)은 보내지 않는다 — 소개자는 B 회사 정보를 직접 입력만 한다. 신청 가능 여부만.
    const invited = await isInvited(me);
    return { migrated: true, self_ready: await selfReady(), invited, items: [] };
  });

  // 신청 — 소개자 = 로그인한 본인. 율은 계약 기본값(1%), 시작일은 본인이 제안(디렉터가 승인 때 조정 가능).
  app.post('/api/commission/referrals/request', { preHandler: [authGuard] }, async (req, reply) => {
    const me = Number(req.ctx.perm.userId);
    if (!(await referralsReady()) || !(await selfReady())) return reply.code(503).send(MIG9);
    if (!(await invitesReady())) return reply.code(503).send({ error: 'migration_required', migration: '0310', note: 'Esta función aún no está activa en el servidor.' });
    if (!(await isInvited(me))) return reply.code(403).send({ error: 'not_invited', note: 'Refatrix aún no te habilitó para la comisión por referencia.' });
    const b = req.body || {};
    const v = validateReferral({ referrer_id: me, referred_id: null, rate: 1, start_date: b.start_date || today(), end_date: null, referred_info: b.referred_info, note: null }, { allowNoReferred: true });
    if (!v.ok) {
      const ES = { users_required: 'Selecciona al comisionista que refieres.', same_user: 'No puedes referirte a ti mismo.', name_required: 'Escribe el nombre o razón social del comisionista referido.', bad_start: 'Fecha de inicio no válida.' };
      return reply.code(400).send({ error: v.error, note: ES[v.error] || v.note });
    }
    const x = v.value;
    const ri = referrerInfo(b.referrer_info);
    const r = (await query(
      `INSERT INTO commission_referrals (referrer_id, referred_id, rate, start_date, referred_info, referrer_info, requested_by, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$1,$1,$1) RETURNING id`,
      [me, null, x.rate, x.start_date, JSON.stringify(x.referred_info), JSON.stringify(ri || {})])).rows[0];
    await logEvent({ userId: me, action: 'create', target: `commission_referral:${r.id}`, detail: { kind: 'self_request', b_name: x.referred_info.name, start: x.start_date } });
    return { ok: true, item: await refOut(await loadReferral(r.id), req.ctx.perm, { withDoc: true }) };
  });

  // 소개자 본인 수정 — 승인 전까지. B 정보 · 본인 정보 · 시작일(제안). 율은 못 바꾼다.
  app.put('/api/commission/referrals/:id/mine', { preHandler: [authGuard] }, async (req, reply) => {
    const me = Number(req.ctx.perm.userId);
    if (!(await referralsReady()) || !(await selfReady())) return reply.code(503).send(MIG9);
    const ref = await loadReferral(req.params.id);
    if (!ref || ref.referrer_id !== me || !ref.active) return reply.code(404).send({ error: 'not_found', note: 'Contrato no encontrado.' });
    if (ref.approved) return reply.code(409).send({ error: 'approved', note: 'Refatrix ya aprobó este contrato. Para cambiar datos, comunícate con Refatrix.' });
    const b = req.body || {};
    const v = validateReferral({ referrer_id: me, referred_id: ref.referred_id, rate: ref.rate, start_date: b.start_date || ref.start_date, end_date: ref.end_date, referred_info: b.referred_info, note: ref.note }, { allowNoReferred: true });
    if (!v.ok) return reply.code(400).send({ error: v.error, note: v.error === 'name_required' ? 'Escribe el nombre o razón social del comisionista referido.' : v.note });
    const x = v.value;
    await withTx(async (cx) => {
      await cx.query(`UPDATE commission_referrals SET start_date=$2, referred_info=$3, referrer_info=$4, updated_by=$5, updated_at=now() WHERE id=$1`,
        [ref.id, x.start_date, JSON.stringify(x.referred_info), JSON.stringify(referrerInfo(b.referrer_info) || {}), me]);
      await recomputeDocsComplete(cx.query.bind(cx), ref.id);
    });
    await logEvent({ userId: me, action: 'update', target: `commission_referral:${ref.id}`, detail: { kind: 'self_edit' } });
    return { ok: true, item: await refOut(await loadReferral(ref.id), req.ctx.perm, { withDoc: true }) };
  });

  // ── 0310 소개자 초대 — 디렉터는 A 만 고른다 ──
  app.get('/api/commission/referrals/invites', { preHandler: [authGuard] }, async (req, reply) => {
    if (!canSeeAll(req.ctx.perm)) return reply.code(403).send({ error: 'forbidden' });
    if (!(await invitesReady())) return { migrated: false, items: [] };
    const rows = (await query(
      `SELECT i.id, i.user_id, u.name, i.note, to_char(i.created_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS created_at_local,
              (SELECT COUNT(*) FROM commission_referrals r WHERE r.referrer_id=i.user_id AND r.active)::int AS referrals
         FROM commission_referral_invites i JOIN users u ON u.id=i.user_id
        WHERE i.active ORDER BY i.created_at DESC`)).rows;
    return { migrated: true, items: rows.map((r) => ({ id: Number(r.id), user_id: Number(r.user_id), name: r.name, note: r.note || null, created_at: r.created_at_local, referrals: r.referrals })) };
  });

  app.post('/api/commission/referrals/invites', { preHandler: [authGuard] }, async (req, reply) => {
    if (!isDirector(req.ctx.perm)) return reply.code(403).send({ error: 'forbidden', note: '디렉터만 초대할 수 있습니다.' });
    if (!(await invitesReady())) return reply.code(503).send({ error: 'migration_required', migration: '0310', note: '서버에서 npm run migrate(0310)를 먼저 실행하세요.' });
    const uid = Number((req.body || {}).user_id);
    const u = (await query(`SELECT id, name FROM users WHERE id=$1 AND deleted_at IS NULL AND role IN ('sales','sales_support')`, [uid])).rows[0];
    if (!u) return reply.code(400).send({ error: 'user_not_found', note: '소개자(A)를 선택하세요.' });
    if (await isInvited(uid)) return reply.code(409).send({ error: 'already_invited', note: `${u.name} 님은 이미 초대되어 있습니다.` });
    const note = req.body && req.body.note ? String(req.body.note).trim().slice(0, 300) : null;
    const r = (await query(`INSERT INTO commission_referral_invites (user_id, note, created_by) VALUES ($1,$2,$3) RETURNING id`, [uid, note, Number(req.ctx.perm.userId)])).rows[0];
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `commission_referral_invite:${r.id}`, detail: { user_id: uid } });
    return { ok: true, id: Number(r.id), user_id: uid, name: u.name };
  });

  app.delete('/api/commission/referrals/invites/:userId', { preHandler: [authGuard] }, async (req, reply) => {
    if (!isDirector(req.ctx.perm)) return reply.code(403).send({ error: 'forbidden' });
    if (!(await invitesReady())) return reply.code(404).send({ error: 'not_found' });
    const r = (await query(`UPDATE commission_referral_invites SET active=false, revoked_at=now(), revoked_by=$2 WHERE user_id=$1 AND active RETURNING id`, [Number(req.params.userId), Number(req.ctx.perm.userId)])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `commission_referral_invite:${r.id}`, detail: { active: false } });
    return { ok: true };
  });

  // 디렉터 승인 — 이후 소개자는 정보를 바꿀 수 없다. 효력일 = 시작일·서류 완비·첫 서명·승인일 중 가장 늦은 날.
  app.post('/api/commission/referrals/:id/approve', { preHandler: [authGuard] }, async (req, reply) => {
    if (!isDirector(req.ctx.perm)) return reply.code(403).send({ error: 'forbidden', note: '디렉터만 승인할 수 있습니다.' });
    if (!(await selfReady())) return reply.code(503).send(MIG9);
    const dir = Number(req.ctx.perm.userId);
    const ref = await loadReferral(req.params.id);
    if (!ref || !ref.active || ref.approved) return reply.code(409).send({ error: 'not_pending', note: '승인 대기 중인 계약이 아닙니다.' });
    // 0311 B 의 ERP 계정(매출 집계 대상) — 소개자가 입력한 회사 정보를 보고 디렉터가 연결
    const bid = req.body && req.body.referred_id != null && req.body.referred_id !== '' ? Number(req.body.referred_id) : ref.referred_id;
    if (!bid) return reply.code(400).send({ error: 'b_account_required', note: `피소개 커미셔너(B · ${ref.referred_info.name || '—'})의 ERP 계정을 선택하세요.` });
    if (bid === ref.referrer_id) return reply.code(400).send({ error: 'same_user', note: '소개자 본인 계정은 B 로 연결할 수 없습니다.' });
    const u = (await query(`SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL`, [bid])).rows[0];
    if (!u) return reply.code(400).send({ error: 'user_not_found', note: '계정을 찾을 수 없습니다.' });
    const dup = (await query(`SELECT r.id, ua.name FROM commission_referrals r JOIN users ua ON ua.id=r.referrer_id WHERE r.referred_id=$1 AND r.active AND r.id<>$2`, [bid, ref.id])).rows[0];
    if (dup) return reply.code(409).send({ error: 'already_referred', note: `그 계정은 이미 ${dup.name} 님의 소개 계약(#${dup.id})에 연결되어 있습니다.` });
    const r = (await query(`UPDATE commission_referrals SET referred_id=$3, approved_at=now(), approved_by=$2, updated_by=$2, updated_at=now() WHERE id=$1 AND active AND approved_at IS NULL RETURNING id`, [ref.id, dir, bid])).rows[0];
    if (!r) return reply.code(409).send({ error: 'not_pending', note: '승인 대기 중인 계약이 아닙니다.' });
    await logEvent({ userId: dir, action: 'update', target: `commission_referral:${r.id}`, detail: { approved: true, referred_id: bid } });
    return { ok: true, item: await refOut(await loadReferral(r.id), req.ctx.perm) };
  });

  // ── 내 소개 계약(소개자) — 계약서 원문 + 서명 상태 ──
  app.get('/api/commission/referrals/me', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    if (!(await referralsReady())) return { migrated: false, items: [] };
    const items = [];
    for (const r of await listReferrals({ referrerId: Number(perm.userId), onlyActive: true })) items.push(await refOut(r, perm, { withDoc: true }));
    return { migrated: true, items };
  });

  // ── 전자서명 (손서명 + 소개자 PIN) ──
  //   · 소개자 본인 화면: 본인이 서명 + 본인 PIN
  //   · 디렉터 화면(대면 · 0308): 같은 기기에서 소개자가 서명 + **소개자 PIN**. captured_by = 디렉터.
  app.post('/api/commission/referrals/:id/sign', { preHandler: [authGuard], bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const perm = req.ctx.perm; const me = Number(perm.userId);
    if (!(await referralsReady())) return reply.code(503).send(MIG);
    const ref = await loadReferral(req.params.id);
    if (!ref || !ref.active) return reply.code(404).send({ error: 'not_found', note: 'Contrato no encontrado.' });
    const inPerson = ref.referrer_id !== me;
    if (inPerson && !isDirector(perm)) return reply.code(403).send({ error: 'forbidden', note: 'Solo EL REFERIDOR puede firmar este contrato.' });
    if (inPerson && !(await capturedReady())) return reply.code(503).send({ error: 'migration_required', migration: '0308', note: '서버에서 npm run migrate(0308)를 먼저 실행하세요.' });
    const uid = ref.referrer_id;   // 서명자 = 항상 소개자(A)
    const b = req.body || {};
    if (b.agree !== true) return reply.code(400).send({ error: 'agree_required', note: 'Marca la casilla de aceptación.' });
    const sig = decodeSignature(b.signature);
    if (!sig.ok) return reply.code(400).send({ error: sig.error, note: sig.note });
    const { terms, hash, doc } = await currentDoc(ref);
    if (String(b.version || '') !== hash) return reply.code(409).send({ error: 'version_changed', version: hash, note: 'El contrato cambió mientras lo leías. Revisa la nueva versión y firma de nuevo.' });
    if (tooManyFails(uid)) return reply.code(429).send({ error: 'too_many_attempts', note: 'Demasiados intentos con PIN incorrecto. Intenta de nuevo en 15 minutos.' });
    const signer = (await query(`SELECT pin_hash FROM users WHERE id=$1 AND deleted_at IS NULL`, [uid])).rows[0];
    if (!signer || !verifyPin(String(b.pin || ''), signer.pin_hash)) {
      noteFail(uid);
      await logEvent({ userId: me, action: 'create', target: `commission_referral_sign:${ref.id}`, detail: { reason: 'bad_pin', version: hash, signer: uid, in_person: inPerson }, result: 'denied' });
      return reply.code(403).send({ error: 'bad_pin', note: inPerson ? `${ref.referrer_name} 님의 PIN 이 아닙니다. (PIN incorrecto)` : 'PIN incorrecto.' });
    }
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    const cols = inPerson ? ', captured_by' : '';
    const vals = inPerson ? ',$9' : '';
    const args = [ref.id, uid, hash, JSON.stringify(terms), JSON.stringify(doc), sig.dataUrl, req.ip || null, ua || null];
    if (inPerson) args.push(me);
    const r = (await query(
      `INSERT INTO commission_referral_signatures (referral_id, user_id, version_hash, terms, doc, signature_png, ip, user_agent${cols})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8${vals})
       RETURNING id, to_char(signed_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS signed_at_local`, args)).rows[0];
    fails.delete(uid);
    await logEvent({ userId: me, action: 'create', target: `commission_referral_sign:${r.id}`, detail: { referral_id: ref.id, version: hash, kind: inPerson ? 'signature_pin_in_person' : 'signature_pin', signer: uid } });
    return { ok: true, id: Number(r.id), version: hash, signed_at: r.signed_at_local, device: deviceLabel(ua), in_person: inPerson };
  });

  // ── 서명 원문(스냅샷 + 손서명) — 소개자 본인 또는 전체열람자 ──
  app.get('/api/commission/referrals/signatures/:sigId', { preHandler: [authGuard] }, async (req, reply) => {
    if (!(await referralsReady())) return reply.code(404).send({ error: 'not_found' });
    const perm = req.ctx.perm;
    const cap = await capturedReady();
    const s = (await query(
      `SELECT s.id, s.referral_id, s.user_id, s.version_hash, s.doc, s.signature_png, s.ip, s.user_agent,
              to_char(s.signed_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS signed_at_local, u.name AS signer_name
              ${cap ? ', cu.name AS captured_by_name' : ''}
         FROM commission_referral_signatures s JOIN users u ON u.id=s.user_id
         ${cap ? 'LEFT JOIN users cu ON cu.id=s.captured_by' : ''} WHERE s.id=$1`, [Number(req.params.sigId)])).rows[0];
    if (!s) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeAll(perm) && Number(s.user_id) !== Number(perm.userId)) return reply.code(403).send({ error: 'forbidden' });
    return {
      id: Number(s.id), referral_id: Number(s.referral_id), version: s.version_hash, signed_at: s.signed_at_local,
      signer_name: s.signer_name, captured_by_name: s.captured_by_name || null, device: deviceLabel(s.user_agent), ip: canSeeAll(perm) ? s.ip : null,
      doc: s.doc, signature: s.signature_png,
    };
  });

  // ── 현재 계약서 미리보기 (전체열람자) ──
  app.get('/api/commission/referrals/:id/preview', { preHandler: [authGuard] }, async (req, reply) => {
    if (!canSeeAll(req.ctx.perm)) return reply.code(403).send({ error: 'forbidden' });
    if (!(await referralsReady())) return reply.code(503).send(MIG);
    const ref = await loadReferral(req.params.id);
    if (!ref) return reply.code(404).send({ error: 'not_found' });
    return refOut(ref, req.ctx.perm, { withDoc: true });
  });

  // ── 실적 — B 의 매출·수금·고객 + A 소개 커미션 (소개자 본인 또는 전체열람자 · 조회 전용) ──
  //   공개 범위(디렉터 결정 2026-10-29): 고객명 · 인보이스 번호·날짜 · 순매출(ex-IVA) · 수금 상태 · 소개 커미션. 원가·마진·할인율 없음.
  app.get('/api/commission/referrals/:id/performance', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    if (!(await referralsReady())) return reply.code(503).send(MIG);
    const ref = await loadReferral(req.params.id);
    if (!ref || !canView(perm, ref) || (!ref.active && !canSeeAll(perm))) return reply.code(404).send({ error: 'not_found' });
    const st = await referralState(ref);
    let lines = await referralLines(ref, st);
    const from = /^\d{4}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
    const to = /^\d{4}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
    if (from || to) {
      const inR = (ym) => !!ym && (!from || ym >= from) && (!to || ym <= to);
      lines = lines.filter((l) => inR(String(l.inv_date).slice(0, 7)) || inR(l.settle_ym) || l.status === 'pending');
    }
    if (!canSeeAll(perm)) await logEvent({ userId: perm.userId, action: 'page_view', target: `commission_referral:${ref.id}`, detail: { kind: 'performance', from, to } });
    return {
      referral: {
        id: ref.id, referrer_name: ref.referrer_name, referred_name: normInfo(ref.referred_info).name || ref.referred_user_name,
        rate: ref.rate, start_date: ref.start_date, end_date: ref.end_date, active: ref.active,
        effective_from: st.effective_from, sign_status: st.sign_status, docs_complete: st.docs_status.complete,
      },
      from, to, lines, ...summarizeReferral(lines),
    };
  });
}
