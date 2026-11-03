// 전자결재 ↔ 자금(미래자금계획 · 거래등록) 연동 — 0258 (디렉터 요청 2026-10-07)
//
//   규칙 한 곳: syncApprovalDoc(q, docId, actorId) — 문서 상태를 보고 연결을 "있어야 할 모습"으로 맞춘다(멱등).
//     · 승인완료 · 미삭제 문서의 미집행(planned) 회차   → 지출 예정 거래(transactions status='plan') 1행
//         (계좌 미지정 · 과목 = 결재 카테고리의 재무 과목 · 메모 「[전자결재] 문서번호 제목 (회차)」)
//     · 전자결재 화면에서 집행(또는 집행 생략)한 회차도 거래등록 실적이 연결될 때까지 예정으로 남긴다(0259 — 실제 지급일·금액으로)
//     · 문서가 승인완료가 아니게 됨(재결재·삭제) / 회차 중단  → 아직 예정이면 숨김(소프트 삭제)
//     · 연결된 거래가 실적이 됨(예정 내역 → 실적 처리, 또는 거래등록에서 이 문서를 골라 등록)
//         → 회차 집행완료(exec_source='finance', 실적 = 거래 금액) → 전 회차 끝나면 사후승인 요청
//     · 거래등록 실적이 삭제·반려됨 → 회차를 미집행으로 되돌리고 예정을 다시 만든다(사후승인 대기였다면 집행대기로)
//   전자결재 라우트(approvalRoutes.js)는 거래 테이블을 직접 다루지 않고 이 모듈만 부른다.
//   재무 라우트(financeRoutes.js)는 거래가 바뀐 뒤 syncApprovalByTxn 을 부른다.
import { n, round2 } from './approval.js';
import { expandBetween } from './recurring.js';
import { getUsdMxnRate } from './fx.js';
import { commissionApprovalReady, linkForDoc } from './commissionApproval.js';   // 0287c 커미션 문서는 생성 즉시 예정

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
            (SELECT ac.fin_category_code FROM approval_categories ac WHERE ac.id = d.category_id) AS fin_code,
            (SELECT u.role FROM users u WHERE u.id = d.drafter_id) AS drafter_role
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
  // 0287c 커미션 지급승인 문서는 **생성(임시저장)·결재 중에도** 미래자금계획에 예정으로 둔다(디렉터 2026-10-19). 반려·삭제되면 빠진다.
  // 2026-10-26 디렉터가 작성한 문서도 임시저장·결재 중부터 예정으로 둔다(디렉터 「내가 작성하는 건 모두 반영」). 반려·삭제되면 빠진다.
  const early = !doc.deleted_at && ['draft', 'progress'].includes(doc.status)
    && (doc.drafter_role === 'director' || await isCommissionDoc(q, docId));
  const live = (doc.status === 'approved' && !doc.deleted_at) || early;
  const code = doc.fin_code || DEFAULT_EXP_CODE;
  const codeOk = (await q(`SELECT 1 FROM categories WHERE code=$1`, [code])).rows.length ? code : null;
  const fx = doc.currency === 'USD' ? n(doc.fx_rate) || 1 : 1;
  for (const p of pays) {
    if (isActual(p)) continue;
    // 0259: 전자결재에서 집행·집행생략한 회차(done · exec_source≠finance)도 거래등록 실적 연결 전까지 예정 유지
    const apDone = p.status === 'done' && p.exec_source !== 'finance';
    const want = live && (p.status === 'planned' || apDone);
    const date = (apDone && p.exec_date) || p.due_date || doc.pay_due || new Date().toISOString().slice(0, 10);
    const amt = round2(n(apDone && p.actual_amount != null ? p.actual_amount : p.planned_amount));
    const mxn = round2(n(apDone && p.actual_mxn != null ? p.actual_mxn : (p.planned_mxn ?? p.planned_amount)));
    const memo = planMemo(doc, p.seq, total);
    const fxRow = doc.currency === 'USD' && apDone && amt > 0 ? Math.round((mxn / amt) * 1e6) / 1e6 : fx;
    if (want) {
      if (p.t_id != null && p.t_status === 'plan') {
        const same = !p.t_deleted && p.t_date === date && Math.abs(n(p.t_amount) - amt) < 0.005 && p.t_currency === doc.currency
          && Math.abs(n(p.t_mxn) - mxn) < 0.005 && (p.t_cat || null) === codeOk && p.t_memo === memo;
        if (!same) {
          await q(`UPDATE transactions SET deleted_at=NULL, txn_date=$2, plan_date=$2, amount=$3, plan_amount=$3, currency=$4, fx_rate=$5,
                     amount_mxn=$6, category_code=$7, memo=$8, updated_by=$9 WHERE id=$1 AND status='plan'`,
            [p.t_id, date, amt, doc.currency, fxRow, mxn, codeOk, memo, actorId]);
          if (p.t_deleted) out.plans.created++; else out.plans.updated++;
        }
      } else {
        const ins = await q(
          `INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind,
                                     approved, owner_id, memo, created_by, plan_amount, plan_date, plan_memo)
           VALUES (NULL,$1,'out',$2,$3,$4,$5,$6,'plan','general',true,$7,$8,$9,$2,$1,$10) RETURNING id`,
          [date, amt, doc.currency, fxRow, mxn, codeOk, doc.drafter_id, memo, actorId ?? doc.drafter_id, `approval_payment:${p.id}`]);
        await q(`UPDATE approval_payments SET txn_id=$2 WHERE id=$1`, [p.id, ins.rows[0].id]);
        out.plans.created++;
      }
    } else if (alive(p) && p.t_status === 'plan') {
      await q(`UPDATE transactions SET deleted_at=now(), updated_by=$2 WHERE id=$1 AND status='plan'`, [p.t_id, actorId]);
      out.plans.removed++;
    }
  }

  // ③-b 0313 고정비 회차 대체 — 결재가 살아 있는 동안 고른 고정비 예정을 숨기고, 반려·삭제되면 되살린다.
  out.recurring = await syncRecurringReplace(q, docId, live, actorId);
  if (out.recurring.hidden || out.recurring.restored) out.changed = true;

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
  out.changed = out.changed || finTouched || out.plans.created + out.plans.updated + out.plans.removed > 0;
  return out;
}

// ═══════ 0313 전자결재 ↔ 고정비 회차 대체 (2026-11-03 디렉터) ═══════
// SUA·임차료처럼 고정비로 등록된 지출을 전자결재로 지급하면 고정비 예정과 전자결재 예정/실적이 따로 남아
// 한 달에 같은 고정비가 2~3건 잡혔다. 결재 작성 시 「대체할 고정비 회차」를 고르면:
//   · 문서가 살아 있는 동안(승인완료 · 디렉터/커미션 문서는 임시저장부터) 그 회차 예정을 숨긴다 → replaced_by_doc 표시
//   · 문서가 반려·삭제되거나 선택을 해제하면 이 문서가 숨긴 회차만 되살린다(직접 지운 회차는 건드리지 않음)
//   숨겨진 회차는 삭제분으로 남으므로 자동전개(occurrenceExists)가 같은 달을 다시 만들지 않는다.
let _rep = { at: 0, ok: false };
export async function replaceReady(q) {
  if (_rep.ok) return true;
  const now = Date.now();
  if (_rep.at && now - _rep.at < 30000) return false;
  try {
    const r = await q(`SELECT 1 FROM information_schema.columns WHERE table_name='transactions' AND column_name='replaced_by_doc'`);
    _rep = { at: now, ok: r.rows.length > 0 };
  } catch (_) { _rep = { at: now, ok: false }; }
  return _rep.ok;
}
export function _resetReplaceReady() { _rep = { at: 0, ok: false }; }

export function normReplaceIds(v) {
  if (!Array.isArray(v)) return null;   // null = 입력 없음(구 클라이언트) → 기존 값 유지
  return [...new Set(v.map(Number).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 24);
}

// 대체 가능한 고정비 회차(예정) — 결재 작성 화면 목록. 이 문서가 이미 숨긴 회차도 포함(선택 유지).
//   기간: 오늘 기준 120일 전 ~ 75일 후(유효일). 비공개 고정비는 디렉터만.
export async function recurringCandidates(q, { docId = null, director = false, today = null } = {}) {
  if (!(await replaceReady(q))) return [];
  const t0 = today || new Date().toISOString().slice(0, 10);
  const rows = (await q(
    `SELECT t.id, to_char(COALESCE(t.plan_date, t.txn_date),'YYYY-MM-DD') AS d, t.amount, t.currency, t.amount_mxn,
            t.category_code, cat.name AS category_name, a.name AS account_name, t.recurring_rule_id AS rule_id, rr.name AS rule_name,
            t.replaced_by_doc, (t.deleted_at IS NOT NULL) AS hidden
       FROM transactions t
       JOIN recurring_rules rr ON rr.id=t.recurring_rule_id
       LEFT JOIN categories cat ON cat.code=t.category_code
       LEFT JOIN accounts a ON a.id=t.account_id
      WHERE t.status='plan' AND t.direction='out' AND t.recurring_rule_id IS NOT NULL
        AND (t.deleted_at IS NULL OR ($1::bigint IS NOT NULL AND t.replaced_by_doc=$1::bigint))
        AND COALESCE(t.plan_date, t.txn_date) BETWEEN ($2::date - 120) AND ($2::date + 75)
        ${director ? '' : 'AND t.is_private=false'}
      ORDER BY COALESCE(t.plan_date, t.txn_date), t.id`, [docId, t0])).rows;
  return rows.map((r) => ({
    id: Number(r.id), date: r.d, amount: Number(r.amount), currency: r.currency, amount_mxn: Number(r.amount_mxn),
    category_code: r.category_code, category_name: r.category_name, account_name: r.account_name,
    rule_id: Number(r.rule_id), rule_name: r.rule_name,
    replaced_by_doc: r.replaced_by_doc == null ? null : Number(r.replaced_by_doc), hidden: r.hidden === true,
  }));
}

// 작성 화면에서 고른 회차 저장 — 고를 수 있는 회차만 남긴다(다른 문서가 이미 대체한 회차·실적·비고정비 제외).
export async function saveReplaceIds(q, docId, ids, { director = false } = {}) {
  if (ids == null || !(await replaceReady(q))) return null;
  let ok = [];
  if (ids.length) {
    ok = (await q(
      `SELECT id FROM transactions
        WHERE id = ANY($1::bigint[]) AND status='plan' AND recurring_rule_id IS NOT NULL
          AND (deleted_at IS NULL OR replaced_by_doc=$2)${director ? '' : ' AND is_private=false'}`, [ids, docId])).rows.map((r) => Number(r.id));
  }
  await q(`UPDATE approval_documents SET replaces_txn_ids=$2 WHERE id=$1`, [docId, ok.length ? ok : null]);
  return ok;
}

// 상세 화면용 — 이 결재가 대체(예정)하는 고정비 회차. active=지금 실제로 숨기고 있음.
export async function replacesForDoc(q, docId) {
  if (!(await replaceReady(q))) return [];
  const ids = (await q(`SELECT replaces_txn_ids FROM approval_documents WHERE id=$1`, [docId])).rows[0]?.replaces_txn_ids || [];
  if (!ids.length) return [];
  return (await q(
    `SELECT t.id, to_char(COALESCE(t.plan_date, t.txn_date),'YYYY-MM-DD') AS d, t.amount, t.currency, rr.name AS rule_name,
            (t.replaced_by_doc IS NOT DISTINCT FROM $2::bigint) AS active
       FROM transactions t LEFT JOIN recurring_rules rr ON rr.id=t.recurring_rule_id
      WHERE t.id = ANY($1::bigint[]) ORDER BY 2, t.id`, [ids.map(Number), docId])).rows
    .map((r) => ({ id: Number(r.id), date: r.d, amount: Number(r.amount), currency: r.currency, rule_name: r.rule_name, active: r.active === true }));
}
// 재기안 — 원문서의 대체 선택을 새 문서로 복사
export async function copyReplaceIds(q, fromId, toId) {
  if (!(await replaceReady(q))) return;
  await q(`UPDATE approval_documents n SET replaces_txn_ids=o.replaces_txn_ids FROM approval_documents o WHERE n.id=$2 AND o.id=$1`, [fromId, toId]);
  if (await ruleChoiceReady(q)) {   // 0314 고정비 선택도 이어받는다
    await q(`UPDATE approval_documents n SET replace_choice=o.replace_choice, replace_rule_id=o.replace_rule_id FROM approval_documents o WHERE n.id=$2 AND o.id=$1`, [fromId, toId]);
  }
}

export async function syncRecurringReplace(q, docId, live, actorId = null) {
  const out = { hidden: 0, restored: 0 };
  if (!(await replaceReady(q))) return out;
  const d = (await q(`SELECT replaces_txn_ids FROM approval_documents WHERE id=$1`, [docId])).rows[0];
  const ids = live && d && Array.isArray(d.replaces_txn_ids) ? d.replaces_txn_ids.map(Number).filter(Boolean) : [];
  // 되살림은 고정비 규칙이 아직 살아 있을 때만 — 그사이 고정비를 지웠다면 표시만 떼고 숨긴 채로 둔다.
  const back = await q(
    `UPDATE transactions SET deleted_at=NULL, replaced_by_doc=NULL, updated_by=$3
      WHERE replaced_by_doc=$1 AND status='plan' AND NOT (id = ANY($2::bigint[]))
        AND recurring_rule_id IN (SELECT id FROM recurring_rules WHERE deleted_at IS NULL)`, [docId, ids, actorId]);
  out.restored = back.rowCount || 0;
  await q(`UPDATE transactions SET replaced_by_doc=NULL WHERE replaced_by_doc=$1 AND NOT (id = ANY($2::bigint[]))`, [docId, ids]);
  if (ids.length) {
    const h = await q(
      `UPDATE transactions SET deleted_at=now(), replaced_by_doc=$1, updated_by=$3
        WHERE id = ANY($2::bigint[]) AND status='plan' AND recurring_rule_id IS NOT NULL AND deleted_at IS NULL`, [docId, ids, actorId]);
    out.hidden = h.rowCount || 0;
  }
  if (out.hidden || out.restored) {
    await event(q, docId, actorId, 'recurring_replace',
      [out.hidden ? `고정비 회차 ${out.hidden}건을 이 결재로 대체(자금계획에서 숨김)` : '', out.restored ? `고정비 회차 ${out.restored}건 되살림` : ''].filter(Boolean).join(' · '));
  }
  return out;
}

// ═══════ 0314 전자결재 「고정비 선택」 (2026-11-03 디렉터) ═══════
// 세금과공과처럼 고정비(SAT·SUA·…)가 걸린 과목은 결재 작성 때 어느 고정비인지 고른다.
//   'rule'   → 결재 지급월(회차 예정일의 달)마다 그 고정비 회차를 찾아(아직 [생성] 안 했으면 만들어) 대체 목록에 넣는다
//              → 결재가 살아 있으면(syncRecurringReplace) 고정비 예정은 숨고 결재 금액만 자금계획에 남는다
//   'none'   → 고정비 아님(별도 지출) — 대체 없음
//   'manual' → 회차 직접 선택(0313 목록) 그대로
export const REPLACE_CHOICES = ['rule', 'none', 'manual'];
let _rc = { at: 0, ok: false };
export async function ruleChoiceReady(q) {
  if (_rc.ok) return true;
  const now = Date.now();
  if (_rc.at && now - _rc.at < 30000) return false;
  try {
    const r = await q(`SELECT 1 FROM information_schema.columns WHERE table_name='approval_documents' AND column_name='replace_rule_id'`);
    _rc = { at: now, ok: r.rows.length > 0 };
  } catch (_) { _rc = { at: now, ok: false }; }
  return _rc.ok;
}
export function _resetRuleChoiceReady() { _rc = { at: 0, ok: false }; }

export function normRuleChoice(b) {
  const c = b && REPLACE_CHOICES.includes(b.replace_choice) ? b.replace_choice : (b && b.replace_choice === null ? null : undefined);
  const rid = Number(b && b.replace_rule_id);
  return { choice: c, rule_id: c === 'rule' && Number.isInteger(rid) && rid > 0 ? rid : null };
}

// 지출 고정비 규칙(활성) — 작성 화면이 결재 카테고리의 재무 과목으로 거른다. 비공개는 디렉터만.
export async function fixedCostRules(q, { director = false } = {}) {
  const rows = (await q(
    `SELECT r.id, r.name, r.category_code, cat.name AS category_name, r.amount, r.currency, r.freq, r.day_of_month, r.weekday,
            a.name AS account_name
       FROM recurring_rules r
       LEFT JOIN categories cat ON cat.code=r.category_code
       LEFT JOIN accounts a ON a.id=r.account_id
      WHERE r.deleted_at IS NULL AND r.active=true AND r.direction='out'${director ? '' : ' AND r.is_private=false'}
      ORDER BY r.name, r.id`)).rows;
  return rows.map((r) => ({ id: Number(r.id), name: r.name, category_code: r.category_code, category_name: r.category_name,
    amount: Number(r.amount), currency: r.currency || 'MXN', freq: r.freq, day_of_month: r.day_of_month == null ? null : Number(r.day_of_month),
    weekday: r.weekday == null ? null : Number(r.weekday), account_name: r.account_name }));
}

// 저장(임시저장·결재 중 내용 수정) 직후 — 고른 값 기록 + 'rule' 이면 지급월 회차를 찾아/만들어 대체 목록 갱신.
//   choice === undefined(구 클라이언트) 면 기록된 값으로 다시 맞춘다(지급일이 바뀌었을 수 있음).
export async function applyRuleChoice(q, docId, { choice, rule_id } = {}, { director = false, actorId = null } = {}) {
  if (!(await ruleChoiceReady(q)) || !(await replaceReady(q))) return null;
  if (choice !== undefined) {
    await q(`UPDATE approval_documents SET replace_choice=$2, replace_rule_id=$3 WHERE id=$1`, [docId, choice, choice === 'rule' ? rule_id : null]);
  }
  const d = (await q(`SELECT replace_choice, replace_rule_id, drafter_id, to_char(pay_due,'YYYY-MM-DD') AS pay_due FROM approval_documents WHERE id=$1`, [docId])).rows[0];
  if (!d) return null;
  if (d.replace_choice === 'none') { await q(`UPDATE approval_documents SET replaces_txn_ids=NULL WHERE id=$1`, [docId]); return []; }
  if (d.replace_choice !== 'rule' || d.replace_rule_id == null) return null;   // manual / 미선택 → 목록 그대로
  const rule = (await q(`SELECT * FROM recurring_rules WHERE id=$1 AND deleted_at IS NULL AND active=true AND direction='out'`, [d.replace_rule_id])).rows[0];
  if (!rule || (rule.is_private && !director)) { await q(`UPDATE approval_documents SET replaces_txn_ids=NULL WHERE id=$1`, [docId]); return []; }
  const pays = (await q(`SELECT to_char(due_date,'YYYY-MM-DD') AS due FROM approval_payments WHERE document_id=$1 AND status <> 'skipped' ORDER BY seq`, [docId])).rows;
  const today = new Date().toISOString().slice(0, 10);
  const months = [...new Set((pays.length ? pays.map((p) => p.due) : [d.pay_due]).map((x) => String(x || today).slice(0, 7)))];
  const startYmd = rule.start_date instanceof Date ? rule.start_date.toISOString().slice(0, 10) : String(rule.start_date || '').slice(0, 10);
  const ids = [];
  for (const m of months) {
    // 이 고정비의 그 달 회차(예정) — 살아 있거나 이 문서가 숨긴 것
    const have = (await q(
      `SELECT id, status, (deleted_at IS NOT NULL) AS del, replaced_by_doc FROM transactions
        WHERE recurring_rule_id=$1 AND to_char(COALESCE(plan_date, txn_date),'YYYY-MM')=$2`, [rule.id, m])).rows;
    const mine = have.filter((t) => t.status === 'plan' && (!t.del || Number(t.replaced_by_doc) === Number(docId)));
    if (mine.length) { ids.push(...mine.map((t) => Number(t.id))); continue; }
    if (have.length) continue;   // 이미 실적이거나(지급 끝) 사용자가 지운 회차 → 대체할 것 없음
    // 아직 [생성] 안 한 달 → 회차를 만들어 대체(자동전개가 같은 달을 다시 띄우지 않도록 실제 행으로 남긴다)
    const [y, mm] = m.split('-').map(Number);
    const mEnd = `${m}-${String(new Date(Date.UTC(y, mm, 0)).getUTCDate()).padStart(2, '0')}`;
    const occ = startYmd ? expandBetween({ freq: rule.freq, start_date: startYmd,
      day_of_month: rule.day_of_month == null ? null : Number(rule.day_of_month),
      weekday: rule.weekday == null ? null : Number(rule.weekday), end_month: rule.end_month }, `${m}-01`, mEnd) : [];
    if (!occ.length) continue;   // 그 달엔 이 고정비가 없음(시작 전·종료 후)
    const fx = rule.currency === 'USD' ? Number((await getUsdMxnRate()).rate) || 1 : 1;
    const amt = round2(n(rule.amount));
    for (const o of occ) {
      const r = await q(
        `INSERT INTO transactions
           (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, memo, created_by,
            recurring_rule_id, recurring_period, plan_amount, plan_date, is_private)
         VALUES ($1,$2,'out',$3,$4,$5,$6,$7,'plan','general',true,$8,$9,$8,$10,$11,$3,$2,$12)
         ON CONFLICT (recurring_rule_id, recurring_period) WHERE recurring_rule_id IS NOT NULL AND deleted_at IS NULL DO NOTHING
         RETURNING id`,
        [rule.account_id || null, o.date, amt, rule.currency || 'MXN', fx, round2(amt * fx), rule.category_code || null,
          actorId ?? d.drafter_id, `[고정비] ${rule.name}`, rule.id, o.period, rule.is_private === true]);
      if (r.rows[0]) ids.push(Number(r.rows[0].id));
    }
  }
  return saveReplaceIds(q, docId, [...new Set(ids)], { director });
}

// 상신 전 확인 — 결재 카테고리의 재무 과목에 고정비가 있는데 아직 고르지 않았으면 이름 목록을 돌려준다.
export async function ruleChoiceMissing(q, docId) {
  if (!(await ruleChoiceReady(q))) return null;
  const d = (await q(
    `SELECT d.replace_choice, ac.fin_category_code AS code FROM approval_documents d
       LEFT JOIN approval_categories ac ON ac.id=d.category_id WHERE d.id=$1`, [docId])).rows[0];
  if (!d || !d.code || d.replace_choice) return null;
  const rules = (await q(`SELECT name FROM recurring_rules WHERE deleted_at IS NULL AND active=true AND direction='out' AND category_code=$1 ORDER BY name`, [d.code])).rows;
  return rules.length ? rules.map((r) => r.name) : null;
}

export async function ruleChoiceForDoc(q, docId) {
  if (!(await ruleChoiceReady(q))) return { replace_choice: null, replace_rule_id: null };
  const d = (await q(`SELECT replace_choice, replace_rule_id FROM approval_documents WHERE id=$1`, [docId])).rows[0] || {};
  return { replace_choice: d.replace_choice || null, replace_rule_id: d.replace_rule_id == null ? null : Number(d.replace_rule_id) };
}

// 0287c 커미션 지급승인 문서인가(재기안 버전 포함). 0287 미적용 DB 면 false.
async function isCommissionDoc(q, docId) {
  try { return (await commissionApprovalReady(q)) && !!(await linkForDoc(q, docId)); }
  catch (e) { if (e && e.code === '42P01') return false; throw e; }
}

// 결재가 끝나지 않은 문서의 예정(디렉터 작성 문서의 결재 전 예정) — 재무 실적 처리는 승인 후에만.
//   커미션 지급승인 문서(0287c)는 기존대로 막지 않는다. 반환 { doc_no, status } | null
export async function approvalPlanLock(q, txnId) {
  if (!(await approvalFinReady(q))) return null;
  const r = (await q(
    `SELECT d.id, d.doc_no, d.status FROM approval_payments p JOIN approval_documents d ON d.id=p.document_id
      WHERE p.txn_id=$1 AND d.deleted_at IS NULL AND d.status <> 'approved'`, [txnId])).rows[0];
  if (!r || await isCommissionDoc(q, Number(r.id))) return null;
  return { doc_no: r.doc_no || '임시저장', status: r.status };
}

// 0287c 회차를 새로 짜기 직전(임시저장·결재 중 내용 수정) — 지금 회차에 달린 예정 행을 숨긴다.
//   회차 행이 지워지면 연결이 끊겨 예정이 고아로 남기 때문. 새 회차의 예정은 이어서 syncApprovalDoc 이 다시 만든다.
export async function detachPlans(q, docId, actorId = null) {
  if (!(await approvalFinReady(q))) return 0;
  const r = await q(
    `UPDATE transactions t SET deleted_at=now(), updated_by=$2
       FROM approval_payments p
      WHERE p.document_id=$1 AND t.id=p.txn_id AND t.status='plan' AND t.deleted_at IS NULL`, [docId, actorId]);
  return r.rowCount || 0;
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
