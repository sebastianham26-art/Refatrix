// =====================================================================
// Refatrix ERP · productDims.js — 제품 무게 · 개별 박스 사이즈 (0327 · 2026-11-18 디렉터 요청)
//
//   ① 제품마스터 업로드 탭 「📦 무게 · 박스 사이즈」 — 엑셀 → 미리보기 → 반영 · 양식/현재값 다운로드
//   ② 견적 건별 대략 총무게 · 총사이즈(가로 × 세로 × 높이) — 견적 목록 · 상세가 같은 함수를 쓴다
//
//   칸 규칙(양식 안내문과 같다)
//   · 빈 칸 = 바꾸지 않음 · 「-」 = 값 지우기 · 같은 CTR 여러 줄 = 마지막 줄
//   · 무게 kg(머리글에 g 가 있으면 그램으로 읽어 kg 로) · 사이즈 cm(머리글에 mm 면 mm 로 읽어 cm 로)
//   · 소수점은 「.」 또는 「,」 둘 다(1,5 = 1.5). 「30x20x10」 한 칸 표기도 받는다(Medidas 열)
//
//   대략 사이즈 계산(estimate)
//   · 순부피 = Σ 수량 × 가로 × 세로 × 높이
//   · 포장부피 = 순부피 ÷ 채움률 0.85 (크기 다른 박스는 빈틈 없이 쌓이지 않는다)
//   · 모양 = 정육면체에 가깝게 — 단, 가장 큰 박스의 긴 변 · 중간 변 · 짧은 변보다 작아지지 않게
//   · 1개뿐이면 그 박스 사이즈 그대로
//   · 자료 없는 줄은 빼고 「무게 자료 없음 n줄」 · 「사이즈 자료 없음 n줄」로 알린다(추정해서 채우지 않는다)
// =====================================================================
import { query } from './db.js';

export const DIM_FIELDS = ['weight_kg', 'box_l_cm', 'box_w_cm', 'box_h_cm'];
export const FIELD_LABEL = { weight_kg: '무게(kg)', box_l_cm: '가로(cm)', box_w_cm: '세로(cm)', box_h_cm: '높이(cm)' };
export const LIMITS = { weight_kg: 500, box_l_cm: 300, box_w_cm: 300, box_h_cm: 300 };
export const FILL_RATE = 0.85;          // 포장부피 = 순부피 ÷ 0.85
export const VOL_DIVISOR = 5000;        // 부피무게(paquetería) = 가로×세로×높이(cm) ÷ 5000

// 양식 머리글(다운로드 · 파서 공통)
export const TEMPLATE_HEADERS = ['Clave CTR', 'Peso (kg)', 'Largo (cm)', 'Ancho (cm)', 'Alto (cm)'];

// ── 0327 적용 여부(마이그레이션 전 서버에서도 견적 목록이 깨지지 않게) ─────────
let readyCache = { v: null, at: 0 };
export async function dimsReady(exec = query) {
  const now = Date.now();
  if (readyCache.v === true) return true;
  if (readyCache.v === false && now - readyCache.at < 60000) return false;   // 없으면 1분마다 다시 본다
  try {
    const r = await exec(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'products'
          AND column_name IN ('weight_kg','box_l_cm','box_w_cm','box_h_cm')`);
    readyCache = { v: Number(r.rows[0].n) === 4, at: now };
  } catch (_) { readyCache = { v: false, at: now }; }
  return readyCache.v;
}
export function _resetDimsReady() { readyCache = { v: null, at: 0 }; }

// ── 머리글 해석 ─────────────────────────────────────────────────────
const fold = (v) => String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC')
  .toLowerCase().trim();
const keyOf = (v) => fold(v).replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9가-힣]/g, '');

const HEAD_WORDS = {
  code: ['clavectr', 'ctr', 'codigoctr', 'codigo', 'clave', 'code', 'sku', 'claveskus', 'clavesku', '제품코드', '코드', 'ctr코드', '품번'],
  weight_kg: ['peso', 'pesokg', 'pesounitario', 'pesog', 'pesogr', 'weight', 'weightkg', 'kg', '무게', '중량', '무게kg', '개당무게', '단위무게'],
  box_l_cm: ['largo', 'largocm', 'length', 'longitud', 'l', '가로', '가로cm', '길이'],
  box_w_cm: ['ancho', 'anchocm', 'width', 'w', '세로', '세로cm', '폭'],
  box_h_cm: ['alto', 'altocm', 'altura', 'height', 'h', '높이', '높이cm'],
  dims: ['medidas', 'medida', 'medidascaja', 'medidasdecaja', 'dimensiones', 'dimensions', 'dimension', 'size', 'boxsize',
    '사이즈', '박스사이즈', '규격', '박스규격', '치수', 'lxwxh', 'largoxanchoxalto', '가로세로높이', '가로x세로x높이'],
};
const HEAD_MAP = new Map();
for (const [f, words] of Object.entries(HEAD_WORDS)) for (const w of words) HEAD_MAP.set(w, f);

/** 머리글 칸 → { field, scale } | null.  scale = 값에 곱해 kg · cm 로 만드는 수 */
export function headerField(cell) {
  const raw = fold(cell);
  if (!raw) return null;
  const k = keyOf(cell);
  let field = HEAD_MAP.get(k) || null;
  if (!field) {
    // 「Peso unitario (kg)」 처럼 앞말이 맞으면 인정(코드 칸은 정확히 맞아야 한다)
    for (const f of ['weight_kg', 'box_l_cm', 'box_w_cm', 'box_h_cm', 'dims']) {
      if (HEAD_WORDS[f].some((w) => w.length >= 4 && k.startsWith(w))) { field = f; break; }
    }
  }
  if (!field) return null;
  let scale = 1;
  if (field === 'weight_kg') {
    if (/\(\s*(g|gr|grs|gramos?|grams?|그램)\s*\)|\bgramos?\b|\bgrams?\b|그램/.test(raw) || k === 'pesog' || k === 'pesogr') scale = 0.001;
    else if (/\(\s*(lb|lbs)\s*\)|\blbs?\b|libras?/.test(raw)) scale = 0.45359237;
  } else if (field !== 'code') {
    if (/\(\s*mm\s*\)|\bmm\b|밀리/.test(raw)) scale = 0.1;
    else if (/\(\s*m\s*\)|\bmetros?\b/.test(raw)) scale = 100;
    else if (/\(\s*(in|inch|pulg)\s*\)|pulgadas?|inch/.test(raw)) scale = 2.54;
  }
  return { field, scale };
}

const CLEAR = new Set(['-', '–', '—', '삭제', 'clear', 'borrar', 'null']);

/** 숫자 칸 → { skip } | { clear } | { value } | { error } */
export function parseNum(raw, field, scale = 1) {
  if (raw == null) return { skip: true };
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { error: '숫자가 아님' };
    return checkRange(raw * scale, field, raw);
  }
  let s = String(raw).trim();
  if (!s) return { skip: true };
  if (CLEAR.has(s.toLowerCase())) return { clear: true };
  s = s.replace(/\s+/g, '').replace(/(kgs?|grs?|g|cms?|mm|kilos?)$/i, '');
  if (/^\d+,\d+$/.test(s)) s = s.replace(',', '.');           // 1,5 → 1.5 (소수점 쉼표)
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');   // 1,234.5
  if (!/^\d*\.?\d+$/.test(s)) return { error: `숫자가 아님: "${String(raw).trim()}"` };
  return checkRange(Number(s) * scale, field, raw);
}
function checkRange(n, field, raw) {
  if (!(n > 0)) return { error: `0 보다 커야 함: "${String(raw).trim()}"` };
  const lim = LIMITS[field];
  if (lim && n > lim) return { error: `${FIELD_LABEL[field] || field} ${round(n, 3)} — 너무 큼(최대 ${lim})` };
  const dec = field === 'weight_kg' ? 3 : 1;
  const v = round(n, dec);
  if (!(v > 0)) return { error: `너무 작음: "${String(raw).trim()}"` };
  return { value: v };
}

/** 「30x20x10」 · 「30 × 20 × 10 cm」 · 「30*20*10」 → [30,20,10] */
export function parseDimsCell(raw, scale = 1) {
  if (raw == null) return { skip: true };
  const s0 = String(raw).trim();
  if (!s0) return { skip: true };
  if (CLEAR.has(s0.toLowerCase())) return { clear: true };
  const s = s0.toLowerCase().replace(/cm|mm/g, '').replace(/,(?=\d)/g, '.');
  const parts = s.split(/\s*[x×*✕]\s*/).filter((p) => p !== '');
  if (parts.length !== 3) return { error: `사이즈는 「가로x세로x높이」 3개 숫자: "${s0}"` };
  const out = [];
  const flds = ['box_l_cm', 'box_w_cm', 'box_h_cm'];
  for (let i = 0; i < 3; i++) {
    const r = parseNum(parts[i], flds[i], scale);
    if (r.error) return { error: `사이즈 "${s0}" — ${r.error}` };
    if (!r.value) return { error: `사이즈 "${s0}" 를 읽을 수 없음` };
    out.push(r.value);
  }
  return { value: out };
}

export const normCode = (v) => String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '');

/**
 * 2차원 표(엑셀 첫 시트) → { rows:[{row, code, set:{field:value|null}}], errors:[{row, code, msg}], headerless, columns, dup }
 *   머리글이 없으면 순서 = CTR · 무게 · 가로 · 세로 · 높이
 */
export function tableToRows(table) {
  const t = Array.isArray(table) ? table.filter((r) => Array.isArray(r)) : [];
  let hIdx = -1; let cols = null;
  for (let i = 0; i < Math.min(t.length, 15); i++) {
    const m = {};
    t[i].forEach((c, j) => { const h = headerField(c); if (h && !(h.field in m)) m[h.field] = { idx: j, scale: h.scale }; });
    const hasVal = ['weight_kg', 'box_l_cm', 'box_w_cm', 'box_h_cm', 'dims'].some((f) => f in m);
    if ('code' in m && hasVal) { hIdx = i; cols = m; break; }
  }
  const headerless = hIdx < 0;
  if (headerless) cols = { code: { idx: 0, scale: 1 }, weight_kg: { idx: 1, scale: 1 }, box_l_cm: { idx: 2, scale: 1 }, box_w_cm: { idx: 3, scale: 1 }, box_h_cm: { idx: 4, scale: 1 } };
  const byCode = new Map(); const errors = []; let dup = 0;
  for (let i = hIdx + 1; i < t.length; i++) {
    const r = t[i];
    const code = normCode(r[cols.code.idx]);
    if (!code) continue;
    if (headerless && i === 0 && !/\d/.test(code)) continue;    // 머리글 같은 첫 줄(숫자 없는 코드) 건너뜀
    const set = {}; const errs = [];
    if (cols.dims) {
      const d = parseDimsCell(r[cols.dims.idx], cols.dims.scale);
      if (d.error) errs.push(d.error);
      else if (d.clear) { set.box_l_cm = null; set.box_w_cm = null; set.box_h_cm = null; }
      else if (d.value) { [set.box_l_cm, set.box_w_cm, set.box_h_cm] = d.value; }
    }
    for (const f of DIM_FIELDS) {
      if (!cols[f]) continue;
      const p = parseNum(r[cols[f].idx], f, cols[f].scale);
      if (p.error) errs.push(`${FIELD_LABEL[f]} ${p.error}`);
      else if (p.clear) set[f] = null;
      else if (p.value != null) set[f] = p.value;
    }
    const rowNo = i + 1;    // 엑셀 줄 번호
    if (errs.length) { errors.push({ row: rowNo, code, msg: errs.join(' · ') }); continue; }
    if (!Object.keys(set).length) continue;    // 모두 빈 칸 = 바꿀 것 없음
    if (byCode.has(code)) dup++;
    byCode.set(code, { row: rowNo, code, set: { ...(byCode.get(code)?.set || {}), ...set } });
  }
  const columns = Object.keys(cols).filter((k) => k !== 'code');
  return { rows: [...byCode.values()], errors, headerless, columns, dup };
}

// ── 미리보기 · 반영 ─────────────────────────────────────────────────
const numOrNull = (v) => (v == null || v === '' ? null : Number(v));
const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-9);

/** rows(tableToRows) → { items:[{code, product_id, name, changes:[{field, old, new}]}], unknown:[code], same:n } */
export async function previewDims(exec, rows) {
  const codes = [...new Set(rows.map((r) => r.code))];
  const cur = new Map();
  if (codes.length) {
    const res = await exec(
      `SELECT id, code, name, weight_kg, box_l_cm, box_w_cm, box_h_cm
         FROM products WHERE deleted_at IS NULL AND UPPER(REPLACE(code,' ','')) = ANY($1::text[])`, [codes]);
    for (const p of res.rows) cur.set(normCode(p.code), p);
  }
  const items = []; const unknown = []; let sameN = 0;
  for (const r of rows) {
    const p = cur.get(r.code);
    if (!p) { unknown.push({ row: r.row, code: r.code }); continue; }
    const changes = [];
    for (const f of DIM_FIELDS) {
      if (!(f in r.set)) continue;
      const o = numOrNull(p[f]); const n = r.set[f];
      if (!same(o, n)) changes.push({ field: f, old: o, new: n });
    }
    if (!changes.length) { sameN++; continue; }
    items.push({ row: r.row, code: p.code, product_id: Number(p.id), name: p.name || '', changes });
  }
  return { items, unknown, same: sameN };
}

/** 한 트랜잭션 안에서 실행(exec = client.query.bind(client)). 미리보기를 다시 계산해 반영한다. */
export async function applyDims(exec, rows, { userId = null, source = 'excel' } = {}) {
  const pv = await previewDims(exec, rows);
  const batch = 'dims-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6);
  let fieldsChanged = 0;
  for (const it of pv.items) {
    const sets = []; const args = [it.product_id];
    for (const ch of it.changes) { args.push(ch.new); sets.push(`${ch.field} = $${args.length}`); }
    args.push(userId);
    await exec(`UPDATE products SET ${sets.join(', ')}, dims_updated_at = now(), dims_updated_by = $${args.length} WHERE id = $1`, args);
    for (const ch of it.changes) {
      await exec(
        `INSERT INTO product_dims_log (batch_id, product_id, code, field, old_value, new_value, source, changed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [batch, it.product_id, it.code, ch.field, ch.old, ch.new, source, userId]);
      fieldsChanged++;
    }
  }
  return { batch_id: batch, products: pv.items.length, fields: fieldsChanged, unknown: pv.unknown, same: pv.same };
}

/** 현재값 다운로드 — 전체 제품(삭제 제외) */
export async function exportDims(exec = query) {
  const r = await exec(
    `SELECT p.code, p.name, p.weight_kg, p.box_l_cm, p.box_w_cm, p.box_h_cm, p.is_active,
            to_char(p.dims_updated_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD HH24:MI') AS updated_at
       FROM products p WHERE p.deleted_at IS NULL ORDER BY p.code`);
  const items = r.rows.map((p) => ({
    code: p.code, name: p.name || '', is_active: p.is_active !== false,
    weight_kg: numOrNull(p.weight_kg), box_l_cm: numOrNull(p.box_l_cm), box_w_cm: numOrNull(p.box_w_cm), box_h_cm: numOrNull(p.box_h_cm),
    updated_at: p.updated_at || null,
  }));
  const stat = { total: items.length, weight: 0, dims: 0, both: 0 };
  for (const it of items) {
    const w = it.weight_kg > 0; const d = it.box_l_cm > 0 && it.box_w_cm > 0 && it.box_h_cm > 0;
    if (w) stat.weight++; if (d) stat.dims++; if (w && d) stat.both++;
  }
  return { items, stat };
}

// ── 견적 무게 · 사이즈 ──────────────────────────────────────────────
function round(n, d = 1) { const k = 10 ** d; return Math.round(Number(n) * k) / k; }

/** 견적 줄 → 집계(목록 SQL 의 LATERAL 과 같은 모양) */
export function aggregateLines(lines) {
  const a = { pcs: 0, wt: 0, wt_pcs: 0, wt_miss: 0, wt_miss_qty: 0, vol: 0, d_pcs: 0, d_miss: 0, d_miss_qty: 0, d_a: 0, d_b: 0, d_c: 0, unreg: 0, unreg_qty: 0 };
  for (const l of lines || []) {
    const q = Number(l.qty) || 0;
    if (q <= 0) continue;
    if (l.product_id == null) { a.unreg++; a.unreg_qty += q; continue; }
    a.pcs += q;
    const w = Number(l.weight_kg) || 0;
    if (w > 0) { a.wt += q * w; a.wt_pcs += q; } else { a.wt_miss++; a.wt_miss_qty += q; }
    const s = [Number(l.box_l_cm) || 0, Number(l.box_w_cm) || 0, Number(l.box_h_cm) || 0];
    if (s.every((x) => x > 0)) {
      s.sort((x, y) => y - x);
      a.vol += q * s[0] * s[1] * s[2]; a.d_pcs += q;
      a.d_a = Math.max(a.d_a, s[0]); a.d_b = Math.max(a.d_b, s[1]); a.d_c = Math.max(a.d_c, s[2]);
    } else { a.d_miss++; a.d_miss_qty += q; }
  }
  return a;
}

/** 집계 → 화면용 { weight_kg, dims:{l,w,h}, vol_m3, vol_weight_kg, … } (자료가 하나도 없으면 null) */
export function estimateShipment(agg) {
  const n = (k) => Number(agg && agg[k]) || 0;
  const pcs = n('pcs'); const wtPcs = n('wt_pcs'); const dPcs = n('d_pcs');
  if (!wtPcs && !dPcs) {
    return (pcs || n('unreg')) ? { weight_kg: null, dims: null, pcs, wt_miss: n('wt_miss'), wt_miss_qty: n('wt_miss_qty'), d_miss: n('d_miss'), d_miss_qty: n('d_miss_qty'), unreg: n('unreg'), unreg_qty: n('unreg_qty'), nodata: true } : null;
  }
  let dims = null; let volM3 = null; let volW = null; let netM3 = null;
  if (dPcs > 0) {
    const a = n('d_a'); const b = n('d_b'); const c = n('d_c'); const V = n('vol');
    let L; let W; let H;
    if (dPcs === 1) { L = a; W = b; H = c; }
    else {
      const Vp = V / FILL_RATE;
      L = Math.max(Math.cbrt(Vp), a);
      W = Math.max(Math.sqrt(Vp / L), b);
      H = Math.max(Vp / (L * W), c);
      if (W > L) [L, W] = [W, L];
    }
    const up = (x) => Math.ceil(x - 1e-9);
    dims = { l: up(L), w: up(W), h: up(H) };
    volM3 = round(dims.l * dims.w * dims.h / 1e6, 3);
    netM3 = round(V / 1e6, 3);
    volW = round(dims.l * dims.w * dims.h / VOL_DIVISOR, 1);
  }
  return {
    weight_kg: wtPcs > 0 ? round(n('wt'), 1) : null,
    dims, vol_m3: volM3, net_m3: netM3, vol_weight_kg: volW,
    pcs, wt_pcs: wtPcs, d_pcs: dPcs,
    wt_miss: n('wt_miss'), wt_miss_qty: n('wt_miss_qty'), d_miss: n('d_miss'), d_miss_qty: n('d_miss_qty'),
    unreg: n('unreg'), unreg_qty: n('unreg_qty'),
  };
}

/** 견적 목록 SQL 조각 — 0327 이 있을 때만 붙인다. (q = quotes 별칭) */
export const SHIP_SELECT = `, shp.pcs AS shp_pcs, shp.wt AS shp_wt, shp.wt_pcs AS shp_wt_pcs, shp.wt_miss AS shp_wt_miss, shp.wt_miss_qty AS shp_wt_miss_qty,
              shp.vol AS shp_vol, shp.d_pcs AS shp_d_pcs, shp.d_miss AS shp_d_miss, shp.d_miss_qty AS shp_d_miss_qty,
              shp.d_a AS shp_d_a, shp.d_b AS shp_d_b, shp.d_c AS shp_d_c, shp.unreg AS shp_unreg, shp.unreg_qty AS shp_unreg_qty`;
const DOK = `(p.box_l_cm > 0 AND p.box_w_cm > 0 AND p.box_h_cm > 0)`;
const G = `GREATEST(p.box_l_cm, p.box_w_cm, p.box_h_cm)`;
const LST = `LEAST(p.box_l_cm, p.box_w_cm, p.box_h_cm)`;
export const SHIP_JOIN = `
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(ql.qty) FILTER (WHERE ql.product_id IS NOT NULL), 0)                                   AS pcs,
                  COALESCE(SUM(ql.qty * p.weight_kg) FILTER (WHERE p.weight_kg > 0), 0)                               AS wt,
                  COALESCE(SUM(ql.qty) FILTER (WHERE p.weight_kg > 0), 0)                                             AS wt_pcs,
                  COUNT(*) FILTER (WHERE ql.product_id IS NOT NULL AND COALESCE(p.weight_kg, 0) <= 0)::int            AS wt_miss,
                  COALESCE(SUM(ql.qty) FILTER (WHERE ql.product_id IS NOT NULL AND COALESCE(p.weight_kg, 0) <= 0), 0) AS wt_miss_qty,
                  COALESCE(SUM(ql.qty * p.box_l_cm * p.box_w_cm * p.box_h_cm) FILTER (WHERE ${DOK}), 0)               AS vol,
                  COALESCE(SUM(ql.qty) FILTER (WHERE ${DOK}), 0)                                                      AS d_pcs,
                  COUNT(*) FILTER (WHERE ql.product_id IS NOT NULL AND NOT COALESCE(${DOK}, FALSE))::int              AS d_miss,
                  COALESCE(SUM(ql.qty) FILTER (WHERE ql.product_id IS NOT NULL AND NOT COALESCE(${DOK}, FALSE)), 0)   AS d_miss_qty,
                  COALESCE(MAX(${G}) FILTER (WHERE ${DOK}), 0)                                                        AS d_a,
                  COALESCE(MAX(p.box_l_cm + p.box_w_cm + p.box_h_cm - ${G} - ${LST}) FILTER (WHERE ${DOK}), 0)        AS d_b,
                  COALESCE(MAX(${LST}) FILTER (WHERE ${DOK}), 0)                                                      AS d_c,
                  COUNT(*) FILTER (WHERE ql.product_id IS NULL)::int                                                  AS unreg,
                  COALESCE(SUM(ql.qty) FILTER (WHERE ql.product_id IS NULL), 0)                                       AS unreg_qty
             FROM quote_lines ql LEFT JOIN products p ON p.id = ql.product_id
            WHERE ql.quote_id = q.id AND ql.qty > 0
         ) shp ON TRUE`;

/** 목록 행(shp_* 칸) → estimateShipment */
export function shipFromRow(r) {
  const agg = {};
  for (const k of ['pcs', 'wt', 'wt_pcs', 'wt_miss', 'wt_miss_qty', 'vol', 'd_pcs', 'd_miss', 'd_miss_qty', 'd_a', 'd_b', 'd_c', 'unreg', 'unreg_qty']) agg[k] = Number(r['shp_' + k]) || 0;
  return estimateShipment(agg);
}
