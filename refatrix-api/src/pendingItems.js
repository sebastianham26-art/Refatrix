// =====================================================================
// Refatrix ERP · pendingItems.js
//   하루 브리핑 "미결 누적(carry-over)" — Layer 1(결정론, AI 없음, 외부전송 없음).
//   7종 원천을 라이브로 집계해 "완료 전까지 남는" 미결 항목을 돌려준다.
//   각 항목은 원천의 상태가 바뀌면(완료/전환/완납/스캔/done) 다음 조회부터 자동 소멸.
//
//   유형 · 미결 판정 · 자동 해제 · 경과일 기준:
//     packing    포장출력했고 스캔 전            → 스캔 업로드 시           printed_at
//     sat        전환됐고 SAT 미발행(TMP-/빈값)  → 실 SAT 부여 시           created_at
//     ar         SAT 발행 & 완납 전 & 기일도래    → 완납 시                  due_date(D+연체)
//     quote_delay 생성 N일(기본3) 미전환·미포장   → 전환/취소 시             created_at
//     mkt        승인계획 지급 due 지남 & 미지급  → 지급 실적처리 시         due_date
//     todo       open & 마감 ≤ 오늘               → done 체크 시             due_date
//     directive  status ≠ done                    → F/UP 완료 시            created_at
//
//   반환 항목: { type, item_key:'type:ref', ref_id, title, sub, amount, first_date, age_days, severity, link }
//   심각도 severity: age_days<=1 'info' / <=3 'warn' / >3 'bad'  (미결 강조·에스컬레이션용)
// =====================================================================
import { query } from './db.js';

function n(v) { return Number(v) || 0; }
function d10(d) { if (!d) return null; if (d instanceof Date) return d.toISOString().slice(0, 10); return String(d).slice(0, 10); }
// 두 YYYY-MM-DD 사이 일수(a-b). 순수 날짜 연산(UTC).
function daysBetween(aYmd, bYmd) {
  if (!aYmd || !bYmd) return 0;
  const [ay, am, ad] = String(aYmd).split('-').map(Number);
  const [by, bm, bd] = String(bYmd).split('-').map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
}
function sevOf(age) { return age <= 1 ? 'info' : (age <= 3 ? 'warn' : 'bad'); }
function party(customerId, guestName, customerName) {
  if (customerId == null) return guestName || '불특정 고객';
  return customerName || '—';
}

// mxToday = 'YYYY-MM-DD' (MX 현지 오늘), quoteDelayDays = 지연 견적 기준 일수(기본 3)
export async function collectPending(mxToday, quoteDelayDays = 3) {
  const out = [];
  const push = (o) => { o.age_days = Math.max(0, o._age); o.severity = sevOf(o.age_days); delete o._age; out.push(o); };

  // ① 포장 미완 -----------------------------------------------------------
  try {
    const rows = (await query(
      `SELECT q.id, q.total_mxn AS amount, q.packing_printed_at AS first_at,
              q.customer_id, q.guest_name, c.name AS customer_name
         FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id
        WHERE q.deleted_at IS NULL AND q.packing_printed_at IS NOT NULL
          AND q.status NOT IN ('converted','cancelled')
          AND NOT EXISTS (SELECT 1 FROM quote_packing_docs pd WHERE pd.quote_id=q.id)`)).rows;
    for (const r of rows) {
      const fd = d10(r.first_at);
      push({ type: 'packing', item_key: `packing:${r.id}`, ref_id: Number(r.id),
        title: `포장 미완 — ${party(r.customer_id, r.guest_name, r.customer_name)}`,
        sub: '포장출력 후 스캔(완료) 전', amount: Math.round(n(r.amount)),
        first_date: fd, _age: daysBetween(mxToday, fd), link: 'warehouse' });
    }
  } catch (_) { /* skip */ }

  // ② SAT 미발행 ----------------------------------------------------------
  try {
    const rows = (await query(
      `SELECT si.id, si.total_mxn AS amount, si.created_at AS first_at,
              si.customer_id, c.name AS customer_name
         FROM sales_invoices si LEFT JOIN customers c ON c.id=si.customer_id
        WHERE si.deleted_at IS NULL AND si.status <> 'deleted'
          AND (si.sat_no IS NULL OR si.sat_no='' OR si.sat_no LIKE 'TMP-%')`)).rows;
    for (const r of rows) {
      const fd = d10(r.first_at);
      push({ type: 'sat', item_key: `sat:${r.id}`, ref_id: Number(r.id),
        title: `SAT 미발행 — ${party(r.customer_id, null, r.customer_name)}`,
        sub: '전환됐으나 실 SAT 미부여', amount: Math.round(n(r.amount)),
        first_date: fd, _age: daysBetween(mxToday, fd), link: 'settlement' });
    }
  } catch (_) { /* skip */ }

  // ③ 미수금(기일도래·연체) ----------------------------------------------
  try {
    const rows = (await query(
      `SELECT si.id, (si.total_mxn - COALESCE(p.paid,0)) AS amount, to_char(si.due_date,'YYYY-MM-DD') AS due_date,
              si.customer_id, c.name AS customer_name
         FROM sales_invoices si
         LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) p ON p.invoice_id=si.id
         LEFT JOIN customers c ON c.id=si.customer_id
        WHERE si.deleted_at IS NULL AND si.status <> 'deleted'
          AND si.sat_no IS NOT NULL AND si.sat_no <> '' AND si.sat_no NOT LIKE 'TMP-%'
          AND si.due_date IS NOT NULL AND si.due_date <= $1
          AND COALESCE(p.paid,0) < si.total_mxn - 0.005`, [mxToday])).rows;
    for (const r of rows) {
      push({ type: 'ar', item_key: `ar:${r.id}`, ref_id: Number(r.id),
        title: `미수금 — ${party(r.customer_id, null, r.customer_name)}`,
        sub: `기일 ${r.due_date} 경과`, amount: Math.round(n(r.amount)),
        first_date: r.due_date, _age: daysBetween(mxToday, r.due_date), link: 'settlement' });
    }
  } catch (_) { /* skip */ }

  // ④ 지연 견적(생성 N일 미전환·미포장) ----------------------------------
  try {
    const rows = (await query(
      `SELECT q.id, q.total_mxn AS amount, q.created_at AS first_at,
              q.customer_id, q.guest_name, c.name AS customer_name
         FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id
        WHERE q.deleted_at IS NULL AND q.status IN ('draft','confirmed')
          AND q.packing_printed_at IS NULL
          AND q.created_at < now() - ($1 || ' days')::interval`, [String(quoteDelayDays)])).rows;
    for (const r of rows) {
      const fd = d10(r.first_at);
      push({ type: 'quote_delay', item_key: `quote_delay:${r.id}`, ref_id: Number(r.id),
        title: `지연 견적 — ${party(r.customer_id, r.guest_name, r.customer_name)}`,
        sub: `생성 후 ${quoteDelayDays}일+ 미전환`, amount: Math.round(n(r.amount)),
        first_date: fd, _age: daysBetween(mxToday, fd), link: 'quotelist' });
    }
  } catch (_) { /* skip */ }

  // ⑤ 마케팅 미집행(due 지남 & 미지급) -----------------------------------
  try {
    const rows = (await query(
      `SELECT l.id, l.amount, to_char(l.due_date,'YYYY-MM-DD') AS due_date,
              p.title AS plan_title, i.name AS item_name
         FROM marketing_spend_lines l
         JOIN marketing_spend_plans p ON p.id=l.plan_id
         LEFT JOIN marketing_spend_items i ON i.id=l.item_id
         LEFT JOIN transactions t ON t.id=l.txn_id
        WHERE p.status='approved' AND p.deleted_at IS NULL
          AND l.due_date IS NOT NULL AND l.due_date <= $1
          AND (l.txn_id IS NULL OR t.status <> 'actual' OR t.deleted_at IS NOT NULL)`, [mxToday])).rows;
    for (const r of rows) {
      push({ type: 'mkt', item_key: `mkt:${r.id}`, ref_id: Number(r.id),
        title: `마케팅 미집행 — ${r.plan_title || ''}${r.item_name ? ' · ' + r.item_name : ''}`,
        sub: `지급 예정 ${r.due_date} 경과`, amount: Math.round(n(r.amount)),
        first_date: r.due_date, _age: daysBetween(mxToday, r.due_date), link: 'mktspend' });
    }
  } catch (_) { /* skip */ }

  // ⑥ 미완료 할 일(open & 마감 ≤ 오늘) -----------------------------------
  try {
    const rows = (await query(
      `SELECT t.id, t.title, to_char(t.due_date,'YYYY-MM-DD') AS due_date
         FROM todos t
        WHERE t.deleted_at IS NULL AND t.status='open'
          AND t.due_date IS NOT NULL AND t.due_date <= $1`, [mxToday])).rows;
    for (const r of rows) {
      push({ type: 'todo', item_key: `todo:${r.id}`, ref_id: Number(r.id),
        title: `할 일 미완 — ${r.title || ''}`,
        sub: `마감 ${r.due_date}`, amount: null,
        first_date: r.due_date, _age: daysBetween(mxToday, r.due_date), link: 'board' });
    }
  } catch (_) { /* skip */ }

  // ⑦ 미완료 디렉터 지시(status ≠ done) ----------------------------------
  try {
    const rows = (await query(
      `SELECT d.id, d.note, d.status, d.created_at AS first_at, c.name AS customer_name
         FROM customer_directives d LEFT JOIN customers c ON c.id=d.customer_id
        WHERE d.status <> 'done'`)).rows;
    for (const r of rows) {
      const fd = d10(r.first_at);
      const noteShort = (r.note || '').slice(0, 40);
      push({ type: 'directive', item_key: `directive:${r.id}`, ref_id: Number(r.id),
        title: `지시 미완 — ${r.customer_name || ''}`,
        sub: `${r.status === 'read' ? '읽음·F/UP 전' : '미확인'}${noteShort ? ' · ' + noteShort : ''}`, amount: null,
        first_date: fd, _age: daysBetween(mxToday, fd), link: 'pipeline' });
    }
  } catch (_) { /* skip */ }

  return out;
}

// 지난 일정(자동 todo 대상) — 최근 pastDays일 내 지난 일정 중 아직 todo로 안 만든 것.
//   calendar_events 는 완료 플래그가 없어, "지난 일정=미완 가능성"으로 보고 todo 전환 후보를 돌려준다.
//   실제 중복방지는 briefing_pending_state.todo_id 로 라우트에서 필터.
export async function pastEventsForTodo(mxToday, pastDays = 7) {
  const from = (() => { const [y, m, d] = mxToday.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d)); t.setUTCDate(t.getUTCDate() - pastDays); return t.toISOString().slice(0, 10); })();
  const rows = (await query(
    `SELECT e.id, e.content, to_char(COALESCE(e.event_at::date, e.event_date),'YYYY-MM-DD') AS ev_date
       FROM calendar_events e
      WHERE e.deleted_at IS NULL
        AND COALESCE(e.event_at::date, e.event_date) < $1
        AND COALESCE(e.event_at::date, e.event_date) >= $2
      ORDER BY COALESCE(e.event_at::date, e.event_date)`, [mxToday, from])).rows;
  return rows.map((r) => ({ event_id: Number(r.id), content: r.content || '(제목 없음)', ev_date: r.ev_date, item_key: `calevent:${r.id}` }));
}
