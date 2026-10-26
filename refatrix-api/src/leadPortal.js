// =====================================================================
// Refatrix ERP · leadPortal.js — Meta 광고 문의 → refaccionaria 고객 포털 (0297 · 2026-10-26 디렉터 지시)
//
//   「ERP 주소는 공개하지 않고, 우리 refaccionaria 고객에게 Meta 광고 문의를 보여 줘서 우리 부품을 팔게 한다」
//
//   고객 화면 = REFATRIX Platform(Netlify) leads.html — 브라우저는 같은 사이트의 /lp-api/* 만 부른다.
//   Netlify(_redirects, 200 proxy)가 그 요청을 여기 /api/lead-portal/* 로 넘기므로 ERP · Railway 주소는 브라우저에 안 나온다.
//
//   ── 디렉터 결정 (2026-10-26) ──
//     · 접속코드는 고객별로 디렉터만 발급 · 통제. 열람 기한 = 디렉터가 **만료일을 직접 입력**(기준표 자동 계산 없음).
//       기준 금액 · 조건 메모는 기록용, 발급 화면에 그 고객 ERP 매출(30일 · 3개월 · 12개월, IVA 제외)을 참고로 보여 준다.
//     · 열람 범위: 지금은 전체 문의. 코드별로 주(州)를 골라 제한할 수 있게 칸만 둔다(scope_states).
//     · 연락처(이름 · 전화)는 「Ver contacto」를 눌러야 나오고, 그때마다 ERP 에 기록(같은 고객 × 같은 문의는 한 줄).
//     · 부품번호 · Refatrix **정확한 가용수량**(현재고 − 다른 견적 예약) · 운송중 수량/ETA · 고객 할인가(IVA 별도)를 보여 준다.
//     · 「Mi stock」(고객 매장 재고) = 고객이 포털에서, 담당 영업사원 · 디렉터가 ERP 에서 고친다. 최근 값 + 입력자 · 날짜, 이력.
//       최근 12개월 우리에게 산 수량(자동 · 참고)도 함께.
//     · 주문 → 그 고객 이름의 ERP 견적(초안) — CRM 견적요청과 같은 조립기(할인율 · 재고 예약 · 부족분 · 개발요청 대장 ·
//       신규견적 WhatsApp 알림). 담당 영업사원이 확인 후 확정.
//
//   ── 고객에게 보내지 않는 것 ──
//     대화 원문 · 우리 직원 답변 · 내부 메모 · 진행 상태 · 다른 refaccionaria 의 열람/주문 · 원가 · 다른 고객 이름.
//
//   ── 보안 ──
//     · 코드 RFX-XXXX-XXXX(31자 알파벳 8자리 ≈ 40bit) · DB 에는 sha256 해시와 끝 4자리만
//     · 토큰 {sub:'lp:<id>', typ:'lead_portal', tv} — authGuard 가 typ 이 붙은 토큰을 **ERP API 전부 401** 로 막는다
//     · 요청마다 코드 상태를 다시 읽는다 — 정지 · 기한 경과 · 재발급 · 삭제는 **다음 요청부터 즉시** 막힌다
//     · 틀린 코드: 같은 IP 8회 → 15분 잠금(429)
// =====================================================================
import crypto from 'node:crypto';
import { query, withTx } from './db.js';
import { logEvent } from './audit.js';
import { authGuard, requirePageAny, requirePageEditAny } from './middleware/authGuard.js';
import { visibleTeamIds } from './teams.js';
import { computeQuoteLine, computeQuoteTotals } from './quotes.js';
import { buildLines, assignReservations, stampLineMeta } from './quoteBuild.js';
import { reserveExpiresAt } from './quoteExpiry.js';
import { syncQuoteShortages } from './quoteShortage.js';
import { recordQuoteDevDemand } from './quoteDevDemand.js';
import { kickQuoteNotify } from './quoteWaNotify.js';
import { resolveSeller, exclusivityReady } from './exclusivity.js';
import { META_STATES } from './metaLeadExtract.js';

export const LP_TYP = 'lead_portal';
export const LP_BUILD = 'lp-1026b';
const TOKEN_TTL = '7d';
const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';           // 0 · O · 1 · I · L 없음(전화로 불러도 헷갈리지 않게)
const MAX_FAIL = 8;
const LOCK_MS = 15 * 60 * 1000;
const MAX_LEADS = 1000;
const MAX_ORDER_LINES = 60;
const MAX_QTY = 9999;
// 「제품·마케팅」 그룹 화면 권한키 — metaLeadsRoutes.js PM_KEYS 와 같은 목록(순환 import 를 피해 여기 둔다)
const PM_KEYS = ['products', 'marketing', 'pricemaster', 'devrequest', 'quote', 'sales'];

const idOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const num = (v) => (v == null || v === '' ? null : Number(v));
const ymd = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(String(s) + 'T00:00:00Z')) ? String(s) : null);
const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t ? t.slice(0, n) : null; };

// ── 코드 ───────────────────────────────────────────────────────────
export function newCode(rand = crypto.randomBytes) {
  const b = rand(8); let s = '';
  for (let i = 0; i < 8; i++) s += ALPHA[b[i] % ALPHA.length];
  return 'RFX-' + s.slice(0, 4) + '-' + s.slice(4);
}
// 사용자가 친 코드 → 비교용(대문자 · 영숫자만 · 앞 RFX 생략 가능)
export function normCode(v) {
  let s = String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('RFX')) s = s.slice(3);
  return /^[A-Z0-9]{8}$/.test(s) ? s : null;
}
export const codeHash = (norm) => crypto.createHash('sha256').update('lp:' + norm).digest('hex');

// ── 포털 준비 여부(마이그레이션 0297 전이면 포털은 503, 기존 화면은 그대로) ──
let ready = false; let probe = 0;
export async function portalReady() {
  if (ready) return true;
  if (Date.now() - probe < 30000) return false;
  probe = Date.now();
  try { ready = (await query(`SELECT 1 FROM information_schema.tables WHERE table_name='lead_portal_codes'`)).rows.length > 0; }
  catch (_) { ready = false; }
  return ready;
}
export function setPortalReady(v) { ready = !!v; probe = Date.now(); }

// ── 상태(목록 · 고객 화면 공통) ──────────────────────────────────────
//   today = 멕시코시티 날짜. 만료일 당일까지 열람.
export function codeState(row, todayYmd) {
  if (!row || row.deleted_at) return 'deleted';
  if (row.active === false) return 'paused';
  const exp = typeof row.expires_on === 'string' ? row.expires_on.slice(0, 10) : row.expires_on;
  if (exp < todayYmd) return 'expired';
  const days = daysBetween(todayYmd, exp);
  return days <= 7 ? 'soon' : 'active';
}
export function daysBetween(a, b) {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);
}
export function todayMx(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(now);
}
const fmtDmy = (s) => (s ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '');

// 고객 안내문(스페인어) — 발급 · 재발급 직후 한 번만(코드 전체가 들어 있다)
export function inviteText({ customerName, code, expiresOn, url }) {
  return [
    `Hola, ${customerName} 👋`,
    'Ya tienes acceso a las solicitudes de clientes que llegan por nuestros anuncios en Facebook, Instagram y WhatsApp.',
    '',
    `🔗 ${url}`,
    `🔑 Código: ${code}`,
    `📅 Vigente hasta: ${fmtDmy(expiresOn)}`,
    '',
    'El código es personal: no lo compartas. Cada vez que veas un contacto queda registrado.',
    'Ofrece piezas CTR a estos clientes y haz tu pedido desde la misma página.',
  ].join('\n');
}
export const portalUrl = () => process.env.LEAD_PORTAL_URL || 'https://refatrix-platform.netlify.app/leads';

// ── 2026-10-26 디렉터 지시: ERP 화면 · CRM 이 아닌 곳(= Meta 광고 문의 포털)에서 온 견적은 「FB」로 시작 ──
//   FB-YYYY-#### (연도별 일련번호, ERP Q-YYYY-#### 와 같은 모양 · 따로 센다)
//   같은 순간 두 주문이 같은 번호를 잡지 않도록 트랜잭션 잠금(pg_advisory_xact_lock) 안에서 최대값 + 1.
export const FB_PREFIX = 'FB';
export function formatFbQuoteNo(year, seq) { return `${FB_PREFIX}-${year}-${String(seq).padStart(4, '0')}`; }
export async function nextFbQuoteNo(c, year) {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('lead_portal_fb_quote_no'))`);
  const r = (await c.query(
    `SELECT COALESCE(MAX((regexp_match(quote_no, '^FB-[0-9]{4}-([0-9]+)$'))[1]::int), 0) AS n
       FROM quotes WHERE quote_no LIKE $1`, [`${FB_PREFIX}-${year}-%`])).rows[0];
  return formatFbQuoteNo(year, (Number(r.n) || 0) + 1);
}

// ── 마스킹 ─────────────────────────────────────────────────────────
export function maskName(n) {
  const s = String(n || '').trim();
  if (!s) return null;
  return s.split(/\s+/).slice(0, 2).map((w) => w[0] + '••••').join(' ');
}
export function maskPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length < 6) return null;
  const local = d.length > 10 ? d.slice(-10) : d;
  return local.slice(0, 2) + ' •••• ••' + local.slice(-2);
}
// 문의의 전화(사람 > AI > 규칙, WhatsApp 은 번호 자체가 연락처)
const PHONE_EXPR = `COALESCE(t.m_phone, t.ai_phone, t.a_phone, CASE WHEN t.platform='whatsapp' AND t.user_id ~ '^[0-9]{10,13}$' THEN t.user_id END)`;
const STATE_EXPR = `COALESCE(t.m_state, t.ai_state, t.a_state)`;

// 문의 → 고객 화면용(연락처 · 원문 · 상태 · 메모 제외)
export function shapeLead(r) {
  const items = Array.isArray(r.items) ? r.items : [];
  const seen = new Set(); const parts = []; const open = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (it.status === 'ok' && it.code) {
      if (seen.has(it.code)) { const p = parts.find((x) => x.code === it.code); if (p && it.qty) p.qty = Math.max(p.qty || 0, Number(it.qty) || 0); continue; }
      seen.add(it.code);
      parts.push({ code: String(it.code), qty: Math.max(1, Math.min(MAX_QTY, Math.round(Number(it.qty) || 1))), veh: clip(it.veh, 60) });
    } else if (it.pieza) {
      const k = clip(it.pieza, 60);
      if (k && !open.includes(k)) open.push(k);
    }
  }
  const tipo = clip(r.tipo, 40);
  return {
    id: Number(r.id), platform: r.platform, first_mx: r.first_mx || null, last_mx: r.last_mx || null,
    state: r.state || null, city: r.city || null, tipo,
    vehicles: clip(r.vehicles, 160), parts_text: clip(r.parts, 200), summary: clip(r.summary, 400),
    parts, open_parts: open.slice(0, 6),
    name_masked: maskName(r.name) || (r.username ? '@' + String(r.username).slice(0, 1) + '••••' : null),
    phone_masked: maskPhone(r.phone), has_phone: !!maskPhone(r.phone),
    revealed: !!r.revealed,
  };
}

// 부품 정보 — 가용(현재고 − 살아 있는 다른 견적 예약) · 운송중 · 고객가 · 12개월 구매 · 매장 재고
export async function productInfo(customerId, discount, codes, exec = query) {
  const out = {};
  const list = [...new Set((codes || []).filter(Boolean).map(String))];
  if (!list.length) return out;
  const rows = (await exec(
    `SELECT p.id, p.code, p.name, p.list_price, p.is_active, p.stock_qty,
            COALESCE(inc.incoming_qty,0) AS incoming_qty, inc.incoming_eta::text AS incoming_eta,
            COALESCE((SELECT SUM(ql.reserved_qty) FROM quote_lines ql JOIN quotes q ON q.id = ql.quote_id
                       WHERE ql.product_id = p.id AND q.status IN ('draft','confirmed') AND q.deleted_at IS NULL
                         AND (q.reserve_expires_at > now() OR q.packing_printed_at IS NOT NULL)),0) AS reserved
       FROM products p LEFT JOIN v_incoming_stock inc ON inc.product_id = p.id
      WHERE p.code = ANY($1::text[]) AND p.deleted_at IS NULL`, [list])).rows;
  const ids = rows.map((r) => Number(r.id));
  const bought = {}; const shelf = {};
  if (ids.length) {
    for (const b of (await exec(
      `SELECT sil.product_id, SUM(sil.qty) AS qty, to_char(MAX(si.inv_date),'YYYY-MM-DD') AS last
         FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id = sil.invoice_id
        WHERE si.customer_id = $1 AND si.status = 'posted' AND si.deleted_at IS NULL
          AND si.inv_date >= CURRENT_DATE - 365 AND sil.product_id = ANY($2::bigint[])
        GROUP BY sil.product_id`, [customerId, ids])).rows) bought[Number(b.product_id)] = { qty: Number(b.qty) || 0, last: b.last };
    for (const s of (await exec(
      `SELECT product_id, qty, src, to_char(updated_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD') AS at
         FROM customer_shelf_stock WHERE customer_id = $1 AND product_id = ANY($2::bigint[])`, [customerId, ids])).rows) {
      shelf[Number(s.product_id)] = { qty: Number(s.qty), src: s.src, at: s.at };
    }
  }
  for (const r of rows) {
    const pid = Number(r.id);
    const stock = r.stock_qty == null ? 0 : Number(r.stock_qty);
    const price = computeQuoteLine({ listPrice: r.list_price, discountRate: discount, qty: 1, ivaRate: 16 }).finalPrice;
    out[r.code] = {
      code: r.code, name: r.name || '', active: r.is_active !== false,
      avail: Math.max(0, stock - (Number(r.reserved) || 0)),
      incoming: Number(r.incoming_qty) || 0, eta: r.incoming_eta ? String(r.incoming_eta).slice(0, 10) : null,
      price, bought12: bought[pid] ? bought[pid].qty : 0, bought_last: bought[pid] ? bought[pid].last : null,
      shelf: shelf[pid] ? shelf[pid].qty : null, shelf_src: shelf[pid] ? shelf[pid].src : null, shelf_at: shelf[pid] ? shelf[pid].at : null,
    };
  }
  return out;
}

// 고객 매장 재고 저장(고객 · 직원 공통) — qty null = 지움. 이력 한 줄.
export async function saveShelf(c, { customerId, productId, qty, src, userId = null, codeId = null }) {
  const old = (await c.query(`SELECT qty FROM customer_shelf_stock WHERE customer_id=$1 AND product_id=$2 FOR UPDATE`, [customerId, productId])).rows[0];
  const oldQty = old ? Number(old.qty) : null;
  if (qty == null) {
    if (!old) return { changed: false, qty: null };
    await c.query(`DELETE FROM customer_shelf_stock WHERE customer_id=$1 AND product_id=$2`, [customerId, productId]);
  } else {
    await c.query(
      `INSERT INTO customer_shelf_stock (customer_id, product_id, qty, src, user_id, code_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (customer_id, product_id) DO UPDATE SET qty=EXCLUDED.qty, src=EXCLUDED.src, user_id=EXCLUDED.user_id, code_id=EXCLUDED.code_id, updated_at=now()`,
      [customerId, productId, qty, src, userId, codeId]);
  }
  await c.query(
    `INSERT INTO customer_shelf_stock_log (customer_id, product_id, old_qty, new_qty, src, user_id, code_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [customerId, productId, oldQty, qty, src, userId, codeId]);
  return { changed: true, qty, old: oldQty };
}
export function parseQty(v) {
  if (v === null || v === undefined || v === '') return { ok: true, qty: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 999999 || Math.round(n) !== n) return { ok: false };
  return { ok: true, qty: n };
}

// 0297 · Meta 문의 목록(ERP)에 「공개된 곳」 — 고객 이름들
export async function revealedMap(threadIds) {
  const m = new Map();
  if (!threadIds || !threadIds.length || !(await portalReady())) return m;
  try {
    for (const r of (await query(
      `SELECT r.thread_id, string_agg(c.name, ' · ' ORDER BY r.first_at) AS names
         FROM lead_portal_reveals r JOIN customers c ON c.id = r.customer_id
        WHERE r.thread_id = ANY($1::bigint[]) GROUP BY r.thread_id`, [threadIds])).rows) m.set(Number(r.thread_id), r.names);
  } catch (_) { /* 표 없음 등 — 목록은 그대로 */ }
  return m;
}

// ── 틀린 코드 잠금(IP) ─────────────────────────────────────────────
const fails = new Map();
export function clientIp(req) {
  return String(req.headers['x-nf-client-connection-ip'] || req.ip || '').split(',')[0].trim() || '?';
}
function locked(ip, now = Date.now()) {
  const f = fails.get(ip);
  if (!f) return false;
  if (f.until && f.until > now) return true;
  if (f.first + LOCK_MS < now) { fails.delete(ip); return false; }
  return false;
}
function failOnce(ip, now = Date.now()) {
  const f = fails.get(ip) && fails.get(ip).first + LOCK_MS > now ? fails.get(ip) : { n: 0, first: now, until: 0 };
  f.n += 1; if (f.n >= MAX_FAIL) f.until = now + LOCK_MS;
  fails.set(ip, f);
  if (fails.size > 5000) { for (const [k, v] of fails) if (v.first + LOCK_MS < now && (!v.until || v.until < now)) fails.delete(k); }
}
export function resetFails() { fails.clear(); }

// ── 직원 쪽: 이 고객을 볼 수 있나(디렉터 · 영업지원 = 전체, 영업 = 담당 · 팀) ──
async function customerVisible(perm, customerId) {
  const c = (await query(`SELECT id, owner_id, team_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [customerId])).rows[0];
  if (!c) return null;
  const vis = visibleTeamIds(perm);
  if (vis === null) return c;
  if (c.owner_id != null && Number(c.owner_id) === Number(perm.userId)) return c;
  if (c.team_id != null && vis.map(Number).includes(Number(c.team_id))) return c;
  return false;
}

export default async function leadPortalRoutes(app) {
  const need = async (reply) => {
    if (await portalReady()) return true;
    reply.code(503).send({ error: 'migration_required', note: '0297_lead_portal 마이그레이션이 필요합니다(npm run migrate).' });
    return false;
  };

  // ════════════════════════════════════════════════════════════════
  //  고객 포털 (Netlify /lp-api/* → /api/lead-portal/*) — 스페인어 오류코드
  // ════════════════════════════════════════════════════════════════
  async function loadCode(id) {
    return (await query(
      `SELECT k.*, to_char(k.expires_on,'YYYY-MM-DD') AS expires_ymd, c.name AS customer_name, c.code AS customer_code,
              c.discount, c.owner_id, COALESCE(c.approval_status,'approved') AS approval_status
         FROM lead_portal_codes k JOIN customers c ON c.id = k.customer_id WHERE k.id=$1`, [id])).rows[0];
  }
  function blocked(k) {
    const st = codeState({ ...k, expires_on: k.expires_ymd }, todayMx());
    if (st === 'deleted') return { code: 401, body: { error: 'session_ended' } };
    if (st === 'paused') return { code: 403, body: { error: 'paused', customer_name: k.customer_name } };
    if (st === 'expired') return { code: 403, body: { error: 'expired', customer_name: k.customer_name, expires_on: k.expires_ymd } };
    return null;
  }
  async function portalGuard(req, reply) {
    if (!(await portalReady())) return reply.code(503).send({ error: 'not_ready' });
    try { await req.jwtVerify(); } catch { return reply.code(401).send({ error: 'session_ended' }); }
    const u = req.user || {};
    if (u.typ !== LP_TYP) return reply.code(401).send({ error: 'session_ended' });
    const id = idOf(String(u.sub || '').replace(/^lp:/, ''));
    const k = id && await loadCode(id);
    if (!k || Number(k.token_version) !== Number(u.tv)) return reply.code(401).send({ error: 'session_ended' });
    const b = blocked(k);
    if (b) return reply.code(b.code).send(b.body);
    req.lp = k;
    if (!k.last_seen_at || Date.now() - new Date(k.last_seen_at).getTime() > 5 * 60 * 1000) {
      query(`UPDATE lead_portal_codes SET last_seen_at=now() WHERE id=$1`, [k.id]).catch(() => {});
    }
  }
  const P = { preHandler: portalGuard };
  const meOut = (k) => {
    const today = todayMx();
    return { customer_name: k.customer_name, expires_on: k.expires_ymd, days_left: daysBetween(today, k.expires_ymd),
      discount: Number(k.discount) || 0, scope_states: k.scope_states || null, build: LP_BUILD };
  };
  const sign = (k) => app.jwt.sign({ sub: 'lp:' + k.id, typ: LP_TYP, tv: Number(k.token_version) }, { expiresIn: TOKEN_TTL });

  app.post('/api/lead-portal/login', async (req, reply) => {
    if (!(await portalReady())) return reply.code(503).send({ error: 'not_ready' });
    const ip = clientIp(req);
    if (locked(ip)) return reply.code(429).send({ error: 'too_many' });
    const norm = normCode(req.body && req.body.code);
    const k0 = norm && (await query(`SELECT id FROM lead_portal_codes WHERE code_hash=$1 AND deleted_at IS NULL`, [codeHash(norm)])).rows[0];
    if (!k0) {
      failOnce(ip);
      await logEvent({ userId: null, action: 'login_fail', target: 'lead_portal', detail: { ip } });
      return reply.code(401).send({ error: 'invalid_code' });
    }
    const k = await loadCode(k0.id);
    const b = blocked(k);
    if (b) return reply.code(b.code).send(b.body);
    await query(`UPDATE lead_portal_codes SET last_seen_at=now() WHERE id=$1`, [k.id]);
    await logEvent({ userId: null, action: 'login', target: `lead_portal:${k.id}`, detail: { ip, customer: k.customer_code } });
    return { token: sign(k), me: meOut(k) };
  });

  // 열 때마다 토큰을 새로 준다(7일 미접속이면 코드 다시 입력)
  app.get('/api/lead-portal/me', P, async (req) => ({ token: sign(req.lp), me: meOut(req.lp) }));

  app.get('/api/lead-portal/leads', P, async (req) => {
    const k = req.lp;
    const args = [k.customer_id]; const conds = [`t.status <> 'descartado'`, `COALESCE(t.in_count,0) > 0`];
    if (Array.isArray(k.scope_states) && k.scope_states.length) { args.push(k.scope_states); conds.push(`${STATE_EXPR} = ANY($${args.length}::text[])`); }
    const rows = (await query(
      `SELECT t.id, t.platform, COALESCE(t.m_name, t.name) AS name, t.username,
              to_char(t.first_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS first_mx,
              to_char(t.last_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS last_mx,
              COALESCE(t.m_tipo, t.ai_tipo, t.a_tipo) AS tipo, ${STATE_EXPR} AS state, COALESCE(t.m_city, t.ai_city, t.a_city) AS city,
              ${PHONE_EXPR} AS phone,
              COALESCE(t.m_vehicles, t.ai_vehicles, t.a_vehicles) AS vehicles, COALESCE(t.m_parts, t.ai_parts, t.a_parts) AS parts,
              t.ai_summary AS summary, COALESCE(t.m_items, t.ai_items) AS items,
              EXISTS (SELECT 1 FROM lead_portal_reveals r WHERE r.thread_id = t.id AND r.customer_id = $1) AS revealed
         FROM meta_threads t WHERE ${conds.join(' AND ')}
        ORDER BY t.last_at DESC NULLS LAST LIMIT ${MAX_LEADS}`, args)).rows;
    const leads = rows.map(shapeLead);
    const products = await productInfo(Number(k.customer_id), Number(k.discount) || 0, leads.flatMap((l) => l.parts.map((p) => p.code)));
    // 카탈로그에서 사라진 코드는 부품표에서 뺀다(주문할 수 없는 줄을 보여 주지 않게)
    for (const l of leads) l.parts = l.parts.filter((p) => products[p.code]);
    const states = [...new Set(leads.map((l) => l.state).filter(Boolean))].sort((a, b) => META_STATES.indexOf(a) - META_STATES.indexOf(b));
    return { me: meOut(k), leads, products, states };
  });

  app.post('/api/lead-portal/leads/:id/contact', P, async (req, reply) => {
    const k = req.lp; const id = idOf(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const args = [id]; let scope = '';
    if (Array.isArray(k.scope_states) && k.scope_states.length) { args.push(k.scope_states); scope = ` AND ${STATE_EXPR} = ANY($2::text[])`; }
    const t = (await query(
      `SELECT t.id, t.platform, COALESCE(t.m_name, t.name) AS name, t.username, ${PHONE_EXPR} AS phone
         FROM meta_threads t WHERE t.id=$1 AND t.status <> 'descartado'${scope}`, args)).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    const r = (await query(
      `INSERT INTO lead_portal_reveals (customer_id, code_id, thread_id) VALUES ($1,$2,$3)
       ON CONFLICT (customer_id, thread_id) DO UPDATE SET last_at=now(), n=lead_portal_reveals.n+1
       RETURNING to_char(first_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS first_mx, n`,
      [k.customer_id, k.id, id])).rows[0];
    const digits = String(t.phone || '').replace(/\D/g, '');
    const wa = digits.length >= 10 ? (digits.length === 10 ? '52' + digits : digits.replace(/^521(\d{10})$/, '52$1')) : null;
    return { id: Number(t.id), platform: t.platform, name: t.name || null, username: t.username || null,
      phone: t.phone || null, wa_link: wa ? 'https://wa.me/' + wa : null, first_seen: r.first_mx, first_time: Number(r.n) === 1 };
  });

  // 고객 매장 재고(Mi stock) — 고객이 고침
  app.put('/api/lead-portal/stock', P, async (req, reply) => {
    const k = req.lp; const b = req.body || {};
    const q = parseQty(b.qty);
    if (!q.ok) return reply.code(400).send({ error: 'bad_qty' });
    const p = (await query(`SELECT id, code FROM products WHERE code=$1 AND deleted_at IS NULL`, [String(b.code || '').trim()])).rows[0];
    if (!p) return reply.code(404).send({ error: 'unknown_code' });
    await withTx((c) => saveShelf(c, { customerId: Number(k.customer_id), productId: Number(p.id), qty: q.qty, src: 'customer', codeId: Number(k.id) }));
    return { ok: true, code: p.code, shelf: q.qty, shelf_src: q.qty == null ? null : 'customer', shelf_at: todayMx() };
  });

  // 주문 → ERP 견적(초안)
  app.post('/api/lead-portal/order', P, async (req, reply) => {
    const k = req.lp; const b = req.body || {};
    if (k.approval_status === 'pending') return reply.code(409).send({ error: 'customer_pending' });
    const key = String(b.key || '').trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) return reply.code(400).send({ error: 'bad_key' });
    const raw = Array.isArray(b.items) ? b.items : [];
    if (!raw.length) return reply.code(400).send({ error: 'empty' });
    if (raw.length > MAX_ORDER_LINES) return reply.code(400).send({ error: 'too_many_lines' });
    const merged = new Map(); const threads = new Set();
    for (const it of raw) {
      const code = String((it && it.code) || '').trim();
      const qty = Number(it && it.qty);
      if (!code || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return reply.code(400).send({ error: 'bad_line', code });
      merged.set(code, (merged.get(code) || 0) + qty);
      const th = idOf(it && it.thread_id); if (th) threads.add(th);
      if (it && Array.isArray(it.thread_ids)) for (const x of it.thread_ids.slice(0, 50)) { const v = idOf(x); if (v) threads.add(v); }
    }
    // 같은 키 = 이미 받은 주문(버튼 두 번 · 재전송)
    const dupOf = async () => (await query(
      `SELECT q.quote_no, q.total_mxn FROM quotes q WHERE q.lead_portal_key=$1 AND q.lead_portal_code_id IN (SELECT id FROM lead_portal_codes WHERE customer_id=$2)`,
      [key, k.customer_id])).rows[0];
    const d0 = await dupOf();
    if (d0) return { ok: true, duplicate: true, quote_no: d0.quote_no, total: Number(d0.total_mxn) || 0, asesor: await asesorName(k) };
    const prods = (await query(`SELECT id, code, is_active FROM products WHERE code = ANY($1::text[]) AND deleted_at IS NULL`, [[...merged.keys()]])).rows;
    const byCode = new Map(prods.map((p) => [p.code, p]));
    const unknown = [...merged.keys()].filter((c) => !byCode.has(c));
    if (unknown.length) return reply.code(400).send({ error: 'unknown_code', codes: unknown });
    const inactive = prods.filter((p) => p.is_active === false).map((p) => p.code);
    if (inactive.length) return reply.code(409).send({ error: 'discontinued', codes: inactive });
    // 문의 번호는 이 코드가 볼 수 있는 것만 남긴다
    let threadIds = [...threads];
    if (threadIds.length) {
      const args = [threadIds]; let scope = '';
      if (Array.isArray(k.scope_states) && k.scope_states.length) { args.push(k.scope_states); scope = ` AND ${STATE_EXPR} = ANY($2::text[])`; }
      threadIds = (await query(`SELECT t.id FROM meta_threads t WHERE t.id = ANY($1::bigint[]) AND t.status <> 'descartado'${scope}`, args)).rows.map((r) => Number(r.id));
    }
    const discount = Number(k.discount) || 0;
    const note = clip(b.note, 300);
    const memo = ['🔑 Portal oportunidades', 'código …' + k.code_last4,
      threadIds.length ? 'Meta #' + threadIds.join(', #') : null, note ? '· ' + note : null].filter(Boolean).join(' · ');
    let seller = null;
    try {
      const r = await resolveSeller(query, { customerId: Number(k.customer_id), requestedSeller: null, perm: null });
      if (r && r.ok) seller = r.seller_id || null;
    } catch (_) { seller = null; }
    const assignee = seller || (k.owner_id ? Number(k.owner_id) : null);
    let res;
    try {
      res = await withTx(async (c) => {
        const year = todayMx().slice(0, 4);
        const quoteNo = await nextFbQuoteNo(c, year);   // FB-YYYY-####
        const lines = await buildLines(discount, 16, [...merged.entries()].map(([code, qty]) => ({ product_id: Number(byCode.get(code).id), code, qty })));
        const totals = computeQuoteTotals(lines.filter((l) => l.product_id)
          .map((l) => ({ lineSubtotal: l.line_subtotal, lineIva: l.line_iva, lineTotal: l.line_total, qty: l.qty })));
        const q = (await c.query(
          `INSERT INTO quotes (quote_no, customer_id, quote_date, discount_rate, iva_rate, memo, status,
                               subtotal_mxn, iva_mxn, total_mxn, total_qty, sku_count, origin, reserve_expires_at,
                               assigned_to, assigned_at, lead_portal_code_id, lead_portal_key, lead_thread_ids)
           VALUES ($1,$2,CURRENT_DATE,$3,16,$4,'draft',$5,$6,$7,$8,$9,'lead_portal',$10::timestamptz,$11,CASE WHEN $11::bigint IS NULL THEN NULL ELSE now() END,$12,$13,$14::bigint[])
           RETURNING id, quote_no, total_mxn`,
          [quoteNo, k.customer_id, discount, memo, totals.subtotal, totals.iva, totals.total, totals.totalQty, totals.skuCount,
            reserveExpiresAt(new Date()), assignee, k.id, key, threadIds])).rows[0];
        for (const l of lines) {
          await c.query(
            `INSERT INTO quote_lines (quote_id, line_no, product_id, input_code, ctr_code, syd_codes,
                                      product_name, app_text, qty, list_price, discount_rate, final_price,
                                      line_subtotal, line_iva, line_total, avail_stock, stock_flag, issue)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            [q.id, l.line_no, l.product_id, l.input_code, l.ctr_code, l.syd_codes, l.product_name,
              l.app_text, l.qty, l.list_price, l.discount_rate, l.final_price, l.line_subtotal,
              l.line_iva, l.line_total, l.avail_stock, l.stock_flag, l.issue || null]);
        }
        await stampLineMeta(c, q.id, lines);
        if (seller && (await exclusivityReady())) await c.query(`UPDATE quotes SET seller_id=$1 WHERE id=$2`, [seller, q.id]);
        await assignReservations(c, q.id);
        await syncQuoteShortages(c, q.id, { userId: null });
        await recordQuoteDevDemand(c, q.id, { userId: null });
        // 문의 상태: 신규 · 연락함 → refaccionaria 연결(이 고객). 판매 · 제외 · 이미 연결은 건드리지 않는다.
        if (threadIds.length) {
          await c.query(
            `UPDATE meta_threads SET status='derivado', derived_customer_id=$2, derived_to=$3, updated_at=now()
              WHERE id = ANY($1::bigint[]) AND status IN ('nuevo','contactado')`, [threadIds, k.customer_id, k.customer_name]);
        }
        return q;
      });
    } catch (e) {
      if (e && e.code === '23505') {
        const d1 = await dupOf();
        if (d1) return { ok: true, duplicate: true, quote_no: d1.quote_no, total: Number(d1.total_mxn) || 0, asesor: await asesorName(k) };
      }
      req.log?.error({ err: e }, 'lead portal order failed');
      return reply.code(500).send({ error: 'internal' });
    }
    await logEvent({ userId: null, action: 'create', target: `quote:${res.id}`, detail: { origin: 'lead_portal', code_id: Number(k.id), customer: k.customer_code, threads: threadIds } });
    kickQuoteNotify(res.id, app);
    return { ok: true, quote_no: res.quote_no, total: Number(res.total_mxn) || 0, asesor: await asesorName(k, assignee) };
  });
  async function asesorName(k, uid) {
    const id = uid || (k.owner_id ? Number(k.owner_id) : null);
    if (!id) return null;
    try { const u = (await query(`SELECT name FROM users WHERE id=$1`, [id])).rows[0]; return u ? String(u.name).split(/\s+/)[0] : null; }
    catch (_) { return null; }
  }

  // ════════════════════════════════════════════════════════════════
  //  ERP — 접속코드 관리(디렉터) · 고객 매장 재고(담당 영업사원 · 디렉터)
  // ════════════════════════════════════════════════════════════════
  const DIR = { preHandler: [authGuard, async (req, reply) => { if (req.ctx.perm.role !== 'director') return reply.code(403).send({ error: 'director_only' }); }] };
  const R = { preHandler: [authGuard, requirePageAny(PM_KEYS)] };
  const W = { preHandler: [authGuard, requirePageEditAny(PM_KEYS)] };
  const clog = (c, codeId, action, detail, userId) => c.query(
    `INSERT INTO lead_portal_code_log (code_id, action, detail, user_id) VALUES ($1,$2,$3,$4)`, [codeId, action, detail ? JSON.stringify(detail) : null, userId]);
  const cleanStates = (v) => {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return null;
    const list = (Array.isArray(v) ? v : [v]).map((s) => String(s).trim()).filter((s) => META_STATES.includes(s));
    return list.length ? [...new Set(list)] : null;
  };
  const cleanAmount = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[,\s$]/g, '')); return Number.isFinite(n) && n >= 0 && n < 1e12 ? Math.round(n * 100) / 100 : undefined; };

  app.get('/api/lead-portal-admin/status', R, async (req) => ({
    ready: await portalReady(), build: LP_BUILD, url: portalUrl(), states: META_STATES,
    director: req.ctx.perm.role === 'director', today: todayMx(),
  }));

  // 고객 찾기 — 직원이 볼 수 있는 고객만
  app.get('/api/lead-portal-admin/customers', R, async (req) => {
    const kw = String(req.query.q || '').trim();
    const vis = visibleTeamIds(req.ctx.perm);
    const args = []; const conds = ['c.deleted_at IS NULL', `COALESCE(c.approval_status,'approved') <> 'pending'`];
    if (kw) { args.push('%' + kw + '%'); conds.push(`(c.name ILIKE $${args.length} OR c.code ILIKE $${args.length} OR c.rfc ILIKE $${args.length})`); }
    if (vis !== null) {
      args.push(req.ctx.perm.userId); const u = args.length;
      args.push(vis.length ? vis : [-1]); const tv = args.length;
      conds.push(`(c.owner_id = $${u} OR c.team_id = ANY($${tv}::bigint[]))`);
    }
    const rows = (await query(
      `SELECT c.id, c.code, c.name, c.discount FROM customers c WHERE ${conds.join(' AND ')} ORDER BY c.name LIMIT 30`, args)).rows;
    return { items: rows.map((r) => ({ id: Number(r.id), code: r.code, name: r.name, discount: Number(r.discount) || 0 })) };
  });

  // 발급 화면 참고 — 그 고객 ERP 매출(IVA 제외)
  app.get('/api/lead-portal-admin/customer-ref/:id', DIR, async (req, reply) => {
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const r = (await query(
      `SELECT COALESCE(SUM(subtotal_mxn) FILTER (WHERE inv_date >= CURRENT_DATE - 30),0) AS d30,
              COALESCE(SUM(subtotal_mxn) FILTER (WHERE inv_date >= CURRENT_DATE - 91),0) AS d90,
              COALESCE(SUM(subtotal_mxn) FILTER (WHERE inv_date >= CURRENT_DATE - 365),0) AS d365,
              to_char(MAX(inv_date),'YYYY-MM-DD') AS last_date
         FROM sales_invoices WHERE customer_id=$1 AND status='posted' AND deleted_at IS NULL`, [id])).rows[0];
    const last = r.last_date ? (await query(
      `SELECT COALESCE(SUM(subtotal_mxn),0) AS amt FROM sales_invoices WHERE customer_id=$1 AND status='posted' AND deleted_at IS NULL AND inv_date=$2::date`, [id, r.last_date])).rows[0] : null;
    const codes = (await portalReady())
      ? (await query(`SELECT count(*)::int AS n FROM lead_portal_codes WHERE customer_id=$1 AND deleted_at IS NULL`, [id])).rows[0].n : 0;
    return { d30: Number(r.d30) || 0, d90: Number(r.d90) || 0, d365: Number(r.d365) || 0, last_date: r.last_date, last_amount: last ? Number(last.amt) || 0 : null, codes };
  });

  const CODE_SELECT = `
    SELECT k.id, k.customer_id, c.code AS customer_code, c.name AS customer_name, k.code_last4,
           to_char(k.expires_on,'YYYY-MM-DD') AS expires_on, k.basis_amount, k.memo, k.scope_states, k.active,
           k.last_seen_at, k.created_at, to_char(k.created_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD') AS created_on,
           (SELECT count(*)::int FROM lead_portal_reveals r WHERE r.code_id = k.id) AS reveals,
           (SELECT count(*)::int FROM quotes q WHERE q.lead_portal_code_id = k.id AND q.deleted_at IS NULL AND q.status <> 'cancelled') AS orders,
           (SELECT COALESCE(SUM(q.total_mxn),0) FROM quotes q WHERE q.lead_portal_code_id = k.id AND q.deleted_at IS NULL AND q.status <> 'cancelled') AS orders_total
      FROM lead_portal_codes k JOIN customers c ON c.id = k.customer_id`;
  const codeOut = (r, today) => ({
    id: Number(r.id), customer_id: Number(r.customer_id), customer_code: r.customer_code, customer_name: r.customer_name,
    last4: r.code_last4, expires_on: r.expires_on, days_left: daysBetween(today, r.expires_on),
    basis_amount: num(r.basis_amount), memo: r.memo || null, scope_states: r.scope_states || null, active: !!r.active,
    state: codeState(r, today), last_seen_at: r.last_seen_at, created_on: r.created_on,
    reveals: Number(r.reveals) || 0, orders: Number(r.orders) || 0, orders_total: Number(r.orders_total) || 0,
  });

  app.get('/api/lead-portal-admin/codes', DIR, async (req, reply) => {
    if (!(await need(reply))) return;
    const today = todayMx();
    const rows = (await query(`${CODE_SELECT} WHERE k.deleted_at IS NULL ORDER BY (k.active AND k.expires_on >= $1::date) DESC, k.expires_on ASC, k.id DESC`, [today])).rows;
    return { today, url: portalUrl(), items: rows.map((r) => codeOut(r, today)) };
  });

  app.post('/api/lead-portal-admin/codes', DIR, async (req, reply) => {
    if (!(await need(reply))) return;
    const b = req.body || {};
    const cid = idOf(b.customer_id); const exp = ymd(b.expires_on); const amt = cleanAmount(b.basis_amount);
    if (!cid) return reply.code(400).send({ error: 'customer_required', note: '고객을 고르세요.' });
    if (!exp) return reply.code(400).send({ error: 'expires_required', note: '만료일을 입력하세요.' });
    if (exp < todayMx()) return reply.code(400).send({ error: 'expires_past', note: '만료일이 오늘보다 앞입니다.' });
    if (amt === undefined) return reply.code(400).send({ error: 'bad_amount', note: '기준 금액은 숫자로 입력하세요.' });
    const cust = (await query(`SELECT id, name, COALESCE(approval_status,'approved') AS st FROM customers WHERE id=$1 AND deleted_at IS NULL`, [cid])).rows[0];
    if (!cust) return reply.code(404).send({ error: 'customer_not_found' });
    if (cust.st === 'pending') return reply.code(409).send({ error: 'customer_pending', note: '승인 대기 고객에게는 발급할 수 없습니다.' });
    const code = newCode(); const norm = normCode(code);
    const row = await withTx(async (c) => {
      const k = (await c.query(
        `INSERT INTO lead_portal_codes (customer_id, code_hash, code_last4, expires_on, basis_amount, memo, scope_states, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
        [cid, codeHash(norm), norm.slice(-4), exp, amt, clip(b.memo, 500), cleanStates(b.scope_states), req.ctx.perm.userId])).rows[0];
      await clog(c, k.id, 'issue', { expires_on: exp, basis_amount: amt, scope_states: cleanStates(b.scope_states) }, req.ctx.perm.userId);
      return k;
    });
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `lead_portal_code:${row.id}`, detail: { customer_id: cid, expires_on: exp } });
    const today = todayMx();
    const r = (await query(`${CODE_SELECT} WHERE k.id=$1`, [row.id])).rows[0];
    return { ok: true, code, invite: inviteText({ customerName: cust.name, code, expiresOn: exp, url: portalUrl() }), item: codeOut(r, today) };
  });

  // 기한 · 기준 금액 · 메모 · 범위 · 정지/재개
  app.patch('/api/lead-portal-admin/codes/:id', DIR, async (req, reply) => {
    if (!(await need(reply))) return;
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {};
    const cur = (await query(`SELECT *, to_char(expires_on,'YYYY-MM-DD') AS exp FROM lead_portal_codes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    const sets = []; const args = []; const changes = {};
    const add = (col, v) => { args.push(v); sets.push(`${col}=$${args.length}`); };
    if ('expires_on' in b) {
      const exp = ymd(b.expires_on); if (!exp) return reply.code(400).send({ error: 'expires_required', note: '만료일을 입력하세요.' });
      if (exp !== cur.exp) { add('expires_on', exp); changes.expires_on = [cur.exp, exp]; }
    }
    if ('basis_amount' in b) {
      const amt = cleanAmount(b.basis_amount); if (amt === undefined) return reply.code(400).send({ error: 'bad_amount' });
      if (num(cur.basis_amount) !== amt) { add('basis_amount', amt); changes.basis_amount = [num(cur.basis_amount), amt]; }
    }
    if ('memo' in b) { const m = clip(b.memo, 500); if ((cur.memo || null) !== m) { add('memo', m); changes.memo = true; } }
    if ('scope_states' in b) {
      const s = cleanStates(b.scope_states);
      if (JSON.stringify(cur.scope_states || null) !== JSON.stringify(s)) { add('scope_states', s); changes.scope_states = [cur.scope_states || null, s]; }
    }
    if ('active' in b) { const a = !!b.active; if (a !== !!cur.active) { add('active', a); changes.active = a; } }
    if (!sets.length) return { ok: true, unchanged: true };
    args.push(req.ctx.perm.userId); sets.push(`updated_by=$${args.length}`, 'updated_at=now()');
    args.push(id);
    await withTx(async (c) => {
      await c.query(`UPDATE lead_portal_codes SET ${sets.join(', ')} WHERE id=$${args.length}`, args);
      const action = 'active' in changes && Object.keys(changes).length === 1 ? (changes.active ? 'resume' : 'pause') : 'update';
      await clog(c, id, action, changes, req.ctx.perm.userId);
    });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `lead_portal_code:${id}`, detail: changes });
    const today = todayMx();
    return { ok: true, item: codeOut((await query(`${CODE_SELECT} WHERE k.id=$1`, [id])).rows[0], today) };
  });

  // 재발급 — 새 코드, 옛 코드 · 옛 토큰 즉시 무효. 기한 · 범위는 그대로.
  app.post('/api/lead-portal-admin/codes/:id/reissue', DIR, async (req, reply) => {
    if (!(await need(reply))) return;
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const cur = (await query(`SELECT k.id, to_char(k.expires_on,'YYYY-MM-DD') AS exp, c.name FROM lead_portal_codes k JOIN customers c ON c.id=k.customer_id WHERE k.id=$1 AND k.deleted_at IS NULL`, [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    const code = newCode(); const norm = normCode(code);
    await withTx(async (c) => {
      await c.query(`UPDATE lead_portal_codes SET code_hash=$1, code_last4=$2, token_version=token_version+1, updated_by=$3, updated_at=now() WHERE id=$4`,
        [codeHash(norm), norm.slice(-4), req.ctx.perm.userId, id]);
      await clog(c, id, 'reissue', { last4: norm.slice(-4) }, req.ctx.perm.userId);
    });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `lead_portal_code:${id}`, detail: { op: 'reissue' } });
    const today = todayMx();
    return { ok: true, code, invite: inviteText({ customerName: cur.name, code, expiresOn: cur.exp, url: portalUrl() }),
      item: codeOut((await query(`${CODE_SELECT} WHERE k.id=$1`, [id])).rows[0], today) };
  });

  app.delete('/api/lead-portal-admin/codes/:id', DIR, async (req, reply) => {
    if (!(await need(reply))) return;
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const r = await withTx(async (c) => {
      const x = (await c.query(`UPDATE lead_portal_codes SET deleted_at=now(), token_version=token_version+1, updated_by=$1, updated_at=now() WHERE id=$2 AND deleted_at IS NULL RETURNING id`, [req.ctx.perm.userId, id])).rows[0];
      if (x) await clog(c, id, 'delete', null, req.ctx.perm.userId);
      return x;
    });
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `lead_portal_code:${id}` });
    return { ok: true };
  });

  app.get('/api/lead-portal-admin/codes/:id/log', DIR, async (req, reply) => {
    if (!(await need(reply))) return;
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const rows = (await query(
      `SELECT l.action, l.detail, u.name AS user_name, to_char(l.at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS at
         FROM lead_portal_code_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.code_id=$1 ORDER BY l.at DESC, l.id DESC LIMIT 100`, [id])).rows;
    return { items: rows };
  });

  // 연락처 공개 기록
  app.get('/api/lead-portal-admin/reveals', DIR, async (req, reply) => {
    if (!(await need(reply))) return;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const args = []; let w = 'true';
    const cid = idOf(req.query.code_id); if (cid) { args.push(cid); w = `r.code_id=$1`; }
    const rows = (await query(
      `SELECT r.thread_id, r.n, to_char(r.first_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS first_mx,
              to_char(r.last_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS last_mx,
              c.name AS customer_name, k.code_last4, t.platform, t.status,
              COALESCE(t.m_vehicles, t.ai_vehicles, t.a_vehicles) AS vehicles, COALESCE(t.m_parts, t.ai_parts, t.a_parts) AS parts
         FROM lead_portal_reveals r JOIN customers c ON c.id = r.customer_id JOIN lead_portal_codes k ON k.id = r.code_id
         JOIN meta_threads t ON t.id = r.thread_id
        WHERE ${w} ORDER BY r.first_at DESC LIMIT ${limit}`, args)).rows;
    return { items: rows.map((r) => ({ ...r, thread_id: Number(r.thread_id), n: Number(r.n) })) };
  });

  // 고객 매장 재고 — 담당 영업사원 · 디렉터(자기가 볼 수 있는 고객만)
  app.get('/api/lead-portal-admin/shelf', R, async (req, reply) => {
    if (!(await need(reply))) return;
    const cid = idOf(req.query.customer_id); if (!cid) return reply.code(400).send({ error: 'customer_required' });
    const cv = await customerVisible(req.ctx.perm, cid);
    if (cv === null) return reply.code(404).send({ error: 'customer_not_found' });
    if (cv === false) return reply.code(403).send({ error: 'not_your_customer' });
    const rows = (await query(
      `SELECT p.code, p.name, s.qty, s.src, u.name AS user_name, k.code_last4,
              to_char(s.updated_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS at
         FROM customer_shelf_stock s JOIN products p ON p.id = s.product_id
         LEFT JOIN users u ON u.id = s.user_id LEFT JOIN lead_portal_codes k ON k.id = s.code_id
        WHERE s.customer_id=$1 ORDER BY p.code`, [cid])).rows;
    const cust = (await query(`SELECT discount FROM customers WHERE id=$1`, [cid])).rows[0];
    const info = await productInfo(cid, Number(cust && cust.discount) || 0, rows.map((r) => r.code));
    return { items: rows.map((r) => ({ code: r.code, name: r.name, qty: Number(r.qty), src: r.src,
      by: r.src === 'customer' ? '고객' + (r.code_last4 ? ' (…' + r.code_last4 + ')' : '') : (r.user_name || '직원'), at: r.at,
      bought12: info[r.code] ? info[r.code].bought12 : 0, avail: info[r.code] ? info[r.code].avail : null })) };
  });

  app.put('/api/lead-portal-admin/shelf', W, async (req, reply) => {
    if (!(await need(reply))) return;
    const b = req.body || {};
    const cid = idOf(b.customer_id); if (!cid) return reply.code(400).send({ error: 'customer_required' });
    const cv = await customerVisible(req.ctx.perm, cid);
    if (cv === null) return reply.code(404).send({ error: 'customer_not_found' });
    if (cv === false) return reply.code(403).send({ error: 'not_your_customer' });
    const q = parseQty(b.qty); if (!q.ok) return reply.code(400).send({ error: 'bad_qty', note: '0 이상의 정수를 입력하세요.' });
    const p = (await query(`SELECT id, code, name FROM products WHERE code=$1 AND deleted_at IS NULL`, [String(b.code || '').trim().toUpperCase()])).rows[0]
      || (await query(`SELECT id, code, name FROM products WHERE code=$1 AND deleted_at IS NULL`, [String(b.code || '').trim()])).rows[0];
    if (!p) return reply.code(404).send({ error: 'unknown_code', note: '없는 부품번호입니다.' });
    const r = await withTx((c) => saveShelf(c, { customerId: cid, productId: Number(p.id), qty: q.qty, src: 'staff', userId: req.ctx.perm.userId }));
    return { ok: true, code: p.code, name: p.name, qty: q.qty, changed: r.changed };
  });

  app.get('/api/lead-portal-admin/shelf/log', R, async (req, reply) => {
    if (!(await need(reply))) return;
    const cid = idOf(req.query.customer_id); if (!cid) return reply.code(400).send({ error: 'customer_required' });
    const cv = await customerVisible(req.ctx.perm, cid);
    if (!cv) return reply.code(cv === null ? 404 : 403).send({ error: cv === null ? 'customer_not_found' : 'not_your_customer' });
    const args = [cid]; let w = '';
    if (req.query.code) { args.push(String(req.query.code)); w = ` AND p.code=$2`; }
    const rows = (await query(
      `SELECT p.code, l.old_qty, l.new_qty, l.src, u.name AS user_name, k.code_last4,
              to_char(l.at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS at
         FROM customer_shelf_stock_log l JOIN products p ON p.id = l.product_id
         LEFT JOIN users u ON u.id = l.user_id LEFT JOIN lead_portal_codes k ON k.id = l.code_id
        WHERE l.customer_id=$1${w} ORDER BY l.at DESC, l.id DESC LIMIT 200`, args)).rows;
    return { items: rows.map((r) => ({ code: r.code, old: num(r.old_qty), new: num(r.new_qty), at: r.at,
      by: r.src === 'customer' ? '고객' + (r.code_last4 ? ' (…' + r.code_last4 + ')' : '') : (r.user_name || '직원') })) };
  });
}
