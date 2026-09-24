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
import { scheduleDrain, signalProductCancel } from './crmSync.js';

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

/**
 * 우리 쪽 표준 필드 이름. 상대가 다른 이름을 쓰면 `field_map` 으로 갈아 끼운다
 * (이름만 바꾼다 — 값의 의미는 여기서 한 번만 정의한다).
 *   CRM 의 제품 업로드 화면 열과 1:1 로 맞춰 둔 것: Clave CTR · Clave SyD · Aplicacion ·
 *   Producto · SAT · Origen · Precio · IVA · EAN13 · Ubicacion · Precio lista comp. · Customer price.
 */
export const PRODUCT_FIELDS = [
  'codigo', 'descripcion', 'aplicaciones', 'referenciaSyd',
  'precioLista', 'moneda', 'existencia', 'imagenUrl', 'activo',
  'sat', 'origen', 'iva', 'ean13', 'ubicacion', 'precioListaComp', 'customerPrice',
  // 0220 · 상대(CRM) 규격이 요구하는 **다른 모양**의 값들.
  //   이름만 갈아 끼워서는 안 되는 것들이라 여기서 값까지 만들어 둔다:
  //   · internalSku  — 제품코드를 두 번째 이름으로도 요구한다(한 값을 두 필드로)
  //   · sydCode1     — SYD 코드가 여러 개여도 **첫 번째 하나만**
  //   · statusCode   — true/false 가 아니라 'active' / 'inactive' 문자열
  'internalSku', 'sydCode1', 'statusCode', 'transactionUser',
];
/** 묶음 봉투의 필드(본문 형식이 'lote' 일 때만 쓰인다). */
export const LOTE_FIELDS = [
  'envioId', 'fechaCorte', 'lote', 'totalLotes', 'totalProductos',
  'esUltimoLote', 'transactionUser', 'productos',
];
export const BODY_SHAPES = ['lote', 'array', 'item'];

/** 제품 1건 → 우리 표준 본문(이름 갈아 끼우기 전). */
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
    // CRM 화면이 가진 나머지 열 — 값이 없으면 빈 문자열/0 이 아니라 **null** 로 둔다.
    //   상대가 안 쓰면 매핑에서 빈 이름으로 지정해 빼면 된다.
    sat: row.sat_code == null ? null : String(row.sat_code).trim(),
    origen: row.origin == null ? null : String(row.origin).trim(),
    iva: row.iva_rate == null ? null : Number(row.iva_rate),
    ean13: row.ean == null ? null : String(row.ean).trim(),
    ubicacion: row.location == null ? null : String(row.location).trim(),
    precioListaComp: row.list_price_syd == null ? null : money(row.list_price_syd),
    customerPrice: row.price_customer_ctr == null ? null : money(row.price_customer_ctr),
    // 0220 · 상대 규격용 파생값
    internalSku: String(row.code || '').trim(),
    sydCode1: firstSyd(row.scode),
    statusCode: row.is_active === false ? 'inactive' : 'active',
    // 봉투가 없는 형식(1건씩·배열)에서는 이 값이 **제품 안에** 들어가야 한다.
    //   buildLote 가 실제 사용자 이름으로 채운다(여기서는 자리만).
    transactionUser: null,
  };
}

/** SYD 코드가 ' // ' 로 여러 개일 때 **첫 번째 하나만** — 상대는 sydCode1 하나만 받는다. */
export function firstSyd(scode) {
  const first = String(scode == null ? '' : scode).split('//')[0].trim();
  return first;
}

/**
 * 이름 갈아 끼우기. `map` 은 {우리이름: 상대이름}.
 *   · 값이 **빈 문자열**이면 그 필드를 **보내지 않는다**(상대가 모르는 필드를 빼는 방법).
 *   · 지정이 없으면 우리 이름 그대로 나간다.
 *   · 순서는 우리 표준 순서를 지킨다 — 이력에서 눈으로 대조하기 쉬우라고.
 */
export function applyMap(obj, map, order) {
  const m = (map && typeof map === 'object') ? map : {};
  const out = {};
  const keys = order && order.length ? order.filter((k) => k in obj) : Object.keys(obj);
  for (const k of keys) {
    if (obj[k] === undefined) continue;          // 이 형식에서 쓰지 않는 필드
    if (Object.prototype.hasOwnProperty.call(m, k)) {
      const name = String(m[k] == null ? '' : m[k]).trim();
      if (!name) continue;                 // 빈 이름 = 이 필드는 빼고 보낸다
      out[name] = obj[k];
    } else {
      out[k] = obj[k];
    }
  }
  return out;
}

/**
 * 한 번에 보낼 본문. 형식은 상대가 정한다(연동 설정의 「본문 형식」).
 *   lote  : 묶음 봉투 + productos[]  ← 우리 계약서 v1.0
 *   array : 루트가 제품 배열         [ {...}, {...} ]
 *   item  : 제품 1건 = 요청 1건      { ... }  (봉투 없음 — 마감 신호도 없다)
 *
 *   ⚠ array·item 에는 봉투가 없으므로 **마감 신호(esUltimoLote)를 보낼 수 없다.**
 *     그 형식에서는 「이번 전송에 없는 제품 감추기」를 상대가 다른 방법으로 해야 한다.
 */
export function buildLote(meta, productos, opt = {}) {
  const map = opt.map || {};
  const shape = BODY_SHAPES.includes(opt.shape) ? opt.shape : 'lote';
  // 봉투가 없는 형식에서는 transactionUser 가 제품 안에 들어간다(봉투 형식에서는 봉투에만).
  const withUser = productos.map((p) => (shape === 'lote'
    ? { ...p, transactionUser: undefined }
    : { ...p, transactionUser: meta.transactionUser }));
  const items = withUser.map((p) => applyMap(p, map, PRODUCT_FIELDS));
  if (shape === 'array') return items;
  if (shape === 'item') return items[0] === undefined ? {} : items[0];
  const envelope = {
    envioId: meta.envioId,
    fechaCorte: meta.fechaCorte,
    lote: meta.lote,
    totalLotes: meta.totalLotes,
    totalProductos: meta.totalProductos,
    // 시험 전송은 절대 마감 신호를 보내지 않는다(원칙 ③).
    esUltimoLote: meta.mode === 'test' ? false : meta.lote === meta.totalLotes,
    transactionUser: meta.transactionUser,
    productos: items,
  };
  return applyMap(envelope, map, LOTE_FIELDS);
}

export function chunk(list, size) {
  const n = Math.max(MIN_BATCH, Math.min(MAX_BATCH, Number(size) || DEFAULT_BATCH));
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * 2026-09-21 · 디렉터 지시: **PRO 로 시작하는 제품은 CRM 에 보내지 않는다.**
 *   대소문자·앞 공백과 무관하게(`pro-01`, ` PRO123` 도 제외). 전체 전송·시험 전송·미리보기·
 *   연결 테스트·화면 건수가 모두 이 한 조건을 쓴다 — 한 곳이라도 빠지면 시험은 안 나가는데
 *   실전에서 나가는 식의 어긋남이 생긴다.
 *   ⚠ LIKE 의 `_`·`%` 가 섞이지 않도록 접두어는 영문/숫자만 허용한다.
 */
export const EXCLUDED_PREFIXES = ['PRO'];

/** 이 코드는 보내지 않는가(JS 쪽 방어선 — SQL 조건과 같은 규칙). */
export function isExcludedCode(code) {
  const c = String(code == null ? '' : code).trim().toUpperCase();
  return EXCLUDED_PREFIXES.some((p) => c.startsWith(p));
}

/** SQL 조건 조각 — `products` 의 code 컬럼 기준. 접두어는 상수라 바인딩이 필요 없다. */
export const EXCLUDE_SQL = EXCLUDED_PREFIXES
  .filter((p) => /^[A-Z0-9]+$/.test(p))
  .map((p) => ` AND upper(btrim(code)) NOT LIKE '${p}%'`)
  .join('');

/** 전송 대상 제품 조건(삭제 안 됨 · 코드 있음 · 제외 접두어 아님). 건수 집계도 이걸 쓴다. */
export const SENDABLE_WHERE = `deleted_at IS NULL AND code IS NOT NULL AND code <> ''${EXCLUDE_SQL}`;

const PRODUCT_COLS = `SELECT code, name, app, scode, list_price, stock_qty, is_active,
                             sat_code, origin, iva_rate, ean, location,
                             list_price_syd, price_customer_ctr
                        FROM products
                       WHERE ${SENDABLE_WHERE}`;

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
    // SQL 이 이미 PRO* 를 거르지만, 조건이 바뀌어도 새지 않도록 한 번 더 거른다.
    const rows = (await fetchProducts({ limit: isTest ? (Number(limit) || 5) : null }))
      .filter((r) => !isExcludedCode(r.code));
    if (!rows.length) return { error: 'no_products' };

    const imgBase = ep.img_base_url || '';
    const shape = BODY_SHAPES.includes(ep.body_shape) ? ep.body_shape : 'lote';
    const map = (ep.field_map && typeof ep.field_map === 'object') ? ep.field_map : {};
    const productos = rows.map((r) => buildProduct(r, imgBase));
    // 「1건씩」 형식이면 요청 1건 = 제품 1건이다(전송 이력도 제품 수만큼 생긴다).
    const lotes = shape === 'item'
      ? productos.map((p) => [p])
      : chunk(productos, ep.batch_size);
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
      const payload = buildLote({ ...meta, lote: i + 1 }, lotes[i], { map, shape });
      const label = shape === 'item'
        ? `${envioId} · ${i + 1}/${lotes.length} · ${lotes[i][0].codigo}`
        : `${envioId} · ${i + 1}/${lotes.length} (${lotes[i].length}건)`;
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
      body_shape: shape,
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

/**
 * 20260924 · **제품 전송 중지.** 아직 안 나간(pending) 제품 건을 전부 건너뜀(skipped)으로 닫는다.
 *   · 고객·오더 건은 건드리지 않는다(entity='product' 만).
 *   · 이미 나간 건(sent)은 되돌릴 수 없다 — CRM 에 들어간 것은 그대로다.
 *   · 엔진이 이미 꺼내 둔 건(최대 25건)도 보내지 않도록 신호를 보낸다. 지금 막 전송 중인 1건만 끝까지 간다.
 *   · 닫힌 건은 전송 이력에서 「재전송」할 수 있고, 새로 「지금 전체 보내기」를 해도 된다.
 *   runId 를 주면 그 실행만, 없으면 대기 중인 제품 건 전부.
 */
export const CANCEL_NOTE = '디렉터 중지 — 전송 취소';
export async function cancelCatalogSync({ runId = null } = {}) {
  signalProductCancel();
  const params = [CANCEL_NOTE];
  let where = `entity='product' AND status='pending'`;
  if (runId != null && Number.isFinite(Number(runId))) {
    params.push(Number(runId));
    where += ` AND entity_id=$2`;
  }
  const r = await query(
    `UPDATE crm_customer_outbox SET status='skipped', last_error=$1
      WHERE ${where} RETURNING id`, params);
  // 한 번 더 — 위 UPDATE 가 끝나기 전에 새 묶음을 꺼낸 드레인이 있으면(시험에서 실제로 25건이 더 나갔다)
  //   그 드레인도 여기서 멈춘다. 진행 중이던 1건만 끝까지 간다.
  signalProductCancel();
  return { ok: true, cancelled: r.rows.length };
}

/** 대기 중인 제품 건 수(화면 진행 표시용). */
export async function pendingProductCount() {
  const r = (await query(
    `SELECT COUNT(*)::int AS n FROM crm_customer_outbox WHERE entity='product' AND status='pending'`)).rows[0];
  return Number(r && r.n) || 0;
}

/**
 * 최근 실행 목록 + **실행(전송 1회)별 성과** (이력 화면용).
 *   20260924 · 누적이 아니라 **전송 단위**로 본다 — 어제 실행과 오늘 실행의 숫자를 섞지 않는다.
 *     · 집계는 실행마다 LATERAL 로(인덱스 idx_crm_outbox_entity) — 제품 건이 수만 행이어도 그 실행만 센다.
 *     · 중지(stopped) = 디렉터가 「전송 중지」로 닫은 건. 다른 건너뜀과 구분한다.
 *     · 재시도 대기(retrying) = 대기 중이지만 한 번 이상 실패한 건.
 *     · 성공률 = 완료 ÷ (전체 − 중지). 소요 = 적재 → 마지막 전송(진행 중이면 지금까지).
 */
export async function listRuns({ limit = 20 } = {}) {
  if (!(await productTablesReady())) return [];
  const rows = (await query(
    `SELECT r.*, u.login_id AS by_login, o.*
       FROM product_sync_runs r
       LEFT JOIN users u ON u.id = r.created_by
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pending,
                COALESCE(SUM(CASE WHEN status='pending' AND attempts > 0 THEN 1 ELSE 0 END),0) AS retrying,
                COALESCE(SUM(CASE WHEN status='sent'    THEN 1 ELSE 0 END),0) AS sent,
                COALESCE(SUM(CASE WHEN status='failed'  THEN 1 ELSE 0 END),0) AS failed,
                COALESCE(SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END),0) AS skipped,
                COALESCE(SUM(CASE WHEN status='skipped' AND last_error=$2 THEN 1 ELSE 0 END),0) AS stopped,
                MIN(sent_at) AS first_sent_at,
                MAX(sent_at) AS last_sent_at
           FROM crm_customer_outbox
          WHERE entity='product' AND entity_id = r.id
       ) o ON true
      ORDER BY r.id DESC
      LIMIT $1`, [Math.max(1, Math.min(100, Number(limit) || 20)), CANCEL_NOTE])).rows;
  return rows.map((r) => runView(r));
}

/** 실행 1행 → 화면용 성과 값. (순수 함수 — 테스트가 직접 부른다) */
export function runView(r, now = Date.now()) {
  const n = (v) => Number(v) || 0;
  const total = n(r.total_lotes);
  const sent = n(r.sent), failed = n(r.failed), pending = n(r.pending);
  const skipped = n(r.skipped), stopped = n(r.stopped), retrying = n(r.retrying);
  const target = Math.max(0, total - stopped);
  const started = r.created_at ? new Date(r.created_at).getTime() : null;
  const last = r.last_sent_at ? new Date(r.last_sent_at).getTime() : null;
  const end = pending > 0 ? now : (last || started);
  const elapsedSec = started && end ? Math.max(0, Math.round((end - started) / 1000)) : 0;
  const state = pending > 0 ? 'running'
    : (stopped > 0 ? 'stopped' : (failed > 0 ? 'done_errors' : 'done'));
  return {
    id: Number(r.id),
    envio_id: r.envio_id,
    fecha_corte: typeof r.fecha_corte === 'string' ? r.fecha_corte : new Date(r.fecha_corte).toISOString().slice(0, 10),
    mode: r.mode,
    origin: r.origin,
    total_productos: n(r.total_productos),
    total_lotes: total,
    batch_size: n(r.batch_size),
    env: r.env,
    by_login: r.by_login || null,
    created_at: r.created_at,
    pending, sent, failed, skipped, stopped, retrying,
    first_sent_at: r.first_sent_at || null,
    last_sent_at: r.last_sent_at || null,
    state,
    elapsed_sec: elapsedSec,
    per_min: elapsedSec > 0 ? Math.round((sent / elapsedSec) * 60) : null,
    success_pct: target > 0 ? Math.round((sent / target) * 1000) / 10 : null,
    progress_pct: total > 0 ? Math.round(((total - pending) / total) * 1000) / 10 : null,
  };
}

/** 실행 1건의 실패·재시도 사유 상위 N개 — 「이번 전송에서 무엇이 거절됐나」. */
export async function runErrors(runId, { limit = 8 } = {}) {
  const rows = (await query(
    `SELECT status, http_status, codigo_error, left(COALESCE(last_error,''), 160) AS reason,
            COUNT(*)::int AS n, MAX(attempts)::int AS max_attempts, MIN(entity_label) AS example
       FROM crm_customer_outbox
      WHERE entity='product' AND entity_id=$1
        AND (status='failed' OR (status='pending' AND attempts > 0))
      GROUP BY 1,2,3,4
      ORDER BY n DESC
      LIMIT $2`, [Number(runId), Math.max(1, Math.min(50, Number(limit) || 8))])).rows;
  return rows.map((r) => ({
    status: r.status,
    http_status: r.http_status == null ? null : Number(r.http_status),
    codigo_error: r.codigo_error, reason: r.reason, count: Number(r.n),
    max_attempts: Number(r.max_attempts), example: r.example,
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
