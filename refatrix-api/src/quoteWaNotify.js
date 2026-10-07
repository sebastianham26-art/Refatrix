// =====================================================================
// Refatrix ERP · quoteWaNotify.js — 견적·매출 추적: 신규 견적 WhatsApp 알림 (0256 · 2026-10-07 디렉터 지시)
//
//   보내는 내용: ① 지정된 받는 사람 ② 견적번호 ③ 고객이름 ④ SKU · 총수량 ⑤ 수주현황 · 견적액
//     수주현황 = 견적 목록과 같은 3분류(예약 확보 기준): 즉시매출가능 / 재고부족 / 개발필요
//     견적액   = IVA 제외(목표·이익과 같은 기준) + IVA 포함 병기. 수주현황 금액도 IVA 제외.
//
//   맨 아래(0257): 「당월 요약」 = 견적·매출 추적 상단 KPI 7칸(같은 함수 computeQuoteSummary).
//     당월 = 멕시코 날짜 기준 이번 달(견적일 기준) · IVA 제외 · 수신자 팀 범위가 있으면 그 팀만.
//     수신자별 month_summary: full(7칸) / no_profit(이익 2칸 제외) / off.
//
//   언제: 견적이 만들어지면 바로(kickQuoteNotify — 응답 뒤, 기다리지 않음) +
//         60초마다 놓친 건 줍기(runQuoteNotifyJob — 최근 24시간, 시도 3회까지).
//     · 대상 경로: 화면 견적 저장 · 견적 복제 · 포털(CRM) 견적요청. 가용재고 견적(pricelist)은 제외.
//     · 수신자 등록 이전에 만들어진 견적은 보내지 않는다(등록 순간 옛 견적이 몰려가지 않게).
//     · 팀 범위: 수신자의 team_ids 가 있으면 그 팀 고객의 견적만(고객 미지정 견적은 작성자 팀).
//
//   발송 규칙: 웹훅이 24시간 창이 닫힌 것을 알면 템플릿부터(QUOTE_WA_TEMPLATE → WHATSAPP_TEMPLATE),
//     아니면 텍스트 → 실패 시 템플릿 한 줄. 창 밖 실패(131047)는 웹훅이 원장을 다시 열어 재시도한다.
//   끄기: QUOTE_WA_ENABLED=0
// =====================================================================
import { query } from './db.js';
import { sendWaTo, waApiReady } from './waSend.js';
import { windowState } from './waWebhook.js';
import { computeQuoteSummary } from './quoteSummary.js';   // 0257 · 당월 요약(KPI 7칸)

export const MAX_ATTEMPTS = 3;
export const LOOKBACK_HOURS = 24;
export const STALE_CLAIM_MIN = 5;

let senderOverride = null;                     // 테스트용
export function setQuoteWaSender(fn) { senderOverride = fn || null; }
export const quoteWaEnabled = () => process.env.QUOTE_WA_ENABLED !== '0';
export const quoteWaTemplate = () => process.env.QUOTE_WA_TEMPLATE || process.env.WHATSAPP_TEMPLATE || null;
export const maskPhone = (p) => { const s = String(p || ''); return s ? s.slice(0, 3) + '****' + s.slice(-4) : null; };

const n = (v) => Number(v) || 0;
const money = (v) => '$' + n(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = (v) => n(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));

// 견적 1건 — 알림에 필요한 값만(목록 화면의 수주현황 3분류와 같은 식)
export async function loadQuoteForNotify(id, q = query) {
  const r = (await q(
    `SELECT q.id, q.quote_no, to_char(q.quote_date,'YYYY-MM-DD') AS quote_date, q.status, q.created_at, q.deleted_at,
            q.subtotal_mxn, q.total_mxn, q.total_qty, q.sku_count, q.customer_id, q.guest_name, q.memo,
            to_jsonb(q) ->> 'origin' AS origin, to_jsonb(q) ->> 'customer_po_no' AS customer_po_no,
            c.name AS customer_name, COALESCE(c.team_id, uc.team_id) AS team_id, t.name AS team_name,
            uc.name AS creator_name,
            cls.ok_cnt, cls.short_cnt, cls.dev_cnt, cls.ok_qty, cls.short_qty, cls.dev_qty, cls.ok_sub, cls.short_sub, cls.line_n
       FROM quotes q
       LEFT JOIN customers c ON c.id = q.customer_id
       LEFT JOIN users uc ON uc.id = q.created_by
       LEFT JOIN sales_teams t ON t.id = COALESCE(c.team_id, uc.team_id)
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE ql.product_id IS NOT NULL AND COALESCE(ql.reserved_qty,0) >= ql.qty)::int AS ok_cnt,
                COUNT(*) FILTER (WHERE ql.product_id IS NOT NULL AND COALESCE(ql.reserved_qty,0) <  ql.qty)::int AS short_cnt,
                COUNT(*) FILTER (WHERE ql.product_id IS NULL)::int AS dev_cnt,
                COALESCE(SUM(ql.qty) FILTER (WHERE ql.product_id IS NOT NULL AND COALESCE(ql.reserved_qty,0) >= ql.qty), 0) AS ok_qty,
                COALESCE(SUM(ql.qty) FILTER (WHERE ql.product_id IS NOT NULL AND COALESCE(ql.reserved_qty,0) <  ql.qty), 0) AS short_qty,
                COALESCE(SUM(ql.qty) FILTER (WHERE ql.product_id IS NULL), 0) AS dev_qty,
                COALESCE(SUM(LEAST(COALESCE(ql.reserved_qty,0), ql.qty)::numeric / NULLIF(ql.qty,0) * ql.line_subtotal)
                         FILTER (WHERE ql.product_id IS NOT NULL), 0) AS ok_sub,
                COALESCE(SUM(GREATEST(ql.qty - COALESCE(ql.reserved_qty,0), 0)::numeric / NULLIF(ql.qty,0) * ql.line_subtotal)
                         FILTER (WHERE ql.product_id IS NOT NULL), 0) AS short_sub,
                COUNT(*)::int AS line_n
           FROM quote_lines ql WHERE ql.quote_id = q.id
       ) cls ON TRUE
      WHERE q.id = $1`, [id])).rows[0];
  if (!r) return null;
  return {
    id: Number(r.id), quote_no: r.quote_no, quote_date: r.quote_date, status: r.status,
    created_at: r.created_at, deleted: !!r.deleted_at, origin: r.origin || null, customer_po_no: r.customer_po_no || null,
    customer_name: r.customer_id == null ? (r.guest_name || '불특정 고객') : r.customer_name,
    team_id: r.team_id != null ? Number(r.team_id) : null, team_name: r.team_name || null,
    creator_name: r.creator_name || null,
    subtotal: n(r.subtotal_mxn), total: n(r.total_mxn),
    // SKU = 서로 다른 줄 수(미등록 코드 줄 포함) · 총수량 = 모든 줄 수량
    sku: n(r.line_n) || n(r.sku_count),
    qty: n(r.ok_qty) + n(r.short_qty) + n(r.dev_qty) || n(r.total_qty),
    cls: { ok: n(r.ok_cnt), short: n(r.short_cnt), dev: n(r.dev_cnt),
      ok_qty: n(r.ok_qty), short_qty: n(r.short_qty), dev_qty: n(r.dev_qty),
      ok_sub: Math.round(n(r.ok_sub) * 100) / 100, short_sub: Math.round(n(r.short_sub) * 100) / 100 },
  };
}

const L = {
  ko: { title: '신규 견적', cust: '고객', team: '팀', by: '작성', po: '고객 PO', sku: 'SKU', qty: '총수량', ea: '개',
    st: '수주현황', ok: '즉시매출가능', short: '재고부족', dev: '개발필요', amt: '견적액', noIva: 'IVA 제외', iva: 'IVA 포함',
    crm: '포털 견적요청', head: 'Refatrix 신규견적', none: '품목 없음' },
  es: { title: 'Nueva cotización', cust: 'Cliente', team: 'Equipo', by: 'Elaboró', po: 'OC cliente', sku: 'SKU', qty: 'Piezas', ea: 'pzas',
    st: 'Estatus de pedido', ok: 'Disponible', short: 'Falta stock', dev: 'Por desarrollar', amt: 'Monto', noIva: 'sin IVA', iva: 'con IVA',
    crm: 'Solicitud del portal', head: 'Refatrix nueva cotización', none: 'sin partidas' },
};

export function buildQuoteText(qt, lang = 'ko') {
  const t = L[lang] || L.ko; const c = qt.cls;
  const lines = [`🧾 *${t.title}* · ${qt.quote_no}`];
  if (qt.origin === 'crm') lines.push(`🌐 ${t.crm}`);
  lines.push(`${t.cust}: *${qt.customer_name}*` + (qt.team_name ? ` (${qt.team_name})` : ''));
  if (qt.customer_po_no) lines.push(`${t.po}: ${qt.customer_po_no}`);
  lines.push(`${t.by}: ${qt.creator_name || '—'} · ${qt.quote_date}`);
  lines.push('');
  lines.push(`${t.sku} *${int(qt.sku)}* · ${t.qty} *${int(qt.qty)}* ${t.ea}`);
  lines.push('');
  lines.push(`*${t.st}* (${t.noIva})`);
  if (!qt.sku) lines.push(`  ${t.none}`);
  else {
    lines.push(`🟢 ${t.ok} ${c.ok} SKU · ${int(c.ok_qty)} ${t.ea} · ${money(c.ok_sub)}`);
    lines.push(`🟡 ${t.short} ${c.short} SKU · ${int(c.short_qty)} ${t.ea} · ${money(c.short_sub)}`);
    lines.push(`🟣 ${t.dev} ${c.dev} SKU · ${int(c.dev_qty)} ${t.ea}`);
  }
  lines.push('');
  lines.push(`💰 *${t.amt}* ${money(qt.subtotal)} (${t.noIva}) · ${money(qt.total)} (${t.iva})`);
  return lines.join('\n');
}

// 템플릿 폴백용 한 줄(줄바꿈 금지)
export function buildQuoteHeadline(qt, lang = 'ko') {
  const t = L[lang] || L.ko; const c = qt.cls;
  return (`[${t.head}] ${qt.quote_no} · ${qt.customer_name} · ${t.sku} ${int(qt.sku)} · ${t.qty} ${int(qt.qty)} · `
    + `${t.ok} ${c.ok} / ${t.short} ${c.short} / ${t.dev} ${c.dev} · ${t.amt} ${money(qt.subtotal)} (${t.noIva})`)
    .replace(/[\n\t]+/g, ' ').slice(0, 950);
}

// ───────── 0257 · 당월 요약(KPI 7칸) ─────────
export const SUMMARY_LEVELS = ['full', 'no_profit', 'off'];
export const levelOf = (r) => (SUMMARY_LEVELS.includes(r && r.month_summary) ? r.month_summary : 'full');
export function mxYm(nowMs = Date.now()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit' }).formatToParts(new Date(nowMs));
  return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}`;
}
const teamKey = (r) => {
  const ids = Array.isArray(r && r.team_ids) ? r.team_ids.map(Number).filter(Boolean).sort((a, b) => a - b) : [];
  return ids.length ? ids.join(',') : 'all';
};
// 같은 팀 범위의 수신자끼리는 한 번만 계산(caches = 한 번의 발송 묶음 안에서만 재사용)
export async function monthSummaryFor(rcpt, { ym = mxYm(), cache = null, q = query } = {}) {
  const key = `${ym}|${teamKey(rcpt)}`;
  if (cache && cache[key]) return cache[key];
  const ids = teamKey(rcpt) === 'all' ? null : teamKey(rcpt).split(',').map(Number);
  const sum = await computeQuoteSummary({ yms: [ym], scope: ids ? { teamIds: ids, guestByCreatorTeam: true } : null }, q);
  let teamNames = null;
  if (ids) teamNames = (await q(`SELECT name FROM sales_teams WHERE id = ANY($1::bigint[]) ORDER BY sort_order, id`, [ids])).rows.map((x) => x.name);
  const out = { ym, sum, teamNames };
  if (cache) cache[key] = out;
  return out;
}

const S = {
  ko: { head: (ym) => `${Number(ym.slice(5))}월 요약`, basis: '견적일 기준 · IVA 제외',
    q: '총 견적액', qs: (d) => `견적 ${d.n}건 · 미결 ${d.open} · 전환 ${d.converted} · 만료 ${d.expired}`,
    s: '실매출액', ss: (d) => `견적액 대비 ${d.rate == null ? '—' : d.rate + '%'} · 인보이스 ${d.invoices}건`,
    l: '재고부족 매출실기', ls: (d) => `전환 시 미확보 ${money(d.converted_amt)} · 만료 시 부족 ${money(d.expired_amt)}`
      + (n(d.open_short_amt) > 0 ? ` (+ 미결 견적 현재 부족 ${money(d.open_short_amt)} · ${int(d.open_short_qty)}개)` : ''),
    qq: '총 견적 수량', qqs: (d) => `견적 줄 ${int(d.lines)}개`,
    sq: '매출 수량', sqs: (sd, qd, ld) => `견적의 ${qd.qty > 0 ? Math.round(sd.qty / qd.qty * 1000) / 10 + '%' : '—'} · 부족 ${int(ld.sku)} SKU / ${int(ld.qty)}개`,
    gp: '매출총이익 실현', gps: (g) => `이익률 ${g.pct == null ? '—' : g.pct + '%'}`,
    gl: '재고부족 이익 실현불가', gls: (g) => `부족 매출 ${money(g.rev)} 기준` + (g.pct == null ? '' : ` · 이익률 ${g.pct}%`),
    est: (g) => [g.est ? `FOB추정 ${g.est}줄` : null, g.nocost ? `원가없음 ${g.nocost}줄 제외` : null].filter(Boolean).join(' · ') },
  es: { head: (ym) => `Resumen ${['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`,
    basis: 'por fecha de cotización · sin IVA',
    q: 'Monto cotizado', qs: (d) => `${d.n} cotizaciones · abiertas ${d.open} · convertidas ${d.converted} · vencidas ${d.expired}`,
    s: 'Venta real', ss: (d) => `${d.rate == null ? '—' : d.rate + '%'} de lo cotizado · ${d.invoices} facturas`,
    l: 'Venta perdida por falta de stock', ls: (d) => `al convertir ${money(d.converted_amt)} · al vencer ${money(d.expired_amt)}`
      + (n(d.open_short_amt) > 0 ? ` (+ faltante actual en abiertas ${money(d.open_short_amt)} · ${int(d.open_short_qty)} pzas)` : ''),
    qq: 'Cantidad cotizada', qqs: (d) => `${int(d.lines)} partidas`,
    sq: 'Cantidad vendida', sqs: (sd, qd, ld) => `${qd.qty > 0 ? Math.round(sd.qty / qd.qty * 1000) / 10 + '%' : '—'} de lo cotizado · faltante ${int(ld.sku)} SKU / ${int(ld.qty)} pzas`,
    gp: 'Utilidad bruta realizada', gps: (g) => `margen ${g.pct == null ? '—' : g.pct + '%'}`,
    gl: 'Utilidad no realizada (falta de stock)', gls: (g) => `sobre ${money(g.rev)} faltante` + (g.pct == null ? '' : ` · margen ${g.pct}%`),
    est: (g) => [g.est ? `FOB estimado ${g.est}` : null, g.nocost ? `sin costo ${g.nocost} excl.` : null].filter(Boolean).join(' · ') },
};

// 화면 카드 7칸과 같은 순서·같은 숫자. level='no_profit' 이면 ⑥⑦(원가) 빼고 5칸.
export function buildMonthSummaryText(ms, lang = 'ko', level = 'full') {
  if (!ms || level === 'off') return '';
  const t = S[lang] || S.ko; const d = ms.sum || {};
  const qd = d.quotes || {}, sd = d.sales || {}, ld = d.lost || {};
  const scope = ms.teamNames && ms.teamNames.length ? ` · ${ms.teamNames.join(', ')}` : '';
  const out = ['━━━━━━━━━━', `📊 *${t.head(ms.ym)}* (${t.basis}${scope})`];
  if (d.empty) return out.join('\n');
  out.push(`① ${t.q} *${money(qd.amt)}* — ${t.qs(qd)}`);
  out.push(`② ${t.s} *${money(sd.amt)}* — ${t.ss(sd)}`);
  out.push(`③ ${t.l} *${money(ld.amt)}* — ${t.ls(ld)}`);
  out.push(`④ ${t.qq} SKU *${int(qd.sku)}* · Pieza *${int(qd.qty)}* — ${t.qqs(qd)}`);
  out.push(`⑤ ${t.sq} SKU *${int(sd.sku)}* · Pieza *${int(sd.qty)}* — ${t.sqs(sd, qd, ld)}`);
  if (level === 'full' && d.gp) {
    const gs = d.gp.sales || {}, gl = d.gp.lost || {};
    const e1 = t.est(gs), e2 = t.est(gl);
    out.push(`⑥ ${t.gp} *${money(gs.gp)}* — ${t.gps(gs)}${e1 ? ' · ' + e1 : ''}`);
    out.push(`⑦ ${t.gl} *${money(gl.gp)}* — ${t.gls(gl)}${e2 ? ' · ' + e2 : ''}`);
  }
  return out.join('\n');
}

export function recipientCovers(rcpt, qt) {
  const ids = Array.isArray(rcpt.team_ids) ? rcpt.team_ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return true;
  return qt.team_id != null && ids.includes(Number(qt.team_id));
}
const notifiable = (qt) => qt && !qt.deleted && qt.status !== 'pricelist' && qt.status !== 'cancelled';

export async function activeRecipients(q = query) {
  return (await q(`SELECT id, name, phone, lang, team_ids, created_at, month_summary FROM quote_wa_recipients
                    WHERE active = true AND deleted_at IS NULL ORDER BY id`)).rows;
}

// 1명에게 1건 — 원장 잠금(claim) 후 발송. force = 성공 이력·시도 상한 무시(수동 재발송·시험).
export async function sendQuoteTo(qt, rcpt, { force = false, q = query, summaryCache = {} } = {}) {
  const claim = (await q(
    `INSERT INTO quote_wa_sends (quote_id, recipient_id, to_masked, status, attempts, claimed_at, updated_at)
     VALUES ($1, $2, $3, 'sending', 0, now(), now())
     ON CONFLICT (quote_id, recipient_id) DO UPDATE SET status = 'sending', claimed_at = now(), updated_at = now()
      WHERE ($4 OR (quote_wa_sends.sent_at IS NULL AND quote_wa_sends.attempts < $5))
        AND (quote_wa_sends.status IS DISTINCT FROM 'sending' OR quote_wa_sends.claimed_at < now() - ($6 || ' minutes')::interval)
     RETURNING id`,
    [qt.id, rcpt.id, maskPhone(rcpt.phone), !!force, MAX_ATTEMPTS, String(STALE_CLAIM_MIN)])).rows[0];
  if (!claim) return { skipped: 'claimed_or_done', recipient_id: Number(rcpt.id) };
  const lang = rcpt.lang === 'es' ? 'es' : 'ko';
  const ws = await windowState(rcpt.phone, q);
  // 0257 · 맨 아래 당월 요약 — 계산이 실패해도 견적 알림은 보낸다
  let text = buildQuoteText(qt, lang);
  const level = levelOf(rcpt);
  if (level !== 'off') {
    try { const ms = await monthSummaryFor(rcpt, { cache: summaryCache, q }); const add = buildMonthSummaryText(ms, lang, level); if (add) text += '\n\n' + add; }
    catch (_) { /* 요약 실패 — 본문만 */ }
  }
  const sender = senderOverride || sendWaTo;
  let res;
  try {
    res = await sender({ to: rcpt.phone, text: text.slice(0, 4000), headline: buildQuoteHeadline(qt, lang),
      templateName: quoteWaTemplate(), windowOpen: ws.open });
  } catch (e) { res = { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
  const status = res.ok ? (res.mode === 'template' ? 'sent_template' : 'sent_text') : 'failed';
  await q(
    `UPDATE quote_wa_sends SET status = $2, message_id = COALESCE($3, message_id), error = $4,
            attempts = attempts + 1, sent_at = CASE WHEN $5 THEN now() ELSE sent_at END, claimed_at = NULL, updated_at = now()
      WHERE id = $1`,
    [claim.id, status, res.message_id || null, res.ok ? (res.text_error || null) : (res.error || 'error'), !!res.ok]);
  return { recipient_id: Number(rcpt.id), ok: !!res.ok, status, error: res.ok ? null : res.error };
}

// 견적 1건 → 범위에 드는 모든 수신자
export async function notifyQuote(quoteId, { q = query, recipients = null } = {}) {
  if (!quoteWaEnabled()) return { skipped: 'disabled' };
  if (!waApiReady() && !senderOverride) return { skipped: 'wa_not_configured' };
  const qt = await loadQuoteForNotify(quoteId, q);
  if (!notifiable(qt)) return { skipped: 'not_notifiable' };
  const rc = recipients || await activeRecipients(q);
  const created = new Date(qt.created_at).getTime();
  const out = []; const summaryCache = {};
  for (const r of rc) {
    if (new Date(r.created_at).getTime() > created) continue;        // 등록 이전 견적은 보내지 않는다
    if (!recipientCovers(r, qt)) continue;
    out.push(await sendQuoteTo(qt, r, { q, summaryCache }));
  }
  return { quote_no: qt.quote_no, results: out };
}

// 응답을 돌려준 뒤 바로(기다리지 않음). 실패해도 60초 줍기가 다시 시도한다.
export function kickQuoteNotify(quoteId, app = null) {
  if (!quoteId || !quoteWaEnabled()) return;
  setTimeout(() => {
    notifyQuote(Number(quoteId)).catch((e) => app && app.log && app.log.warn({ err: String(e && e.message) }, '[quote-wa] kick failed'));
  }, 300);
}

// 놓친 건 줍기 — 최근 24시간 견적 중 아직 성공 기록이 없는 (견적 × 수신자)
export async function runQuoteNotifyJob({ q = query } = {}) {
  if (!quoteWaEnabled()) return { skipped: 'disabled' };
  if (!waApiReady() && !senderOverride) return { skipped: 'wa_not_configured' };
  const rc = await activeRecipients(q);
  if (!rc.length) return { skipped: 'no_recipients' };
  const ids = (await q(
    `SELECT q.id FROM quotes q
      WHERE q.deleted_at IS NULL AND q.status NOT IN ('pricelist','cancelled')
        AND q.created_at > now() - ($1 || ' hours')::interval
        AND q.created_at >= (SELECT min(created_at) FROM quote_wa_recipients WHERE active AND deleted_at IS NULL)
        AND EXISTS (SELECT 1 FROM quote_wa_recipients r
                     WHERE r.active AND r.deleted_at IS NULL AND r.created_at <= q.created_at
                       AND NOT EXISTS (SELECT 1 FROM quote_wa_sends s
                                        WHERE s.quote_id = q.id AND s.recipient_id = r.id
                                          AND (s.sent_at IS NOT NULL OR s.attempts >= $2)))
      ORDER BY q.created_at LIMIT 50`, [String(LOOKBACK_HOURS), MAX_ATTEMPTS])).rows;
  const done = [];
  for (const r of ids) done.push(await notifyQuote(Number(r.id), { q, recipients: rc }));
  return { checked: ids.length, done };
}

export function startQuoteNotifyWorker(app) {
  if (globalThis.__refatrixQuoteWaWorker) return;
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try { await runQuoteNotifyJob({}); }
    catch (e) { app && app.log && app.log.warn({ err: String(e && e.message) }, '[quote-wa] job failed'); }   // 0256 전이면 테이블 없음 — 조용히
    finally { busy = false; }
  };
  globalThis.__refatrixQuoteWaWorker = setInterval(() => { tick(); }, 60000);
  setTimeout(() => { tick(); }, 30000);
}
