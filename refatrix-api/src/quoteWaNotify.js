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
//   발송 규칙(2026-10-08 e · 0265): 기본 'rich' = 「헤더 이미지 + 상세」 한 통 — 창이 열려 있으면 이미지+캡션(무료),
//     닫혀 있으면 상세 템플릿 cotizacion_detalle(변수 16개) → 승인 전이면 nueva_cotizacion 한 줄. deliverQuote 참고.
//   예전 규칙(2026-10-08 b): 항상 승인 템플릿(디자인 · 헤더 이미지 포함) — 창이 열려 있으면 상세 텍스트를 이어서. 설정(0264)으로 「창 열리면 텍스트」도 가능 — deliverQuote 참고.
//     아니면 텍스트 → 실패 시 템플릿 한 줄. 창 밖 실패(131047)는 웹훅이 원장을 다시 열어 재시도한다.
//   끄기: QUOTE_WA_ENABLED=0
// =====================================================================
import { query } from './db.js';
import { sendWaText, sendWaTemplate, sendWaImageTemplate, sendWaImage, sendWaTemplateParams, uploadWaMedia, waApiReady } from './waSend.js';
import { windowState } from './waWebhook.js';
import { computeQuoteSummary } from './quoteSummary.js';   // 0257 · 당월 요약(KPI 7칸)

export const MAX_ATTEMPTS = 3;
export const LOOKBACK_HOURS = 24;
export const STALE_CLAIM_MIN = 5;

let senderOverride = null;                     // 테스트용
export function setQuoteWaSender(fn) { senderOverride = fn || null; }
export const quoteWaEnabled = () => process.env.QUOTE_WA_ENABLED !== '0';
// 2026-10-08 · 기본 = 승인받은 nueva_cotizacion (이름을 비워 둬도 이 템플릿으로 간다). 언어는 승인 때 고른 것과 같아야 한다.
export const quoteWaTemplate = () => process.env.QUOTE_WA_TEMPLATE || 'nueva_cotizacion';
export const quoteWaTemplateLang = () => process.env.QUOTE_WA_TEMPLATE_LANG || process.env.WHATSAPP_TEMPLATE_LANG || 'es_MX';
// 0265 · 상세 템플릿(헤더 이미지 + 여러 줄 본문 · 변수 16개). 한국어 수신자는 'ko' 번역을 먼저, 없으면(#132001) 스페인어로.
export const quoteWaDetailTemplate = () => (process.env.QUOTE_WA_DETAIL_TEMPLATE === '-' ? '' : (process.env.QUOTE_WA_DETAIL_TEMPLATE || 'cotizacion_detalle'));
export const DETAIL_PARAM_COUNT = 16;

// 2026-10-08 디렉터 점검 — 「템플릿이 승인됐는데도 창 밖 수신자가 못 받는다」
//   전에는 공용 sendWaTo 를 썼다: 24시간 창이 「닫힘」으로 확실할 때만 템플릿, 그 밖(모름 · 템플릿 실패)은 자유 텍스트.
//   Meta 는 창 밖 자유 텍스트도 일단 「접수」로 답하고 나중에 131047 로 버린다 → 원장엔 성공, 휴대폰엔 안 옴.
//   템플릿 실패 사유도 버려져 원인을 볼 수 없었다.
//   이제: 창이 「열림」으로 확실할 때만 자유 텍스트(무료 · 상세). 그 밖에는 항상 템플릿.
//     · 템플릿이 실패하면 사유를 남긴다. 창이 「닫힘」이면 텍스트는 보내지 않는다(어차피 안 감 → 실패로 두고 재시도).
//     · 창 상태를 모를 때(웹훅 미설정)만 마지막 수단으로 텍스트 — 이때도 템플릿 실패 사유를 함께 남긴다.
export const DEFAULT_QUOTE_API = {
  text: ({ to, text }) => sendWaText(text, to),
  template: (param, opts) => sendWaTemplate(param, opts),
  imageTemplate: (a) => sendWaImageTemplate(a),
  image: (a) => sendWaImage(a),                       // 0265 · 헤더 이미지 + 캡션(창 안 · 무료)
  paramsTemplate: (a) => sendWaTemplateParams(a),     // 0265 · 상세 템플릿(변수 여러 개)
};
// 2026-10-08 b · 「템플릿 디자인이 안 오고 텍스트로 온다」 → 발송 형식 설정(0264)
//   mode = 'template'(기본): 창 상태와 상관없이 승인 템플릿(디자인)으로. 창이 열려 있고 followDetail 이면 상세 텍스트를 이어서(무료).
//   mode = 'text_when_open': 창이 열려 있으면 상세 텍스트만(예전 방식), 아니면 템플릿.
//   headerMediaId: 템플릿 헤더가 이미지면 그 이미지(Meta media id) — 없이 보내면 #132012 로 실패한다.
// 0265 · mode = 'rich'(새 기본): 「헤더 이미지 + 상세」 한 통
//   창 열림  → 이미지(헤더) + caption(상세 · 당월 요약 ≤1024자) — 무료. 헤더 이미지가 없으면 상세 텍스트.
//   그 밖    → 상세 템플릿(detailName · detail = [{lang, params}] 순서대로 · #132001(번역 없음)이면 다음 언어)
//   상세 템플릿 실패 → 아래 기존 규칙(nueva_cotizacion 한 줄 + 헤더 이미지) — 실패 사유는 text_error 로 남긴다.
export async function deliverQuote({ to, text, headline, templateName = quoteWaTemplate(), templateLang = quoteWaTemplateLang(),
  windowOpen = null, mode = 'rich', followDetail = true, headerMediaId = null,
  caption = null, detailName = quoteWaDetailTemplate(), detail = [] }, api = DEFAULT_QUOTE_API) {
  if (windowOpen === true && mode === 'text_when_open') {
    const r = await api.text({ to, text });
    if (r.ok) return { ok: true, mode: 'text', message_id: r.message_id };
  }
  let pre = '';
  if (mode === 'rich') {
    if (windowOpen === true) {
      const r = headerMediaId ? await api.image({ to, mediaId: headerMediaId, caption: caption || text.slice(0, 1024) })
                              : await api.text({ to, text });
      if (r.ok) return { ok: true, mode: headerMediaId ? 'image' : 'text', message_id: r.message_id };
      pre = `${headerMediaId ? '이미지' : '텍스트'} 실패: ${r.error} · `;
    }
    if (detailName && Array.isArray(detail) && detail.length) {
      let dErr = '';
      for (const d of detail) {
        const t = await api.paramsTemplate({ to, name: detailName, lang: d.lang, mediaId: headerMediaId, params: d.params });
        if (t.ok) {
          const out = { ok: true, mode: 'detail_template', message_id: t.message_id };
          if (dErr || pre) out.text_error = `${pre}${dErr}`.replace(/ · $/, '') + ` — ${d.lang} 으로 보냄`;
          return out;
        }
        dErr += `상세 템플릿 ${detailName}(${d.lang}) 실패${t.code ? ' #' + t.code : ''}: ${t.error} · `;
        if (Number(t.code) === 132012 && !headerMediaId) dErr += '헤더가 이미지라면 알림 패널에 헤더 이미지를 올리세요 · ';
        if (Number(t.code) !== 132001) break;          // 번역 없음일 때만 다음 언어로
      }
      pre += dErr;
    }
  }
  let tErr = 'no_template';
  if (templateName) {
    const t = headerMediaId
      ? await api.imageTemplate({ to, mediaId: headerMediaId, param: headline, name: templateName, lang: templateLang })
      : await api.template(headline, { to, name: templateName, lang: templateLang });
    if (t.ok) {
      const out = { ok: true, mode: headerMediaId ? 'image_template' : 'template', message_id: t.message_id };
      if (windowOpen === true && mode === 'template' && followDetail) {   // 창이 열려 있으면 상세를 이어서(무료) — 실패해도 알림은 성공
        try { const d = await api.text({ to, text }); out.detail = d.ok ? 'sent' : `failed: ${d.error}`; } catch (e) { out.detail = 'failed'; }
      }
      if (pre) out.text_error = pre.replace(/ · $/, '') + ` — ${templateName} 한 줄로 보냄`;
      return out;
    }
    tErr = pre + `템플릿 ${templateName}(${templateLang}) 실패${t.code ? ' #' + t.code : ''}: ${t.error}`;
    if (Number(t.code) === 132012 && !headerMediaId) tErr += ' — 템플릿 헤더가 이미지라면 알림 패널 「템플릿 헤더 이미지」에 이미지를 올리세요';
  }
  if (windowOpen === true || windowOpen === null) {
    const r = await api.text({ to, text });
    if (r.ok) return { ok: true, mode: 'text', message_id: r.message_id,
      text_error: `${tErr} — 텍스트로 보냄${windowOpen === null ? '(24시간 창 밖이면 도착 안 함)' : ''}` };
    return { ok: false, error: `${tErr} / 텍스트: ${r.error}` };
  }
  return { ok: false, error: tErr };
}

// ── 발송 형식 · 헤더 이미지 (0264) ──
export const QUOTE_WA_MODES = ['rich', 'template', 'text_when_open'];
const MEDIA_FRESH_DAYS = 25;
let uploadOverride = null;
export function setQuoteWaUpload(fn) { uploadOverride = fn || null; }
export async function loadQuoteWaSettings(q = query) {
  try {
    const r = (await q(`SELECT send_mode, follow_detail, header_mime, header_name, octet_length(header_image) AS header_bytes,
                               media_id, media_at, updated_at FROM quote_wa_settings WHERE id = 1`)).rows[0];
    if (!r) return { send_mode: 'rich', follow_detail: true, has_header: false };
    return { send_mode: QUOTE_WA_MODES.includes(r.send_mode) ? r.send_mode : 'rich', follow_detail: r.follow_detail !== false,
      has_header: Number(r.header_bytes) > 0, header_name: r.header_name || null, header_mime: r.header_mime || null,
      header_bytes: Number(r.header_bytes) || 0, media_id: r.media_id || null, media_at: r.media_at || null, updated_at: r.updated_at };
  } catch { return { send_mode: 'rich', follow_detail: true, has_header: false }; }   // 0264 전
}
// 헤더 이미지의 Meta media id — 25일 지나면 다시 올린다
export async function ensureHeaderMedia(set, q = query) {
  if (!set || !set.has_header) return { ok: true, id: null };
  if (set.media_id && set.media_at && Date.now() - new Date(set.media_at).getTime() < MEDIA_FRESH_DAYS * 86400000) return { ok: true, id: set.media_id };
  const img = (await q(`SELECT header_image, header_mime, header_name FROM quote_wa_settings WHERE id = 1`)).rows[0];
  if (!img || !img.header_image) return { ok: true, id: null };
  const up = await (uploadOverride || uploadWaMedia)(img.header_image, { mime: img.header_mime || 'image/jpeg', filename: img.header_name || 'nueva_cotizacion.jpg' });
  if (!up.ok) return { ok: false, error: up.error };
  await q(`UPDATE quote_wa_settings SET media_id = $1, media_at = now() WHERE id = 1`, [up.id]);
  set.media_id = up.id; set.media_at = new Date();
  return { ok: true, id: up.id };
}
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
  if (ids) {
    teamNames = (await q(`SELECT name FROM sales_teams WHERE id = ANY($1::bigint[]) ORDER BY sort_order, id`, [ids])).rows.map((x) => x.name);
    // 2026-10-08 e · 모든 팀을 고른 수신자는 팀 이름을 줄줄이 붙이지 않는다(= 전사)
    const all = Number((await q(`SELECT count(*)::int AS n FROM sales_teams`)).rows[0].n) || 0;
    if (all && teamNames.length >= all) teamNames = null;
  }
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
// compact = 「 — 」 뒤 세부를 뺀 짧은 꼴(이미지 캡션 1024자 안에 넣을 때)
export function buildMonthSummaryText(ms, lang = 'ko', level = 'full', { compact = false } = {}) {
  if (!ms || level === 'off') return '';
  const t = S[lang] || S.ko; const d = ms.sum || {};
  const qd = d.quotes || {}, sd = d.sales || {}, ld = d.lost || {};
  const tn = ms.teamNames || [];
  const scope = !tn.length ? '' : (tn.length > 3 ? ` · ${tn.length}${lang === 'es' ? ' equipos' : '개 팀'}` : ` · ${tn.join(', ')}`);
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
  return (compact ? out.map((x) => x.replace(/ — .*$/, '')) : out).join('\n');
}

// ───────── 0265 · 「헤더 이미지 + 상세」 ─────────
// 이미지 캡션(≤1024자): 견적 상세 + 당월 요약. 넘치면 요약 세부를 빼고, 그래도 넘치면 자른다.
export const CAPTION_MAX = 1024;
export function buildQuoteCaption(qt, ms, lang = 'ko', level = 'full') {
  const body = buildQuoteText(qt, lang);
  const full = buildMonthSummaryText(ms, lang, level);
  let c = full ? `${body}\n\n${full}` : body;
  if (c.length > CAPTION_MAX && full) c = `${body}\n\n${buildMonthSummaryText(ms, lang, level, { compact: true })}`;
  return c.length > CAPTION_MAX ? c.slice(0, CAPTION_MAX - 1) + '…' : c;
}
// 상세 템플릿 변수 16개 — 템플릿 본문(고정 글자)과 같은 순서. 값에 줄바꿈 없음 · 빈 값은 「—」.
//   {{1}} 견적번호 {{2}} 고객 {{3}} 작성 {{4}} SKU {{5}} 총수량 {{6}}~{{8}} 수주현황 3분류 {{9}} 견적액
//   {{10}}~{{16}} 당월 요약 ①~⑦ (level no_profit → ⑥⑦ 「—」 · off/계산 실패 → 전부 「—」)
export function buildDetailParams(qt, ms, lang = 'ko', level = 'full') {
  const t = L[lang] || L.ko; const c = qt.cls; const ko = lang !== 'es';
  const dash = '—';
  const p = [
    `${qt.quote_no}${qt.origin === 'crm' ? ` (${t.crm})` : ''}`,
    `${qt.customer_name}${qt.team_name ? ` (${qt.team_name})` : ''}${qt.customer_po_no ? ` · ${t.po} ${qt.customer_po_no}` : ''}`,
    `${qt.creator_name || dash} · ${qt.quote_date}`,
    int(qt.sku), int(qt.qty),
    `${c.ok} SKU · ${int(c.ok_qty)} ${t.ea} · ${money(c.ok_sub)}`,
    `${c.short} SKU · ${int(c.short_qty)} ${t.ea} · ${money(c.short_sub)}`,
    `${c.dev} SKU · ${int(c.dev_qty)} ${t.ea}`,
    `${money(qt.subtotal)} (${t.noIva}) · ${money(qt.total)} (${t.iva})`,
  ];
  const d = (ms && ms.sum) || null;
  if (!d || level === 'off') { for (let i = 0; i < 7; i++) p.push(dash); return p; }
  const qd = d.quotes || {}, sd = d.sales || {}, ld = d.lost || {};
  const ea = t.ea;
  p.push(`${money(qd.amt)} · ${ko ? `견적 ${n(qd.n)}건` : `${n(qd.n)} cotizaciones`}`);
  p.push(`${money(sd.amt)} · ${ko ? '견적 대비' : 'de lo cotizado'} ${sd.rate == null ? dash : sd.rate + '%'}`);
  p.push(money(ld.amt));
  p.push(`SKU ${int(qd.sku)} · ${int(qd.qty)} ${ea}`);
  p.push(`SKU ${int(sd.sku)} · ${int(sd.qty)} ${ea}`);
  if (level === 'full' && d.gp) {
    const gs = d.gp.sales || {}, gl = d.gp.lost || {};
    p.push(`${money(gs.gp)} · ${ko ? '이익률' : 'margen'} ${gs.pct == null ? dash : gs.pct + '%'}`);
    p.push(money(gl.gp));
  } else { p.push(dash); p.push(dash); }
  return p;
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
  let ms = null;
  if (level !== 'off') {
    try { ms = await monthSummaryFor(rcpt, { cache: summaryCache, q }); const add = buildMonthSummaryText(ms, lang, level); if (add) text += '\n\n' + add; }
    catch (_) { ms = null; /* 요약 실패 — 본문만 */ }
  }
  // 0265 · 「헤더 이미지 + 상세」 — 캡션과 상세 템플릿 변수(수신자 언어 먼저, 그다음 다른 언어)
  const caption = buildQuoteCaption(qt, ms, lang, level);
  const detail = lang === 'ko'
    ? [{ lang: 'ko', params: buildDetailParams(qt, ms, 'ko', level) }, { lang: quoteWaTemplateLang(), params: buildDetailParams(qt, ms, 'es', level) }]
    : [{ lang: quoteWaTemplateLang(), params: buildDetailParams(qt, ms, 'es', level) }];
  const sender = senderOverride || deliverQuote;
  // 0264 · 발송 형식 · 헤더 이미지 — 한 번의 발송 묶음 안에서는 한 번만 읽고 한 번만 올린다
  if (!summaryCache.__set) summaryCache.__set = await loadQuoteWaSettings(q);
  const set = summaryCache.__set;
  let headerMediaId = null;
  if (set.has_header) {
    if (!summaryCache.__media) summaryCache.__media = await ensureHeaderMedia(set, q);
    headerMediaId = summaryCache.__media.ok ? summaryCache.__media.id : null;
  }
  let res;
  try {
    res = await sender({ to: rcpt.phone, text: text.slice(0, 4000), headline: buildQuoteHeadline(qt, lang),
      templateName: quoteWaTemplate(), templateLang: quoteWaTemplateLang(), windowOpen: ws.open,
      mode: set.send_mode, followDetail: set.follow_detail, headerMediaId,
      caption, detailName: quoteWaDetailTemplate(), detail });
    if (set.has_header && !headerMediaId && res && res.ok) res.text_error = `헤더 이미지 업로드 실패: ${(summaryCache.__media || {}).error || '?'}`;
  } catch (e) { res = { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
  const STATUS = { template: 'sent_template', image_template: 'sent_template', detail_template: 'sent_detail', image: 'sent_image', text: 'sent_text' };
  const status = res.ok ? (STATUS[res.mode] || 'sent_text') : 'failed';
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
