// =====================================================================
// Refatrix ERP · pfVehicles.js — REFATRIX Platform 신규 차종 (0346 · 2026-11-27)
//   POST /api/pf-catalog/vehicles   신규 차종 받기(있으면 200 existed · 없으면 201)
//   GET  /api/pf-catalog/vehicles?q= 받은 차종 + ERP 에서 연결된 제품 수 · 적용차종 연식
//   그리고 제품찾기(차종) 목록 보충 — app-makers · app-models · app-years · vehicle-map 이 이 표도 함께 읽는다.
//
//   같은 차종 판정: 이름 키(vehicleMap.nameKey — 대소문자 · 공백 · 하이픈 · 점 · 악센트 무시)의 메이커|모델,
//                   또는 같은 ref. 제품찾기와 같은 키라서 'Geely Emgrand' = 'GEELY EMGRAND' = 'geely-emgrand'.
//   제품 연결은 이 표가 아니라 제품 마스터 적용차종(products.app → product_applications) 그대로다.
//   가격 · 재고 · 제품 데이터는 읽지도 쓰지도 않는다(oe 매칭 후보 조회만 — 코드만 돌려준다).
// =====================================================================
import { query } from './db.js';
import { nameKey, NK_SQL, MK_PARTS_SQL } from './vehicleMap.js';
import { normOe } from './oeParse.js';

let readyFlag = false; let probeAt = 0;
/** 0346 적용 여부 — 긍정은 영구 캐시, 부정은 30초마다 다시 본다(반쪽배포 안전장치). */
export async function pfVehReady(exec = query) {
  if (readyFlag) return true;
  if (Date.now() - probeAt < 30000) return false;
  probeAt = Date.now();
  try { readyFlag = !!(await exec(`SELECT to_regclass('public.pf_vehicles') AS t`)).rows[0]?.t; } catch (_) { readyFlag = false; }
  return readyFlag;
}
export function setPfVehReady(v) { readyFlag = !!v; probeAt = Date.now(); }

const txt = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const yearOf = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1950 && n <= 2100 ? n : undefined;   // undefined = 잘못된 값
};
const intOf = (v) => { const n = Number(v); return Number.isFinite(n) && Math.abs(n) < 2e9 ? Math.round(n) : null; };

/** 요청 본문 → 저장값. 오류면 { error } */
export function normVehicleInput(b) {
  const src = b && typeof b === 'object' ? b : {};
  const brand = txt(src.brand, 80);
  const model = txt(src.model, 120);
  const brandKey = nameKey(brand), modelKey = nameKey(model);
  if (!brand || !model || !brandKey || !modelKey) return { error: 'brand/model 필수' };
  const yf = yearOf(src.year_from), yt = yearOf(src.year_to);
  if (yf === undefined || yt === undefined) return { error: 'year_from/year_to 는 1950~2100 정수 또는 null' };
  if (yf != null && yt != null && yt < yf) return { error: 'year_to 가 year_from 보다 앞섭니다' };
  const oe = (Array.isArray(src.oe) ? src.oe : []).slice(0, 300).map((o) => {
    const x = o && typeof o === 'object' ? o : {};
    const price = Number(x.price);
    return { cat: txt(x.cat, 60), pos: txt(x.pos, 60), oe: txt(x.oe, 60), price: Number.isFinite(price) ? price : null, src: txt(x.src, 200) };
  }).filter((o) => o.oe || o.cat);
  const kind = txt(src.kind, 20) || 'passenger';
  return {
    brand, model, brand_key: brandKey, model_key: modelKey, norm_key: brandKey + '|' + modelKey,
    year_from: yf, year_to: yt == null ? null : yt,
    segment: txt(src.segment, 60), origin: txt(src.origin, 60), kind,
    source: txt(src.source, 60), ref: txt(src.ref, 160) || null,
    sales_ytd: src.sales_ytd == null || src.sales_ytd === '' ? null : intOf(src.sales_ytd),
    oe,
  };
}

const OUT_COLS = `id, brand, model, year_from, year_to, segment, origin, kind, source, ref, sales_ytd, oe_ref, created_by,
                  to_char(created_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS created_at`;
function outRow(r) {
  if (!r) return null;
  return {
    id: Number(r.id), brand: r.brand, model: r.model,
    year_from: r.year_from == null ? null : Number(r.year_from), year_to: r.year_to == null ? null : Number(r.year_to),
    segment: r.segment || '', origin: r.origin || '', kind: r.kind || '', source: r.source || '', ref: r.ref || null,
    sales_ytd: r.sales_ytd == null ? null : Number(r.sales_ytd), created_by: r.created_by || '', created_at: r.created_at || null,
    oe_ref: Array.isArray(r.oe_ref) ? r.oe_ref : [],
  };
}

/** 플랫폼 OE → ERP 제품 마스터 OE 와 같은 번호의 제품 후보(코드만). */
export async function oeMatches(oeList, exec = query) {
  const norms = [...new Set((oeList || []).map((o) => normOe(o && o.oe)).filter((n) => n && n.length >= 4))];
  if (!norms.length) return [];
  try {
    const rows = (await exec(
      `SELECT DISTINCT p.code, o.oe_code, o.oe_norm FROM product_oe_codes o
         JOIN products p ON p.id = o.product_id AND p.deleted_at IS NULL
        WHERE o.oe_norm = ANY($1::text[]) ORDER BY p.code LIMIT 200`, [norms])).rows;
    return rows.map((r) => ({ code: r.code, oe: r.oe_code }));
  } catch (_) { return []; }   // 0228 전(OE 분해표 없음) — 후보 없이 진행
}

/**
 * 받기 — 같은 ref 또는 같은 이름 키가 있으면 그것(existed:true · 바꾸지 않음), 없으면 새로 만든다.
 *   동시에 두 번 오면 ON CONFLICT 로 하나만 생기고, 늦은 쪽은 existed 로 돌려준다.
 */
export async function receiveVehicle(v, { by = '' } = {}, exec = query) {
  const find = async () => (await exec(
    `SELECT ${OUT_COLS} FROM pf_vehicles WHERE norm_key = $1 OR ($2::text IS NOT NULL AND ref = $2) ORDER BY (ref = $2) DESC NULLS LAST, id LIMIT 1`,
    [v.norm_key, v.ref])).rows[0];
  const ex = await find();
  if (ex) return { existed: true, vehicle: outRow(ex) };
  const ins = (await exec(
    `INSERT INTO pf_vehicles (brand, model, brand_key, model_key, norm_key, year_from, year_to, segment, origin, kind, source, ref, sales_ytd, oe_ref, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
     ON CONFLICT DO NOTHING
     RETURNING ${OUT_COLS}`,
    [v.brand, v.model, v.brand_key, v.model_key, v.norm_key, v.year_from, v.year_to, v.segment, v.origin, v.kind,
      v.source, v.ref, v.sales_ytd, JSON.stringify(v.oe || []), String(by || '').slice(0, 80)])).rows[0];
  if (ins) return { existed: false, vehicle: outRow(ins) };
  const again = await find();
  return { existed: true, vehicle: outRow(again) };
}

/**
 * 목록 — 받은 차종마다 ERP 에서 그 차종(메이커 낱개 · 모델 이름 키)에 연결된 제품 수와 적용차종 연식 범위.
 *   year_from/year_to 는 플랫폼이 보낸 값 그대로, app_year_from/app_year_to 는 ERP 제품 마스터에서 다듬은 값.
 */
export async function listVehicles({ q = '', limit = 500 } = {}, exec = query) {
  const params = [];
  let where = '';
  const qq = txt(q, 80);
  if (qq) {
    params.push('%' + qq + '%', '%' + nameKey(qq) + '%');
    where = `WHERE (v.brand || ' ' || v.model) ILIKE $1 OR v.ref ILIKE $1 OR (v.brand_key || v.model_key) LIKE $2`;
  }
  const lim = Math.max(1, Math.min(2000, parseInt(limit, 10) || 500));
  const rows = (await exec(
    `SELECT v.id, v.brand, v.model, v.year_from, v.year_to, v.segment, v.origin, v.kind, v.source, v.ref, v.sales_ytd, v.created_by,
            to_char(v.created_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS created_at,
            COALESCE(a.n, 0) AS products, a.y0, a.y1
       FROM pf_vehicles v
       LEFT JOIN LATERAL (
         SELECT COUNT(DISTINCT pa.product_id)::int AS n, MIN(pa.year_from) AS y0, MAX(pa.year_to) AS y1
           FROM product_applications pa JOIN products p ON p.id = pa.product_id AND p.deleted_at IS NULL
          WHERE ${NK_SQL('pa.model')} = v.model_key
            AND EXISTS (SELECT 1 FROM unnest(${MK_PARTS_SQL('pa.maker')}) AS mkp(x) WHERE ${NK_SQL('mkp.x')} = v.brand_key)
       ) a ON true
       ${where}
      ORDER BY v.brand_key, v.model_key
      LIMIT ${lim}`, params)).rows;
  return rows.map((r) => ({
    id: Number(r.id), brand: r.brand, model: r.model,
    year_from: r.year_from == null ? null : Number(r.year_from), year_to: r.year_to == null ? null : Number(r.year_to),
    segment: r.segment || '', origin: r.origin || '', kind: r.kind || '', source: r.source || '', ref: r.ref || null,
    sales_ytd: r.sales_ytd == null ? null : Number(r.sales_ytd), created_by: r.created_by || '', created_at: r.created_at,
    products: Number(r.products) || 0,
    app_year_from: r.y0 == null ? null : Number(r.y0), app_year_to: r.y1 == null ? null : Number(r.y1),
  }));
}

// ── 제품찾기 목록 보충 (표가 없으면 빈 목록 — 기존 동작 그대로) ─────────────────────
const curYear = () => new Date().getFullYear();
/** 메이커 드롭다운 보충 — [{k, v, n:0}] (n 은 제품 적용 건수가 아니므로 0) */
export async function extraMakerRows(exec = query) {
  if (!(await pfVehReady(exec))) return [];
  try {
    return (await exec(`SELECT brand_key AS k, brand AS v FROM pf_vehicles GROUP BY 1, 2`)).rows.map((r) => ({ k: r.k, v: r.v, n: 0, pf: true }));
  } catch (_) { return []; }
}
/** 모델 드롭다운 보충 — 메이커 키 · 연식(선택). 연식을 고르면 범위 안(끝 연식 비면 열린 범위)만, 시작 연식이 없는 차종은 연식 미선택일 때만. */
export async function extraModelRows({ makerKey = '', year = null } = {}, exec = query) {
  if (!(await pfVehReady(exec))) return [];
  const params = []; const conds = ['true'];
  if (makerKey) { params.push(makerKey); conds.push(`brand_key = $${params.length}`); }
  if (year != null) { params.push(year); conds.push(`year_from IS NOT NULL AND year_from <= $${params.length} AND (year_to IS NULL OR year_to >= $${params.length})`); }
  try {
    return (await exec(`SELECT model_key AS k, model AS v FROM pf_vehicles WHERE ${conds.join(' AND ')} GROUP BY 1, 2`, params))
      .rows.map((r) => ({ k: r.k, v: r.v, n: 0, pf: true }));
  } catch (_) { return []; }
}
/** 연식 드롭다운 보충 — 끝 연식이 비면 올해 + 1 까지 */
export async function extraYears({ makerKey = '', modelKey = '' } = {}, exec = query) {
  if (!(await pfVehReady(exec))) return [];
  const params = [curYear() + 1]; const conds = ['year_from IS NOT NULL'];
  if (makerKey) { params.push(makerKey); conds.push(`brand_key = $${params.length}`); }
  if (modelKey) { params.push(modelKey); conds.push(`model_key = $${params.length}`); }
  try {
    return (await exec(
      `SELECT DISTINCT y FROM pf_vehicles, generate_series(year_from, GREATEST(year_from, COALESCE(year_to, $1::int))) AS y
        WHERE ${conds.join(' AND ')}`, params)).rows.map((r) => Number(r.y));
  } catch (_) { return []; }
}
/** 차량 도면 — 고른 차종이 플랫폼 신규 차종이면 그 기록(연결된 제품이 없을 때 안내 · OE 참고). */
export async function vehicleRef({ maker = '', model = '' } = {}, exec = query) {
  if (!(await pfVehReady(exec))) return null;
  const bk = nameKey(maker), mk = nameKey(model);
  if (!bk || !mk) return null;
  try {
    const r = (await exec(`SELECT ${OUT_COLS} FROM pf_vehicles WHERE brand_key = $1 AND model_key = $2 LIMIT 1`, [bk, mk])).rows[0];
    return outRow(r);
  } catch (_) { return null; }
}
