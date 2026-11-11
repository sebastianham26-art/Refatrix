// =====================================================================
// Refatrix ERP · xrefMaster.js — 멕시코 경쟁사 크로스레퍼런스 마스터 (0325 · 2026-11-11)
//
//   기준 파일(mexico_cross_reference_YYMMDD.xlsx)의 한 행 = 같은 부품의 브랜드별 코드 묶음.
//     SYD · CTR · BAW · GROB · VAZLO · KYB · MOOG (+ DESCRIPCIÓN · PRECIO · APLICACIÓN · UBICACIÓN)
//
//   연결 규칙(디렉터 지시): 경쟁사 코드 → 이 마스터에서 같은 행의 SYD 코드 → ERP 에 등록된 SYD 코드
//                          (product_syd_codes) → 그 SYD 의 CTR 제품.
//     · 행에 CTR 칸이 채워져 있으면 그 CTR 코드도 바로 쓴다(지금 파일은 비어 있다).
//     · 한 칸에 '7000265 // 7000176' · '340038/340039' 처럼 여러 코드가 있으면 나눠서 각각 등록.
//     · 같은 숫자가 여러 브랜드에 나온다(GROB 2509007 = SYD 2509007 등) — 브랜드를 고르면 그 브랜드 칸만 본다.
//
//   쓰는 곳: 견적 코드 해석(quoteBuild.resolveCode) · 개발요청 자동 검수(devMatchSweep) · 제품찾기(/api/products)
// =====================================================================
import { query } from './db.js';

export const normCode = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');

// 알려진 브랜드 칸(표시 순서). 이 밖의 이름 칸도 브랜드로 받는다(예: 나중에 YOKOMITSU 칸 추가).
export const XM_BRANDS = ['SYD', 'CTR', 'BAW', 'GROB', 'VAZLO', 'KYB', 'MOOG'];
export const COMPETITOR_BRANDS = ['BAW', 'GROB', 'VAZLO', 'KYB', 'MOOG'];
const BRAND_ALIAS = { VASLO: 'VAZLO', VAZLO: 'VAZLO', 'GROB1': 'GROB', SYD1: 'SYD' };
const TEXT_COLS = { DESCRIPCION: 'descripcion', PRECIO: 'precio', APLICACION: 'aplicacion', UBICACION: 'ubicacion' };

const deaccent = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
const headKey = (s) => deaccent(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

/** 브랜드 정리 — 'auto' · '' → null(자동 판별). 'Vaslo' → 'VAZLO'. */
export function normBrand(b) {
  const k = headKey(b);
  if (!k || k === 'AUTO' || k === 'ALL' || k === 'TODOS') return null;
  return BRAND_ALIAS[k] || k.replace(/[0-9]+$/, '') || null;
}

/** 한 칸 → 코드 조각들. '//' · '/' · ',' · ';' · 줄바꿈으로 나눈다. 숫자 칸(엑셀 숫자형)도 문자열로. */
export function splitCell(v) {
  if (v == null) return [];
  let s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(v)) : String(v);
  s = s.trim();
  if (!s) return [];
  const out = [];
  const seen = new Set();
  for (const part of s.split(/\/\/|\/|,|;|\n|\r/)) {
    const p = part.trim();
    if (!p || p === '0' || p === '-') continue;
    const n = normCode(p);
    if (!n || seen.has(n)) continue;
    seen.add(n); out.push(p);
  }
  return out;
}

/**
 * 엑셀 시트(2차원 배열, SheetJS header:1) → 마스터 행.
 *   헤더 = 앞 10행 중 SYD 칸 + 다른 브랜드 칸 2개 이상이 있는 첫 행.
 *   반환 { ok, error?, header:{brands:[…], text:[…]}, rows:[{row_no, syd_text, ctr_text, codes:{BRAND:[code…]}, …}],
 *          brand_counts, code_count, empty_rows }
 */
export function parseMasterAoa(aoa) {
  const rowsIn = Array.isArray(aoa) ? aoa : [];
  let hIdx = -1, cols = null;
  for (let i = 0; i < Math.min(rowsIn.length, 10); i++) {
    const r = Array.isArray(rowsIn[i]) ? rowsIn[i] : [];
    const keys = r.map(headKey);
    const hasSyd = keys.includes('SYD');
    const others = keys.filter((k) => k && k !== 'SYD' && (XM_BRANDS.includes(BRAND_ALIAS[k] || k))).length;
    if (hasSyd && others >= 2) { hIdx = i; cols = keys; break; }
  }
  if (hIdx < 0) return { ok: false, error: 'no_header', note: '헤더 행(SYD · BAW · GROB … 열 이름)을 찾지 못했습니다.' };
  const brandCols = [], textCols = [];
  cols.forEach((k, ci) => {
    if (!k) return;
    if (TEXT_COLS[k]) { textCols.push({ ci, key: TEXT_COLS[k] }); return; }
    const b = BRAND_ALIAS[k] || k;
    if (!/^[A-Z][A-Z0-9]{1,19}$/.test(b)) return;
    if (brandCols.some((x) => x.brand === b)) return;   // 같은 이름 두 칸이면 첫 칸만
    brandCols.push({ ci, brand: b });
  });
  const rows = [];
  const brandCounts = {};
  let codeCount = 0, empty = 0;
  for (let i = hIdx + 1; i < rowsIn.length; i++) {
    const r = Array.isArray(rowsIn[i]) ? rowsIn[i] : [];
    const codes = {};
    let n = 0;
    for (const bc of brandCols) {
      const parts = splitCell(r[bc.ci]);
      if (!parts.length) continue;
      codes[bc.brand] = parts;
      n += parts.length;
      brandCounts[bc.brand] = (brandCounts[bc.brand] || 0) + parts.length;
    }
    if (!n) { empty++; continue; }
    codeCount += n;
    const row = { row_no: i + 1, codes, syd_text: (codes.SYD || []).join(' // ') || null, ctr_text: (codes.CTR || []).join(' // ') || null };
    for (const tc of textCols) {
      const v = r[tc.ci];
      if (tc.key === 'precio') {
        const p = v == null || v === '' ? null : Number(String(v).replace(/[$,\s]/g, ''));
        row.precio = Number.isFinite(p) ? p : null;
      } else row[tc.key] = v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, 2000);
    }
    rows.push(row);
  }
  return {
    ok: true, header_row: hIdx + 1,
    header: { brands: brandCols.map((b) => b.brand), text: textCols.map((t) => t.key) },
    rows, brand_counts: brandCounts, code_count: codeCount, empty_rows: empty,
  };
}

// ── 반쪽배포 안전장치: 0325 전이면 마스터 단계만 조용히 쉰다(견적 저장이 멈추면 안 된다) ──
let readyFlag = false, readyProbe = 0;
export async function xrefMasterReady(exec = query) {
  if (readyFlag) return true;
  if (Date.now() - readyProbe < 30000) return false;
  readyProbe = Date.now();
  try {
    const r = await exec(
      `SELECT 1 FROM information_schema.columns WHERE table_name='product_dev_requests' AND column_name='input_brand'
        AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='xref_master_codes') LIMIT 1`);
    readyFlag = r.rows.length > 0;
  } catch (_) { readyFlag = false; }
  return readyFlag;
}
export function setXrefMasterReady(v) { readyFlag = !!v; readyProbe = Date.now(); }

// 활성 버전 id (15초 보관, 업로드 때 비움)
let activeCache = { at: 0, id: null };
export function invalidateXrefMaster() { activeCache = { at: 0, id: null }; }
export async function activeVersionId(exec = query) {
  if (!(await xrefMasterReady(exec))) return null;
  if (Date.now() - activeCache.at < 15000) return activeCache.id;
  const r = (await exec(`SELECT id FROM xref_master_versions WHERE is_active ORDER BY id DESC LIMIT 1`)).rows[0];
  activeCache = { at: Date.now(), id: r ? Number(r.id) : null };
  return activeCache.id;
}

const NSQL = (col) => `regexp_replace(upper(COALESCE(${col},'')), '[^A-Z0-9]', '', 'g')`;

/**
 * 마스터 행들 → 행별 SYD · CTR 코드와 ERP 제품.
 *   rowNos: 행 번호 배열. 반환 Map(row_no → { row_no, codes, descripcion, aplicacion, precio,
 *                                           syd:[원문], products:[{product_id, ctr_code, via:'syd'|'ctr', syd_code}] })
 */
export async function masterRows(vid, rowNos, exec = query) {
  const out = new Map();
  const ids = [...new Set((rowNos || []).map(Number).filter(Number.isFinite))];
  if (!vid || !ids.length) return out;
  const rows = (await exec(
    `SELECT row_no, codes, descripcion, aplicacion, precio, ubicacion FROM xref_master_rows
      WHERE version_id=$1 AND row_no = ANY($2::int[])`, [vid, ids])).rows;
  const sydNorm = new Map();   // norm → 원문
  const ctrNorm = new Map();
  for (const r of rows) {
    const codes = r.codes || {};
    const syd = Array.isArray(codes.SYD) ? codes.SYD : [];
    const ctr = Array.isArray(codes.CTR) ? codes.CTR : [];
    for (const s of syd) sydNorm.set(normCode(s), s);
    for (const s of ctr) ctrNorm.set(normCode(s), s);
    out.set(Number(r.row_no), {
      row_no: Number(r.row_no), codes, syd, ctr,
      descripcion: r.descripcion || null, aplicacion: r.aplicacion || null, ubicacion: r.ubicacion || null,
      precio: r.precio != null ? Number(r.precio) : null, products: [],
    });
  }
  const sydList = [...sydNorm.keys()].filter(Boolean);
  const ctrList = [...ctrNorm.keys()].filter(Boolean);
  const bySyd = new Map(), byCtr = new Map();
  if (sydList.length) {
    const pr = (await exec(
      `SELECT DISTINCT s.product_id, p.code, s.syd_code, ${NSQL('s.syd_code')} AS n
         FROM product_syd_codes s JOIN products p ON p.id = s.product_id AND p.deleted_at IS NULL
        WHERE ${NSQL('s.syd_code')} = ANY($1)`, [sydList])).rows;
    for (const p of pr) { if (!bySyd.has(p.n)) bySyd.set(p.n, []); bySyd.get(p.n).push({ product_id: Number(p.product_id), ctr_code: p.code, syd_code: p.syd_code }); }
  }
  if (ctrList.length) {
    const pr = (await exec(
      `SELECT id, code, ${NSQL('code')} AS n FROM products WHERE deleted_at IS NULL AND ${NSQL('code')} = ANY($1)`, [ctrList])).rows;
    for (const p of pr) { if (!byCtr.has(p.n)) byCtr.set(p.n, []); byCtr.get(p.n).push({ product_id: Number(p.id), ctr_code: p.code }); }
  }
  for (const r of out.values()) {
    const seen = new Set();
    for (const c of r.ctr) for (const p of (byCtr.get(normCode(c)) || [])) {
      if (seen.has(p.product_id)) continue; seen.add(p.product_id);
      r.products.push({ ...p, via: 'ctr' });
    }
    for (const s of r.syd) for (const p of (bySyd.get(normCode(s)) || [])) {
      if (seen.has(p.product_id)) continue; seen.add(p.product_id);
      r.products.push({ ...p, via: 'syd' });
    }
  }
  return out;
}

/**
 * 입력 코드들 → 마스터 매칭(정확 일치, 정규화 기준).
 *   brand 를 주면 그 브랜드 칸만, 없으면 전 브랜드.
 *   반환 Map(norm → [{ brand, code, row_no, syd:[…], products:[…], descripcion, aplicacion }])
 */
export async function bridgeCodes(codes, { brand = null, exec = query } = {}) {
  const out = new Map();
  const vid = await activeVersionId(exec);
  if (!vid) return out;
  const norms = [...new Set((codes || []).map(normCode).filter(Boolean))];
  if (!norms.length) return out;
  const b = normBrand(brand);
  const args = [vid, norms];
  let bCond = '';
  if (b) { args.push(b); bCond = ` AND brand = $3`; }
  const hits = (await exec(
    `SELECT DISTINCT row_no, brand, code, norm_code FROM xref_master_codes
      WHERE version_id=$1 AND norm_code = ANY($2)${bCond}
      ORDER BY row_no`, args)).rows;
  if (!hits.length) return out;
  const rows = await masterRows(vid, hits.map((h) => h.row_no), exec);
  for (const h of hits) {
    const r = rows.get(Number(h.row_no)); if (!r) continue;
    if (!out.has(h.norm_code)) out.set(h.norm_code, []);
    out.get(h.norm_code).push({ brand: h.brand, code: h.code, row_no: r.row_no, syd: r.syd, ctr: r.ctr,
      products: r.products, descripcion: r.descripcion, aplicacion: r.aplicacion });
  }
  return out;
}

/** 한 코드 → { hits:[…], products: Map(product_id → {ctr_code, via, brand, code, syd_code}) } */
export async function bridgeOne(code, opts = {}) {
  const n = normCode(code);
  const m = await bridgeCodes([code], opts);
  const hits = m.get(n) || [];
  const products = new Map();
  for (const h of hits) for (const p of h.products) {
    if (!products.has(p.product_id)) products.set(p.product_id, { ...p, brand: h.brand, code: h.code });
  }
  return { hits, products };
}

/**
 * 제품찾기 검색 — 입력이 마스터 코드와 정확히 같거나(4자 이상) 앞부분이 같으면(5자 이상) 걸린다.
 *   반환 { products: Map(product_id → {brand, code, syd_code}), unbridged:[{brand, code, syd, descripcion, aplicacion}] }
 *   unbridged = 마스터엔 있지만 ERP CTR 로 이어지지 않는 행(SYD 미등록 등) — 화면 안내용.
 */
export async function searchMaster(q, { limit = 40, exec = query } = {}) {
  const res = { products: new Map(), unbridged: [] };
  const n = normCode(q);
  if (n.length < 4) return res;
  const vid = await activeVersionId(exec);
  if (!vid) return res;
  const hits = (await exec(
    `SELECT DISTINCT row_no, brand, code, norm_code, (norm_code = $2) AS exact FROM xref_master_codes
      WHERE version_id=$1 AND (norm_code = $2 ${n.length >= 5 ? `OR norm_code LIKE $3` : ''})
      ORDER BY exact DESC, row_no LIMIT ${Math.max(1, Math.min(200, Number(limit) || 40))}`,
    n.length >= 5 ? [vid, n, n + '%'] : [vid, n])).rows;
  if (!hits.length) return res;
  const rows = await masterRows(vid, hits.map((h) => h.row_no), exec);
  const seenRow = new Set();
  for (const h of hits) {
    const r = rows.get(Number(h.row_no)); if (!r) continue;
    if (r.products.length) {
      for (const p of r.products) if (!res.products.has(p.product_id)) res.products.set(p.product_id, { brand: h.brand, code: h.code, syd_code: p.syd_code || null, via: p.via });
    } else if (!seenRow.has(r.row_no) && res.unbridged.length < 10) {
      seenRow.add(r.row_no);
      res.unbridged.push({ brand: h.brand, code: h.code, syd: r.syd, descripcion: r.descripcion, aplicacion: r.aplicacion, precio: r.precio });
    }
  }
  return res;
}

/**
 * 개발요청 자동 검수용 — 정규화 코드 집합 → Map(norm → Map(brand → Set(product_id)))
 *   마스터 전체를 한 번에 대조한다(스위퍼가 수천 건을 돌 때 코드마다 질의하지 않게).
 */
export async function masterIndexFor(norms, exec = query) {
  const out = new Map();
  const list = [...new Set((norms || []).filter(Boolean))];
  const vid = await activeVersionId(exec);
  if (!vid || !list.length) return out;
  const hits = (await exec(
    `SELECT DISTINCT row_no, brand, norm_code FROM xref_master_codes WHERE version_id=$1 AND norm_code = ANY($2)`,
    [vid, list])).rows;
  if (!hits.length) return out;
  const rows = await masterRows(vid, hits.map((h) => h.row_no), exec);
  for (const h of hits) {
    const r = rows.get(Number(h.row_no)); if (!r || !r.products.length) continue;
    if (!out.has(h.norm_code)) out.set(h.norm_code, new Map());
    const byBrand = out.get(h.norm_code);
    if (!byBrand.has(h.brand)) byBrand.set(h.brand, new Set());
    for (const p of r.products) byBrand.get(h.brand).add(p.product_id);
  }
  return out;
}

/**
 * 0325b · 견적 엑셀 「경쟁사 코드 열」 — CTR 코드들 → 브랜드별 경쟁사 코드.
 *   ⓐ 마스터: CTR 의 SYD(product_syd_codes) 와 같은 마스터 행 · 또는 마스터 CTR 칸이 그 CTR 인 행의 브랜드 코드
 *   ⓑ 제품 교차참조(product_xref_codes)
 *   반환 Map(CTR 코드 → { BRAND: [code…] })  — 정규화 기준 중복 제거, 마스터 먼저
 */
export async function competitorCodesFor(ctrCodes, brands, exec = query) {
  const out = new Map();
  const codes = [...new Set((ctrCodes || []).map((c) => String(c == null ? '' : c).trim()).filter(Boolean))];
  const want = [...new Set((brands || []).map(normBrand).filter(Boolean))];
  if (!codes.length || !want.length) return out;
  const seen = new Map();   // ctr → Set(brand|norm)
  const add = (ctr, brand, code) => {
    const b = normBrand(brand); if (!b || !want.includes(b)) return;
    const n = normCode(code); if (!n) return;
    if (!seen.has(ctr)) seen.set(ctr, new Set());
    const k = b + '|' + n; if (seen.get(ctr).has(k)) return; seen.get(ctr).add(k);
    if (!out.has(ctr)) out.set(ctr, {});
    (out.get(ctr)[b] = out.get(ctr)[b] || []).push(String(code).trim());
  };
  const vid = await activeVersionId(exec);
  if (vid) {
    // 한 번에 큰 JOIN 을 돌리면 전체 카탈로그(수천 SKU)에서 수 초가 걸린다 → 색인을 타는 세 질의로 나눠 메모리에서 잇는다.
    const ps = (await exec(
      `SELECT p.code AS ctr, ${NSQL('sc.syd_code')} AS n
         FROM products p JOIN product_syd_codes sc ON sc.product_id = p.id
        WHERE p.deleted_at IS NULL AND p.code = ANY($1::text[])`, [codes])).rows;
    const sydToCtr = new Map();   // syd norm → [ctr]
    for (const r of ps) { if (!r.n) continue; if (!sydToCtr.has(r.n)) sydToCtr.set(r.n, []); sydToCtr.get(r.n).push(r.ctr); }
    const ctrNorm = new Map(codes.map((c) => [normCode(c), c]));
    const keys = [...new Set([...sydToCtr.keys(), ...ctrNorm.keys()])].filter(Boolean);
    const hits = keys.length ? (await exec(
      `SELECT row_no, brand, norm_code FROM xref_master_codes
        WHERE version_id = $1 AND brand IN ('SYD','CTR') AND norm_code = ANY($2::text[])`, [vid, keys])).rows : [];
    const rowCtr = new Map();     // row_no → Set(ctr)
    for (const h of hits) {
      const list = h.brand === 'SYD' ? (sydToCtr.get(h.norm_code) || []) : (ctrNorm.has(h.norm_code) ? [ctrNorm.get(h.norm_code)] : []);
      if (!list.length) continue;
      const rn = Number(h.row_no);
      if (!rowCtr.has(rn)) rowCtr.set(rn, new Set());
      for (const c of list) rowCtr.get(rn).add(c);
    }
    if (rowCtr.size) {
      const bc = (await exec(
        `SELECT row_no, brand, code FROM xref_master_codes
          WHERE version_id = $1 AND row_no = ANY($2::int[]) AND brand = ANY($3::text[])
          ORDER BY row_no, brand, code`, [vid, [...rowCtr.keys()], want])).rows;
      for (const r of bc) for (const c of rowCtr.get(Number(r.row_no)) || []) add(c, r.brand, r.code);
    }
  }
  try {
    const xr = (await exec(
      `SELECT p.code AS ctr, x.brand, x.xref_code FROM product_xref_codes x
         JOIN products p ON p.id = x.product_id AND p.deleted_at IS NULL
        WHERE p.code = ANY($1::text[]) ORDER BY p.code, x.brand, x.xref_code`, [codes])).rows;
    for (const r of xr) add(r.ctr, r.brand, r.xref_code);
  } catch (_) { /* 0130 미적용 */ }
  return out;
}
