// =====================================================================
// Refatrix ERP · dailyBriefingRoutes.js  (하루 아침 브리핑 — Phase 1)
//
//   목적: 디렉터가 로그인하면 "오늘의 브리핑" 한 장으로 각 부서 현황을 요약.
//     ① 오늘의 일정   (calendar_events, MX 현지 오늘)
//     ② 어제 견적     (quotes, quote_date = MX 어제)
//     ③ 진행 중 포장  (stageCohorts.buildStageCohorts().packing — 단일 기준 재사용)
//     ④ 마케팅 일정   (marketing_spend_plans/lines, 향후 7일 예정 행사·집행)
//     ⑤ 재무 현황     (accounts 잔액 + 오늘 확정거래 순액 + 향후 7일 예정 지출/수금)
//
//   원칙(격리·무해): 100% 읽기 전용. 재고·매출·단계에 아무 영향 없음.
//     기존 엔드포인트를 건드리지 않고, 이미 검증된 공용 로직(stageCohorts,
//     /api/accounts 잔액 공식)을 그대로 재사용하는 미러/집계 전용.
//
//   Phase 1 = 규칙 템플릿. 외부 전송 없음 — 문장 조립까지 서버 안에서 끝남.
//     각 section 은 { key, icon, title, text(한국어 완성문), ...구조화 필드 } 를
//     반환하므로, 프런트는 text 를 그대로 카드/팝업에 뿌리면 됩니다.
//
//   대상: 디렉터(항상) + socio(디렉터가 공유 옵션을 켠 경우만, 열람 전용).
//         그 외 역할은 { enabled:false } 만 반환(프런트 무표시).
// =====================================================================
import { query } from '../db.js';
import { authGuard } from '../middleware/authGuard.js';
import { buildStageCohorts } from '../stageCohorts.js';
import { mxTodayStr, MX_OFFSET_MIN } from '../workingHours.js';
import { getUsdMxnRate } from '../fx.js';
import { briefingViewer } from '../briefingShare.js';

// ── 포맷 헬퍼(서버측 한국어 문장 조립용) ──
function n(v) { return Number(v) || 0; }
function d10(d) { if (!d) return null; if (d instanceof Date) return d.toISOString().slice(0, 10); return String(d).slice(0, 10); }
// 금액(MXN): 정수 자리로 반올림해 천단위 구분. "$1,234,567"
function money(v) { return '$' + Math.round(n(v)).toLocaleString('en-US'); }
// 수량: 소수 3자리까지 필요 시 표기(대개 정수)
function qty(v) { const x = n(v); return (Math.round(x) === x ? x : x.toFixed(3)).toLocaleString ? Number(x).toLocaleString('en-US', { maximumFractionDigits: 3 }) : String(x); }

// YYYY-MM-DD 를 n일 이동(UTC 기준 순수 날짜 연산 — 타임존 무관)
function shiftYmd(ymd, days) {
  const [y, m, dd] = String(ymd).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, dd));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
// timestamptz(ISO) → MX 현지 "YYYY-MM-DD"
function mxDateOf(iso) {
  if (!iso) return null;
  const t = new Date(iso);
  if (isNaN(t.getTime())) return null;
  const m = new Date(t.getTime() + MX_OFFSET_MIN * 60000);
  return m.toISOString().slice(0, 10);
}
// timestamptz(ISO) → MX 현지 "HH:MM"
function mxHmOf(iso) {
  if (!iso) return null;
  const t = new Date(iso);
  if (isNaN(t.getTime())) return null;
  const m = new Date(t.getTime() + MX_OFFSET_MIN * 60000);
  return String(m.getUTCHours()).padStart(2, '0') + ':' + String(m.getUTCMinutes()).padStart(2, '0');
}
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
function krDateLabel(ymd) {
  const [y, m, dd] = String(ymd).split('-').map(Number);
  const w = DOW[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
  return `${y}년 ${m}월 ${dd}일 (${w})`;
}
function joinNames(names, max = 3) {
  const uniq = [];
  for (const x of names) { const s = (x || '').trim(); if (s && !uniq.includes(s)) uniq.push(s); }
  if (!uniq.length) return '';
  if (uniq.length <= max) return uniq.join(', ');
  return uniq.slice(0, max).join(', ') + ` 외 ${uniq.length - max}곳`;
}

// ─────────────────────────────────────────────────────────────────────
// ① 오늘의 일정 — 디렉터는 전체 일정. MX 현지 "오늘"만.
//    타임드 일정은 event_at(timestamptz), 종일은 event_date. tz 경계 대비 ±1일 조회 후 필터.
// ─────────────────────────────────────────────────────────────────────
async function sectionSchedule(mxToday) {
  const from = shiftYmd(mxToday, -1);
  const to = shiftYmd(mxToday, 1);
  const rows = (await query(
    `SELECT e.event_date, e.event_time, e.event_at, e.content
       FROM calendar_events e
      WHERE e.deleted_at IS NULL
        AND e.event_date >= $1 AND e.event_date <= $2
      ORDER BY COALESCE(e.event_at, e.event_date::timestamptz), e.event_time NULLS FIRST, e.id`, [from, to])).rows;
  const items = [];
  for (const r of rows) {
    const iso = r.event_at ? new Date(r.event_at).toISOString() : null;
    const dkey = iso ? mxDateOf(iso) : d10(r.event_date);
    if (dkey !== mxToday) continue;
    const hm = iso ? mxHmOf(iso) : (r.event_time ? String(r.event_time).slice(0, 5) : null);
    items.push({ time: hm, content: r.content || '' });
  }
  items.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));

  let text;
  if (!items.length) {
    text = '오늘 등록된 일정은 없습니다.';
  } else {
    const parts = items.map((it) => (it.time ? it.time + ' ' : '종일 ') + it.content);
    text = `오늘 일정은 ${items.length}건입니다. ` + parts.join(' / ') + '.';
  }
  return { key: 'schedule', icon: '📅', title: '오늘의 일정', count: items.length, items, text };
}

// ─────────────────────────────────────────────────────────────────────
// ② 어제 견적 — quote_date = MX 어제. 가격표(pricelist) 견적 제외.
// ─────────────────────────────────────────────────────────────────────
async function sectionQuotes(mxYesterday) {
  const rows = (await query(
    `SELECT q.total_mxn, q.sku_count, q.total_qty, q.customer_id, q.guest_name, c.name AS customer_name
       FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id
      WHERE q.deleted_at IS NULL AND q.status <> 'pricelist' AND q.quote_date = $1
      ORDER BY q.id`, [mxYesterday])).rows;
  const cnt = rows.length;
  let sku = 0, tqty = 0, amt = 0;
  const names = [];
  for (const r of rows) {
    sku += n(r.sku_count); tqty += n(r.total_qty); amt += n(r.total_mxn);
    names.push(r.customer_id == null ? (r.guest_name || '불특정 고객') : (r.customer_name || '—'));
  }
  const custLabel = joinNames(names);
  let text;
  if (!cnt) {
    text = '어제 접수된 견적은 없습니다.';
  } else {
    text = `어제 견적은 총 ${cnt}건이며, ${custLabel ? custLabel + '로부터 ' : ''}`
      + `총 ${qty(sku)} SKU · ${qty(tqty)}개 제품이 접수되었습니다 (견적액 ${money(amt)}).`;
  }
  return {
    key: 'quotes', icon: '📝', title: '어제 견적',
    count: cnt, sku_count: sku, total_qty: tqty, total_mxn: Math.round(amt),
    customers: custLabel, text,
  };
}

// ─────────────────────────────────────────────────────────────────────
// ②-b 어제 영업활동 — 영업(파이프라인) > 영업활동의 미팅·방문 기록(customer_meetings).
//     meeting_date = MX 어제. 담당자·접촉 고객·단계 이동 집계.
// ─────────────────────────────────────────────────────────────────────
async function sectionSalesActivity(mxYesterday) {
  const rows = (await query(
    `SELECT m.customer_id, c.name AS customer_name, u.name AS by_name,
            m.stage_before, m.stage_after, sa.name AS stage_after_name
       FROM customer_meetings m
       LEFT JOIN customers c ON c.id=m.customer_id
       LEFT JOIN users u ON u.id=m.created_by
       LEFT JOIN stages sa ON sa.id=m.stage_after
      WHERE m.meeting_date = $1
      ORDER BY m.id`, [mxYesterday])).rows;
  const cnt = rows.length;
  const custNames = [];
  const repNames = [];
  const advances = [];
  for (const r of rows) {
    custNames.push(r.customer_name || '—');
    if (r.by_name) repNames.push(r.by_name);
    // 단계 이동(전→후가 다르고 후단계가 있는 경우) = 실질 진전
    if (r.stage_after != null && String(r.stage_before) !== String(r.stage_after)) {
      advances.push({ customer: r.customer_name || '—', to_stage: r.stage_after_name || null });
    }
  }
  const custLabel = joinNames(custNames);
  const repLabel = joinNames(repNames);
  const advCnt = advances.length;

  let text;
  if (!cnt) {
    text = '어제 기록된 영업활동은 없습니다.';
  } else {
    const advParts = advances.slice(0, 3)
      .map((a) => a.to_stage ? `${a.customer}→${a.to_stage}` : a.customer);
    const advMore = advCnt > 3 ? ` 외 ${advCnt - 3}건` : '';
    const advText = advCnt ? ` 단계 이동 ${advCnt}건 (${advParts.join(', ')}${advMore}).` : '';
    text = `어제 영업활동은 ${cnt}건입니다`
      + (repLabel ? ` (${repLabel})` : '')
      + `. 접촉 고객: ${custLabel || '—'}.`
      + advText;
  }
  return {
    key: 'sales_activity', icon: '🤝', title: '어제 영업활동',
    count: cnt, advance_count: advCnt, customers: custLabel, reps: repLabel, advances, text,
  };
}

// ─────────────────────────────────────────────────────────────────────
// ③ 진행 중 포장 — 공용 stageCohorts.packing 재사용(WBR·포털 SLA 와 단일 기준).
//    포장출력 됐으나 포장작업지시서 스캔(완료) 전, 전환 전.
// ─────────────────────────────────────────────────────────────────────
async function sectionPacking(perm, allTeams) {
  // socio 는 visibleTeamIds 가 빈 배열이라 팀 필터가 걸리면 결과가 비어버린다.
  // 브리핑은 "디렉터와 같은 전사 뷰"를 공유하는 것이 목적이므로 allTeams 로 전체 코호트를 본다.
  const cohorts = await buildStageCohorts(perm, 'total', allTeams ? { allTeams: true } : {});
  const list = (cohorts.packing || []).map((r) => ({
    customer: r.customer_name || '—', amount: Math.round(n(r.amount)), total_qty: n(r.total_qty), sku_count: n(r.sku_count),
  }));
  const cnt = list.length;
  const amt = list.reduce((s, x) => s + x.amount, 0);
  const tqty = list.reduce((s, x) => s + x.total_qty, 0);
  // 금액 큰 순으로 상위 몇 건을 문장에 나열
  const top = list.slice().sort((a, b) => b.amount - a.amount).slice(0, 3);
  let text;
  if (!cnt) {
    text = '현재 진행 중인 포장은 없습니다.';
  } else {
    const parts = top.map((x) => `${x.customer} 오더 ${money(x.amount)}·${qty(x.total_qty)}개`);
    const more = cnt > top.length ? ` 외 ${cnt - top.length}건` : '';
    text = `현재 진행 중인 포장은 ${cnt}건입니다. ` + parts.join(' / ') + more
      + ` (합계 ${money(amt)} · ${qty(tqty)}개).`;
  }
  return { key: 'packing', icon: '📦', title: '진행 중 포장', count: cnt, total_mxn: amt, total_qty: tqty, items: list, text };
}

// ─────────────────────────────────────────────────────────────────────
// ④ 마케팅 일정 — 승인된 계획 중 향후 7일 내 행사 + 예정 집행 "세부 내역".
//    돈: 각 지급 라인마다 [언제·어느 활동·무슨 집행항목(업체)·지급구분·왜(목적)·얼마].
//    계층: 계획(활동) → 집행항목(장소/케이터링/판촉물…) → 지급라인(선지급/중도금/잔금/일시불).
// ─────────────────────────────────────────────────────────────────────
const MKT_KIND = { adv: '선지급금', mid: '중도금', fin: '잔금', one: '일시불' };
async function sectionMarketing(mxToday) {
  const to = shiftYmd(mxToday, 7);
  let plans = [];
  let lines = [];
  try {
    plans = (await query(
      `SELECT id, title, category, to_char(event_date,'YYYY-MM-DD') AS event_date
         FROM marketing_spend_plans
        WHERE status='approved' AND deleted_at IS NULL
          AND event_date IS NOT NULL AND event_date >= $1 AND event_date <= $2
        ORDER BY event_date`, [mxToday, to])).rows;

    // 향후 7일 예정 집행 라인(승인 계획) — 활동·집행항목·업체·목적·명목까지 조인
    const raw = (await query(
      `SELECT to_char(l.due_date,'YYYY-MM-DD') AS due_date, l.kind, l.amount, l.memo AS line_memo,
              p.id AS plan_id, p.title AS plan_title, p.category, p.purpose,
              i.name AS item_name, i.memo AS vendor
         FROM marketing_spend_lines l
         JOIN marketing_spend_plans p ON p.id=l.plan_id
         LEFT JOIN marketing_spend_items i ON i.id=l.item_id
        WHERE p.status='approved' AND p.deleted_at IS NULL
          AND l.due_date >= $1 AND l.due_date <= $2
        ORDER BY l.due_date, p.title, i.sort_order, l.sort_order, l.id`, [mxToday, to])).rows;

    // 대상(고객/불특정) — 등장한 계획들만 조회해 라벨 구성 (ANY 대신 정수 IN 리터럴 — pg-mem 호환)
    const planIds = [...new Set(raw.map((r) => Number(r.plan_id)).filter(Number.isInteger))];
    const targetMap = {};
    if (planIds.length) {
      const trows = (await query(
        `SELECT t.plan_id, t.is_general, c.name AS customer_name
           FROM marketing_spend_targets t
           LEFT JOIN customers c ON c.id=t.customer_id
          WHERE t.plan_id IN (${planIds.join(',')})`)).rows;
      for (const t of trows) {
        const pid = Number(t.plan_id);
        (targetMap[pid] = targetMap[pid] || []).push(t.is_general ? '불특정 다수' : (t.customer_name || '고객'));
      }
    }
    lines = raw.map((r) => ({
      due_date: r.due_date,
      plan_title: r.plan_title || '',
      category: r.category || null,
      item_name: r.item_name || '기본 집행',
      vendor: r.vendor || null,                 // 업체·비고
      kind: r.kind || 'one',
      kind_label: MKT_KIND[r.kind] || '일시불',
      amount: Math.round(n(r.amount)),
      purpose: r.purpose || null,               // 왜(목적)
      line_memo: r.line_memo || null,           // 명목
      targets: joinNames(targetMap[Number(r.plan_id)] || [], 4),
    }));
  } catch (_) { /* 0115/0116 미적용 시 안전 무시 */ }

  const evItems = plans.map((p) => ({ title: p.title, category: p.category || null, event_date: p.event_date }));
  const payAmt = lines.reduce((s, l) => s + l.amount, 0);
  const payCnt = lines.length;

  // 요약 문장 + "왜·어디에·얼마" 한 줄 요약(상위 몇 건). 상세는 lines 로 카드에 표기.
  let text;
  if (!evItems.length && !payCnt) {
    text = '향후 7일 내 예정된 마케팅 행사·집행은 없습니다.';
  } else {
    const evParts = evItems.slice(0, 3).map((p) => `${p.event_date} ${p.title}`);
    const evMore = evItems.length > 3 ? ` 외 ${evItems.length - 3}건` : '';
    const evText = evItems.length ? `예정 행사 ${evItems.length}건 — ` + evParts.join(' / ') + evMore + '. ' : '';
    const payText = payCnt
      ? `향후 7일 집행 예정액 ${money(payAmt)}(${payCnt}건). 세부: `
        + lines.slice(0, 3).map((l) =>
            `${l.due_date} ${l.plan_title}·${l.item_name} ${l.kind_label} ${money(l.amount)}`).join(' / ')
        + (payCnt > 3 ? ` 외 ${payCnt - 3}건` : '') + '.'
      : '예정 집행액은 없습니다.';
    text = evText + payText;
  }
  return {
    key: 'marketing', icon: '📣', title: '마케팅 일정',
    count: evItems.length, plan_amount: payAmt, plan_count: payCnt,
    items: evItems, lines, text,
  };
}

// ─────────────────────────────────────────────────────────────────────
// ⑤ 재무 현황 — 현재 현금(잔액 합) + 오늘 확정거래 순액(어제 대비 변동)
//                + 향후 7일 예정 지출(plan out) / 예정 수금(미수 인보이스 due).
//    잔액 공식은 /api/accounts 와 100% 동일: open_balance(USD는 오늘환율) + Σ actual·approved 의 amount_mxn.
//    (Phase 1 은 디렉터 전용 = 전 계좌 기준.)
// ─────────────────────────────────────────────────────────────────────
async function sectionFinance(mxToday) {
  const usd = (await getUsdMxnRate()).rate;
  const to7 = shiftYmd(mxToday, 7);

  const accs = (await query(
    `SELECT a.currency, a.open_balance,
            COALESCE((SELECT SUM(CASE WHEN t.direction='in' THEN t.amount_mxn ELSE -t.amount_mxn END)
                        FROM transactions t
                       WHERE t.account_id=a.id AND t.status='actual' AND t.approved=true AND t.deleted_at IS NULL),0) AS txn_mxn
       FROM accounts a
      WHERE a.deleted_at IS NULL AND a.disabled IS NOT TRUE`)).rows;
  let cashNow = 0;
  for (const a of accs) cashNow += n(a.open_balance) * (a.currency === 'USD' ? usd : 1) + n(a.txn_mxn);

  const dRow = (await query(
    `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount_mxn ELSE -amount_mxn END),0) AS net
       FROM transactions
      WHERE status='actual' AND approved=true AND deleted_at IS NULL AND txn_date=$1`, [mxToday])).rows[0];
  const deltaToday = n(dRow && dRow.net);

  const outRow = (await query(
    `SELECT COALESCE(SUM(amount_mxn),0) AS amt, COUNT(*) AS cnt
       FROM transactions
      WHERE status='plan' AND deleted_at IS NULL AND direction='out'
        AND txn_date >= $1 AND txn_date <= $2`, [mxToday, to7])).rows[0];
  const planOut = Math.round(n(outRow && outRow.amt));
  const planOutCnt = n(outRow && outRow.cnt);

  let arDue = 0, arCnt = 0;
  try {
    const arRow = (await query(
      `SELECT COALESCE(SUM(si.total_mxn - COALESCE(p.paid,0)),0) AS amt, COUNT(*) AS cnt
         FROM sales_invoices si
         LEFT JOIN (SELECT spa.invoice_id, SUM(spa.amount) AS paid
                      FROM sales_payment_allocations spa GROUP BY spa.invoice_id) p ON p.invoice_id=si.id
        WHERE si.deleted_at IS NULL AND si.status <> 'deleted'
          AND si.sat_no IS NOT NULL AND si.sat_no <> '' AND si.sat_no NOT LIKE 'TMP-%'
          AND si.due_date IS NOT NULL AND si.due_date >= $1 AND si.due_date <= $2
          AND COALESCE(p.paid,0) < si.total_mxn - 0.005`, [mxToday, to7])).rows[0];
    arDue = Math.round(n(arRow && arRow.amt)); arCnt = n(arRow && arRow.cnt);
  } catch (_) { /* 스키마 차이 시 안전 무시 */ }

  const dSign = deltaToday > 0 ? '+' : (deltaToday < 0 ? '−' : '');
  const deltaText = deltaToday === 0
    ? '오늘 확정된 현금 거래는 없습니다'
    : `오늘 확정 거래로 ${dSign}${money(Math.abs(deltaToday))} 변동`;
  const text = `${deltaText}. 현재 현금 잔액은 ${money(cashNow)}입니다. `
    + `향후 7일 예정 지출 ${money(planOut)}(${planOutCnt}건)`
    + (arCnt ? ` · 예정 수금 ${money(arDue)}(${arCnt}건)` : '') + '.';

  return {
    key: 'finance', icon: '💰', title: '재무 현황',
    cash_now: Math.round(cashNow), delta_today: Math.round(deltaToday),
    plan_out_7d: planOut, plan_out_count: planOutCnt,
    ar_due_7d: arDue, ar_due_count: arCnt, fx_rate: usd, text,
  };
}

export default async function dailyBriefingRoutes(app) {
  // GET /api/portal/daily-briefing — 디렉터 + (옵션 ON 시) socio. 읽기 전용.
  app.get('/api/portal/daily-briefing', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const view = await briefingViewer(perm);
    if (!view.allowed) {
      return { enabled: false, role: perm.role };
    }
    const now = new Date();
    const mxToday = mxTodayStr(now);
    const mxYesterday = shiftYmd(mxToday, -1);

    // 섹션은 서로 독립 — 하나가 실패해도 나머지는 나오도록 개별 방어.
    async function safe(fn, key, title, icon) {
      try { return await fn(); }
      catch (e) { return { key, icon, title, error: true, text: `${title} 정보를 불러오지 못했습니다.` }; }
    }
    const [schedule, quotes, salesActivity, packing, marketing, finance] = await Promise.all([
      safe(() => sectionSchedule(mxToday), 'schedule', '오늘의 일정', '📅'),
      safe(() => sectionQuotes(mxYesterday), 'quotes', '어제 견적', '📝'),
      safe(() => sectionSalesActivity(mxYesterday), 'sales_activity', '어제 영업활동', '🤝'),
      safe(() => sectionPacking(perm, perm.role !== 'director'), 'packing', '진행 중 포장', '📦'),
      safe(() => sectionMarketing(mxToday), 'marketing', '마케팅 일정', '📣'),
      safe(() => sectionFinance(mxToday), 'finance', '재무 현황', '💰'),
    ]);

    return {
      enabled: true,
      role: view.role,
      share_socio: view.share_socio,
      can_toggle: view.can_toggle,
      read_only: view.read_only,
      generated_at: now.toISOString(),
      mx_date: mxToday,
      mx_yesterday: mxYesterday,
      date_label: krDateLabel(mxToday),
      greeting: `${krDateLabel(mxToday)} · 오늘의 브리핑`,
      sections: [schedule, quotes, salesActivity, packing, marketing, finance],
    };
  });
}
