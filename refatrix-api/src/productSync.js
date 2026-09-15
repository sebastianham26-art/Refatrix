// ERP → CRM(웹 카달록) 제품 카탈로그 전송. 계약서 v1.0 (Contrato_API_Producto_v1.0).
//
//   무엇을 언제 보내나
//     하루 1회, **전체 카탈로그**를 묶음(lote)으로 나눠 보낸다. 변경분만 보내지 않는다 —
//     받는 쪽이 "이번에 안 온 제품은 감춘다"로 마감할 수 있어야 단종품이 웹에 남지 않는다.
//
//   설계 원칙 4가지
//   ① 엔진을 새로 만들지 않는다. 적재는 기존 아웃박스(crm_customer_outbox, entity='product'),
//      전송·재시도·이력·재전송은 crmSync 의 것을 그대로 쓴다. 고친 곳이 적을수록 덜 깨진다.
//   ② 실행 1건 = product_sync_runs 의 1행. 「오늘 자동 전송을 이미 돌렸나」를 묶음 수로 세면
//      반드시 언젠가 두 번 나간다. 날짜에 유니크 인덱스를 걸어 DB 가 잠근다.
//   ③ **시험 전송은 카탈로그를 닫지 않는다.** test 모드는 envioId 가 `TEST-…` 이고
//      esUltimoLote 를 절대 true 로 보내지 않는다. 몇 건만 보낸 뒤 마감 신호가 가면
//      CRM 은 나머지 전 제품을 감춘다 — 한 번의 실수로 카탈로그가 비는 사고다.
//   ④ 적재는 전송을 기다리지 않는다. 묶음을 쌓고 즉시 응답한다(워커가 밀어 낸다).
import { query } from './db.js';
import { getEndpoint, activeUrl } from './integrations.js';
import { scheduleDrain } from './crmSync.js';

export const PRODUCT_KEY = 'product';

const MX_OFFSET_MIN = -360;          // 멕시코 중부시간(UTC-6, 서머타임 없음)
const PROBE_MS = 30000;
const DEFAULT_BATCH = 500;
const MAX_BATCH = 2000;
const MIN_BATCH = 10;

let runsReady = false;
let runsProbe = 0;
let timer = null;

/** 실행 이력 표가 준비됐는가(0218). 긍정만 영구 캐시 — 기동 후 migrate 해도 반영된다. */
export async function productTablesReady() {
  if (runsReady) return true;
  if (Date.now() - runsProbe < PROBE_MS) return false;
  runsProbe = Date.now();
  try {
    const r = await query(`SELECT to_regclass('public.product_sync_runs') AS t`);
    runsReady = !!(r.rows[0] && r.rows[0].t);
  } catch (_) { runsReady = false; }
  return runsReady;
}

export function mxNowParts(now = Date.now()) {
  const m = new Date(now + MX_OFFSET_MIN * 60000);
  return {
    ymd: m.toISOString().slice(0, 10),
    hour: m.getUTCHours(),
    // 초까지 넣는다 — 같은 분에 두 번 시험하면 envioId 가 겹쳐 상대가 두 전송을 구분할 수 없다.
    stamp: m.toISOString().slice(0, 19).replace(/[-:T]/g, ''),
  };
}

/**
 * 가용재고 → 구간 문자열. 정확한 수량은 내보내지 않는다(참고용이고, 경쟁 정보다).
 *   0 · 1-10 · 11-20 · 21-30 · +30
 */
export function stockRange(qty) {
  const n = Math.floor(Number(qty) || 0);
  if (n <= 0) return '0';
  if (n <= 10) return '1-10';
  if (n <= 20) return '11-20';
  if (n <= 30) return '21-30';
  return '+30';
}

/**
 * 사진 주소 — ERP 에 제품별 사진 컬럼이 없으므로 **규칙**으로 만든다.
 *   기본주소에 `{code}` 가 있으면 그 자리에, 없으면 끝에 `/코드.jpg` 를 붙인다.
 *   기본주소가 비어 있으면 빈 문자열(계약서: "vacío si no hay").
 */
export function imageUrlFor(base, code) {
  const b = String(base == null ? '' : base).trim();
  const c = String(code == null ? '' : code).trim();
  if (!b || !c) return '';
  const enc = encodeURIComponent(c);
  if (b.includes('{code}')) return b.replace(/\{code\}/g, enc);
  return b.replace(/\/+$/, '') + '/' + enc + '.jpg';
}

/** 숫자 정리 — node-pg 는 NUMERIC 을 문자열로 준다. 계약서는 소수 2자리. */
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** 제품 1건 → 계약서 본문. 여기서 정한 이름이 곧 계약서다. */
export function buildProduct(row, imgBase) {
  return {
    codigo: String(row.code || '').trim(),
    descripcion: String(row.name || '').trim(),
    aplicaciones: String(row.app || '').trim(),
    referenciaSyd: String(row.scode || '').trim(),
    precioLista: money(row.list_price),
    moneda: 'MXN',
    existencia: stockRange(row.stock_qty),
    imagenUrl: imageUrlFor(imgBase, row.code),
    // 비활성(단종·판매중단)도 **보낸다** — 빼 버리면 CRM 이 감출 근거가 없다.
    activo: row.is_active !== false,
  };
}

/** 묶음 1개의 본문. */
export function buildLote(meta, productos) {
  return {
    envioId: meta.envioId,
    fechaCorte: meta.fechaCorte,
    lote: meta.lote,
    totalLotes: meta.totalLotes,
    totalProductos: meta.totalProductos,
    // 시험 전송은 절대 마감 신호를 보내지 않는다(원칙 ③).
    esUltimoLote: meta.mode === 'test' ? false : meta.lote === meta.totalLotes,
    transactionUser: meta.transactionUser,
    productos,
  };
}

export function chunk(list, size) {
  const n = Math.max(MIN_BATCH, Math.min(MAX_BATCH, Number(size) || DEFAULT_BATCH));
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

const PRODUCT_COLS = `SELECT code, name, app, scode, list_price, stock_qty, is_active
                        FROM products
                       WHERE deleted_at IS NULL AND code IS NOT NULL AND code <> ''`;

export async function fetchProducts({ limit = null, code = null } = {}) {
  if (code) {
    return (await query(`${PRODUCT_COLS} AND code = $1 LIMIT 1`, [String(code).trim()])).rows;
  }
  const sql = `${PRODUCT_COLS} ORDER BY code` + (limit ? ` LIMIT ${Math.max(1, Math.min(5000, Number(limit)))}` : '');
  return (await query(sql)).rows;
}

async function actorName(userId, userField) {
  if (!userId) return 'erp';
  try {
    const u = (await query(`SELECT login_id, name, role FROM users WHERE id=$1`, [userId])).rows[0];
    if (!u) return 'erp';
    const f = ['login_id', 'name', 'role'].includes(userField) ? userField : 'login_id';
    return String(u[f] || u.login_id || u.name || u.role || 'erp');
  } catch (_) { return 'erp'; }
}

/** 같은 날 두 번째 전체 전송은 envioId 가 달라야 한다 — 상대가 두 corte 를 구분할 수 있게. */
async function nextEnvioId(ymd, mode) {
  if (mode === 'test') return `TEST-${mxNowParts().stamp}`;
  const base = `CAT-${ymd}`;
  const r = (await query(
    `SELECT COUNT(*)::int AS n FROM product_sync_runs WHERE fecha_corte = $1 AND mode = 'full'`,
    [ymd])).rows[0];
  const n = Number(r && r.n) || 0;
  return n === 0 ? base : `${base}-${n + 1}`;
}

/**
 * 카탈로그 전송 적재.
 *   mode: 'full' = 전체(마지막 묶음에 마감 신호) · 'test' = 앞에서 몇 건만(마감하지 않는다)
 *   절대 throw 하지 않는다 — 화면 버튼이 500 으로 죽으면 원인을 알 수 없다.
 */
export async function runCatalogSync({
  mode = 'full', limit = null, origin = 'manual', actorUserId = null, app = null,
} = {}) {
  try {
    if (!(await productTablesReady())) return { error: 'migration_required' };
    const ep = await getEndpoint(PRODUCT_KEY);
    if (!ep) return { error: 'endpoint_missing' };

    const { ymd } = mxNowParts();
    const isTest = mode === 'test';
    const rows = await fetchProducts({ limit: isTest ? (Number(limit) || 5) : null });
    if (!rows.length) return { error: 'no_products' };

    const imgBase = ep.img_base_url || '';
    const productos = rows.map((r) => buildProduct(r, imgBase));
    const lotes = chunk(productos, ep.batch_size);
    const transactionUser = await actorName(actorUserId, ep.user_field);
    const envioId = await nextEnvioId(ymd, isTest ? 'test' : 'full');

    const run = (await query(
      `INSERT INTO product_sync_runs
         (envio_id, fecha_corte, mode, origin, total_productos, total_lotes, batch_size, env, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
      [envioId, ymd, isTest ? 'test' : 'full', origin, productos.length, lotes.length,
       Math.max(MIN_BATCH, Math.min(MAX_BATCH, Number(ep.batch_size) || DEFAULT_BATCH)),
       ep.env || null, actorUserId || null])).rows[0];

    const meta = {
      envioId, fechaCorte: ymd, totalLotes: lotes.length,
      totalProductos: productos.length, transactionUser, mode: isTest ? 'test' : 'full',
    };
    const ids = [];
    for (let i = 0; i < lotes.length; i++) {
      const payload = buildLote({ ...meta, lote: i + 1 }, lotes[i]);
      const label = `${envioId} · ${i + 1}/${lotes.length} (${lotes[i].length}건)`;
      const ins = (await query(
        `INSERT INTO crm_customer_outbox
           (customer_id, entity, entity_id, entity_label, endpoint_key, op, origin, rfc, payload, status, acted_by)
         VALUES (NULL,'product',$1,$2,$3,'upsert',$4,NULL,$5,'pending',$6) RETURNING id`,
        [Number(run.id), label, PRODUCT_KEY, origin === 'auto' ? 'auto_daily' : `product_${isTest ? 'test' : 'full'}`,
         JSON.stringify(payload), actorUserId || null])).rows[0];
      ids.push(Number(ins.id));
    }

    // 연동이 꺼져 있거나 주소가 비어 있으면 워커가 **시도 횟수를 쓰지 않고** 대기로 둔다.
    // 화면이 그 사실을 바로 말할 수 있게 여기서도 알려 준다.
    const ready = !!(ep.enabled && activeUrl(ep));
    if (ready) scheduleDrain(app);

    return {
      ok: true,
      run_id: Number(run.id),
      envio_id: envioId,
      fecha_corte: ymd,
      mode: isTest ? 'test' : 'full',
      total_productos: productos.length,
      total_lotes: lotes.length,
      outbox_ids: ids,
      queued_only: !ready,
      note: ready ? null
        : (!ep.enabled ? 'endpoint_disabled' : 'url_missing'),
    };
  } catch (e) {
    try { console.error('[productSync] 적재 실패', e && e.message); } catch (_) {}
    return { error: 'enqueue_failed', detail: String((e && e.message) || e).slice(0, 300) };
  }
}

/** 최근 실행 목록 + 묶음별 상태 집계(이력 화면용). */
export async function listRuns({ limit = 20 } = {}) {
  if (!(await productTablesReady())) return [];
  const rows = (await query(
    `SELECT r.*,
            COALESCE(o.pending,0) AS pending, COALESCE(o.sent,0) AS sent,
            COALESCE(o.failed,0)  AS failed,  COALESCE(o.skipped,0) AS skipped,
            u.login_id AS by_login
       FROM product_sync_runs r
       LEFT JOIN users u ON u.id = r.created_by
       LEFT JOIN (
         SELECT entity_id,
                SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status='sent'    THEN 1 ELSE 0 END) AS sent,
                SUM(CASE WHEN status='failed'  THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped
           FROM crm_customer_outbox
          WHERE entity='product'
          GROUP BY entity_id
       ) o ON o.entity_id = r.id
      ORDER BY r.id DESC
      LIMIT $1`, [Math.max(1, Math.min(100, Number(limit) || 20))])).rows;
  return rows.map((r) => ({
    id: Number(r.id),
    envio_id: r.envio_id,
    fecha_corte: typeof r.fecha_corte === 'string' ? r.fecha_corte : new Date(r.fecha_corte).toISOString().slice(0, 10),
    mode: r.mode,
    origin: r.origin,
    total_productos: Number(r.total_productos),
    total_lotes: Number(r.total_lotes),
    batch_size: Number(r.batch_size),
    env: r.env,
    by_login: r.by_login || null,
    created_at: r.created_at,
    pending: Number(r.pending), sent: Number(r.sent),
    failed: Number(r.failed), skipped: Number(r.skipped),
  }));
}

/** 오늘(멕시코 날짜) 자동 전체 전송이 이미 있었나. */
export async function autoRanToday(ymd) {
  const r = (await query(
    `SELECT 1 FROM product_sync_runs
      WHERE fecha_corte=$1 AND origin='auto' AND mode='full' LIMIT 1`, [ymd])).rows[0];
  return !!r;
}

/**
 * 자동 전송 스케줄러 — 5분 주기로 확인하고, 설정 시각이 지났는데 오늘 실행이 없으면 한 번 돌린다.
 *   · 서버가 그 시각에 자고 있었어도 **그날 안에 따라잡는다**(정각에 의존하지 않는다).
 *   · 하루 1회 보장은 DB 유니크 인덱스(uq_psr_auto_day)가 최종적으로 책임진다.
 */
export async function productSyncTick({ app = null } = {}) {
  try {
    if (!(await productTablesReady())) return { skipped: 'migration_required' };
    const ep = await getEndpoint(PRODUCT_KEY);
    if (!ep || !ep.auto_send) return { skipped: 'auto_off' };
    if (!ep.enabled || !activeUrl(ep)) return { skipped: 'endpoint_not_ready' };
    const { ymd, hour } = mxNowParts();
    const h = Number(ep.send_hour_mx);
    if (hour < (Number.isFinite(h) ? h : 6)) return { skipped: 'too_early' };
    if (await autoRanToday(ymd)) return { skipped: 'already_sent' };
    const r = await runCatalogSync({ mode: 'full', origin: 'auto', app });
    return { ran: true, result: r };
  } catch (e) {
    try { console.error('[productSync] tick 실패', e && e.message); } catch (_) {}
    return { skipped: 'error' };
  }
}

export function startProductSyncWorker(app) {
  if (timer) return;
  const tick = () => { productSyncTick({ app }).catch(() => {}); };
  timer = setInterval(tick, 300000);          // 5분
  if (timer.unref) timer.unref();
  setTimeout(tick, 25000);                    // 기동 25초 뒤 한 번(밀린 날 따라잡기)
  try { app?.log?.info?.('[productSync] 카탈로그 자동 전송 감시 시작 — 5분 주기'); } catch (_) {}
}
