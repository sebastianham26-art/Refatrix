// =====================================================================
// Refatrix ERP · productDims.js — 제품 무게 · 포장 박스 코드 · 포장 박스 마스터
//   0327 (2026-11-18) 제품 무게 · 개별 박스 사이즈
//   0328 (2026-11-18 디렉터 지시) 제품에는 가로·세로·높이 대신 「포장 박스 코드」를 넣고,
//        박스 코드별 사이즈는 포장 박스 마스터에 나중에 넣는다 → 사이즈는 박스 마스터로 계산.
//
//   ① 제품마스터 업로드 탭 「📦 제품 무게 · 포장 박스 코드」  (Clave CTR · Peso (kg) · Caja)
//   ② 같은 탭 「📐 포장 박스 마스터」                         (Código caja · Largo · Ancho · Alto · Descripción)
//   ③ 견적 건별 대략 총무게 · 총사이즈 — 견적 목록 · 상세가 같은 함수를 쓴다
//
//   칸 규칙(양식 안내문과 같다)
//   · 빈 칸 = 바꾸지 않음 · 「-」 = 값 지우기 · 같은 코드 여러 줄 = 마지막 줄
//   · 무게 kg(머리글에 g 면 그램) · 사이즈 cm(머리글에 mm 면 mm) · 소수점 「.」「,」 둘 다
//   · 박스 코드는 대문자 · 앞뒤 공백 제거로 맞춘다(「caja 3」 = 「CAJA 3」)
//
//   대략 사이즈 계산(estimate)
//   · 순부피 = Σ 수량 × (그 제품 박스의) 가로 × 세로 × 높이
//   · 포장부피 = 순부피 ÷ 채움률 0.85 → 정육면체에 가깝게, 가장 큰 박스보다 작지 않게 · 1개면 그 박스 그대로
//   · 박스 코드가 없거나 박스 사이즈가 아직 없는 줄은 빼고 개수만 알린다(추정해서 채우지 않는다)
// =====================================================================
import { query } from './db.js';

export const DIM_FIELDS = ['weight_kg', 'box_code'];              // 제품 업로드가 바꾸는 칸
export const BOX_FIELDS = ['box_l_cm', 'box_w_cm', 'box_h_cm', 'description'];
export const FIELD_LABEL = { weight_kg: '무게(kg)', box_code: '박스 코드', box_l_cm: '가로(cm)', box_w_cm: '세로(cm)', box_h_cm: '높이(cm)', description: '설명' };
export const LIMITS = { weight_kg: 500, box_l_cm: 300, box_w_cm: 300, box_h_cm: 300 };
export const FILL_RATE = 0.85;
export const VOL_DIVISOR = 5000;

export const TEMPLATE_HEADERS = ['Clave CTR', 'Peso (kg)', 'Caja'];
export const BOX_TEMPLATE_HEADERS = ['Código caja', 'Largo (cm)', 'Ancho (cm)', 'Alto (cm)', 'Descripción'];

// ── 0327 + 0328 적용 여부(마이그레이션 전 서버에서도 견적 목록이 깨지지 않게) ─────
let readyCache = { v: null, at: 0 };
export async function dimsReady(exec = query) {
  const now = Date.now();
  if (readyCache.v === true) return true;
  if (readyCache.v === false && now - readyCache.at < 60000) return false;
  try {
    const r = await exec(
      `SELECT (SELECT COUNT(*) FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'products'
                  AND column_name IN ('weight_kg','box_code'))::int AS c,
              (SELECT COUNT(*) FROM information_schema.tables
                WHERE table_schema = current_schema() AND table_name = 'packing_boxes')::int AS t`);
    readyCache = { v: Number(r.rows[0].c) === 2 && Number(r.rows[0].t) === 1, at: now };
  } catch (_) { readyCache = { v: false, at: now }; }
  return readyCache.v;
}
export function _resetDimsReady() { readyCache = { v: null, at: 0 }; }

// ── 머리글 해석 ─────────────────────────────────────────────────────
const fold = (v) => String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC')
  .toLowerCase().trim();
const keyOf = (v) => fold(v).replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9가-힣]/g, '');

const W_WEIGHT = ['peso', 'pesokg', 'pesounitario', 'pesog', 'pesogr', 'weight', 'weightkg', 'kg', '무게', '중량', '무게kg', '개당무게', '단위무게'];
const W_BOXCODE = ['caja', 'cajas', 'codigocaja', 'clavecaja', 'cajacodigo', 'tipodecaja', 'tipocaja', 'empaque', 'box', 'boxcode', 'boxname',
  '박스', '박스코드', '박스명', '박스명칭', '포장박스', '포장박스코드', '포장박스명칭', '포장박스명'];
const W_L = ['largo', 'largocm', 'length', 'longitud', 'l', '가로', '가로cm', '길이'];
const W_W = ['ancho', 'anchocm', 'width', 'w', '세로', '세로cm', '폭'];
const W_H = ['alto', 'altocm', 'altura', 'height', 'h', '높이', '높이cm'];
const W_DIMS = ['medidas', 'medida', 'medidascaja', 'medidasdecaja', 'dimensiones', 'dimensions', 'dimension', 'size', 'boxsize',
  '사이즈', '박스사이즈', '규격', '박스규격', '치수', 'lxwxh', 'largoxanchoxalto', '가로세로높이', '가로x세로x높이'];
const W_DESC = ['descripcion', 'description', 'nombre', 'nombrecaja', 'notas', 'nota', '설명', '비고', '메모'];

const HEAD_WORDS = {
  // 제품 업로드: CTR 코드 · 무게 · 박스 코드 (가로·세로·높이 열이 있어도 읽지 않는다 — 사이즈는 박스 마스터)
  product: {
    code: ['clavectr', 'ctr', 'codigoctr', 'codigo', 'clave', 'code', 'sku', 'clavesku', '제품코드', '코드', 'ctr코드', '품번'],
    weight_kg: W_WEIGHT, box_code: W_BOXCODE,
  },
  // 박스 마스터 업로드: 박스 코드 · 가로 · 세로 · 높이 · 설명
  box: {
    code: W_BOXCODE.concat(['codigo', 'clave', 'code', '코드']),
    box_l_cm: W_L, box_w_cm: W_W, box_h_cm: W_H, dims: W_DIMS, description: W_DESC,
  },
};
const PREFIX_FIELDS = { product: ['weight_kg', 'box_code'], box: ['box_l_cm', 'box_w_cm', 'box_h_cm', 'dims', 'description'] };
const MAPS = {};
for (const [mode, fields] of Object.entries(HEAD_WORDS)) {
  MAPS[mode] = new Map();
  for (const [f, words] of Object.entries(fields)) for (const w of words) if (!MAPS[mode].has(w)) MAPS[mode].set(w, f);
}

/** 머리글 칸 → { field, scale } | null.  scale = 값에 곱해 kg · cm 로 만드는 수 */
export function headerField(cell, mode = 'product') {
  const raw = fold(cell);
  if (!raw) return null;
  const k = keyOf(cell);
  let field = MAPS[mode].get(k) || null;
  if (!field) {
    for (const f of PREFIX_FIELDS[mode]) {
      if (HEAD_WORDS[mode][f].some((w) => w.length >= 4 && k.startsWith(w))) { field = f; break; }
    }
  }
  if (!field) return null;
  let scale = 1;
  if (field === 'weight_kg') {
    if (/\(\s*(g|gr|grs|gramos?|grams?|그램)\s*\)|\bgramos?\b|\bgrams?\b|그램/.test(raw) || k === 'pesog' || k === 'pesogr') scale = 0.001;
    else if (/\(\s*(lb|lbs)\s*\)|\blbs?\b|libras?/.test(raw)) scale = 0.45359237;
  } else if (['box_l_cm', 'box_w_cm', 'box_h_cm', 'dims'].includes(field)) {
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
  if (/^\d+,\d+$/.test(s)) s = s.replace(',', '.');
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  if (!/^\d*\.?\d+$/.test(s)) return { error: `숫자가 아님: "${String(raw).trim()}"` };
  return checkRange(Number(s) * scale, field, raw);
}
function checkRange(n, field, raw) {
  if (!(n > 0)) return { error: `0 보다 커야 함: "${String(raw).trim()}"` };
  const lim = LIMITS[field];
  if (lim && n > lim) return { error: `${FIELD_LABEL[field] || field} ${round(n, 3)} — 너무 큼(최대 ${lim})` };
  const v = round(n, field === 'weight_kg' ? 3 : 1);
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
  const out = []; const flds = ['box_l_cm', 'box_w_cm', 'box_h_cm'];
  for (let i = 0; i < 3; i++) {
    const r = parseNum(parts[i], flds[i], scale);
    if (r.error) return { error: `사이즈 "${s0}" — ${r.error}` };
    if (!r.value) return { error: `사이즈 "${s0}" 를 읽을 수 없음` };
    out.push(r.value);
  }
  return { value: out };
}

export const normCode = (v) => String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '');
/** 박스 코드: 대문자 · 공백 하나로 · 40자 */
export const normBox = (v) => String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, ' ');
export function parseText(raw, { box = false, max = 200 } = {}) {
  if (raw == null) return { skip: true };
  const s = String(raw).trim();
  if (!s) return { skip: true };
  if (CLEAR.has(s.toLowerCase())) return { clear: true };
  const v = box ? normBox(s) : s.replace(/\s+/g, ' ');
  if (box && v.length > 40) return { error: `박스 코드가 너무 김(40자): "${s}"` };
  return { value: v.slice(0, max) };
}

/**
 * 2차원 표(엑셀 첫 시트) → { rows:[{row, code, set}], errors, headerless, columns, dup }
 *   mode 'product' : 머리글이 없으면 CTR · 무게 · 박스 코드 순
 *   mode 'box'     : 머리글이 없으면 박스 코드 · 가로 · 세로 · 높이 · 설명 순
 */
export function tableToRows(table, mode = 'product') {
  const t = Array.isArray(table) ? table.filter((r) => Array.isArray(r)) : [];
  const valFields = mode === 'box' ? ['box_l_cm', 'box_w_cm', 'box_h_cm', 'dims', 'description'] : ['weight_kg', 'box_code'];
  let hIdx = -1; let cols = null;
  for (let i = 0; i < Math.min(t.length, 15); i++) {
    const m = {};
    t[i].forEach((c, j) => { const h = headerField(c, mode); if (h && !(h.field in m)) m[h.field] = { idx: j, scale: h.scale }; });
    if ('code' in m && valFields.some((f) => f in m)) { hIdx = i; cols = m; break; }
  }
  const headerless = hIdx < 0;
  if (headerless) {
    cols = mode === 'box'
      ? { code: { idx: 0, scale: 1 }, box_l_cm: { idx: 1, scale: 1 }, box_w_cm: { idx: 2, scale: 1 }, box_h_cm: { idx: 3, scale: 1 }, description: { idx: 4, scale: 1 } }
      : { code: { idx: 0, scale: 1 }, weight_kg: { idx: 1, scale: 1 }, box_code: { idx: 2, scale: 1 } };
  }
  const byCode = new Map(); const errors = []; let dup = 0;
  for (let i = hIdx + 1; i < t.length; i++) {
    const r = t[i];
    const code = mode === 'box' ? normBox(r[cols.code.idx]) : normCode(r[cols.code.idx]);
    if (!code) continue;
    if (headerless && i === 0 && (mode === 'box' ? headerField(r[0], 'box') : !/\d/.test(code))) continue;   // 머리글 같은 첫 줄
    if (mode === 'box' && code.length > 40) { errors.push({ row: i + 1, code, msg: '박스 코드가 너무 김(40자)' }); continue; }
    const set = {}; const errs = [];
    if (cols.dims) {
      const d = parseDimsCell(r[cols.dims.idx], cols.dims.scale);
      if (d.error) errs.push(d.error);
      else if (d.clear) { set.box_l_cm = null; set.box_w_cm = null; set.box_h_cm = null; }
      else if (d.value) { [set.box_l_cm, set.box_w_cm, set.box_h_cm] = d.value; }
    }
    for (const f of ['weight_kg', 'box_l_cm', 'box_w_cm', 'box_h_cm']) {
      if (!cols[f]) continue;
      const p = parseNum(r[cols[f].idx], f, cols[f].scale);
      if (p.error) errs.push(`${FIELD_LABEL[f]} ${p.error}`);
      else if (p.clear) set[f] = null;
      else if (p.value != null) set[f] = p.value;
    }
    for (const f of ['box_code', 'description']) {
      if (!cols[f]) continue;
      const p = parseText(r[cols[f].idx], { box: f === 'box_code' });
      if (p.error) errs.push(p.error);
      else if (p.clear) set[f] = null;
      else if (p.value != null) set[f] = p.value;
    }
    const rowNo = i + 1;
    if (errs.length) { errors.push({ row: rowNo, code, msg: errs.join(' · ') }); continue; }
    if (!Object.keys(set).length && mode !== 'box') continue;    // 제품: 모두 빈 칸 = 바꿀 것 없음 (박스: 코드만 적어도 등록)
    if (byCode.has(code)) dup++;
    byCode.set(code, { row: rowNo, code, set: { ...(byCode.get(code)?.set || {}), ...set } });
  }
  const columns = Object.keys(cols).filter((k) => k !== 'code');
  return { rows: [...byCode.values()], errors, headerless, columns, dup };
}

// ── 공통 ────────────────────────────────────────────────────────────
const numOrNull = (v) => (v == null || v === '' ? null : Number(v));
const sameVal = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'number' || typeof b === 'number') return Math.abs(Number(a) - Number(b)) < 1e-9;
  return String(a) === String(b);
};
const newBatch = (p) => p + '-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6);

// ── 제품 무게 · 박스 코드 : 미리보기 · 반영 ─────────────────────────
/** → { items:[{code, product_id, name, changes}], unknown:[{row,code}], same, new_boxes:[code], nosize_boxes:[code] } */
export async function previewDims(exec, rows) {
  const codes = [...new Set(rows.map((r) => r.code))];
  const cur = new Map();
  if (codes.length) {
    const res = await exec(
      `SELECT id, code, name, weight_kg, box_code
         FROM products WHERE deleted_at IS NULL AND UPPER(REPLACE(code,' ','')) = ANY($1::text[])`, [codes]);
    for (const p of res.rows) cur.set(normCode(p.code), p);
  }
  const items = []; const unknown = []; let same = 0; const boxesUsed = new Set();
  for (const r of rows) {
    const p = cur.get(r.code);
    if (!p) { unknown.push({ row: r.row, code: r.code }); continue; }
    if (r.set.box_code) boxesUsed.add(r.set.box_code);
    const changes = [];
    for (const f of DIM_FIELDS) {
      if (!(f in r.set)) continue;
      const o = f === 'weight_kg' ? numOrNull(p[f]) : (p[f] || null); const n = r.set[f];
      if (!sameVal(o, n)) changes.push({ field: f, old: o, new: n });
    }
    if (!changes.length) { same++; continue; }
    items.push({ row: r.row, code: p.code, product_id: Number(p.id), name: p.name || '', changes });
  }
  // 박스 마스터 대조 — 없는 박스 · 사이즈 없는 박스(나중에 박스 마스터에서 넣으면 계산된다)
  const newBoxes = []; const nosize = [];
  if (boxesUsed.size) {
    const b = await exec(`SELECT code, box_l_cm, box_w_cm, box_h_cm FROM packing_boxes WHERE code = ANY($1::text[])`, [[...boxesUsed]]);
    const m = new Map(b.rows.map((x) => [x.code, x]));
    for (const c of [...boxesUsed].sort()) {
      const x = m.get(c);
      if (!x) newBoxes.push(c);
      else if (!(Number(x.box_l_cm) > 0 && Number(x.box_w_cm) > 0 && Number(x.box_h_cm) > 0)) nosize.push(c);
    }
  }
  return { items, unknown, same, new_boxes: newBoxes, nosize_boxes: nosize };
}

/** 한 트랜잭션 안에서 실행(exec = client.query.bind(client)). 새 박스 코드는 박스 마스터에 사이즈 빈 채로 만든다. */
export async function applyDims(exec, rows, { userId = null, source = 'excel' } = {}) {
  const pv = await previewDims(exec, rows);
  const batch = newBatch('dims');
  let fieldsChanged = 0;
  for (const c of pv.new_boxes) {
    await exec(`INSERT INTO packing_boxes (code, updated_by) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING`, [c, userId]);
    await exec(`INSERT INTO packing_box_log (batch_id, box_code, field, old_value, new_value, changed_by) VALUES ($1,$2,'(new)',NULL,'product upload',$3)`, [batch, c, userId]);
  }
  for (const it of pv.items) {
    const sets = []; const args = [it.product_id];
    for (const ch of it.changes) { args.push(ch.new); sets.push(`${ch.field} = $${args.length}`); }
    args.push(userId);
    await exec(`UPDATE products SET ${sets.join(', ')}, dims_updated_at = now(), dims_updated_by = $${args.length} WHERE id = $1`, args);
    for (const ch of it.changes) {
      const num = ch.field === 'weight_kg';
      await exec(
        `INSERT INTO product_dims_log (batch_id, product_id, code, field, old_value, new_value, old_text, new_text, source, changed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [batch, it.product_id, it.code, ch.field, num ? ch.old : null, num ? ch.new : null, num ? null : ch.old, num ? null : ch.new, source, userId]);
      fieldsChanged++;
    }
  }
  return { batch_id: batch, products: pv.items.length, fields: fieldsChanged, unknown: pv.unknown, same: pv.same,
    new_boxes: pv.new_boxes, nosize_boxes: pv.nosize_boxes };
}

/** 현재값 다운로드 — 전체 제품(삭제 제외) + 그 박스의 사이즈(참고) */
export async function exportDims(exec = query) {
  const r = await exec(
    `SELECT p.code, p.name, p.weight_kg, p.box_code, p.is_active, b.box_l_cm, b.box_w_cm, b.box_h_cm,
            to_char(p.dims_updated_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD HH24:MI') AS updated_at
       FROM products p LEFT JOIN packing_boxes b ON b.code = p.box_code
      WHERE p.deleted_at IS NULL ORDER BY p.code`);
  const items = r.rows.map((p) => ({
    code: p.code, name: p.name || '', is_active: p.is_active !== false,
    weight_kg: numOrNull(p.weight_kg), box_code: p.box_code || null,
    box_l_cm: numOrNull(p.box_l_cm), box_w_cm: numOrNull(p.box_w_cm), box_h_cm: numOrNull(p.box_h_cm),
    updated_at: p.updated_at || null,
  }));
  const stat = { total: items.length, weight: 0, box: 0, sized: 0 };
  for (const it of items) {
    if (it.weight_kg > 0) stat.weight++;
    if (it.box_code) stat.box++;
    if (it.box_l_cm > 0 && it.box_w_cm > 0 && it.box_h_cm > 0) stat.sized++;
  }
  return { items, stat };
}

// ── 포장 박스 마스터 : 미리보기 · 반영 · 다운로드 ────────────────────
export async function previewBoxes(exec, rows) {
  const codes = rows.map((r) => r.code);
  const cur = new Map();
  if (codes.length) {
    const res = await exec(`SELECT code, description, box_l_cm, box_w_cm, box_h_cm FROM packing_boxes WHERE code = ANY($1::text[])`, [codes]);
    for (const b of res.rows) cur.set(b.code, b);
  }
  const used = new Map();
  if (codes.length) {
    const u = await exec(`SELECT box_code, COUNT(*)::int AS n FROM products WHERE deleted_at IS NULL AND box_code = ANY($1::text[]) GROUP BY box_code`, [codes]);
    for (const x of u.rows) used.set(x.box_code, Number(x.n));
  }
  const items = []; let same = 0;
  for (const r of rows) {
    const b = cur.get(r.code);
    const changes = [];
    for (const f of BOX_FIELDS) {
      if (!(f in r.set)) continue;
      const o = b ? (f === 'description' ? (b[f] || null) : numOrNull(b[f])) : null; const n = r.set[f];
      if (!sameVal(o, n)) changes.push({ field: f, old: o, new: n });
    }
    if (b && !changes.length) { same++; continue; }
    items.push({ row: r.row, code: r.code, is_new: !b, products: used.get(r.code) || 0, changes });
  }
  return { items, same };
}

export async function applyBoxes(exec, rows, { userId = null } = {}) {
  const pv = await previewBoxes(exec, rows);
  const batch = newBatch('box');
  let fields = 0;
  for (const it of pv.items) {
    if (it.is_new) {
      await exec(`INSERT INTO packing_boxes (code, updated_by) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING`, [it.code, userId]);
      await exec(`INSERT INTO packing_box_log (batch_id, box_code, field, old_value, new_value, changed_by) VALUES ($1,$2,'(new)',NULL,'box upload',$3)`, [batch, it.code, userId]);
    }
    if (it.changes.length) {
      const sets = []; const args = [it.code];
      for (const ch of it.changes) { args.push(ch.new); sets.push(`${ch.field} = $${args.length}`); }
      args.push(userId);
      await exec(`UPDATE packing_boxes SET ${sets.join(', ')}, updated_at = now(), updated_by = $${args.length} WHERE code = $1`, args);
      for (const ch of it.changes) {
        await exec(`INSERT INTO packing_box_log (batch_id, box_code, field, old_value, new_value, changed_by) VALUES ($1,$2,$3,$4,$5,$6)`,
          [batch, it.code, ch.field, ch.old == null ? null : String(ch.old), ch.new == null ? null : String(ch.new), userId]);
        fields++;
      }
    }
  }
  return { batch_id: batch, boxes: pv.items.length, created: pv.items.filter((x) => x.is_new).length, fields, same: pv.same };
}

/** 박스 마스터 다운로드 — 등록된 박스 + 제품에만 적혀 있고 아직 마스터에 없는 박스(사이즈 빈 칸) */
export async function exportBoxes(exec = query) {
  const r = await exec(
    `WITH used AS (SELECT box_code AS code, COUNT(*)::int AS n FROM products WHERE deleted_at IS NULL AND box_code IS NOT NULL GROUP BY box_code)
     SELECT COALESCE(b.code, u.code) AS code, b.description, b.box_l_cm, b.box_w_cm, b.box_h_cm, COALESCE(u.n, 0) AS products,
            (b.code IS NULL) AS missing,
            to_char(b.updated_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD HH24:MI') AS updated_at
       FROM packing_boxes b FULL OUTER JOIN used u ON u.code = b.code
      ORDER BY 1`);
  const items = r.rows.map((b) => ({
    code: b.code, description: b.description || '', box_l_cm: numOrNull(b.box_l_cm), box_w_cm: numOrNull(b.box_w_cm), box_h_cm: numOrNull(b.box_h_cm),
    products: Number(b.products) || 0, in_master: !b.missing, updated_at: b.updated_at || null,
  }));
  const stat = { total: items.length, sized: 0, nosize: 0, nosize_products: 0 };
  for (const it of items) {
    if (it.box_l_cm > 0 && it.box_w_cm > 0 && it.box_h_cm > 0) stat.sized++;
    else { stat.nosize++; stat.nosize_products += it.products; }
  }
  return { items, stat };
}

// ── 견적 무게 · 사이즈 ──────────────────────────────────────────────
function round(n, d = 1) { const k = 10 ** d; return Math.round(Number(n) * k) / k; }

/** 견적 줄(제품 무게 · box_code · 박스 마스터 사이즈 box_l/w/h_cm) → 집계(목록 SQL 의 LATERAL 과 같은 모양) */
export function aggregateLines(lines) {
  const a = { pcs: 0, wt: 0, wt_pcs: 0, wt_miss: 0, wt_miss_qty: 0, vol: 0, d_pcs: 0, d_miss: 0, d_miss_qty: 0,
    d_nobox: 0, d_nobox_qty: 0, d_nosize: 0, d_nosize_qty: 0, d_a: 0, d_b: 0, d_c: 0, unreg: 0, unreg_qty: 0 };
  const nosizeBoxes = new Set();
  for (const l of lines || []) {
    const q = Number(l.qty) || 0;
    if (q <= 0) continue;
    if (l.product_id == null) { a.unreg++; a.unreg_qty += q; continue; }
    a.pcs += q;
    const w = Number(l.weight_kg) || 0;
    if (w > 0) { a.wt += q * w; a.wt_pcs += q; } else { a.wt_miss++; a.wt_miss_qty += q; }
    const s = [Number(l.box_l_cm) || 0, Number(l.box_w_cm) || 0, Number(l.box_h_cm) || 0];
    if (l.box_code && s.every((x) => x > 0)) {
      s.sort((x, y) => y - x);
      a.vol += q * s[0] * s[1] * s[2]; a.d_pcs += q;
      a.d_a = Math.max(a.d_a, s[0]); a.d_b = Math.max(a.d_b, s[1]); a.d_c = Math.max(a.d_c, s[2]);
    } else {
      a.d_miss++; a.d_miss_qty += q;
      if (!l.box_code) { a.d_nobox++; a.d_nobox_qty += q; } else { a.d_nosize++; a.d_nosize_qty += q; nosizeBoxes.add(String(l.box_code)); }
    }
  }
  a.nosize_boxes = [...nosizeBoxes].sort();
  return a;
}

/** 집계 → 화면용 { weight_kg, dims:{l,w,h}, vol_m3, vol_weight_kg, … } (줄이 하나도 없으면 null) */
export function estimateShipment(agg) {
  const n = (k) => Number(agg && agg[k]) || 0;
  const pcs = n('pcs'); const wtPcs = n('wt_pcs'); const dPcs = n('d_pcs');
  const miss = {
    wt_miss: n('wt_miss'), wt_miss_qty: n('wt_miss_qty'), d_miss: n('d_miss'), d_miss_qty: n('d_miss_qty'),
    d_nobox: n('d_nobox'), d_nobox_qty: n('d_nobox_qty'), d_nosize: n('d_nosize'), d_nosize_qty: n('d_nosize_qty'),
    unreg: n('unreg'), unreg_qty: n('unreg_qty'),
    ...(agg && Array.isArray(agg.nosize_boxes) ? { nosize_boxes: agg.nosize_boxes } : {}),
  };
  if (!wtPcs && !dPcs) return (pcs || n('unreg')) ? { weight_kg: null, dims: null, pcs, ...miss, nodata: true } : null;
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
  return { weight_kg: wtPcs > 0 ? round(n('wt'), 1) : null, dims, vol_m3: volM3, net_m3: netM3, vol_weight_kg: volW,
    pcs, wt_pcs: wtPcs, d_pcs: dPcs, ...miss };
}

/** 견적 목록 SQL 조각 — 0327 · 0328 이 있을 때만 붙인다. (q = quotes 별칭) */
const SHIP_KEYS = ['pcs', 'wt', 'wt_pcs', 'wt_miss', 'wt_miss_qty', 'vol', 'd_pcs', 'd_miss', 'd_miss_qty',
  'd_nobox', 'd_nobox_qty', 'd_nosize', 'd_nosize_qty', 'd_a', 'd_b', 'd_c', 'unreg', 'unreg_qty'];
export const SHIP_SELECT = ', ' + SHIP_KEYS.map((k) => `shp.${k} AS shp_${k}`).join(', ');
const DOK = `(p.box_code IS NOT NULL AND pb.box_l_cm > 0 AND pb.box_w_cm > 0 AND pb.box_h_cm > 0)`;
const G = `GREATEST(pb.box_l_cm, pb.box_w_cm, pb.box_h_cm)`;
const LST = `LEAST(pb.box_l_cm, pb.box_w_cm, pb.box_h_cm)`;
const PR = `ql.product_id IS NOT NULL`;
export const SHIP_JOIN = `
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(ql.qty) FILTER (WHERE ${PR}), 0)                                                       AS pcs,
                  COALESCE(SUM(ql.qty * p.weight_kg) FILTER (WHERE p.weight_kg > 0), 0)                               AS wt,
                  COALESCE(SUM(ql.qty) FILTER (WHERE p.weight_kg > 0), 0)                                             AS wt_pcs,
                  COUNT(*) FILTER (WHERE ${PR} AND COALESCE(p.weight_kg, 0) <= 0)::int                                AS wt_miss,
                  COALESCE(SUM(ql.qty) FILTER (WHERE ${PR} AND COALESCE(p.weight_kg, 0) <= 0), 0)                     AS wt_miss_qty,
                  COALESCE(SUM(ql.qty * pb.box_l_cm * pb.box_w_cm * pb.box_h_cm) FILTER (WHERE ${DOK}), 0)            AS vol,
                  COALESCE(SUM(ql.qty) FILTER (WHERE ${DOK}), 0)                                                      AS d_pcs,
                  COUNT(*) FILTER (WHERE ${PR} AND NOT COALESCE(${DOK}, FALSE))::int                                  AS d_miss,
                  COALESCE(SUM(ql.qty) FILTER (WHERE ${PR} AND NOT COALESCE(${DOK}, FALSE)), 0)                       AS d_miss_qty,
                  COUNT(*) FILTER (WHERE ${PR} AND p.box_code IS NULL)::int                                           AS d_nobox,
                  COALESCE(SUM(ql.qty) FILTER (WHERE ${PR} AND p.box_code IS NULL), 0)                                AS d_nobox_qty,
                  COUNT(*) FILTER (WHERE ${PR} AND p.box_code IS NOT NULL AND NOT COALESCE(${DOK}, FALSE))::int       AS d_nosize,
                  COALESCE(SUM(ql.qty) FILTER (WHERE ${PR} AND p.box_code IS NOT NULL AND NOT COALESCE(${DOK}, FALSE)), 0) AS d_nosize_qty,
                  COALESCE(MAX(${G}) FILTER (WHERE ${DOK}), 0)                                                        AS d_a,
                  COALESCE(MAX(pb.box_l_cm + pb.box_w_cm + pb.box_h_cm - ${G} - ${LST}) FILTER (WHERE ${DOK}), 0)     AS d_b,
                  COALESCE(MAX(${LST}) FILTER (WHERE ${DOK}), 0)                                                      AS d_c,
                  COUNT(*) FILTER (WHERE ql.product_id IS NULL)::int                                                  AS unreg,
                  COALESCE(SUM(ql.qty) FILTER (WHERE ql.product_id IS NULL), 0)                                       AS unreg_qty
             FROM quote_lines ql
             LEFT JOIN products p ON p.id = ql.product_id
             LEFT JOIN packing_boxes pb ON pb.code = p.box_code
            WHERE ql.quote_id = q.id AND ql.qty > 0
         ) shp ON TRUE`;

/** 목록 행(shp_* 칸) → estimateShipment */
export function shipFromRow(r) {
  const agg = {};
  for (const k of SHIP_KEYS) agg[k] = Number(r['shp_' + k]) || 0;
  return estimateShipment(agg);
}
