// =====================================================================
// Refatrix ERP · stageAlerts.js
//   수주 단계 경고 → 담당자(영업) 직접 팝업 노티스.
//   디렉터 확정 정책:
//    · 4종 경고 전부(48h 오더미확정 · 포장 6h · SAT 3h · 외상 지연)
//    · 즉시 1회 + 미해결 시 매일 1회 리마인드(정확히 1회/일)
//   담당자: 고객 영업담당(owner_id) → 없으면 견적 작성자(created_by) → 디렉터.
//   전달: notices(audience='users', is_popup, popup_persist=false) + notice_targets
//         → nav 로그인 팝업(/api/notices/popup). 미확인 1건씩 팝업.
//   멱등: quote_stage_alerts (quote_id,warn_type) ON CONFLICT … last_notified_day 가드.
//   해소: 더 이상 경고 아니면 직전 노티스 회수(soft-delete) + resolved.
// =====================================================================
import { query } from './db.js';
import { computeQuoteStage } from './quoteStage.js';
import { mxTodayStr } from './workingHours.js';

const ALERT_WARN_TYPES = new Set(['created', 'printing', 'await_sat', 'await_collect']);

function mxFmt(iso) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() - 360 * 60000); // UTC-6
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export async function sweepStageAlerts() {
  const now = new Date();
  const today = mxTodayStr(now);

  // 1) 후보 견적: 미완결 라이프사이클 + 최근 180일 또는 미해결 알림 보유
  const rows = (await query(
    `SELECT q.id, q.quote_no, q.status AS qstatus, q.created_at,
            q.packing_printed_at, q.packing_due_at, q.invoice_id, q.created_by,
            c.name AS customer_name, c.owner_id,
            pd.uploaded_at AS packed_at,
            si.created_at AS converted_at, si.sat_no, to_char(si.due_date,'YYYY-MM-DD') AS due_date, si.total_mxn,
            (SELECT COALESCE(SUM(spa.amount),0) FROM sales_payment_allocations spa WHERE spa.invoice_id = si.id) AS paid_sum
       FROM quotes q
       LEFT JOIN customers c ON c.id=q.customer_id
       LEFT JOIN quote_packing_docs pd ON pd.quote_id=q.id
       LEFT JOIN sales_invoices si ON si.id=q.invoice_id
      WHERE q.deleted_at IS NULL
        AND q.status NOT IN ('cancelled','expired','delete_pending')
        AND (q.quote_date >= (CURRENT_DATE - INTERVAL '180 days')
             OR q.id IN (SELECT quote_id FROM quote_stage_alerts WHERE resolved_at IS NULL))
      ORDER BY q.id
      LIMIT 2000`)).rows;

  const active = new Map(); // `${qid}:${warn_type}` → { o, st }
  for (const o of rows) {
    const st = computeQuoteStage({
      status: o.qstatus, created_at: o.created_at,
      packing_printed_at: o.packing_printed_at, packing_due_at: o.packing_due_at, packed_at: o.packed_at,
      invoice_id: o.invoice_id, converted_at: o.converted_at, sat_no: o.sat_no,
      due_date: o.due_date, total_mxn: o.total_mxn, paid_sum: o.paid_sum,
    }, now);
    if (st.warn && ALERT_WARN_TYPES.has(st.stage_key)) active.set(`${o.id}:${st.stage_key}`, { o, st });
  }

  // 2) 활성 경고 → 일 1회 팝업 노티스
  for (const [, { o, st }] of active) {
    try {
      const won = (await query(
        `INSERT INTO quote_stage_alerts (quote_id, warn_type, first_warned_at, last_notified_day)
         VALUES ($1,$2, now(), $3::date)
         ON CONFLICT (quote_id, warn_type) DO UPDATE
           SET last_notified_day = EXCLUDED.last_notified_day, resolved_at = NULL
           WHERE quote_stage_alerts.last_notified_day IS DISTINCT FROM EXCLUDED.last_notified_day
             AND (quote_stage_alerts.last_notified_day IS NULL OR quote_stage_alerts.last_notified_day < EXCLUDED.last_notified_day)
         RETURNING quote_id, last_notice_id`, [o.id, st.stage_key, today])).rows[0];
      if (!won) continue; // 오늘 이미 발송 → 스킵(정확히 1회/일)

      // 직전 노티스 회수(스택 방지)
      if (won.last_notice_id) await query(`UPDATE notices SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL`, [won.last_notice_id]);

      // 담당자: owner_id → created_by → 디렉터
      let targets = [];
      const primary = o.owner_id != null ? Number(o.owner_id) : (o.created_by != null ? Number(o.created_by) : null);
      if (primary) {
        const ok = (await query(`SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL`, [primary])).rows[0];
        if (ok) targets = [primary];
      }
      if (!targets.length) {
        targets = (await query(`SELECT id FROM users WHERE role='director' AND deleted_at IS NULL`)).rows.map((r) => Number(r.id));
      }
      if (!targets.length) continue;

      const title = `⚠ [수주경고] ${o.quote_no || ('#' + o.id)} · ${st.stage_label}`;
      const dlTxt = st.stage_key === 'await_collect'
        ? (o.due_date ? `외상만기 ${String(o.due_date).slice(0, 10)}` : '')
        : (st.deadline ? `기준시각 ${mxFmt(st.deadline)}` : '');
      const body = `${o.customer_name ? o.customer_name + ' 고객 · ' : ''}${st.warn_label}`
        + (dlTxt ? `\n${dlTxt}` : '')
        + `\n수주흐름추이 화면에서 확인하세요.`;

      const nid = (await query(
        `INSERT INTO notices (title, body, audience, is_popup, popup_persist, pinned, created_by)
         VALUES ($1,$2,'users',true,false,false,NULL) RETURNING id`, [title, body])).rows[0].id;
      for (const uid of targets) {
        await query(
          `INSERT INTO notice_targets (notice_id, user_id)
             SELECT $1,$2 WHERE EXISTS (SELECT 1 FROM users WHERE id=$2 AND deleted_at IS NULL)
           ON CONFLICT (notice_id, user_id) DO NOTHING`, [nid, uid]);
      }
      await query(`UPDATE quote_stage_alerts SET last_notice_id=$2 WHERE quote_id=$1 AND warn_type=$3`, [o.id, nid, st.stage_key]);
    } catch (_) { /* 한 건 실패가 전체 sweep 을 막지 않음 */ }
  }

  // 3) 해소 처리: 미해결 알림인데 더 이상 활성 아님 → 노티스 회수 + resolved
  const open = (await query(`SELECT quote_id, warn_type, last_notice_id FROM quote_stage_alerts WHERE resolved_at IS NULL`)).rows;
  for (const a of open) {
    if (active.has(`${a.quote_id}:${a.warn_type}`)) continue;
    try {
      if (a.last_notice_id) await query(`UPDATE notices SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL`, [a.last_notice_id]);
      await query(`UPDATE quote_stage_alerts SET resolved_at=now() WHERE quote_id=$1 AND warn_type=$2`, [a.quote_id, a.warn_type]);
    } catch (_) {}
  }
}
