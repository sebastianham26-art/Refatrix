import { query, withTx } from '../db.js';
import { authGuard, requirePage, requirePageAny, requirePageEdit, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';

// =====================================================================
// Refatrix ERP · marketingSpendRoutes.js  (마케팅 지출 계획 · v2 집행항목)
//   · 구조: 활동(계획) → 집행 항목 N(장소·케이터링·판촉물 …)
//            → 항목별 지급 라인 N(선지급/중도금/잔금/일시불).
//   · 담당자(marketing 편집권한) 작성·제출 → 디렉터가 내용을 직접 수정하며
//     승인 → 모든 지급 라인마다 transactions(status='plan', 6070,
//     memo '[마케팅] 집행항목 · 구분 · 활동', 0125)이 생성돼 재무 예정 내역·현금흐름
//     AP(자금 계획)에 반영. 실제 송금은 재무 [실적 처리](confirm-pay).
//   · 승인 후 수정:
//       - 디렉터: 즉시 반영 — 연결 거래가 아직 plan이면 자동 동기화,
//         이미 actual(지급완료)이면 그 라인은 잠금(409 line_locked).
//       - 담당자(작성자, 비디렉터): "수정 요청" — pending_revision(jsonb)에만
//         저장되고 자금계획(현금흐름)은 건드리지 않음. 디렉터가 열어 검토·
//         승인 저장 시에만 예정 지출이 동기화되고 요청이 종료됨(0124).
//         디렉터 승인 전까지 담당자는 요청 내용을 계속 수정 가능.
//   · 대상 통계: 고객별 연간 매출목표(target_customer_months 합) +
//     올해 1/1~오늘 누적 매출(sales_invoices posted subtotal_mxn, ex-IVA).
//
//   · 「집행 처리」(0195, 2026-09-03) — 재무등록과 독립:
//     한 번의 송금으로 여러 지급 라인을 커버하면 재무 [실적 처리]는 한 줄에만 붙고
//     나머지 줄이 영원히 예정으로 남아 현금예측이 과대계상됐다. 이를 계획 쪽에서 소진한다.
//       - 재무·디렉터가 라인(복수 선택 가능)에 집행일·실지급액을 기록 → marketing_spend_executions.
//       - 완결(exec_closed): 예정 거래를 소프트삭제 → 현금흐름에서 통째로 제외.
//       - 부분 집행: 예정 거래 금액을 잔액으로 감액 → 잔액만 미래 유출로 남음.
//       - 되돌리기: 우리가 지운 거래(exec_txn_settled)만 복원. 재무가 실적처리했으면 409.
//       - 실제 송금 거래와 링크하지 않는다(디렉터 결정). 대신 월 단위 금액 대사(/reconcile)로
//         "집행 처리는 했는데 원장에 없는" 오차를 잡는다 — 이 패널이 유일한 검출 수단이다.
//       - 이중 소진 방지: 재무 실적처리된 줄은 집행 불가, 집행 완결한 줄은 예정 거래가 사라져
//         재무 예정 내역에 아예 나오지 않는다(구조적 차단). 완결 줄은 수정·삭제도 잠긴다.
//
//   · 「개정 스냅샷」(0196, 2026-09-03) — 수정분 변경표시(diff)의 기준선:
//     제출·승인·반려·디렉터 수정마다 계획 전문을 marketing_spend_revisions 에 남기고,
//     상세 응답이 직전 스냅샷(base_snapshot)을 함께 내려준다. diff 계산·표시는 화면에서.
//     스냅샷 기록은 best-effort(트랜잭션 밖 try/catch) — 실패해도 계획 저장은 항상 성공한다.
// =====================================================================

function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
const KINDS = new Set(['adv', 'mid', 'fin', 'one']);
const KIND_LABEL = { adv: '선지급금', mid: '중도금', fin: '잔금', one: '일시불' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDirector(req) { return req.ctx.perm.role === 'director'; }

// 증빙 파일 검증(인보이스 첨부와 동일하게 폭넓은 허용, 8MB)
export function validateSpendFileDataUrl(dataUrl, maxBytes = 8 * 1024 * 1024) {
  let s = String(dataUrl || '');
  // 확장자 미인식 파일: 브라우저 FileReader가 mime 없이 'data:;base64,'를 만들 수 있음 → octet-stream으로 간주
  s = s.replace(/^data:;base64,/, 'data:application/octet-stream;base64,')
       .replace(/^data:base64,/, 'data:application/octet-stream;base64,');
  const m = s.match(/^data:([a-zA-Z0-9.+\/-]+);base64,([A-Za-z0-9+\/=\s]+)$/);
  if (!m) return { ok: false, error: 'bad_format' };
  const mime = m[1].toLowerCase();
  const okMime = mime.startsWith('image/') || [
    'application/pdf', 'text/xml', 'application/xml',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/csv', 'text/plain', 'application/zip', 'application/octet-stream',
  ].includes(mime);
  if (!okMime) return { ok: false, error: 'bad_mime' };
  const b64 = m[2].replace(/\s+/g, '');
  if (!b64) return { ok: false, error: 'empty' };
  const bytes = Math.floor(b64.length * 3 / 4);
  if (bytes > maxBytes) return { ok: false, error: 'too_large' };
  return { ok: true, mime, size: bytes, data: s };
}

// 지급 라인 정규화(항목 내부). 오류 시 {error}
export function normalizeLines(rawLines) {
  const lines = Array.isArray(rawLines) ? rawLines : [];
  if (!lines.length) return { error: 'lines_required' };
  if (lines.length > 50) return { error: 'too_many_lines' };
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] || {};
    const kind = KINDS.has(l.kind) ? l.kind : 'one';
    const due = String(l.due_date || '');
    let dOk = DATE_RE.test(due);
    if (dOk) { const dt = new Date(due + 'T00:00:00Z'); dOk = !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === due; }
    if (!dOk) return { error: 'bad_line_date', index: i };
    const amount = Number(l.amount);
    if (!(amount > 0)) return { error: 'bad_line_amount', index: i };
    out.push({ id: l.id != null ? Number(l.id) : null, kind, due_date: due, amount: r2(amount),
      memo: (l.memo == null || String(l.memo).trim() === '') ? null : String(l.memo).trim().slice(0, 300), sort_order: i });
  }
  return { lines: out };
}

// 집행 항목 정규화(항목마다 지급 라인 1개 이상). 오류 시 {error}
export function normalizeItems(rawItems) {
  const arr = Array.isArray(rawItems) ? rawItems : [];
  if (!arr.length) return { error: 'items_required' };
  if (arr.length > 30) return { error: 'too_many_items' };
  const items = [];
  let totalLines = 0;
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i] || {};
    const name = String(it.name || '').trim().slice(0, 120);
    if (!name) return { error: 'item_name_required', index: i };
    const nl = normalizeLines(it.lines);
    if (nl.error) return { error: nl.error, item_index: i, index: nl.index };
    totalLines += nl.lines.length;
    if (totalLines > 100) return { error: 'too_many_lines_total' };
    items.push({ id: it.id != null ? Number(it.id) : null, name,
      memo: (it.memo == null || String(it.memo).trim() === '') ? null : String(it.memo).trim().slice(0, 300),
      sort_order: i, lines: nl.lines });
  }
  return { items };
}

// 본문 → 대상 정규화(고객 중복 제거, 불특정 다수 1건으로 축약)
export function normalizeTargets(rawTargets) {
  const arr = Array.isArray(rawTargets) ? rawTargets : [];
  if (arr.length > 200) return { error: 'too_many_targets' };
  const custIds = [];
  const seen = new Set();
  let general = false;
  for (const t of arr) {
    if (t && t.is_general) { general = true; continue; }
    const cid = Number(t && t.customer_id);
    if (!(cid > 0)) return { error: 'bad_target' };
    if (!seen.has(cid)) { seen.add(cid); custIds.push(cid); }
  }
  return { custIds, general };
}

// 계획 거래 메모: '[마케팅] 집행항목 · 구분 · 활동명 (· 명목)'  (0125)
//  — 집행항목이 앞에 오도록: 현금흐름·예정내역의 좁은 메모 칸(22~30자)에서
//    활동명이 아니라 "그 날짜에 무엇을 집행하는지"가 먼저 보이게 한다.
//  — 재무 화면이 '[마케팅]' 접두사로 출처 배지를 표시(규약 유지)
export function spendTxnMemo(title, itemName, kind, lineMemo) {
  const base = `[마케팅] ${String(itemName || '기본 집행').slice(0, 80)} · ${KIND_LABEL[kind] || kind} · ${String(title || '').slice(0, 100)}`;
  return lineMemo ? `${base} · ${String(lineMemo).slice(0, 160)}` : base;
}

// 일정 달력 자동 연동(0135): 계획 승인/수정/삭제 시 호출.
//   승인 상태면 행사일·집행라인 일정을 (재)생성하고, 아니면(반려·삭제·회수) 제거.
//   대상자 = 계획 작성자(마케팅 담당) + 디렉터 전원. scope='shared'.
//   run = 트랜잭션 클라이언트의 query 함수. actorId = 이벤트 created_by.
export function fmtMoney(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export async function syncPlanCalendar(run, planId, actorId) {
  // best-effort: 마이그레이션(0135) 미적용 등으로 실패해도 호출측(계획 저장)에 영향 없도록 자체 흡수.
  //   반드시 트랜잭션 커밋 "이후" pool query로 호출할 것(실패가 계획 저장을 롤백하지 않게).
  try {
    // 1) 기존 자동 일정 제거(대상자 → 이벤트 순, 이 계획 소속 전부)
    await run(`DELETE FROM calendar_event_targets WHERE event_id IN (SELECT id FROM calendar_events WHERE src_plan_id=$1)`, [planId]);
    await run(`DELETE FROM calendar_events WHERE src_plan_id=$1`, [planId]);

    const p = (await run(
      `SELECT title, to_char(event_date,'YYYY-MM-DD') AS event_date, created_by, status, deleted_at
         FROM marketing_spend_plans WHERE id=$1`, [planId])).rows[0];
    if (!p || p.deleted_at || p.status !== 'approved') return; // 승인 상태에서만 일정 생성

    // 대상자 = 작성자 + 디렉터 전원(중복 제거)
    const dirs = (await run(`SELECT id FROM users WHERE role='director' AND deleted_at IS NULL`)).rows.map((r) => Number(r.id));
    const targetIds = [...new Set([...(p.created_by != null ? [Number(p.created_by)] : []), ...dirs])];

    const addEvent = async (dateStr, content, kind, srcId) => {
      if (!dateStr) return;
      const ev = (await run(
        `INSERT INTO calendar_events (event_date, content, scope, created_by, src_kind, src_id, src_plan_id)
         VALUES ($1,$2,'shared',$3,$4,$5,$6) RETURNING id`,
        [dateStr, String(content).slice(0, 200), actorId || p.created_by || null, kind, srcId, planId])).rows[0];
      for (const uid of targetIds) {
        await run(`INSERT INTO calendar_event_targets (event_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ev.id, uid]);
      }
    };

    // 2) 행사일 일정 — 내용 = 행사명
    if (p.event_date) await addEvent(p.event_date, p.title || '(행사)', 'mkt_plan', planId);

    // 3) 집행 라인 일정 — 내용 = 행사명 · 집행항목명 · 금액
    const lines = (await run(
      `SELECT l.id, to_char(l.due_date,'YYYY-MM-DD') AS due_date, l.amount,
              COALESCE(i.name,'기본 집행') AS item_name
         FROM marketing_spend_lines l
         LEFT JOIN marketing_spend_items i ON i.id=l.item_id
        WHERE l.plan_id=$1 AND l.due_date IS NOT NULL
        ORDER BY l.due_date, l.id`, [planId])).rows;
    for (const l of lines) {
      const content = `${p.title || ''} · ${l.item_name} · ${fmtMoney(l.amount)} MXN`;
      await addEvent(l.due_date, content, 'mkt_line', Number(l.id));
    }
  } catch (e) {
    // 마이그레이션 미적용/일시 오류 등 — 계획 저장 자체는 성공해야 하므로 삼킨다.
    try { console.error('[mktspend] calendar sync skipped:', e && e.message ? e.message : e); } catch (_) {}
  }
}

// =====================================================================
// 집행 처리(0195) 헬퍼
// =====================================================================

// 집행 처리 권한 — 디렉터 + 재무담당(treasury).
//   화면은 마케팅 지출계획이지만, "돈이 실제로 나갔다"를 아는 사람은 재무이므로
//   마케팅 담당은 상태 열람만 한다(디렉터 결정 2026-09-03).
export function canExecute(perm) {
  const r = perm && perm.role;
  return r === 'director' || r === 'treasury';
}

// 라인 집행 상태 — 화면 배지와 서버 판단이 항상 같도록 한 곳에서 계산.
//   paid   : 재무 [실적 처리]로 확정(기존 경로)
//   closed : 마케팅 집행 처리로 완결 — 예정 거래 제거됨
//   partial: 일부만 집행 — 잔액이 예정으로 남음
//   none   : 미집행
export function execStateOf(planAmount, execTotal, execClosed, paid) {
  if (paid) return 'paid';
  if (execClosed) return 'closed';
  if (Number(execTotal) > 0) return 'partial';
  return 'none';
}

// 라인 하나의 집행 합계를 다시 계산하고, 연결된 예정 거래를 그에 맞춘다.
//   완결      → 예정 거래 소프트삭제(현금흐름에서 제외) + exec_txn_settled=true
//   부분 집행 → 예정 거래 금액을 "잔액"으로 감액(우리가 지웠던 거래면 복원)
//   집행 없음 → 계획액으로 원복(우리가 지웠던 거래면 복원)
//   재무가 이미 실적(actual) 처리한 거래는 절대 건드리지 않는다.
// 반환 {plan, total, balance, closed}
export async function recomputeLineExec(run, lineId, actorId) {
  const l = (await run(
    `SELECT id, plan_id, amount, exec_closed, exec_txn_settled, txn_id
       FROM marketing_spend_lines WHERE id=$1 FOR UPDATE`, [lineId])).rows[0];
  if (!l) return null;
  const s = (await run(
    `SELECT COALESCE(SUM(amount),0) AS t FROM marketing_spend_executions
      WHERE line_id=$1 AND reverted_at IS NULL`, [lineId])).rows[0];
  const plan = r2(Number(l.amount) || 0);
  const total = r2(Number(s.t) || 0);
  let balance = r2(plan - total);
  let closed = !!l.exec_closed;

  // 집행 기록이 하나도 남지 않으면 완결도 자동 해제(전부 되돌린 경우)
  if (total <= 0) closed = false;
  // 잔액이 없으면(계획액을 다 채웠거나 초과) 사실상 완결
  if (total > 0 && balance <= 0.005) { closed = true; balance = 0; }

  let settled = !!l.exec_txn_settled;
  if (l.txn_id != null) {
    const t = (await run(`SELECT id, status, deleted_at FROM transactions WHERE id=$1`, [l.txn_id])).rows[0];
    if (t && t.status !== 'actual') {
      if (closed) {
        if (!t.deleted_at) {
          await run(
            `UPDATE transactions
                SET deleted_at=now(), updated_by=$1,
                    plan_memo = COALESCE(plan_memo || E'\n','') || $2
              WHERE id=$3 AND deleted_at IS NULL`,
            [actorId, `${new Date().toISOString().slice(0, 10)}(마케팅 집행): 집행 ${fmtMoney(total)} · 계획 ${fmtMoney(plan)}`, l.txn_id]);
        }
        settled = true;
      } else {
        // 미완결 — 잔액(집행 없으면 계획액)으로 되돌린다.
        //   우리가 지운 거래(settled)만 복원한다. 재무 > 예정 삭제 등 다른 경로로
        //   지워진 거래를 되살리면 디렉터의 삭제 의도를 뒤집게 되므로.
        const amt = total > 0 ? balance : plan;
        if (t.deleted_at && settled) {
          await run(
            `UPDATE transactions SET amount=$1, amount_mxn=$1, plan_amount=$1, deleted_at=NULL, updated_by=$2 WHERE id=$3`,
            [amt, actorId, l.txn_id]);
          settled = false;
        } else if (!t.deleted_at) {
          await run(
            `UPDATE transactions SET amount=$1, amount_mxn=$1, plan_amount=$1, updated_by=$2 WHERE id=$3`,
            [amt, actorId, l.txn_id]);
          settled = false;
        }
      }
    }
  }

  await run(
    `UPDATE marketing_spend_lines
        SET exec_closed=$1,
            exec_closed_at = CASE WHEN $1 AND exec_closed_at IS NULL THEN now()
                                  WHEN $1 THEN exec_closed_at ELSE NULL END,
            exec_closed_by = CASE WHEN $1 THEN COALESCE(exec_closed_by,$2) ELSE NULL END,
            exec_txn_settled=$3
      WHERE id=$4`,
    [closed, actorId, settled, lineId]);

  return { plan, total, balance, closed };
}

// 계획에 속한 "집행 기록이 있는 라인" 전부 재계산.
//   계획 수정으로 라인 금액이 바뀌면 잔액도 달라지므로 저장 뒤에 한 번 돌린다.
//   0195 미적용 환경에서도 저장이 깨지지 않도록 호출측에서 try/catch 로 감싼다.
export async function recomputePlanExec(run, planId, actorId) {
  const rows = (await run(
    `SELECT DISTINCT e.line_id FROM marketing_spend_executions e
       JOIN marketing_spend_lines l ON l.id=e.line_id
      WHERE l.plan_id=$1 AND e.reverted_at IS NULL`, [planId])).rows;
  for (const r of rows) await recomputeLineExec(run, Number(r.line_id), actorId);
  return rows.length;
}

// =====================================================================
// 개정 스냅샷(0196) 헬퍼 — 변경표시(diff)의 기준선
// =====================================================================

// 계획의 현재 상태를 스냅샷 객체로 만든다(프런트 diff 가 쓰는 형태와 동일).
export async function snapshotFromDb(run, planId) {
  const p = (await run(
    `SELECT title, category, to_char(event_date,'YYYY-MM-DD') AS event_date, purpose
       FROM marketing_spend_plans WHERE id=$1`, [planId])).rows[0];
  if (!p) return null;
  const items = (await run(
    `SELECT id, name, memo, sort_order FROM marketing_spend_items
      WHERE plan_id=$1 ORDER BY sort_order, id`, [planId])).rows;
  const lines = (await run(
    `SELECT id, item_id, kind, to_char(due_date,'YYYY-MM-DD') AS due_date, amount, memo, sort_order
       FROM marketing_spend_lines WHERE plan_id=$1 ORDER BY sort_order, id`, [planId])).rows;
  const mapLine = (l) => ({ id: Number(l.id), kind: l.kind, due_date: l.due_date,
    amount: r2(Number(l.amount) || 0), memo: l.memo, sort_order: Number(l.sort_order) || 0 });
  const targets = (await run(
    `SELECT customer_id, is_general FROM marketing_spend_targets WHERE plan_id=$1 ORDER BY id`, [planId])).rows;
  const out = {
    title: p.title, category: p.category, event_date: p.event_date, purpose: p.purpose,
    items: items.map((it) => ({ id: Number(it.id), name: it.name, memo: it.memo,
      sort_order: Number(it.sort_order) || 0,
      lines: lines.filter((l) => Number(l.item_id) === Number(it.id)).map(mapLine) })),
    targets: targets.map((t) => ({ customer_id: t.customer_id == null ? null : Number(t.customer_id),
      is_general: !!t.is_general })),
  };
  const orphan = lines.filter((l) => l.item_id == null).map(mapLine);
  if (orphan.length) out.items.push({ id: null, name: '기본 집행', memo: null, sort_order: 999, lines: orphan });
  return out;
}

// 상태 전이 시점의 스냅샷 기록. best-effort — 실패해도 호출측(계획 저장)에 영향 없음.
//   반드시 트랜잭션 커밋 "이후" pool query 로 호출할 것(0135 달력 동기화와 같은 이유).
export async function saveRevision(run, planId, event, actorId) {
  try {
    const snap = await snapshotFromDb(run, planId);
    if (!snap) return;
    const m = (await run(`SELECT COALESCE(MAX(rev_no),0) AS n FROM marketing_spend_revisions WHERE plan_id=$1`, [planId])).rows[0];
    const next = Number(m.n) + 1;
    await run(
      `INSERT INTO marketing_spend_revisions (plan_id, rev_no, event, snapshot, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5)
       ON CONFLICT (plan_id, rev_no) DO NOTHING`,
      [planId, next, event, JSON.stringify(snap), actorId || null]);
  } catch (e) {
    try { console.error('[mktspend] revision snapshot skipped:', e && e.message ? e.message : e); } catch (_) {}
  }
}

export default async function marketingSpendRoutes(app) {
  const num = (v) => (v == null ? 0 : Number(v));

  // ---- 저장 헬퍼(트랜잭션 내) ------------------------------------------
  async function insertItemsWithLines(run, planId, items) {
    for (const it of items) {
      const r = await run(
        `INSERT INTO marketing_spend_items (plan_id, name, memo, sort_order) VALUES ($1,$2,$3,$4) RETURNING id`,
        [planId, it.name, it.memo, it.sort_order]);
      const itemId = Number(r.rows[0].id);
      for (const l of it.lines) {
        await run(
          `INSERT INTO marketing_spend_lines (plan_id, item_id, kind, due_date, amount, memo, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [planId, itemId, l.kind, l.due_date, l.amount, l.memo, l.sort_order]);
      }
    }
  }
  async function replaceTargets(run, planId, custIds, general) {
    await run(`DELETE FROM marketing_spend_targets WHERE plan_id=$1`, [planId]);
    for (const cid of custIds) {
      await run(`INSERT INTO marketing_spend_targets (plan_id, customer_id, is_general) VALUES ($1,$2,false)`, [planId, cid]);
    }
    if (general) {
      await run(`INSERT INTO marketing_spend_targets (plan_id, customer_id, is_general) VALUES ($1,NULL,true)`, [planId]);
    }
  }
  async function validateCustomers(custIds) {
    if (!custIds.length) return true;
    const rows = (await query(`SELECT id FROM customers WHERE id=ANY($1) AND deleted_at IS NULL`, [custIds])).rows;
    return rows.length === custIds.length;
  }

  // ---- 0195 적용 여부(집행 컬럼 존재) -----------------------------------
  //   트랜잭션 안에서 실패하는 쿼리를 던지면 트랜잭션 전체가 abort 되므로,
  //   "컬럼이 있는지"는 반드시 트랜잭션 "밖"에서 미리 확인한다.
  //   true 는 영구 캐시, false 는 매번 재확인(마이그레이션 적용 직후 재시작 없이도 살아나도록).
  let execReadyCache = false;
  async function execReady() {
    if (execReadyCache) return true;
    try {
      await query(`SELECT exec_closed FROM marketing_spend_lines LIMIT 1`);
      execReadyCache = true;
    } catch (_) { execReadyCache = false; }
    return execReadyCache;
  }

  // 잠긴 라인 = 재무 실적처리(paid) 또는 마케팅 집행 완결(exec_closed).
  //   둘 다 "이미 돈이 나간 줄"이므로 수정·삭제를 막는다(되돌린 뒤에 고칠 것).
  async function lockedLines(run, planId, ready) {
    const cols = `l.id, l.item_id, l.kind, to_char(l.due_date,'YYYY-MM-DD') AS due_date, l.amount, l.memo`;
    if (ready) {
      return (await run(
        `SELECT ${cols}, (t.status='actual' AND t.deleted_at IS NULL) AS paid, l.exec_closed
           FROM marketing_spend_lines l LEFT JOIN transactions t ON t.id=l.txn_id
          WHERE l.plan_id=$1
            AND ((t.status='actual' AND t.deleted_at IS NULL) OR l.exec_closed=true)`, [planId])).rows;
    }
    return (await run(
      `SELECT ${cols}, true AS paid, false AS exec_closed
         FROM marketing_spend_lines l JOIN transactions t ON t.id=l.txn_id
        WHERE l.plan_id=$1 AND t.status='actual' AND t.deleted_at IS NULL`, [planId])).rows;
  }
  const lockReason = (e) => (e.paid ? 'paid' : 'executed');

  // ---- 헤더 필드 정규화 ------------------------------------------------
  function headerFields(b) {
    const title = String(b.title || '').trim().slice(0, 200);
    if (!title) return { error: 'title_required' };
    const category = (b.category == null || String(b.category).trim() === '') ? null : String(b.category).trim().slice(0, 60);
    const eventDate = (b.event_date && DATE_RE.test(String(b.event_date))) ? String(b.event_date) : null;
    const purpose = (b.purpose == null || String(b.purpose).trim() === '') ? null : String(b.purpose).trim().slice(0, 2000);
    return { title, category, eventDate, purpose };
  }

  // =====================================================================
  // 고객 검색(마케팅 권한으로 — customers 페이지 권한 없이도 대상 선택 가능)
  // =====================================================================
  app.get('/api/mktspend/customers', { preHandler: [authGuard, requirePage('marketing')] }, async (req) => {
    const q = String(req.query.q || '').trim();
    if (!q) return { items: [] };
    const rows = (await query(
      `SELECT id, code, name FROM customers
        WHERE deleted_at IS NULL AND (name ILIKE $1 OR code ILIKE $1)
        ORDER BY name LIMIT 20`, ['%' + q + '%'])).rows;
    return { items: rows.map((r) => ({ id: Number(r.id), code: r.code, name: r.name })) };
  });

  // =====================================================================
  // 대상 통계: 연간 매출목표 + 올해 누적 매출(기안 시점 기준, ex-IVA)
  // =====================================================================
  app.get('/api/mktspend/target-stats', { preHandler: [authGuard, requirePageAny(['marketing', 'finance'])] }, async (req) => {
    const ids = String(req.query.ids || '').split(',').map((s) => Number(s)).filter((n) => n > 0);
    const year = String(new Date().getFullYear());
    const today = new Date().toISOString().slice(0, 10);
    if (!ids.length) return { year, as_of: today, items: [], total_target: 0, total_sales: 0 };
    const ymFrom = year + '-01', ymTo = year + '-12';
    const dFrom = year + '-01-01';
    const custRows = (await query(`SELECT id, code, name FROM customers WHERE id=ANY($1)`, [ids])).rows;
    const tgtRows = (await query(
      `SELECT customer_id, COALESCE(SUM(amount),0) AS t FROM target_customer_months
        WHERE customer_id=ANY($1) AND ym >= $2 AND ym <= $3 GROUP BY customer_id`, [ids, ymFrom, ymTo])).rows;
    const salesRows = (await query(
      `SELECT customer_id, COALESCE(SUM(subtotal_mxn),0) AS s FROM sales_invoices
        WHERE customer_id=ANY($1) AND status='posted' AND inv_date >= $2 AND inv_date <= $3 GROUP BY customer_id`,
      [ids, dFrom, today])).rows;
    const tgtMap = new Map(tgtRows.map((r) => [Number(r.customer_id), r2(num(r.t))]));
    const salesMap = new Map(salesRows.map((r) => [Number(r.customer_id), r2(num(r.s))]));
    let totalTarget = 0, totalSales = 0;
    const items = custRows.map((c) => {
      const id = Number(c.id);
      const target = tgtMap.has(id) ? tgtMap.get(id) : null;   // null = 목표 미설정
      const sales = salesMap.get(id) || 0;
      if (target != null) totalTarget = r2(totalTarget + target);
      totalSales = r2(totalSales + sales);
      return { customer_id: id, code: c.code, name: c.name, annual_target: target, ytd_sales: sales,
        progress: target ? Math.round(sales / target * 100) : null };
    });
    return { year, as_of: today, items, total_target: totalTarget, total_sales: totalSales };
  });

  // =====================================================================
  // 계획 목록
  // =====================================================================
  // 열람은 marketing 또는 finance 권한(재무담당이 집행 처리를 하려면 이 화면을 봐야 한다).
  // 작성·수정·승인은 종전대로 requirePageEdit('marketing') / requireDirector 유지.
  app.get('/api/mktspend/plans', { preHandler: [authGuard, requirePageAny(['marketing', 'finance'])] }, async (req) => {
    const st = ['draft', 'submitted', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const params = [];
    let where = `p.deleted_at IS NULL`;
    if (st) { params.push(st); where += ` AND p.status=$${params.length}`; }
    const rows = (await query(
      `SELECT p.id, p.title, p.category, to_char(p.event_date,'YYYY-MM-DD') AS event_date, p.status, p.reject_reason,
              (p.pending_revision IS NOT NULL) AS has_revision,
              p.created_by, u.name AS created_by_name, p.submitted_at, p.decided_at,
              COALESCE(ia.item_count,0) AS item_count,
              COALESCE(la.line_count,0) AS line_count, COALESCE(la.total_amount,0) AS total_amount, la.first_due,
              COALESCE(ta.customer_count,0) AS customer_count, COALESCE(ta.general_count,0) AS general_count,
              COALESCE(fa.file_count,0) AS file_count
         FROM marketing_spend_plans p
         LEFT JOIN users u ON u.id=p.created_by
         LEFT JOIN (SELECT plan_id, COUNT(*) AS item_count
                      FROM marketing_spend_items GROUP BY plan_id) ia ON ia.plan_id=p.id
         LEFT JOIN (SELECT plan_id, COUNT(*) AS line_count, COALESCE(SUM(amount),0) AS total_amount,
                           to_char(MIN(due_date),'YYYY-MM-DD') AS first_due
                      FROM marketing_spend_lines GROUP BY plan_id) la ON la.plan_id=p.id
         LEFT JOIN (SELECT plan_id, SUM(CASE WHEN is_general THEN 0 ELSE 1 END) AS customer_count,
                           SUM(CASE WHEN is_general THEN 1 ELSE 0 END) AS general_count
                      FROM marketing_spend_targets GROUP BY plan_id) ta ON ta.plan_id=p.id
         LEFT JOIN (SELECT plan_id, COUNT(*) AS file_count
                      FROM marketing_spend_files GROUP BY plan_id) fa ON fa.plan_id=p.id
        WHERE ${where}
        ORDER BY p.id DESC LIMIT 300`, params)).rows;
    const items = rows.map((r) => ({
      id: Number(r.id), title: r.title, category: r.category, event_date: r.event_date, status: r.status,
      reject_reason: r.reject_reason, created_by: r.created_by == null ? null : Number(r.created_by),
      created_by_name: r.created_by_name, submitted_at: r.submitted_at, decided_at: r.decided_at,
      item_count: num(r.item_count), line_count: num(r.line_count), total_amount: r2(num(r.total_amount)), first_due: r.first_due,
      customer_count: num(r.customer_count), has_general: num(r.general_count) > 0, file_count: num(r.file_count),
      has_revision: !!r.has_revision,
    }));
    return { items, me: req.ctx.perm.userId, is_director: isDirector(req) };
  });

  // =====================================================================
  // 계획 상세(집행 항목 → 라인+지급상태, 대상, 파일 메타)
  // =====================================================================
  app.get('/api/mktspend/plans/:id', { preHandler: [authGuard, requirePageAny(['marketing', 'finance'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!(id > 0)) return reply.code(400).send({ error: 'bad_id' });
    const p = (await query(
      `SELECT p.*, to_char(p.event_date,'YYYY-MM-DD') AS event_date_fmt,
              u.name AS created_by_name, d.name AS decided_by_name, rv.name AS revision_by_name
         FROM marketing_spend_plans p
         LEFT JOIN users u ON u.id=p.created_by
         LEFT JOIN users d ON d.id=p.decided_by
         LEFT JOIN users rv ON rv.id=p.revision_by
        WHERE p.id=$1 AND p.deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const itemRows = (await query(
      `SELECT id, name, memo, sort_order FROM marketing_spend_items WHERE plan_id=$1 ORDER BY sort_order, id`, [id])).rows;
    // exec_* 컬럼은 0195 미적용 환경에서도 상세 조회가 죽지 않도록 별도 조회 + 폴백.
    let execCols = new Map();   // line_id → {exec_closed}
    let execRows = [];          // 집행 기록
    try {
      const ec = (await query(
        `SELECT id, exec_closed FROM marketing_spend_lines WHERE plan_id=$1`, [id])).rows;
      execCols = new Map(ec.map((r) => [Number(r.id), !!r.exec_closed]));
      execRows = (await query(
        `SELECT e.id, e.line_id, to_char(e.exec_date,'YYYY-MM-DD') AS exec_date, e.amount, e.note,
                e.created_at, u.name AS created_by_name
           FROM marketing_spend_executions e
           LEFT JOIN users u ON u.id=e.created_by
           JOIN marketing_spend_lines l ON l.id=e.line_id
          WHERE l.plan_id=$1 AND e.reverted_at IS NULL
          ORDER BY e.exec_date, e.id`, [id])).rows;
    } catch (_) { execCols = new Map(); execRows = []; }
    const execByLine = new Map();
    for (const e of execRows) {
      const k = Number(e.line_id);
      if (!execByLine.has(k)) execByLine.set(k, []);
      execByLine.get(k).push({ id: Number(e.id), exec_date: e.exec_date, amount: r2(num(e.amount)),
        note: e.note, created_by_name: e.created_by_name });
    }

    const lineRows = (await query(
      `SELECT l.id, l.item_id, l.kind, to_char(l.due_date,'YYYY-MM-DD') AS due_date, l.amount, l.memo, l.sort_order, l.txn_id,
              t.status AS txn_status, to_char(t.txn_date,'YYYY-MM-DD') AS txn_date, t.amount AS txn_amount, t.deleted_at AS txn_deleted
         FROM marketing_spend_lines l
         LEFT JOIN transactions t ON t.id=l.txn_id
        WHERE l.plan_id=$1 ORDER BY l.sort_order, l.id`, [id])).rows;
    const mapLine = (l) => {
      const lid = Number(l.id);
      const exs = execByLine.get(lid) || [];
      const planAmt = r2(num(l.amount));
      const execTotal = r2(exs.reduce((s, e) => s + e.amount, 0));
      const paid = l.txn_status === 'actual';
      const closed = !!execCols.get(lid);
      return { id: lid, item_id: l.item_id == null ? null : Number(l.item_id),
        kind: l.kind, due_date: l.due_date, amount: planAmt, memo: l.memo,
        txn_id: l.txn_id == null ? null : Number(l.txn_id),
        paid, txn_deleted: !!l.txn_deleted,
        paid_date: paid ? l.txn_date : null,
        paid_amount: paid ? r2(num(l.txn_amount)) : null,
        // ---- 집행 처리(0195) ----
        executions: exs,
        exec_total: execTotal,
        exec_balance: r2(planAmt - execTotal),
        exec_diff: r2(execTotal - planAmt),           // 계획대비 차이(완결 라인만 의미 있음)
        exec_closed: closed,
        exec_state: execStateOf(planAmt, execTotal, closed, paid),
        exec_last_date: exs.length ? exs[exs.length - 1].exec_date : null };
    };
    const items = itemRows.map((it) => ({ id: Number(it.id), name: it.name, memo: it.memo,
      lines: lineRows.filter((l) => Number(l.item_id) === Number(it.id)).map(mapLine) }));
    // 항목 미귀속 라인(0116 백필 전 잔여) 안전망
    const orphan = lineRows.filter((l) => l.item_id == null).map(mapLine);
    if (orphan.length) items.push({ id: null, name: '기본 집행', memo: null, lines: orphan });
    const targets = (await query(
      `SELECT tg.id, tg.customer_id, tg.is_general, c.code, c.name
         FROM marketing_spend_targets tg
         LEFT JOIN customers c ON c.id=tg.customer_id
        WHERE tg.plan_id=$1 ORDER BY tg.is_general, tg.id`, [id])).rows;
    const files = (await query(
      `SELECT f.id, f.file_name, f.mime_type, f.file_size, f.uploaded_at, u.name AS uploaded_by_name
         FROM marketing_spend_files f LEFT JOIN users u ON u.id=f.uploaded_by
        WHERE f.plan_id=$1 ORDER BY f.id DESC`, [id])).rows;
    // ---- 담당자 수정 요청(0124): 대상 고객명 하이드레이션 포함 ----
    let revision = null;
    if (p.pending_revision != null) {
      let rp = p.pending_revision;
      if (typeof rp === 'string') { try { rp = JSON.parse(rp); } catch (_) { rp = null; } }
      if (rp) {
        const rids = (rp.targets || []).filter((t) => t && t.customer_id).map((t) => Number(t.customer_id));
        let nmap = new Map();
        if (rids.length) {
          const cr = (await query(`SELECT id, code, name FROM customers WHERE id=ANY($1)`, [rids])).rows;
          nmap = new Map(cr.map((c) => [Number(c.id), c]));
        }
        rp.targets = (rp.targets || []).map((t) => {
          if (t && t.customer_id) {
            const c = nmap.get(Number(t.customer_id)) || {};
            return { customer_id: Number(t.customer_id), is_general: false, code: c.code || null, name: c.name || ('#' + t.customer_id) };
          }
          return { customer_id: null, is_general: true };
        });
        revision = { payload: rp, by_name: p.revision_by_name || null, at: p.revision_at };
      }
    }
    // ---- 개정 스냅샷(0196) — 미적용 환경에서도 상세가 죽지 않도록 폴백 ----
    let recentRevs = [];
    try {
      recentRevs = (await query(
        `SELECT r.rev_no, r.event, r.created_at, r.snapshot, u.name AS created_by_name
           FROM marketing_spend_revisions r
           LEFT JOIN users u ON u.id=r.created_by
          WHERE r.plan_id=$1 ORDER BY r.rev_no DESC LIMIT 2`, [id])).rows
        .map((r) => ({ rev_no: Number(r.rev_no), event: r.event, created_at: r.created_at,
          created_by_name: r.created_by_name,
          snapshot: typeof r.snapshot === 'string' ? JSON.parse(r.snapshot) : r.snapshot }));
    } catch (_) { recentRevs = []; }
    return {
      plan: { id: Number(p.id), title: p.title, category: p.category,
        event_date: p.event_date_fmt || null,
        purpose: p.purpose, status: p.status, reject_reason: p.reject_reason,
        created_by: p.created_by == null ? null : Number(p.created_by), created_by_name: p.created_by_name,
        submitted_at: p.submitted_at, decided_at: p.decided_at, decided_by_name: p.decided_by_name },
      items,
      lines: lineRows.map(mapLine),
      targets: targets.map((t) => ({ id: Number(t.id), customer_id: t.customer_id == null ? null : Number(t.customer_id),
        is_general: !!t.is_general, code: t.code, name: t.name })),
      files: files.map((f) => ({ id: Number(f.id), file_name: f.file_name, mime_type: f.mime_type,
        file_size: f.file_size == null ? null : Number(f.file_size), uploaded_at: f.uploaded_at, uploaded_by_name: f.uploaded_by_name })),
      revision,
      // ---- 변경표시(0196) 기준선: 최근 스냅샷 2건 ----
      //   화면은 "가장 최근 스냅샷"과 현재 상태를 비교해 보고, 차이가 없으면(=그 스냅샷이
      //   곧 현재 상태이면) 그 다음 스냅샷을 기준으로 삼는다 → 항상 "직전 마일스톤 대비"가 된다.
      revisions_recent: recentRevs,
      can_execute: canExecute(req.ctx.perm),
      can_edit: isDirector(req) || (Number(p.created_by) === Number(req.ctx.perm.userId) && ['draft', 'rejected', 'approved'].includes(p.status)),
      is_director: isDirector(req),
    };
  });

  // =====================================================================
  // 계획 생성(작성중 저장) — body.items = [{name, memo, lines:[…]}]
  // =====================================================================
  app.post('/api/mktspend/plans', { preHandler: [authGuard, requirePageEdit('marketing')] }, async (req, reply) => {
    const b = req.body || {};
    const h = headerFields(b);
    if (h.error) return reply.code(400).send({ error: h.error });
    const ni = normalizeItems(b.items);
    if (ni.error) return reply.code(400).send(ni);
    const nt = normalizeTargets(b.targets);
    if (nt.error) return reply.code(400).send(nt);
    if (!(await validateCustomers(nt.custIds))) return reply.code(400).send({ error: 'customer_not_found' });
    const userId = req.ctx.perm.userId;
    const planId = await withTx(async (c) => {
      const run = (s, p2) => c.query(s, p2);
      const r = await run(
        `INSERT INTO marketing_spend_plans (title, category, event_date, purpose, status, created_by, updated_by)
         VALUES ($1,$2,$3,$4,'draft',$5,$5) RETURNING id`,
        [h.title, h.category, h.eventDate, h.purpose, userId]);
      const pid = Number(r.rows[0].id);
      await insertItemsWithLines(run, pid, ni.items);
      await replaceTargets(run, pid, nt.custIds, nt.general);
      return pid;
    });
    await logEvent({ userId, action: 'create', target: `mktspend:${planId}` });
    return { ok: true, id: planId };
  });

  // =====================================================================
  // 계획 수정
  //   · draft/rejected: 작성자 또는 디렉터 — 항목·라인·대상 전체 교체
  //   · submitted: 디렉터만(승인 전 검토 수정) — 전체 교체
  //   · approved: 디렉터만 — 연결 거래 동기화(plan만), actual 라인은 잠금
  // =====================================================================
  app.patch('/api/mktspend/plans/:id', { preHandler: [authGuard, requirePageEdit('marketing')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!(id > 0)) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {};
    const h = headerFields(b);
    if (h.error) return reply.code(400).send({ error: h.error });
    const ni = normalizeItems(b.items);
    if (ni.error) return reply.code(400).send(ni);
    const nt = normalizeTargets(b.targets);
    if (nt.error) return reply.code(400).send(nt);
    if (!(await validateCustomers(nt.custIds))) return reply.code(400).send({ error: 'customer_not_found' });
    const p = (await query(`SELECT * FROM marketing_spend_plans WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const dir = isDirector(req);
    const mine = Number(p.created_by) === Number(req.ctx.perm.userId);
    if (['draft', 'rejected'].includes(p.status)) { if (!dir && !mine) return reply.code(403).send({ error: 'not_owner' }); }
    else if (p.status === 'approved') { if (!dir && !mine) return reply.code(403).send({ error: 'not_owner' }); }
    else if (!dir) return reply.code(403).send({ error: 'director_only' });
    const userId = req.ctx.perm.userId;

    // ---- 승인건 + 담당자(비디렉터): "수정 요청" 저장 — 자금계획(현금흐름) 미반영 ----
    //      디렉터가 검토·승인 저장할 때만 예정 지출이 동기화된다(0124).
    if (p.status === 'approved' && !dir) {
      // 잠금 라인 조기 검사(실제 반영 시에도 다시 검사됨) — 지급완료 + 집행완료
      const paidRows = await lockedLines(query, id, await execReady());
      const flat = [];
      for (const it of ni.items) for (const l of it.lines) flat.push({ ...l, itemId: it.id });
      for (const e of paidRows) {
        const m = flat.find((l) => l.id != null && Number(l.id) === Number(e.id));
        if (!m) return reply.code(409).send({ error: 'line_locked', line_id: Number(e.id), reason: lockReason(e) });
        const changed = m.kind !== e.kind || m.due_date !== e.due_date || Math.abs(num(e.amount) - m.amount) > 0.001
          || (e.memo || null) !== m.memo || Number(m.itemId) !== Number(e.item_id);
        if (changed) return reply.code(409).send({ error: 'line_locked', line_id: Number(e.id), reason: lockReason(e) });
      }
      const payload = { title: h.title, category: h.category, event_date: h.eventDate, purpose: h.purpose,
        items: ni.items,
        targets: [...nt.custIds.map((cid) => ({ customer_id: cid })), ...(nt.general ? [{ is_general: true }] : [])] };
      await query(
        `UPDATE marketing_spend_plans SET pending_revision=$1::jsonb, revision_by=$2, revision_at=now(), updated_by=$2 WHERE id=$3`,
        [JSON.stringify(payload), userId, id]);
      await logEvent({ userId, action: 'update', target: `mktspend:${id}`, detail: { revision: true } });
      return { ok: true, revision: true };
    }

    const ready = await execReady();   // 트랜잭션 밖에서 미리 확인(0195 컬럼 유무)
    const result = await withTx(async (c) => {
      const run = (s, p2) => c.query(s, p2);
      await run(
        `UPDATE marketing_spend_plans SET title=$1, category=$2, event_date=$3, purpose=$4, updated_by=$5 WHERE id=$6`,
        [h.title, h.category, h.eventDate, h.purpose, userId, id]);
      await replaceTargets(run, id, nt.custIds, nt.general);

      if (p.status !== 'approved') {
        // 아직 거래 미생성 — 항목·라인 전체 교체
        await run(`DELETE FROM marketing_spend_lines WHERE plan_id=$1`, [id]);
        await run(`DELETE FROM marketing_spend_items WHERE plan_id=$1`, [id]);
        await insertItemsWithLines(run, id, ni.items);
        return { ok: true };
      }

      // ---- 승인된 계획: 집행 항목 upsert + 연결 거래 동기화 ---------------
      const exItems = (await run(`SELECT id, name, memo, sort_order FROM marketing_spend_items WHERE plan_id=$1`, [id])).rows;
      const exItemIds = new Set(exItems.map((e) => Number(e.id)));
      const keepItemIds = new Set();
      // 1) 항목 upsert(기존 id 유지·이름 수정 / 신규 삽입)
      for (const it of ni.items) {
        if (it.id != null && exItemIds.has(it.id)) {
          await run(`UPDATE marketing_spend_items SET name=$1, memo=$2, sort_order=$3 WHERE id=$4 AND plan_id=$5`,
            [it.name, it.memo, it.sort_order, it.id, id]);
          it._dbId = it.id;
        } else {
          const r = await run(`INSERT INTO marketing_spend_items (plan_id, name, memo, sort_order) VALUES ($1,$2,$3,$4) RETURNING id`,
            [id, it.name, it.memo, it.sort_order]);
          it._dbId = Number(r.rows[0].id);
        }
        keepItemIds.add(it._dbId);
      }
      // 2) 라인 동기화
      const existing = (await run(
        `SELECT l.id, l.item_id, l.kind, to_char(l.due_date,'YYYY-MM-DD') AS due_date, l.amount, l.memo, l.txn_id,
                ${ready ? 'l.exec_closed' : 'false AS exec_closed'},
                t.status AS txn_status, t.deleted_at AS txn_deleted
           FROM marketing_spend_lines l LEFT JOIN transactions t ON t.id=l.txn_id
          WHERE l.plan_id=$1`, [id])).rows;
      const exMap = new Map(existing.map((e) => [Number(e.id), e]));
      const flat = [];
      for (const it of ni.items) for (const l of it.lines) flat.push({ ...l, itemId: it._dbId, itemName: it.name });
      const keepLineIds = new Set(flat.filter((l) => l.id != null).map((l) => Number(l.id)));
      // 삭제된 라인
      for (const e of existing) {
        if (keepLineIds.has(Number(e.id))) continue;
        if (e.txn_id != null && e.txn_status === 'actual' && !e.txn_deleted) {
          return { error: 'line_locked', line_id: Number(e.id), reason: 'paid' };
        }
        if (e.exec_closed) {
          // 마케팅에서 집행 완결한 줄 — 되돌린 뒤에 삭제할 것(집행 이력이 고아가 되지 않게)
          return { error: 'line_locked', line_id: Number(e.id), reason: 'executed' };
        }
        if (e.txn_id != null && !e.txn_deleted) {
          await run(`UPDATE transactions SET deleted_at=now(), updated_by=$1 WHERE id=$2`, [userId, e.txn_id]);
        }
        await run(`DELETE FROM marketing_spend_lines WHERE id=$1`, [e.id]);
      }
      // 유지·수정 라인 + 신규 라인
      for (const l of flat) {
        if (l.id != null && exMap.has(Number(l.id))) {
          const e = exMap.get(Number(l.id));
          const changed = e.kind !== l.kind || e.due_date !== l.due_date || Math.abs(num(e.amount) - l.amount) > 0.001
            || (e.memo || null) !== l.memo || Number(e.item_id) !== Number(l.itemId);
          if (e.txn_status === 'actual' && !e.txn_deleted) {
            if (changed) return { error: 'line_locked', line_id: Number(l.id), reason: 'paid' };
            await run(`UPDATE marketing_spend_lines SET sort_order=$1 WHERE id=$2`, [l.sort_order, l.id]);
            continue;
          }
          if (e.exec_closed) {
            // 집행 완결 줄 — 내용 변경 불가(순서만 갱신). 고치려면 먼저 집행을 되돌린다.
            if (changed) return { error: 'line_locked', line_id: Number(l.id), reason: 'executed' };
            await run(`UPDATE marketing_spend_lines SET sort_order=$1 WHERE id=$2`, [l.sort_order, l.id]);
            continue;
          }
          await run(
            `UPDATE marketing_spend_lines SET item_id=$1, kind=$2, due_date=$3, amount=$4, memo=$5, sort_order=$6 WHERE id=$7`,
            [l.itemId, l.kind, l.due_date, l.amount, l.memo, l.sort_order, l.id]);
          if (e.txn_id != null && !e.txn_deleted) {
            await run(
              `UPDATE transactions SET txn_date=$1, plan_date=$1, amount=$2, amount_mxn=$2, plan_amount=$2, memo=$3, updated_by=$4 WHERE id=$5`,
              [l.due_date, l.amount, spendTxnMemo(h.title, l.itemName, l.kind, l.memo), userId, e.txn_id]);
          }
        } else {
          const r = await run(
            `INSERT INTO marketing_spend_lines (plan_id, item_id, kind, due_date, amount, memo, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [id, l.itemId, l.kind, l.due_date, l.amount, l.memo, l.sort_order]);
          const lineId = Number(r.rows[0].id);
          const t = await run(
            `INSERT INTO transactions
               (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, memo, created_by, plan_amount, plan_date)
             VALUES (NULL,$1,'out',$2,'MXN',1,$2,'6070','plan','general',true,$3,$4,$3,$2,$1) RETURNING id`,
            [l.due_date, l.amount, userId, spendTxnMemo(h.title, l.itemName, l.kind, l.memo)]);
          await run(`UPDATE marketing_spend_lines SET txn_id=$1 WHERE id=$2`, [t.rows[0].id, lineId]);
        }
      }
      // 3) 빈 항목 정리(라인 삭제가 모두 통과한 뒤)
      for (const e of exItems) {
        if (!keepItemIds.has(Number(e.id))) {
          await run(`DELETE FROM marketing_spend_items WHERE id=$1 AND plan_id=$2`, [e.id, id]);
        }
      }
      // 4) 부분 집행 라인의 잔액 재계산 — 계획액이 바뀌면 예정 거래 금액도 따라가야 한다
      if (ready) await recomputePlanExec(run, id, userId);
      // 5) 디렉터가 저장했으므로 담당자 수정 요청은 종료(반영 또는 대체)
      await run(`UPDATE marketing_spend_plans SET pending_revision=NULL, revision_by=NULL, revision_at=NULL WHERE id=$1`, [id]);
      return { ok: true, synced: true, revision_cleared: p.pending_revision != null };
    });
    if (result.error) return reply.code(409).send(result);
    await syncPlanCalendar(query, id, userId); // 커밋 후 best-effort(실패해도 저장 유지) — 승인건 수정 시 일정 재동기화
    if (p.status === 'approved') await saveRevision(query, id, 'director_edit', userId); // 변경표시 기준선(0196)
    await logEvent({ userId, action: 'update', target: `mktspend:${id}` });
    return result;
  });

  // =====================================================================
  // 제출(승인 요청) / 회수
  // =====================================================================
  app.post('/api/mktspend/plans/:id/submit', { preHandler: [authGuard, requirePageEdit('marketing')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const p = (await query(`SELECT * FROM marketing_spend_plans WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (!['draft', 'rejected'].includes(p.status)) return reply.code(409).send({ error: 'bad_status', status: p.status });
    if (!isDirector(req) && Number(p.created_by) !== Number(req.ctx.perm.userId)) return reply.code(403).send({ error: 'not_owner' });
    const n = (await query(`SELECT COUNT(*) AS n FROM marketing_spend_lines WHERE plan_id=$1`, [id])).rows[0];
    if (!(Number(n.n) > 0)) return reply.code(400).send({ error: 'lines_required' });
    await query(
      `UPDATE marketing_spend_plans SET status='submitted', submitted_at=now(), reject_reason=NULL, updated_by=$1 WHERE id=$2`,
      [req.ctx.perm.userId, id]);
    await saveRevision(query, id, 'submitted', req.ctx.perm.userId); // 변경표시 기준선(0196)
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `mktspend:${id}`, detail: { submit: true } });
    return { ok: true };
  });

  app.post('/api/mktspend/plans/:id/withdraw', { preHandler: [authGuard, requirePageEdit('marketing')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const p = (await query(`SELECT * FROM marketing_spend_plans WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (p.status !== 'submitted') return reply.code(409).send({ error: 'bad_status', status: p.status });
    if (!isDirector(req) && Number(p.created_by) !== Number(req.ctx.perm.userId)) return reply.code(403).send({ error: 'not_owner' });
    await query(`UPDATE marketing_spend_plans SET status='draft', updated_by=$1 WHERE id=$2`, [req.ctx.perm.userId, id]);
    return { ok: true };
  });

  // =====================================================================
  // 수정 요청 폐기(0124) — 디렉터(반려) 또는 요청자·담당자 본인(취소).
  //   승인본·자금계획은 그대로 유지된다.
  // =====================================================================
  app.post('/api/mktspend/plans/:id/discard-revision', { preHandler: [authGuard, requirePageEdit('marketing')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!(id > 0)) return reply.code(400).send({ error: 'bad_id' });
    const p = (await query(`SELECT * FROM marketing_spend_plans WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (p.pending_revision == null) return reply.code(409).send({ error: 'no_revision' });
    const meId = Number(req.ctx.perm.userId);
    if (!isDirector(req) && Number(p.revision_by) !== meId && Number(p.created_by) !== meId) {
      return reply.code(403).send({ error: 'not_allowed' });
    }
    await query(
      `UPDATE marketing_spend_plans SET pending_revision=NULL, revision_by=NULL, revision_at=NULL, updated_by=$1 WHERE id=$2`,
      [meId, id]);
    await logEvent({ userId: meId, action: 'update', target: `mktspend:${id}`, detail: { revision_discard: true } });
    return { ok: true };
  });

  // =====================================================================
  // 승인(디렉터) — 모든 항목의 지급 라인마다 계획 거래 생성 → 자금계획 연결
  //   본문에 수정 내용(title/items/targets 등)을 함께 보내면 반영 후 승인.
  // =====================================================================
  app.post('/api/mktspend/plans/:id/approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!(id > 0)) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {};
    const p = (await query(`SELECT * FROM marketing_spend_plans WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (!['submitted', 'draft', 'rejected'].includes(p.status)) return reply.code(409).send({ error: 'bad_status', status: p.status });

    // 수정 내용이 오면 검증(없으면 저장된 내용 그대로 승인)
    let h = null, ni = null, nt = null;
    if (b.title != null || b.items != null || b.targets != null) {
      h = headerFields({ title: b.title != null ? b.title : p.title, category: b.category, event_date: b.event_date, purpose: b.purpose });
      if (h.error) return reply.code(400).send({ error: h.error });
      ni = normalizeItems(b.items);
      if (ni.error) return reply.code(400).send(ni);
      nt = normalizeTargets(b.targets);
      if (nt.error) return reply.code(400).send(nt);
      if (!(await validateCustomers(nt.custIds))) return reply.code(400).send({ error: 'customer_not_found' });
    }
    const userId = req.ctx.perm.userId;
    const result = await withTx(async (c) => {
      const run = (s, p2) => c.query(s, p2);
      let title = p.title;
      if (h) {
        title = h.title;
        await run(`UPDATE marketing_spend_plans SET title=$1, category=$2, event_date=$3, purpose=$4, updated_by=$5 WHERE id=$6`,
          [h.title, h.category, h.eventDate, h.purpose, userId, id]);
        await replaceTargets(run, id, nt.custIds, nt.general);
        await run(`DELETE FROM marketing_spend_lines WHERE plan_id=$1`, [id]);
        await run(`DELETE FROM marketing_spend_items WHERE plan_id=$1`, [id]);
        await insertItemsWithLines(run, id, ni.items);
      }
      const lines = (await run(
        `SELECT l.id, l.kind, to_char(l.due_date,'YYYY-MM-DD') AS due_date, l.amount, l.memo,
                COALESCE(i.name,'기본 집행') AS item_name
           FROM marketing_spend_lines l
           LEFT JOIN marketing_spend_items i ON i.id=l.item_id
          WHERE l.plan_id=$1 ORDER BY l.sort_order, l.id`, [id])).rows;
      if (!lines.length) return { error: 'lines_required' };
      const txnIds = [];
      for (const l of lines) {
        const t = await run(
          `INSERT INTO transactions
             (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, memo, created_by, plan_amount, plan_date)
           VALUES (NULL,$1,'out',$2,'MXN',1,$2,'6070','plan','general',true,$3,$4,$3,$2,$1) RETURNING id`,
          [l.due_date, r2(num(l.amount)), userId, spendTxnMemo(title, l.item_name, l.kind, l.memo)]);
        await run(`UPDATE marketing_spend_lines SET txn_id=$1 WHERE id=$2`, [t.rows[0].id, l.id]);
        txnIds.push(Number(t.rows[0].id));
      }
      await run(`UPDATE marketing_spend_plans SET status='approved', decided_by=$1, decided_at=now(), reject_reason=NULL, updated_by=$1 WHERE id=$2`, [userId, id]);
      return { ok: true, txn_ids: txnIds };
    });
    if (result.error) return reply.code(400).send(result);
    await syncPlanCalendar(query, id, userId); // 커밋 후 best-effort — 승인 시 일정 달력 자동 등록
    await saveRevision(query, id, 'approved', userId); // 변경표시 기준선(0196) — 이후 수정은 이 승인본 대비로 보인다
    await logEvent({ userId, action: 'update', target: `mktspend:${id}`, detail: { approve: true, txns: result.txn_ids.length } });
    return result;
  });

  // 반려(디렉터, 사유 필수)
  app.post('/api/mktspend/plans/:id/reject', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!reason) return reply.code(400).send({ error: 'reason_required' });
    const p = (await query(`SELECT * FROM marketing_spend_plans WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (p.status !== 'submitted') return reply.code(409).send({ error: 'bad_status', status: p.status });
    await query(
      `UPDATE marketing_spend_plans SET status='rejected', reject_reason=$1, decided_by=$2, decided_at=now(), updated_by=$2 WHERE id=$3`,
      [reason.slice(0, 500), req.ctx.perm.userId, id]);
    await syncPlanCalendar(query, id, req.ctx.perm.userId); // best-effort — 반려 → 일정 제거
    await saveRevision(query, id, 'rejected', req.ctx.perm.userId); // 반려 시점 = 다음 재제출 diff 의 기준선(0196)
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `mktspend:${id}`, detail: { reject: true } });
    return { ok: true };
  });

  // =====================================================================
  // 삭제(soft) — 작성자(draft/rejected) 또는 디렉터. 승인건은 지급완료 없을 때만.
  // =====================================================================
  app.delete('/api/mktspend/plans/:id', { preHandler: [authGuard, requirePageEdit('marketing')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const p = (await query(`SELECT * FROM marketing_spend_plans WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const dir = isDirector(req);
    const mine = Number(p.created_by) === Number(req.ctx.perm.userId);
    if (!dir && !(mine && ['draft', 'rejected'].includes(p.status))) return reply.code(403).send({ error: 'not_allowed' });
    const delReady = await execReady(); // 트랜잭션 밖에서 확인(0195 컬럼 유무)
    const result = await withTx(async (c) => {
      const run = (s, p2) => c.query(s, p2);
      if (p.status === 'approved') {
        const paid = (await run(
          `SELECT COUNT(*) AS n FROM marketing_spend_lines l JOIN transactions t ON t.id=l.txn_id
            WHERE l.plan_id=$1 AND t.status='actual' AND t.deleted_at IS NULL`, [id])).rows[0];
        if (Number(paid.n) > 0) return { error: 'has_paid_lines' };
        if (delReady) {
          // 집행 기록이 있으면 삭제 불가 — 집행 이력(실제 나간 돈)이 고아가 되지 않게.
          const ex = (await run(
            `SELECT COUNT(*) AS n FROM marketing_spend_executions e
               JOIN marketing_spend_lines l ON l.id=e.line_id
              WHERE l.plan_id=$1 AND e.reverted_at IS NULL`, [id])).rows[0];
          if (Number(ex.n) > 0) return { error: 'has_executed_lines' };
        }
        const txns = (await run(`SELECT txn_id FROM marketing_spend_lines WHERE plan_id=$1 AND txn_id IS NOT NULL`, [id])).rows;
        for (const t of txns) {
          await run(`UPDATE transactions SET deleted_at=now(), updated_by=$1 WHERE id=$2 AND deleted_at IS NULL`, [req.ctx.perm.userId, t.txn_id]);
        }
      }
      await run(`UPDATE marketing_spend_plans SET deleted_at=now(), updated_by=$1 WHERE id=$2`, [req.ctx.perm.userId, id]);
      return { ok: true };
    });
    if (result.error) return reply.code(409).send(result);
    await syncPlanCalendar(query, id, req.ctx.perm.userId); // best-effort — 삭제 → 일정 제거
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `mktspend:${id}` });
    return result;
  });

  // =====================================================================
  // 집행 처리(0195) — 재무·디렉터. 여러 라인을 한 번에 처리할 수 있다
  //   (한 번의 송금으로 여러 줄을 커버하는 것이 이 기능의 출발점).
  // =====================================================================
  app.post('/api/mktspend/plans/:id/executions', { preHandler: [authGuard, requirePageAny(['marketing', 'finance'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!(id > 0)) return reply.code(400).send({ error: 'bad_id' });
    if (!canExecute(req.ctx.perm)) return reply.code(403).send({ error: 'exec_forbidden' });
    if (!(await execReady())) return reply.code(503).send({ error: 'migration_required', note: '0195' });

    const b = req.body || {};
    const execDate = String(b.exec_date || '');
    if (!DATE_RE.test(execDate)) return reply.code(400).send({ error: 'bad_exec_date' });
    const note = (b.note == null || String(b.note).trim() === '') ? null : String(b.note).trim().slice(0, 300);
    const close = b.close !== false;   // 기본 = 완결
    const raw = Array.isArray(b.lines) ? b.lines : [];
    if (!raw.length) return reply.code(400).send({ error: 'lines_required' });
    if (raw.length > 100) return reply.code(400).send({ error: 'too_many_lines' });

    const wants = []; const seen = new Set();
    for (const r of raw) {
      const lid = Number(r && r.line_id);
      if (!(lid > 0)) return reply.code(400).send({ error: 'bad_line_id' });
      if (seen.has(lid)) continue;                       // 중복 id 는 1건으로
      seen.add(lid);
      const amt = Number(r && r.amount);
      if (!(amt > 0)) return reply.code(400).send({ error: 'bad_amount', line_id: lid });
      wants.push({ line_id: lid, amount: r2(amt) });
    }

    const p = (await query(`SELECT id, status FROM marketing_spend_plans WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (p.status !== 'approved') return reply.code(409).send({ error: 'not_approved', status: p.status });

    const userId = req.ctx.perm.userId;
    const out = await withTx(async (c) => {
      const run = (s, p2) => c.query(s, p2);
      const rows = (await run(
        `SELECT l.id, l.amount, l.exec_closed, l.txn_id, t.status AS txn_status, t.deleted_at AS txn_deleted
           FROM marketing_spend_lines l LEFT JOIN transactions t ON t.id=l.txn_id
          WHERE l.plan_id=$1 AND l.id=ANY($2)`, [id, wants.map((w) => w.line_id)])).rows;
      const map = new Map(rows.map((r) => [Number(r.id), r]));
      // 전건 사전 검사 — 하나라도 안 되면 아무것도 처리하지 않는다(부분 성공 방지)
      for (const w of wants) {
        const e = map.get(w.line_id);
        if (!e) return { error: 'line_not_in_plan', line_id: w.line_id };
        if (e.txn_status === 'actual' && !e.txn_deleted) return { error: 'already_paid', line_id: w.line_id };
        if (e.exec_closed) return { error: 'already_closed', line_id: w.line_id };
      }
      const res = [];
      for (const w of wants) {
        await run(
          `INSERT INTO marketing_spend_executions (line_id, plan_id, exec_date, amount, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6)`, [w.line_id, id, execDate, w.amount, note, userId]);
        if (close) await run(`UPDATE marketing_spend_lines SET exec_closed=true WHERE id=$1`, [w.line_id]);
        const st = await recomputeLineExec(run, w.line_id, userId);
        res.push({ line_id: w.line_id, ...(st || {}) });
      }
      return { ok: true, lines: res };
    });
    if (out.error) return reply.code(409).send(out);
    await logEvent({ userId, action: 'update', target: `mktspend:${id}`,
      detail: { execute: true, lines: wants.length, close, exec_date: execDate } });
    return out;
  });

  // 집행 되돌리기 — 소프트 취소(이력 보존) + 예정 거래 복원.
  //   재무가 이미 실적 처리한 건은 409(데이터를 말없이 덮지 않는다).
  app.post('/api/mktspend/executions/:execId/revert', { preHandler: [authGuard, requirePageAny(['marketing', 'finance'])] }, async (req, reply) => {
    const eid = Number(req.params.execId);
    if (!(eid > 0)) return reply.code(400).send({ error: 'bad_id' });
    if (!canExecute(req.ctx.perm)) return reply.code(403).send({ error: 'exec_forbidden' });
    if (!(await execReady())) return reply.code(503).send({ error: 'migration_required', note: '0195' });
    const reason = ((req.body && req.body.reason) == null) ? null : String(req.body.reason).trim().slice(0, 300) || null;
    const userId = req.ctx.perm.userId;

    const out = await withTx(async (c) => {
      const run = (s, p2) => c.query(s, p2);
      const e = (await run(
        `SELECT e.id, e.line_id, e.reverted_at, l.plan_id, t.status AS txn_status, t.deleted_at AS txn_deleted
           FROM marketing_spend_executions e
           JOIN marketing_spend_lines l ON l.id=e.line_id
           LEFT JOIN transactions t ON t.id=l.txn_id
          WHERE e.id=$1 FOR UPDATE OF e`, [eid])).rows[0];
      if (!e) return { error: 'not_found' };
      if (e.reverted_at) return { error: 'already_reverted' };
      if (e.txn_status === 'actual' && !e.txn_deleted) return { error: 'finance_actual' };
      await run(
        `UPDATE marketing_spend_executions SET reverted_at=now(), reverted_by=$1, revert_reason=$2 WHERE id=$3`,
        [userId, reason, eid]);
      const st = await recomputeLineExec(run, Number(e.line_id), userId);
      return { ok: true, plan_id: Number(e.plan_id), line_id: Number(e.line_id), ...(st || {}) };
    });
    if (out.error) {
      const code = out.error === 'not_found' ? 404 : 409;
      return reply.code(code).send(out);
    }
    await logEvent({ userId, action: 'update', target: `mktspend:${out.plan_id}`, detail: { execute_revert: true, exec_id: eid } });
    return out;
  });

  // =====================================================================
  // 마케팅 집행 ↔ 재무 대사(월 단위 금액 비교)
  //   실지급 거래와 링크를 두지 않기로 했으므로(디렉터 결정), 이 패널이
  //   "집행 처리는 했는데 원장에 없는" / "원장엔 있는데 계획에서 안 빠진" 오차의
  //   유일한 검출 수단이다. 월 마감 체크리스트에 넣어 운영할 것.
  // =====================================================================
  app.get('/api/mktspend/reconcile', { preHandler: [authGuard, requirePageAny(['marketing', 'finance'])] }, async (req, reply) => {
    if (!canExecute(req.ctx.perm)) return reply.code(403).send({ error: 'exec_forbidden' });
    const ym = String(req.query.ym || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) return reply.code(400).send({ error: 'bad_ym' });
    const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
    if (!(m >= 1 && m <= 12)) return reply.code(400).send({ error: 'bad_ym' });
    const from = `${ym}-01`;
    const to = (m === 12) ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;

    // ① 재무 실적처리로 집행된 계획 라인(계획 ↔ 원장이 연결된 부분)
    const a = (await query(
      `SELECT COALESCE(SUM(t.amount_mxn),0) AS s, COUNT(*) AS n
         FROM marketing_spend_lines l JOIN transactions t ON t.id=l.txn_id
        WHERE t.status='actual' AND t.deleted_at IS NULL AND t.direction='out'
          AND t.txn_date >= $1 AND t.txn_date < $2`, [from, to])).rows[0];
    // ③ 원장의 [마케팅] 지출 실적 전체
    const cRow = (await query(
      `SELECT COALESCE(SUM(amount_mxn),0) AS s, COUNT(*) AS n
         FROM transactions
        WHERE status='actual' AND deleted_at IS NULL AND direction='out'
          AND memo LIKE '[마케팅]%'
          AND txn_date >= $1 AND txn_date < $2`, [from, to])).rows[0];

    // ② 마케팅 집행 처리(0195). 미적용이면 0으로 둔다.
    let bSum = 0, bCnt = 0, execItems = [];
    if (await execReady()) {
      const b = (await query(
        `SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS n FROM marketing_spend_executions
          WHERE reverted_at IS NULL AND exec_date >= $1 AND exec_date < $2`, [from, to])).rows[0];
      bSum = r2(num(b.s)); bCnt = num(b.n);
      execItems = (await query(
        `SELECT e.id, to_char(e.exec_date,'YYYY-MM-DD') AS exec_date, e.amount, e.note,
                p.id AS plan_id, p.title, COALESCE(i.name,'기본 집행') AS item_name, l.kind
           FROM marketing_spend_executions e
           JOIN marketing_spend_lines l ON l.id=e.line_id
           JOIN marketing_spend_plans p ON p.id=l.plan_id
           LEFT JOIN marketing_spend_items i ON i.id=l.item_id
          WHERE e.reverted_at IS NULL AND e.exec_date >= $1 AND e.exec_date < $2
          ORDER BY e.exec_date, e.id LIMIT 200`, [from, to])).rows
        .map((r) => ({ id: Number(r.id), exec_date: r.exec_date, amount: r2(num(r.amount)), note: r.note,
          plan_id: Number(r.plan_id), title: r.title, item_name: r.item_name,
          kind: r.kind, kind_label: KIND_LABEL[r.kind] || r.kind }));
    }

    // 원장의 [마케팅] 실적 중 계획 라인에 연결되지 않은 건(통합 송금·수동 등록 등)
    const unlinked = (await query(
      `SELECT t.id, to_char(t.txn_date,'YYYY-MM-DD') AS txn_date, t.amount_mxn, t.memo
         FROM transactions t
        WHERE t.status='actual' AND t.deleted_at IS NULL AND t.direction='out'
          AND t.memo LIKE '[마케팅]%'
          AND t.txn_date >= $1 AND t.txn_date < $2
          AND NOT EXISTS (SELECT 1 FROM marketing_spend_lines l WHERE l.txn_id = t.id)
        ORDER BY t.txn_date, t.id LIMIT 200`, [from, to])).rows
      .map((r) => ({ id: Number(r.id), txn_date: r.txn_date, amount: r2(num(r.amount_mxn)), memo: r.memo }));

    const linked = r2(num(a.s));                 // ①
    const ledger = r2(num(cRow.s));              // ③
    const unlinkedSum = r2(ledger - linked);     // ③ − ① = ② 와 비교해야 할 금액
    return {
      ym, from, to,
      finance_linked: { amount: linked, count: num(a.n) },        // ① 재무 실적처리(계획 연결)
      marketing_exec: { amount: bSum, count: bCnt },              // ② 마케팅 집행 처리
      ledger_total: { amount: ledger, count: num(cRow.n) },       // ③ 원장 [마케팅] 지출 실적
      unlinked_ledger: { amount: unlinkedSum, count: unlinked.length },
      plan_executed: r2(linked + bSum),
      // gap > 0 : 마케팅에서 집행 처리했는데 원장에 그만큼의 지출이 없다(재무 등록 누락 의심)
      // gap < 0 : 원장에 [마케팅] 지출이 있는데 계획에서 소진되지 않았다(집행 처리 누락 의심)
      gap: r2(bSum - unlinkedSum),
      exec_items: execItems,
      unlinked_items: unlinked,
    };
  });

  // 개정 이력(0196) — 요약만(스냅샷 본문 제외)
  app.get('/api/mktspend/plans/:id/revisions', { preHandler: [authGuard, requirePageAny(['marketing', 'finance'])] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!(id > 0)) return reply.code(400).send({ error: 'bad_id' });
    let rows = [];
    try {
      rows = (await query(
        `SELECT r.rev_no, r.event, r.created_at, r.snapshot, u.name AS created_by_name
           FROM marketing_spend_revisions r LEFT JOIN users u ON u.id=r.created_by
          WHERE r.plan_id=$1 ORDER BY r.rev_no DESC LIMIT 100`, [id])).rows;
    } catch (_) { return { items: [], note: 'migration_required' }; }
    return { items: rows.map((r) => {
      const s = typeof r.snapshot === 'string' ? JSON.parse(r.snapshot) : (r.snapshot || {});
      const items = Array.isArray(s.items) ? s.items : [];
      let lines = 0, total = 0;
      for (const it of items) for (const l of (it.lines || [])) { lines++; total += Number(l.amount) || 0; }
      return { rev_no: Number(r.rev_no), event: r.event, created_at: r.created_at,
        created_by_name: r.created_by_name, title: s.title || null,
        item_count: items.length, line_count: lines, total_amount: r2(total) };
    }) };
  });

  // =====================================================================
  // 증빙 파일 — 인보이스 첨부(0091) 패턴
  // =====================================================================
  app.get('/api/mktspend/plans/:id/files', { preHandler: [authGuard, requirePage('marketing')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!(id > 0)) return reply.code(400).send({ error: 'bad_id' });
    const rows = (await query(
      `SELECT f.id, f.file_name, f.mime_type, f.file_size, f.uploaded_at, u.name AS uploaded_by_name
         FROM marketing_spend_files f LEFT JOIN users u ON u.id=f.uploaded_by
        WHERE f.plan_id=$1 ORDER BY f.id DESC`, [id])).rows;
    return { items: rows.map((f) => ({ id: Number(f.id), file_name: f.file_name, mime_type: f.mime_type,
      file_size: f.file_size == null ? null : Number(f.file_size), uploaded_at: f.uploaded_at, uploaded_by_name: f.uploaded_by_name })) };
  });

  app.post('/api/mktspend/plans/:id/files', { preHandler: [authGuard, requirePageEdit('marketing')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!(id > 0)) return reply.code(400).send({ error: 'bad_id' });
    const p = (await query(`SELECT id FROM marketing_spend_plans WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {};
    const v = validateSpendFileDataUrl(b.data);
    if (!v.ok) return reply.code(400).send({ error: 'invalid_file', note: v.error });
    const name = String(b.file_name || 'archivo').slice(0, 200);
    const r = (await query(
      `INSERT INTO marketing_spend_files (plan_id, file_name, mime_type, file_data, file_size, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, uploaded_at`,
      [id, name, v.mime, v.data, v.size, req.ctx.perm.userId])).rows[0];
    return { ok: true, id: Number(r.id), uploaded_at: r.uploaded_at };
  });

  app.get('/api/mktspend/files/:fileId', { preHandler: [authGuard, requirePage('marketing')] }, async (req, reply) => {
    const fid = Number(req.params.fileId);
    if (!(fid > 0)) return reply.code(400).send({ error: 'bad_id' });
    const f = (await query(`SELECT id, plan_id, file_name, mime_type, file_data FROM marketing_spend_files WHERE id=$1`, [fid])).rows[0];
    if (!f) return reply.code(404).send({ error: 'not_found' });
    return { id: Number(f.id), plan_id: Number(f.plan_id), file_name: f.file_name, mime_type: f.mime_type, file_data: f.file_data };
  });

  app.delete('/api/mktspend/files/:fileId', { preHandler: [authGuard, requirePageEdit('marketing')] }, async (req, reply) => {
    const fid = Number(req.params.fileId);
    if (!(fid > 0)) return reply.code(400).send({ error: 'bad_id' });
    const r = await query(`DELETE FROM marketing_spend_files WHERE id=$1 RETURNING plan_id`, [fid]);
    if (!r.rows.length) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
