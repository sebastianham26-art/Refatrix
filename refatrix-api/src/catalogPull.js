// 카탈로그 조회 API (0221) — 고객이 우리 카탈로그를 읽어 가는 방향.
//
//   계약서: Contrato_API_Catalogo_Multimarca_v1.0 (멀티브랜드 비교 플랫폼 · 매주 토요일 05:00~09:00)
//
//   설계에서 양보하지 않은 것 세 가지
//     1) **가격을 저장하지 않는다.** precioCompra 는 호출이 들어온 그 순간
//        customers.discount 로 계산한다. 디렉터가 고객 마스터의 할인율을 고치면
//        다음 호출부터 자동으로 바뀐 가격이 나간다. 어디에도 복사본이 없으니 어긋날 수가 없다.
//     2) **청구서와 같은 공식**을 쓴다(sales.js computeLine 과 동일):
//          단가 = 반올림2( 정가 × (1 − 할인율/100) )
//        API 가격과 인보이스 가격이 다르면 그 연동은 신뢰를 잃는다.
//     3) **키가 고객을 가리킨다.** 키 1개 = catalog_api_clients 1행 = customers 1행.
//        키를 모르면 가격도 없다.
import { query } from './db.js';
import { getEndpoint } from './integrations.js';
import { PRODUCT_KEY, imageUrlFor } from './productSync.js';

// 멕시코 중부시간 — 서머타임 폐지(2022) 이후 연중 UTC−6 고정.
export const MX_OFFSET_MIN = -360;

/** 지금의 멕시코 날짜·요일·시각. dow: 0=일 … 6=토 */
export function mxParts(now = Date.now()) {
  const m = new Date(now + MX_OFFSET_MIN * 60000);
  return {
    ymd: m.toISOString().slice(0, 10),
    dow: m.getUTCDay(),
    hour: m.getUTCHours(),
    minute: m.getUTCMinutes(),
  };
}

/** 멕시코 로컬 시각 → ISO 문자열(-06:00 표기). 상대가 그대로 스케줄러에 넣을 수 있게. */
export function mxIso(ymd, hour = 0, minute = 0) {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${ymd}T${hh}:${mm}:00-06:00`;
}

function addDaysYmd(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 접속창 판정.
 *   @returns {{open:boolean, periodKey:string, nextOpen:string}}
 *   periodKey  — 이 접속창을 식별하는 값(멕시코 날짜). 「한 창에 한 번」을 세는 열쇠다.
 *   nextOpen   — 다음에 열리는 시각. 닫혀 있을 때 상대에게 그대로 돌려준다.
 */
export function windowState(client, now = Date.now()) {
  const p = mxParts(now);
  const start = Number(client.window_start_hour);
  const end = Number(client.window_end_hour);
  const dow = client.window_dow == null ? null : Number(client.window_dow);
  const dayOk = dow == null || dow === p.dow;
  const hourOk = p.hour >= start && p.hour < end;

  if (!client.window_enforced) return { open: true, periodKey: p.ymd, nextOpen: mxIso(p.ymd, start) };

  // 다음 개방 시각 — 오늘 아직 안 열렸으면 오늘, 아니면 다음 해당 요일.
  let nextYmd = p.ymd;
  if (dayOk && p.hour < start) {
    // 오늘 이따가 열린다
  } else {
    const step = dow == null ? 1 : ((dow - p.dow + 7) % 7) || 7;
    nextYmd = addDaysYmd(p.ymd, step);
  }
  return { open: dayOk && hourOk, periodKey: p.ymd, nextOpen: mxIso(nextYmd, start) };
}

/** 코드 정규화 — 하이픈·공백·마침표를 빼고 대문자로. 검색 대조용. */
export function normCode(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** 소수 2자리 반올림. node-pg 가 NUMERIC 을 문자열로 주므로 Number() 를 먼저 태운다. */
export function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * 구매단가 = 반올림2( 정가 × (1 − 할인율/100) ).
 *   할인율이 비어 있거나 0이면 **0% 로 본다** — 정가와 같은 값이 나간다(디렉터 결정 2026-09-15).
 *   할인율이 범위를 벗어나면(음수·100 초과) 0 으로 본다. 이상한 마스터 값이
 *   고객에게 이상한 가격으로 나가는 것보다, 정가가 나가고 화면에 경고가 남는 편이 낫다.
 */
export function purchasePrice(listPrice, discountPct) {
  const list = round2(listPrice);
  const d = Number(discountPct);
  const pct = Number.isFinite(d) && d > 0 && d < 100 ? d : 0;
  return round2(list * (1 - pct / 100));
}

/** 할인율 표시값 — 계산에 쓴 값 그대로(0 포함). */
export function usedDiscount(discountPct) {
  const d = Number(discountPct);
  return Number.isFinite(d) && d > 0 && d < 100 ? Math.round(d * 100) / 100 : 0;
}

// 장착 위치 — ERP 에 전용 칼럼이 없다. 제품명에서 알아본다(계약서 11항 1안).
//   판별이 안 되면 null 을 보낸다. 틀린 값을 지어내지 않는다.
const POSICIONES = [
  ['INFERIOR', 'Inferior'], ['SUPERIOR', 'Superior'],
  ['DELANTER', 'Delantera'], ['TRASER', 'Trasera'],
  ['DERECH', 'Derecha'], ['IZQUIERD', 'Izquierda'],
  ['INTERIOR', 'Interior'], ['EXTERIOR', 'Exterior'],
  ['CENTRAL', 'Central'],
];
export function posicionMontaje(descripcion) {
  const t = String(descripcion == null ? '' : descripcion).toUpperCase();
  const hit = [];
  for (const [needle, label] of POSICIONES) if (t.includes(needle)) hit.push(label);
  return hit.length ? hit.join(' / ') : null;
}

/**
 * 재고 구간 — 고객에게 **정확한 수량을 주지 않는다**(디렉터 결정 2026-09-17).
 *   0 · 1-5 · 6-10 · 11-20 · 21-50 · 51-100 · 101+
 *
 *   제품전송(CRM)의 stockRange 와 경계가 다르다 — 그쪽은 이미 운영 중인 다른 계약이라
 *   건드리지 않는다. 같은 함수를 공유했다가 한쪽을 고치면 다른 쪽이 조용히 바뀐다.
 *   소수 재고는 내림, 음수는 0.
 */
export function catalogStockRange(qty) {
  const n = Math.trunc(Number(qty));
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n <= 5) return '1-5';
  if (n <= 10) return '6-10';
  if (n <= 20) return '11-20';
  if (n <= 50) return '21-50';
  if (n <= 100) return '51-100';
  return '101+';
}

/**
 * 재고 표기. 기본은 **구간**(계약서 10항).
 *   'qty' 로 바꾸면 정확한 수량(숫자)이 나간다 — 그때는 필드 타입이 문자열에서 숫자로
 *   바뀌므로 상대 개발자에게 미리 알려야 한다.
 */
export function stockValue(qty, mode) {
  if (mode === 'qty') {
    const n = Number(qty);
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  }
  return catalogStockRange(qty);
}

/** 커서 — 상대에게는 불투명한 문자열이다. 안에는 마지막으로 보낸 제품 id 만 들어 있다. */
export function encodeCursor(id) {
  return Buffer.from(JSON.stringify({ id: Number(id) }), 'utf8').toString('base64url');
}
export function decodeCursor(s) {
  if (!s) return null;
  try {
    const o = JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));
    const id = Number(o && o.id);
    return Number.isFinite(id) && id >= 0 ? id : null;
  } catch (_) { return null; }
}

/** 페이지 크기 정리 — 상대가 이상한 값을 보내도 서버가 죽지 않는다. */
export function pageLimit(asked, dflt = 500) {
  const n = Number(asked);
  if (!Number.isFinite(n) || n <= 0) return Math.max(10, Math.min(1000, Number(dflt) || 500));
  return Math.max(10, Math.min(1000, Math.trunc(n)));
}

/**
 * 계약서 6항의 제품 객체를 만든다.
 *   row       — products 한 줄
 *   refs      — [{marca, codigo}]
 *   apps      — product_applications 줄들
 *   opt       — { discount, stockMode, imgBase }
 */
export function buildProducto(row, refs, apps, opt = {}) {
  const descripcion = String(row.name || '').trim();
  const listPrice = round2(row.list_price);
  return {
    codigo: String(row.code || '').trim(),
    descripcion,
    activo: row.is_active !== false,

    referencias: (refs || []).map((r) => ({
      marca: String(r.brand || '').trim() || 'SIN MARCA',
      codigo: String(r.xref_code || '').trim(),
    })).filter((r) => r.codigo),

    aplicaciones: (apps || []).map((a) => ({
      marca: String(a.maker || '').trim() || null,
      modelo: String(a.model || '').trim() || null,
      anioDesde: a.year_from == null ? null : Number(a.year_from),
      anioHasta: a.year_to == null ? null : Number(a.year_to),
      nota: notaOf(a.app_text),
    })),
    aplicacionesTexto: String(row.app || '').trim(),

    precio: {
      moneda: 'MXN',
      precioLista: listPrice,
      precioCompra: purchasePrice(listPrice, opt.discount),
      ivaPorcentaje: row.iva_rate == null ? 16 : Number(row.iva_rate),
      ivaIncluido: false,
    },

    existencia: stockValue(row.stock_qty, opt.stockMode),

    caracteristicas: {
      material: row.material == null || String(row.material).trim() === ''
        ? null : String(row.material).trim(),
      posicionMontaje: posicionMontaje(descripcion),
    },

    imagenUrl: imageUrlFor(opt.imgBase, row.code) || null,
    actualizado: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

/** 적용차종 원문의 대괄호 주석만 뽑는다 — [perno grueso] → perno grueso */
export function notaOf(appText) {
  const m = String(appText == null ? '' : appText).match(/\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

// ─────────────────────────── 조회 (DB) ───────────────────────────

const PRODUCT_COLS = `SELECT p.id, p.code, p.name, p.app, p.scode, p.list_price, p.stock_qty,
                             p.is_active, p.iva_rate, p.material, p.updated_at
                        FROM products p
                       WHERE p.deleted_at IS NULL AND p.code IS NOT NULL AND p.code <> ''`;

/** 키로 고객사를 찾는다. 찾은 순간 **고객 마스터의 지금 할인율**을 함께 읽는다. */
export async function clientByToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  const r = (await query(
    `SELECT c.*, cu.name AS customer_name, cu.code AS customer_code, cu.discount AS customer_discount
       FROM catalog_api_clients c
       LEFT JOIN customers cu ON cu.id = c.customer_id AND cu.deleted_at IS NULL
      WHERE c.token_prod = $1 OR c.token_test = $1
      LIMIT 1`, [t])).rows[0];
  if (!r) return null;
  const env = r.token_prod === t ? 'prod' : 'test';
  return { ...r, env };
}

/** 관리 화면·미리보기용 — id 로 같은 모양을 만든다. */
export async function clientById(id) {
  const r = (await query(
    `SELECT c.*, cu.name AS customer_name, cu.code AS customer_code, cu.discount AS customer_discount
       FROM catalog_api_clients c
       LEFT JOIN customers cu ON cu.id = c.customer_id AND cu.deleted_at IS NULL
      WHERE c.id = $1`, [Number(id)])).rows[0];
  return r || null;
}

/** 사진 주소 규칙 — 고객사별 값이 없으면 제품전송 연동의 값을 그대로 쓴다. */
export async function imgBaseFor(client) {
  const own = String(client.img_base_url || '').trim();
  if (own) return own;
  try {
    const ep = await getEndpoint(PRODUCT_KEY);
    return String((ep && ep.img_base_url) || '').trim();
  } catch (_) { return ''; }
}

/**
 * 내보내지 않을 제품코드 접두어. 기본은 `PRO` (디렉터 결정 2026-09-17).
 *   고객에게 보내면 안 되는 코드군을 **화면에서** 지정한다. 콤마로 여러 개.
 *   대소문자는 구분하지 않는다.
 */
export function excludePrefixes(client) {
  const v = client ? client.exclude_prefixes : undefined;
  // 칼럼이 아직 없는 환경(0223 마이그레이션 전)에서는 **안전한 쪽**으로 — PRO 를 막는다.
  if (v === undefined) return ['PRO'];
  // 화면에서 비우면(null·'') 제외 없이 전부 내보낸다. 사람이 일부러 지운 것이다.
  if (v === null) return [];
  return String(v).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
}

/**
 * 제외 조건을 SQL 로 만든다. params 배열에 값을 밀어 넣고 조각을 돌려준다.
 *   호출부가 params 를 공유하므로 $n 번호가 어긋나지 않는다.
 */
function excludeSql(client, params) {
  const list = excludePrefixes(client);
  if (!list.length) return '';
  params.push(list.map((x) => `${x}%`));
  return ` AND upper(p.code) NOT LIKE ALL($${params.length}::text[])`;
}

/**
 * 대응품번을 어디서 가져오는가 (디렉터 결정 2026-09-19).
 *   'scode' (기본) — products.scode. **제품/마케팅 화면의 「경쟁사 코드」와 같은 값**이다.
 *                    ' // ' 로 여러 개, 전부 marca 'SYD'.
 *   'xref'         — product_xref_codes (BAW·GROB·VASLO·KYB·MOOG·YOKOMITSU…).
 *                    그 표는 「아무 경쟁사 코드나 입력해도 CTR 제품을 찾는」 역매칭용으로 쌓은 것이라
 *                    화면이 보여 주는 목록과 다르다.
 *   'both'         — 둘을 합치고 같은 코드는 한 번만.
 */
export function refSource(client) {
  const v = client && client.ref_source != null ? String(client.ref_source).trim().toLowerCase() : '';
  return ['scode', 'xref', 'both'].includes(v) ? v : 'scode';
}

/** products.scode → [{brand:'SYD', xref_code}] · ' // ' 구분, 빈 값 제거, 중복 제거. */
export function scodeRefs(scode) {
  const seen = new Set();
  return String(scode == null ? '' : scode)
    .split(/\s*\/\/\s*/)
    .map((x) => x.trim())
    .filter((x) => {
      if (!x) return false;
      const k = x.toUpperCase();
      if (seen.has(k)) return false;
      seen.add(k); return true;
    })
    .map((x) => ({ brand: 'SYD', xref_code: x }));
}

function brandFilter(client) {
  const raw = String(client.brands || '').trim();
  if (!raw) return null;
  const list = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  return list.length ? list : null;
}

/**
 * 한 페이지 — id 오름차순 커서.
 *   코드가 아니라 id 로 도는 이유: 제품명이나 코드가 바뀌어도 순서가 흔들리지 않는다.
 *   @returns {{productos:Array, lastId:number|null}}
 */
export async function fetchPage(client, { afterId = null, limit = 500 } = {}) {
  const params = [];
  let sql = PRODUCT_COLS;
  if (!client.include_inactive) sql += ` AND p.is_active IS NOT FALSE`;
  sql += excludeSql(client, params);
  if (afterId != null) { params.push(afterId); sql += ` AND p.id > $${params.length}`; }
  sql += ` ORDER BY p.id LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 500))}`;
  const rows = (await query(sql, params)).rows;
  return {
    productos: await decorate(client, rows),
    lastId: rows.length ? Number(rows[rows.length - 1].id) : null,
  };
}

/** 단건 — 코드로. 대소문자·앞뒤 공백은 흡수한다. */
export async function fetchOne(client, codigo) {
  const code = String(codigo || '').trim();
  if (!code) return null;
  const params = [code];
  let sql = `${PRODUCT_COLS} AND upper(p.code) = upper($1)`;
  if (!client.include_inactive) sql += ` AND p.is_active IS NOT FALSE`;
  // 제외 접두어에 걸리면 단건 조회로도 못 보게 한다 — 목록에만 없고 직접 조회는 되면 구멍이다.
  sql += excludeSql(client, params);
  const rows = (await query(`${sql} LIMIT 1`, params)).rows;
  const list = await decorate(client, rows);
  return list[0] || null;
}

/** 전체 건수 — 상대가 total 로 진행률을 보여 줄 수 있어야 한다. */
export async function countProducts(client) {
  const params = [];
  let sql = `SELECT count(*)::int AS n FROM products p
              WHERE p.deleted_at IS NULL AND p.code IS NOT NULL AND p.code <> ''`;
  if (!client.include_inactive) sql += ` AND p.is_active IS NOT FALSE`;
  sql += excludeSql(client, params);
  return Number((await query(sql, params)).rows[0].n) || 0;
}

/** 공개 중인 대응품번 브랜드 목록. */
export async function listBrands(client) {
  const src = refSource(client);
  const acc = new Map();
  const add = (marca, n) => acc.set(marca, (acc.get(marca) || 0) + Number(n || 0));

  // 실제로 내보내는 출처만 센다 — 목록에는 있는데 응답에는 없는 브랜드가 생기면 안 된다.
  if (src === 'scode' || src === 'both') {
    const params = [];
    let sql = `SELECT count(*)::int AS n FROM products p
                WHERE p.deleted_at IS NULL AND COALESCE(btrim(p.scode),'') <> ''`;
    if (!client.include_inactive) sql += ` AND p.is_active IS NOT FALSE`;
    sql += excludeSql(client, params);
    add('SYD', (await query(sql, params)).rows[0].n);
  }
  if (src === 'xref' || src === 'both') {
    const only = brandFilter(client);
    const rows = (await query(
      `SELECT COALESCE(NULLIF(btrim(brand),''),'SIN MARCA') AS marca, count(*)::int AS n
         FROM product_xref_codes GROUP BY 1 ORDER BY 1`)).rows;
    for (const r of rows) {
      if (only && !only.includes(String(r.marca).toUpperCase())) continue;
      add(r.marca, r.n);
    }
  }
  return [...acc.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([marca, productos]) => ({ marca, productos }));
}

/** 제품 줄들에 대응품번·적용차종을 붙여 계약서 모양으로 만든다(N+1 질의를 피한다). */
async function decorate(client, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.id));
  const only = brandFilter(client);
  const src = refSource(client);

  let refs = [];
  if (src === 'xref' || src === 'both') {
    const refParams = [ids];
    let refSql = `SELECT product_id, xref_code, COALESCE(NULLIF(btrim(brand),''),'SIN MARCA') AS brand
                    FROM product_xref_codes WHERE product_id = ANY($1::bigint[])`;
    if (only) { refParams.push(only); refSql += ` AND upper(COALESCE(brand,'SIN MARCA')) = ANY($2::text[])`; }
    refSql += ` ORDER BY brand, xref_code`;
    refs = (await query(refSql, refParams)).rows;
  }

  const apps = (await query(
    `SELECT product_id, app_text, maker, model, year_from, year_to
       FROM product_applications WHERE product_id = ANY($1::bigint[])
      ORDER BY maker, model, year_from`, [ids])).rows;

  const byRef = new Map(); const byApp = new Map();
  for (const r of refs) {
    const k = Number(r.product_id);
    if (!byRef.has(k)) byRef.set(k, []);
    byRef.get(k).push(r);
  }
  // 화면과 같은 출처(products.scode) — 'both' 면 xref 와 합치되 같은 코드는 한 번만.
  if (src === 'scode' || src === 'both') {
    for (const row of rows) {
      const k = Number(row.id);
      if (!byRef.has(k)) byRef.set(k, []);
      const bucket = byRef.get(k);
      const seen = new Set(bucket.map((x) => String(x.xref_code).toUpperCase()));
      for (const r of scodeRefs(row.scode)) {
        if (seen.has(r.xref_code.toUpperCase())) continue;
        seen.add(r.xref_code.toUpperCase());
        bucket.push({ product_id: k, ...r });
      }
    }
  }
  for (const a of apps) {
    const k = Number(a.product_id);
    if (!byApp.has(k)) byApp.set(k, []);
    byApp.get(k).push(a);
  }

  const imgBase = await imgBaseFor(client);
  const opt = { discount: client.customer_discount, stockMode: client.stock_mode, imgBase };
  return rows.map((r) => buildProducto(r, byRef.get(Number(r.id)) || [], byApp.get(Number(r.id)) || [], opt));
}

// ─────────────────────── 접속창·회차·이력 (DB) ───────────────────────

/**
 * 이번 접속창의 회차를 연다(없으면 만든다).
 *   @returns {{ok:boolean, run:object|null, reason:string|null}}
 *   테스트 키는 회차를 소모하지 않는다 — 평일에도 몇 번이든 붙어 볼 수 있어야 한다.
 */
export async function openRun(client, periodKey, env) {
  if (env === 'test') return { ok: true, run: null, reason: null };
  const existing = (await query(
    `SELECT * FROM catalog_api_runs WHERE client_id=$1 AND period_key=$2 AND env=$3`,
    [client.id, periodKey, env])).rows[0];
  if (existing) {
    if (existing.closed_at) return { ok: false, run: existing, reason: 'ya_sincronizado' };
    return { ok: true, run: existing, reason: null };
  }
  const run = (await query(
    `INSERT INTO catalog_api_runs (client_id, period_key, env) VALUES ($1,$2,$3) RETURNING *`,
    [client.id, periodKey, env])).rows[0];
  return { ok: true, run, reason: null };
}

/** 페이지를 하나 보냈다. 마지막 페이지(done)면 그 자리에서 회차를 닫는다. */
export async function advanceRun(run, items, done) {
  if (!run) return;
  await query(
    `UPDATE catalog_api_runs
        SET pages = pages + 1, productos = productos + $2,
            closed_at = CASE WHEN $3 THEN now() ELSE closed_at END
      WHERE id = $1`, [run.id, Number(items) || 0, !!done]);
}

/** 이 접속창 안에서 이 고객사가 몇 번 호출했나 — 레이트리밋 판정용. */
export async function callsInWindow(clientId, sinceIso) {
  const r = (await query(
    `SELECT count(*)::int AS n FROM catalog_api_calls
      WHERE client_id=$1 AND created_at >= $2`, [clientId, sinceIso])).rows[0];
  return Number(r.n) || 0;
}

/** 호출 1건 기록. 기록 실패가 응답을 막지 않는다. */
export async function logCall(rec) {
  try {
    await query(
      `INSERT INTO catalog_api_calls
         (client_id, remote_ip, env, path, query, http_status, codigo_error, items, ms, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [rec.client_id || null, rec.remote_ip || null, rec.env || null,
       rec.path || null, rec.query || null, rec.http_status || null,
       rec.codigo_error || null, rec.items == null ? null : Number(rec.items),
       rec.ms == null ? null : Number(rec.ms), rec.note || null]);
  } catch (_) { /* 이력 실패가 연동을 끊지 않는다 */ }
}

/** IP 제한 — 비어 있으면 제한하지 않는다. */
export function ipAllowed(client, ip) {
  const raw = String(client.ip_allow || '').trim();
  if (!raw) return true;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const got = String(ip || '').trim();
  return list.some((a) => got === a || got.startsWith(a));
}

/** 이 표가 아직 없는 환경(마이그레이션 전)에서도 서버가 죽지 않게. */
let ready = false; let probe = 0;
export async function catalogTablesReady() {
  if (ready) return true;
  if (Date.now() - probe < 30000) return false;
  probe = Date.now();
  try {
    const r = await query(
      `SELECT 1 FROM information_schema.tables WHERE table_name='catalog_api_clients' LIMIT 1`);
    ready = r.rows.length > 0;
  } catch (_) { ready = false; }
  return ready;
}
