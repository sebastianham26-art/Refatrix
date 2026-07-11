// =====================================================================
// Refatrix ERP · stageCohorts.js
//   수주 단계별 "현재 대기" 코호트 SQL — WBR·포털·창고 SLA 카드 공용 단일 기준.
//   (기존 wbrRoutes.js 내부 함수였던 buildStageCohorts/getSlaKpi 를 공용 모듈로 추출.
//    wbr·portal 동작 100% 동일. 창고 SLA 는 allTeams 옵션으로 팀필터 없이 전체 집계.)
//   각 단계 = 지금 그 단계에 막혀있는(아직 안 끝난) 건. 월 무관(시점 기준).
// =====================================================================
import { query } from './db.js';
import { visibleTeamIds } from './teams.js';
import { ORDER_WINDOW_DAYS, ORDER_WAIT_STATUSES } from './processWindow.js';

// 단계별 "현재 대기" 코호트 — 팀 가시성(visibleTeamIds) 적용. wbr·portal 공용 단일 기준.
//   각 단계 = 지금 그 단계에 막혀있는(아직 안 끝난) 건. 월 무관(시점 기준).
//   opts.allTeams=true → 팀 필터 없이 전체 집계(창고 포장은 팀 무관 중앙집중 처리 → 전체를 봐야 함).
export async function buildStageCohorts(perm, reqTeam, opts = {}) {
  const allTeams = !!(opts && opts.allTeams);
  const vis = allTeams ? null : visibleTeamIds(perm); // null = 전체(디렉터/영업지원, 또는 창고 allTeams)
  const reqRaw = String(reqTeam || 'total').split(',').map((s) => s.trim()).filter(Boolean);
  let teamIds;
  if (allTeams || reqRaw.includes('total') || !reqRaw.length) teamIds = vis;
  else { const want = reqRaw.map(Number).filter(Number.isInteger); teamIds = vis ? want.filter((id) => vis.includes(id)) : want; }
  const empty = Array.isArray(teamIds) && teamIds.length === 0;
  function tc(args) { if (teamIds == null) return ''; args.push(teamIds); return ` AND c.team_id = ANY($${args.length})`; }

  const cohorts = { order: [], packing: [], sat: [], collect: [] };
  if (empty) return cohorts;

  let a = []; let tcl = tc(a);
  // 오더확정 대기: 견적 미결(작성중/확정) + 아직 포장출력 전
  cohorts.order = (await query(
    `SELECT q.created_at, q.total_mxn AS amount, c.name AS customer_name, (SELECT COUNT(*) FROM quote_lines ql WHERE ql.quote_id=q.id) AS sku_count, (SELECT COALESCE(SUM(ql.qty),0) FROM quote_lines ql WHERE ql.quote_id=q.id) AS total_qty
       FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id
      WHERE q.deleted_at IS NULL AND q.status IN (${ORDER_WAIT_STATUSES.map((s) => `'${s}'`).join(',')})
        AND q.packing_printed_at IS NULL
        AND q.created_at >= now() - (${ORDER_WINDOW_DAYS} || ' days')::interval${tcl}`, a)).rows;

  a = []; tcl = tc(a);
  // 포장단계 대기: 포장출력 했지만 포장작업지시서 스캔 업로드(완료) 전, 아직 전환 전
  cohorts.packing = (await query(
    `SELECT COALESCE((SELECT MIN(occurred_at) FROM audit_log WHERE action='print' AND target='packing_print' AND detail->>'quote_id' = q.id::text), q.packing_printed_at) AS packing_printed_at, q.packing_due_at, q.total_mxn AS amount, c.name AS customer_name, (SELECT COUNT(*) FROM quote_lines ql WHERE ql.quote_id=q.id) AS sku_count, (SELECT COALESCE(SUM(ql.qty),0) FROM quote_lines ql WHERE ql.quote_id=q.id) AS total_qty
       FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id
      WHERE q.deleted_at IS NULL AND q.packing_printed_at IS NOT NULL AND q.status <> 'converted'
        AND NOT EXISTS (SELECT 1 FROM quote_packing_docs pd WHERE pd.quote_id=q.id)${tcl}`, a)).rows;

  a = []; tcl = tc(a);
  // 인보이스(SAT) 대기: 전환됐지만 실제 SAT 번호 미부여(없음/빈값/TMP- = 미발행)
  cohorts.sat = (await query(
    `SELECT si.created_at AS converted_at, si.total_mxn AS amount, c.name AS customer_name, (SELECT COUNT(*) FROM sales_invoice_lines sil WHERE sil.invoice_id=si.id) AS sku_count, (SELECT COALESCE(SUM(sil.qty),0) FROM sales_invoice_lines sil WHERE sil.invoice_id=si.id) AS total_qty
       FROM sales_invoices si LEFT JOIN customers c ON c.id=si.customer_id
      WHERE si.deleted_at IS NULL AND si.status <> 'deleted'
        AND (si.sat_no IS NULL OR si.sat_no = '' OR si.sat_no LIKE 'TMP-%')${tcl}`, a)).rows;

  a = []; tcl = tc(a);
  // 정시수금 대기: 실제 SAT 번호 발행완료된 인보이스 중 미수금(완납 안 됨)
  cohorts.collect = (await query(
    `SELECT to_char(si.due_date,'YYYY-MM-DD') AS due_date, si.total_mxn AS amount, c.name AS customer_name, (SELECT COUNT(*) FROM sales_invoice_lines sil WHERE sil.invoice_id=si.id) AS sku_count, (SELECT COALESCE(SUM(sil.qty),0) FROM sales_invoice_lines sil WHERE sil.invoice_id=si.id) AS total_qty
       FROM sales_invoices si
       LEFT JOIN (SELECT spa.invoice_id, SUM(spa.amount) AS paid
                    FROM sales_payment_allocations spa GROUP BY spa.invoice_id) p ON p.invoice_id=si.id
       LEFT JOIN customers c ON c.id=si.customer_id
      WHERE si.deleted_at IS NULL AND si.status <> 'deleted'
        AND si.sat_no IS NOT NULL AND si.sat_no <> '' AND si.sat_no NOT LIKE 'TMP-%'
        AND si.due_date IS NOT NULL
        AND COALESCE(p.paid,0) < si.total_mxn - 0.005${tcl}`, a)).rows;

  return cohorts;
}

// SLA 지연 임계치 = process_sla_kpi(업무 프로세스 KPI factor). 테이블 없으면 기본값.
export async function getSlaKpi() {
  try {
    const r = (await query(`SELECT order_hours, packing_hours, sat_hours FROM process_sla_kpi WHERE id=1`)).rows[0];
    if (r) return { order: Number(r.order_hours) || 48, packing: Number(r.packing_hours) || 6, sat: Number(r.sat_hours) || 3 };
  } catch (e) { /* 테이블 미생성 시 기본값 */ }
  return { order: 48, packing: 6, sat: 3 };
}
