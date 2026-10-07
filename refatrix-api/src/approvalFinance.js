// 전자결재 ↔ 자금(미래자금계획 · 거래등록) 연동 — 0258 (디렉터 요청 2026-10-07)
//
//   규칙 한 곳: syncApprovalDoc(q, docId, actorId) — 문서 상태를 보고 연결을 "있어야 할 모습"으로 맞춘다(멱등).
//     · 승인완료 · 미삭제 문서의 미집행(planned) 회차   → 지출 예정 거래(transactions status='plan') 1행
//         (계좌 미지정 · 과목 = 결재 카테고리의 재무 과목 · 메모 「[전자결재] 문서번호 제목 (회차)」)
//     · 문서가 승인완료가 아니게 됨(재결재·삭제) / 회차 중단 / 전자결재 화면에서 집행  → 아직 예정이면 숨김(소프트 삭제)
//     · 연결된 거래가 실적이 됨(예정 내역 → 실적 처리, 또는 거래등록에서 이 문서를 골라 등록)
//         → 회차 집행완료(exec_source='finance', 실적 = 거래 금액) → 전 회차 끝나면 사후승인 요청
//     · 거래등록 실적이 삭제·반려됨 → 회차를 미집행으로 되돌리고 예정을 다시 만든다(사후승인 대기였다면 집행대기로)
//   전자결재 라우트(approvalRoutes.js)는 거래 테이블을 직접 다루지 않고 이 모듈만 부른다.
//   재무 라우트(financeRoutes.js)는 거래가 바뀐 뒤 syncApprovalByTxn 을 부른다.
import { n, round2 } from './approval.js';

export const APPROVAL_MEMO_PREFIX = '[전자결재]';
export const DEFAULT_EXP_CODE = '6130';            // 기타경비 — 카테고리에 과목이 없을 때

// 0258 적용 여부(백엔드만 먼저 올라간 상태에서 재무 화면이 깨지지 않도록) — 한 번 확인되면 계속 true
let _ready = { at: 0, ok: false };
export async function approvalFinReady(q) {
  if (_ready.ok) return true;
  const now = Date.now();
  if (_ready.at && now - _ready.at < 30000) return false;
  try {
    const r = await q(`SELECT 1 FROM information_schema.columns WHERE table_name='approval_payments' AND column_name='txn_id'`);
    _ready = { at: now, ok: r.rows.length > 0 };
  } catch (_) { _ready = { at: now, ok: false }; }
  return _ready.ok;
}
export function _resetApprovalFinReady() { _ready = { at: 0, ok: false }; }

async function notify(q, userId, docId, kind, memo, actorId) {
  if (userId == null || (actorId != null && Number(userId) === Number(actorId))) return;
  await q(`INSERT INTO approval_notifications(user_id, document_id, kind, memo) VALUES ($1,$2,$3,$4)`,
    [userId, docId, kind, memo ? String(memo).slice(0, 300) : null]);
}
async function event(q, docId, actorId, action, detail) {
  await q(`INSERT INTO approval_events(document_id, actor_id, action, step_type, detail) VALUES ($1,$2,$3,NULL,$4)`,
    [docId, actorId ?? null, action, detail || null]);
}

export function planMemo(doc, seq, total) {
  return `${APPROVAL_MEMO_PREFIX} ${doc.doc_no || ''} ${doc.title || ''}${total > 1 ? ` (${seq}/${total})` : ''}${doc.vendor ? ` · ${doc.vendor}` : ''}`
    .replace(/\s+/g, ' ').trim().slice(0, 500);
}

// 거래 실적 → 회차 실적(문서 통화). 문서·거래 통화가 다르면 MXN 을 거쳐 환산.
export function actualFromTxn(doc, t) {
  const tCur = t.currency || 'MXN';
  const mxn = round2(n(t.amount_mxn));
  let amt;
  if (tCur === doc.currency) amt = round2(n(t.amount));
  else if (doc.currency === 'USD') amt = n(doc.fx_rate) > 0 ? round2(mxn / n(doc.fx_rate)) : round2(mxn);
  else amt = mxn;
  const fx = tCur === 'USD' ? n(t.fx_rate) : (doc.currency === 'USD' ? n(doc.fx_rate) : 1);
  return { amount: amt, mxn, fx };
}

async function loadDoc(q, docId, lock) {
  return (await q(
    `SELECT d.id, d.doc_no, d.title, d.vendor, d.drafter_id, d.status, d.exec_status, d.post_status, d.currency, d.fx_rate,
            d.pay_method, d.deleted_at, d.category_id, d.planned_total, d.actual_total, to_char(d.pay_due,'YYYY-MM-DD') AS pay_due,
            (SELECT ac.fin_category_code FROM approval_categories ac WHERE ac.id = d.category_id) AS fin_code
       FROM approval_documents d WHERE d.id=$1${lock ? ' FOR UPDATE' : ''}`, [docId])).rows[0] || null;
}
async function loadPays(q, docId) {
  return (await q(
    `SELECT p.id, p.seq, to_char(p.due_date,'YYYY-MM-DD') AS due_date, p.planned_amount, p.planned_mxn, p.status, p.exec_source,
            p.txn_id, p.actual_amount, p.actual_mxn, to_char(p.exec_date,'YYYY-MM-DD') AS exec_date,
            t.id AS t_id, t.status AS t_status, (t.deleted_at IS NOT NULL) AS t_deleted, t.amount AS t_amount, t.currency AS t_currency,
            t.fx_rate AS t_fx, t.amount_mxn AS t_mxn, to_char(t.txn_date,'YYYY-MM-DD') AS t_date, t.category_code AS t_cat, t.memo AS t_memo,
            COALESCE(t.updated_by, t.created_by) AS t_by
       FROM approval_payments p LEFT JOIN transactions t ON t.id = p.txn_id
      WHERE p.document_id=$1 ORDER BY p.seq`, [docId])).rows;
}
const alive = (p) => p.t_id != null && !p.t_deleted;
const isActual = (p) => alive(p) && p.t_status === 'actual';

// 문서 연결 맞추기 — 반환 { changed, plans:{created,updated,removed}, finance:{settled,reverted} }
export async function syncApprovalDoc(q, docId, actorId = null) {
  if (!(await approvalFinReady(q))) return { skipped: 'migration_required' };
  const doc = await loadDoc(q, docId, true);
  if (!doc) return { skipped: 'not_found' };
  const out = { changed: false, plans: { created: 0, updated: 0, removed: 0 }, finance: { settled: 0, reverted: 0 } };
  let pays = await loadPays(q, docId);
  const total = pays.length;
  let finTouched = false;

  // ① 거래등록 실적이 사라진 회차 → 미집행으로 되돌림
  for (const p of pays) {
    if (p.status === 'done' && p.exec_source === 'finance' && !isActual(p)) {
      await q(`UPDATE approval_payments SET status='planned', actual_amount=NULL, actual_mxn=NULL, fx_rate=NULL, fx_date=NULL,
                 exec_date=NULL, pay_method=NULL, memo=NULL, exec_at=NULL, exec_by=NULL, exec_source=NULL,
                 txn_id = CASE WHEN $2 THEN txn_id ELSE NULL END WHERE id=$1`, [p.id, alive(p) && p.t_status === 'plan']);
      await event(q, docId, actorId, 'fin_revert', `${total > 1 ? `${p.seq}/${total}회차 · ` : ''}연결된 거래등록 실적이 삭제·반려되어 미집행으로 되돌림`);
      out.finance.reverted++; finTouched = true;
    }
  }
  // ② 연결 거래가 실적 → 회차 집행완료(거래등록) · 이미 거래등록으로 처리된 회차는 실적 갱신
  if (finTouched) pays = await loadPays(q, docId);
  for (const p of pays) {
    if (!isActual(p)) continue;
    const t = { amount: p.t_amount, currency: p.t_currency, fx_rate: p.t_fx, amount_mxn: p.t_mxn };
    const a = actualFromTxn(doc, t);
    if (p.status === 'planned') {
      await q(`UPDATE approval_payments SET status='done', exec_source='finance', actual_amount=$2, actual_mxn=$3, fx_rate=$4,
                 fx_date=$5, exec_date=$5, pay_method=$6, memo=$7, exec_at=now(), exec_by=$8 WHERE id=$1`,
        [p.id, a.amount, a.mxn, a.fx, p.t_date, doc.pay_method || '계좌이체', `거래등록 #${p.t_id}`, p.t_by ?? actorId]);
      await event(q, docId, actorId, 'fin_exec', `${total > 1 ? `${p.seq}/${total}회차 · ` : ''}거래등록 #${p.t_id} 실적 ${doc.currency === 'USD' ? `USD ${a.amount.toFixed(2)} = ` : ''}MXN ${a.mxn.toFixed(2)} · ${p.t_date}`);
      out.finance.settled++; finTouched = true;
    } else if (p.status === 'done' && p.exec_source === 'finance'
      && (Math.abs(n(p.actual_mxn) - a.mxn) > 0.004 || Math.abs(n(p.actual_amount) - a.amount) > 0.004 || p.exec_date !== p.t_date)) {
      await q(`UPDATE approval_payments SET actual_amount=$2, actual_mxn=$3, fx_rate=$4, fx_date=$5, exec_date=$5 WHERE id=$1`,
        [p.id, a.amount, a.mxn, a.fx, p.t_date]);
      finTouched = true;
    }
  }
  if (finTouched) pays = await loadPays(q, docId);

  // ③ 예정 행 맞추기
  const live = doc.status === 'approved' && !doc.deleted_at;
  const code = doc.fin_code || DEFAULT_EXP_CODE;
  const codeOk = (await q(`SELECT 1 FROM categories WHERE code=$1`, [code])).rows.length ? code : null;
  const fx = doc.currency === 'USD' ? n(doc.fx_rate) || 1 : 1;
  for (const p of pays) {
    if (isActual(p)) continue;
    const want = live && p.status === 'planned';
    const date = p.due_date || doc.pay_due || new Date().toISOString().slice(0, 10);
    const amt = round2(n(p.planned_amount)), mxn = round2(n(p.planned_mxn ?? p.planned_amount)), memo = planMemo(doc, p.seq, total);
    if (want) {
      if (p.t_id != null && p.t_status === 'plan') {
        const same = !p.t_deleted && p.t_date === date && Math.abs(n(p.t_amount) - amt) < 0.005 && p.t_currency === doc.currency
          && Math.abs(n(p.t_mxn) - mxn) < 0.005 && (p.t_cat || null) === codeOk && p.t_memo === memo;
        if (!same) {
          await q(`UPDATE transactions SET deleted_at=NULL, txn_date=$2, plan_date=$2, amount=$3, plan_amount=$3, currency=$4, fx_rate=$5,
                     amount_mxn=$6, category_code=$7, memo=$8, updated_by=$9 WHERE id=$1 AND status='plan'`,
            [p.t_id, date, amt, doc.currency, fx, mxn, codeOk, memo, actorId]);
          if (p.t_deleted) out.plans.created++; else out.plans.updated++;
        }
      } else {
        const ins = await q(
          `INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind,
                                     approved, owner_id, memo, created_by, plan_amount, plan_date, plan_memo)
           VALUES (NULL,$1,'out',$2,$3,$4,$5,$6,'plan','general',true,$7,$8,$9,$2,$1,$10) RETURNING id`,
          [date, amt, doc.currency, fx, mxn, codeOk, doc.drafter_id, memo, actorId ?? doc.drafter_id, `approval_payment:${p.id}`]);
        await q(`UPDATE approval_payments SET txn_id=$2 WHERE id=$1`, [p.id, ins.rows[0].id]);
        out.plans.created++;
      }
    } else if (alive(p) && p.t_status === 'plan') {
      await q(`UPDATE transactions SET deleted_at=now(), updated_by=$2 WHERE id=$1 AND status='plan'`, [p.t_id, actorId]);
      out.plans.removed++;
    }
  }

  // ④ 문서 집행 상태 — 거래등록 실적으로 회차가 바뀐 경우에만 손댄다
  if (finTouched) {
    pays = await loadPays(q, docId);
    const done = pays.filter((p) => p.status === 'done');
    const open = pays.filter((p) => p.status === 'planned');
    const actual = round2(done.reduce((s, p) => s + n(p.actual_mxn), 0));
    const post = (await q(`SELECT id, user_id, status FROM approval_lines WHERE document_id=$1 AND step_type='post_ceo'`, [docId])).rows[0];
    if (doc.status === 'approved' && doc.exec_status === 'pending' && pays.length && !open.length) {
      const last = [...done].sort((a, c) => String(a.exec_date || '').localeCompare(String(c.exec_date || '')) || a.seq - c.seq).pop();
      await q(`UPDATE approval_documents SET exec_status='done', actual_total=$2, exec_date=$3, exec_pay_method=$4, exec_at=now(), exec_by=$5,
                 post_status='pending', updated_at=now() WHERE id=$1`,
        [docId, actual, last ? last.exec_date : null, doc.pay_method || '계좌이체', actorId]);
      if (post) {
        await q(`UPDATE approval_lines SET status='pending', pending_at=now() WHERE id=$1`, [post.id]);
        await notify(q, post.user_id, docId, '사후승인 요청', null, actorId);
      }
      await notify(q, doc.drafter_id, docId, '집행완료', '거래등록 실적', actorId);
      await event(q, docId, actorId, 'exec_done', `거래등록 실적으로 전 회차 처리 · 실적 합계 MXN ${actual.toFixed(2)}`);
    } else if (doc.exec_status === 'done' && open.length && ['pending', 'none'].includes(doc.post_status)) {
      await q(`UPDATE approval_documents SET exec_status='pending', post_status='none', actual_total=$2, exec_at=NULL, exec_by=NULL, updated_at=now() WHERE id=$1`, [docId, actual]);
      if (post && post.status === 'pending') {
        await q(`UPDATE approval_lines SET status='waiting', pending_at=NULL WHERE id=$1`, [post.id]);
        await q(`DELETE FROM approval_notifications WHERE document_id=$1 AND read_at IS NULL AND kind='사후승인 요청'`, [docId]);
      }
      await event(q, docId, actorId, 'exec_reopen', '거래등록 실적 취소로 집행대기로 되돌림');
    } else {
      await q(`UPDATE approval_documents SET actual_total=$2, updated_at=now() WHERE id=$1`, [docId, actual]);
    }
  }
  out.changed = finTouched || out.plans.created + out.plans.updated + out.plans.removed > 0;
  return out;
}

// 거래가 바뀐 뒤(실적 처리·삭제·반려·수정) 그 거래와 연결된 전자결재 문서를 맞춘다.
export async function syncApprovalByTxn(q, txnId, actorId = null) {
  if (!(await approvalFinReady(q))) return [];
  const docs = (await q(`SELECT DISTINCT document_id FROM approval_payments WHERE txn_id=$1`, [txnId])).rows;
  const res = [];
  for (const d of docs) res.push(await syncApprovalDoc(q, Number(d.document_id), actorId));
  return res;
}

// 거래를 지우면 사후승인까지 끝난 문서가 되돌아가야 하는 경우 → 막는다. 반환: 문서번호 | null
export async function approvalCloseLock(q, txnId) {
  if (!(await approvalFinReady(q))) return null;
  const r = (await q(
    `SELECT d.doc_no FROM approval_payments p JOIN approval_documents d ON d.id=p.document_id
      WHERE p.txn_id=$1 AND p.exec_source='finance' AND d.deleted_at IS NULL AND d.post_status IN ('confirmed','flagged')`, [txnId])).rows[0];
  return r ? (r.doc_no || '전자결재') : null;
}

// 거래에 연결된 전자결재 정보(목록·상세 표시용) — { txnId: {...} }
export async function approvalLinksForTxns(q, ids) {
  const list = (ids || []).map(Number).filter(Boolean);
  if (!list.length || !(await approvalFinReady(q))) return {};
  const rows = (await q(
    `SELECT p.txn_id, p.id AS payment_id, p.seq, p.status AS pay_status, p.exec_source,
            (SELECT count(*)::int FROM approval_payments x WHERE x.document_id=p.document_id) AS pay_n,
            d.id AS doc_id, d.doc_no, d.title, d.vendor, d.status AS doc_status, d.post_status, (d.deleted_at IS NOT NULL) AS doc_deleted
       FROM approval_payments p JOIN approval_documents d ON d.id=p.document_id
      WHERE p.txn_id = ANY($1::bigint[])`, [list])).rows;
  const m = {};
  for (const r of rows) {
    m[Number(r.txn_id)] = {
      payment_id: Number(r.payment_id), seq: Number(r.seq), pay_n: Number(r.pay_n), pay_status: r.pay_status, exec_source: r.exec_source,
      doc_id: Number(r.doc_id), doc_no: r.doc_no, title: r.title, vendor: r.vendor, doc_status: r.doc_status, post_status: r.post_status,
      doc_deleted: r.doc_deleted,
    };
  }
  return m;
}

// 거래등록에서 고를 수 있는 전자결재 회차 — 승인완료·미삭제 · 중단 아님 · 아직 거래등록 실적이 없는 회차
export async function approvalOptions(q, { search } = {}) {
  if (!(await approvalFinReady(q))) return [];
  const args = [];
  let cond = '';
  if (search && String(search).trim()) {
    args.push(`%${String(search).trim().toLowerCase()}%`);
    cond = ` AND lower(COALESCE(d.doc_no,'') || ' ' || d.title || ' ' || COALESCE(d.vendor,'')) LIKE $${args.length}`;
  }
  const rows = (await q(
    `SELECT p.id AS payment_id, p.seq, (SELECT count(*)::int FROM approval_payments x WHERE x.document_id=p.document_id) AS pay_n,
            to_char(p.due_date,'YYYY-MM-DD') AS due_date, p.planned_amount, p.planned_mxn, p.status AS pay_status, p.exec_source,
            p.actual_amount, p.actual_mxn, p.txn_id, t.status AS t_status,
            d.id AS doc_id, d.doc_no, d.title, d.vendor, d.currency, d.fx_rate, d.pay_method, d.exec_required,
            ac.name AS category_name, COALESCE(ac.fin_category_code, '${DEFAULT_EXP_CODE}') AS category_code, u.name AS drafter_name
       FROM approval_payments p
       JOIN approval_documents d ON d.id=p.document_id AND d.deleted_at IS NULL AND d.status='approved'
       LEFT JOIN approval_categories ac ON ac.id=d.category_id
       LEFT JOIN users u ON u.id=d.drafter_id
       LEFT JOIN transactions t ON t.id=p.txn_id AND t.deleted_at IS NULL
      WHERE p.status <> 'skipped' AND NOT (p.status='done' AND p.exec_source='finance') AND (t.id IS NULL OR t.status='plan')${cond}
      ORDER BY p.due_date NULLS LAST, d.doc_no, p.seq LIMIT 300`, args)).rows;
  return rows.map((r) => ({
    payment_id: Number(r.payment_id), seq: Number(r.seq), pay_n: Number(r.pay_n), due_date: r.due_date,
    planned_amount: n(r.planned_amount), planned_mxn: n(r.planned_mxn ?? r.planned_amount), pay_status: r.pay_status, exec_source: r.exec_source,
    plan_txn_id: r.txn_id != null && r.t_status === 'plan' ? Number(r.txn_id) : null,
    doc_id: Number(r.doc_id), doc_no: r.doc_no, title: r.title, vendor: r.vendor, currency: r.currency, fx_rate: n(r.fx_rate),
    category_code: r.category_code, category_name: r.category_name, drafter_name: r.drafter_name, pay_method: r.pay_method,
  }));
}

// 회차 1건을 거래등록 연결 대상으로 잠그고 검증 — 반환 { pay, doc, planTxnId } | { error }
export async function lockPaymentForLink(q, paymentId) {
  if (!(await approvalFinReady(q))) return { error: 'migration_required' };
  const p = (await q(`SELECT p.*, d.status AS doc_status, d.deleted_at AS doc_deleted, d.id AS doc_id
                         FROM approval_payments p JOIN approval_documents d ON d.id=p.document_id WHERE p.id=$1 FOR UPDATE OF p`, [paymentId])).rows[0];
  if (!p) return { error: 'approval_payment_not_found' };
  if (p.doc_deleted || p.doc_status !== 'approved') return { error: 'approval_not_approved' };
  if (p.status === 'skipped') return { error: 'approval_payment_skipped' };
  let planTxnId = null;
  if (p.txn_id != null) {
    const t = (await q(`SELECT id, status, deleted_at FROM transactions WHERE id=$1 FOR UPDATE`, [p.txn_id])).rows[0];
    if (t && !t.deleted_at && t.status === 'actual') return { error: 'approval_payment_already_linked' };
    if (t && !t.deleted_at && t.status === 'plan') planTxnId = Number(t.id);
  }
  if (p.status === 'done' && p.exec_source === 'finance') return { error: 'approval_payment_already_linked' };
  return { pay: p, docId: Number(p.doc_id), planTxnId };
}

// 전자결재 상세 화면용 — 회차별 자금 연결 상태 { paymentId: { txn_id, fin:'plan'|'actual'|null, txn_date } }
export async function paymentFinanceMap(q, docId) {
  if (!(await approvalFinReady(q))) return {};
  const rows = (await q(
    `SELECT p.id, p.txn_id, p.exec_source, t.status, to_char(t.txn_date,'YYYY-MM-DD') AS txn_date
       FROM approval_payments p LEFT JOIN transactions t ON t.id=p.txn_id AND t.deleted_at IS NULL
      WHERE p.document_id=$1`, [docId])).rows;
  const m = {};
  for (const r of rows) m[Number(r.id)] = { txn_id: r.status ? Number(r.txn_id) : null, fin: r.status || null, txn_date: r.txn_date || null, exec_source: r.exec_source || null };
  return m;
}
