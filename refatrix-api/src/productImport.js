// 제품 마스터 업로드 순수 함수
import { parseOe, formatOe, sameOe, oeToken } from './oeParse.js';
// 파일 컬럼(헤더) → 시스템 필드 매핑. 헤더 이름으로 인식(순서 무관).
export const COLUMN_MAP = {
  'Clave CTR': 'code',
  'Clave SyD': 'scode',
  'Aplicacion (Maker : Model : Year)': 'app',
  'Nombre del producto': 'name',
  'Clave SAT': 'sat_code',
  'Origen': 'origin',
  'List Price': 'list_price',
  'IVA': 'iva_rate',
  'Barcode (EAN13)': 'ean',
  'Fast Movement Location': 'location',
  'List Price de SYD': 'list_price_syd',
  'Precio Cliente de SYD': 'price_customer_syd',
  'Precio Cliente de CTR': 'price_customer_ctr',
  'Material': 'material',
  'Material (Aluminio)': 'material',
  '소재': 'material',
  // 0228 — OE(순정) 부품번호. 규칙은 oeParse.js.
  'OE': 'oe',
  'OE / OEM Reference': 'oe',
  'Referencia OE': 'oe',
  // 2026-09-24 — 판매상태 일괄 지정(Activo/Inactivo). products 칼럼이 아니라 판매상태 전환(0179 규칙)으로 처리한다.
  'Estado': 'estado',
  'Estado (Activo/Inactivo)': 'estado',
  'Motivo inactivo': 'motivo',
  'Motivo': 'motivo',
};

/** 판매상태 칸 → 'active' | 'inactive' | null(칸이 비면 바꾸지 않음). */
export function parseEstado(v) {
  const t = String(v == null ? '' : v).trim().toLowerCase();
  if (!t) return null;
  if (['inactivo', 'inactive', '비활성', 'discontinued', 'descontinuado', 'no', '0', 'false'].includes(t)) return 'inactive';
  if (['activo', 'active', '활성', 'si', 'sí', 'yes', '1', 'true'].includes(t)) return 'active';
  return 'invalid';
}

// 업로드 시 갱신 대상 필드(코드는 키라 제외. 재고·평균원가는 절대 제외).
export const UPDATABLE_FIELDS = [
  'scode', 'app', 'name', 'sat_code', 'origin', 'list_price', 'iva_rate', 'ean',
  'location', 'list_price_syd', 'price_customer_syd', 'price_customer_ctr',
  'material', 'oe',
];
const NUMERIC_FIELDS = new Set(['list_price', 'iva_rate', 'list_price_syd', 'price_customer_syd', 'price_customer_ctr']);

function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// SyD 원문에서 개별 코드 분해(' // ' 구분, 변형 허용: //, 앞뒤 공백)
// 소재값 정규화: 알루미늄 계열( aluminio / aluminum / 알루미늄 / al )은 'aluminio'로 통일.
//   빈값 → null. 그 외 텍스트는 다듬어서 그대로 저장(향후 다른 소재 확장 대비).
export function normalizeMaterial(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (low.includes('alumin') || low.includes('\uc54c\ub8e8\ubbf8\ub284') || low === 'al') return 'aluminio';
  return s;
}

export function splitSyd(raw) {
  if (raw == null) return [];
  return String(raw)
    .split(/\s*\/\/\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// 적용차종 한 항목 파싱: "메이커 모델 연식" → {app_text, maker, model, year_from, year_to}
// 메이커 = 앞쪽 연속 대문자 토큰(쉼표 허용), 연식 = 끝쪽 4자리(-4자리), 모델 = 나머지.
export function parseAppEntry(entryRaw) {
  const app_text = String(entryRaw).trim();
  if (!app_text) return null;
  // 파싱용 문자열: 대괄호 주석([usa ...] 등) 제거(연식 오인 방지). 원문은 app_text에 보존.
  let s = app_text.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  let year_from = null, year_to = null;
  // 마지막 연식 패턴(4자리, 선택적 -4자리)을 찾음
  const yearRe = /(\d{4})(?:\s*-\s*(\d{4}))?/g;
  let ym, last = null;
  while ((ym = yearRe.exec(s)) !== null) last = ym;
  let modelPart = s;
  if (last) {
    year_from = Number(last[1]);
    year_to = last[2] ? Number(last[2]) : year_from;
    modelPart = s.slice(0, last.index).trim();
  }
  // 메이커: 앞쪽 연속 대문자 토큰(쉼표/&/. 허용)
  let maker = '', model = modelPart;
  const mk = modelPart.match(/^([A-ZÁÉÍÓÚÑ&./]+(?:,\s*[A-ZÁÉÍÓÚÑ&./]+)*)\s+/);
  if (mk) { maker = mk[1].trim(); model = modelPart.slice(mk[0].length).trim(); }
  return { app_text, maker: maker || null, model: model || null, year_from, year_to };
}

// 적용차종 전체(' // ' 구분) → 항목 배열
export function parseApplications(raw) {
  if (raw == null) return [];
  return String(raw)
    .split(/\s*\/\/\s*/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
    .map(parseAppEntry)
    .filter(Boolean);
}

// 헤더 배열 → 필드 인덱스 맵
export function buildHeaderIndex(headerRow) {
  const idx = {};
  headerRow.forEach((h, i) => {
    const key = COLUMN_MAP[String(h || '').trim()];
    if (key) idx[key] = i;
  });
  return idx;
}

// 한 행(배열) → 정규화된 제품 객체. code 없으면 null.
export function parseRow(row, headerIdx) {
  const get = (field) => (headerIdx[field] != null ? row[headerIdx[field]] : undefined);
  const code = clean(get('code'));
  if (!code) return null;
  const obj = { code };
  for (const f of UPDATABLE_FIELDS) {
    const raw = get(f);
    if (raw === undefined) continue; // 파일에 그 컬럼 자체가 없음
    obj[f] = NUMERIC_FIELDS.has(f) ? toNum(raw) : (f === 'material' ? normalizeMaterial(raw) : clean(raw));
  }
  obj.syd_codes = splitSyd(obj.scode);
  obj.applications = parseApplications(obj.app);
  // 0228 — 파일에 **있는 열만** 다룬다. 없는 열의 파생표(SyD·적용차종·OE)는 건드리지 않는다.
  //   (예전에는 Clave SyD 열이 없는 파일을 올려도 분해표를 「빈 목록」으로 다시 만들어
  //    SyD·차종 검색이 조용히 비었다 — 2026-09-23 OE 두 열 파일 점검에서 발견)
  obj.has = { scode: 'scode' in obj, app: 'app' in obj, oe: 'oe' in obj, name: 'name' in obj, estado: headerIdx.estado != null };
  if (obj.has.estado) {
    obj.estado = parseEstado(get('estado'));
    const mo = clean(get('motivo'));
    obj.motivo = mo ? mo.slice(0, 200) : null;
  }
  if (obj.has.oe) {
    obj.oe_codes = parseOe(obj.oe);
    obj.oe = formatOe(obj.oe_codes);   // 정규 표기로 저장 → 같은 파일 재업로드는 「동일」
  } else obj.oe_codes = [];
  return obj;
}

// 값 비교(숫자/문자 정규화). 둘 다 빈값이면 같음.
function eq(a, b, isNum) {
  if (isNum) {
    const x = a == null || a === '' ? null : Number(a);
    const y = b == null || b === '' ? null : Number(b);
    if (x == null && y == null) return true;
    return x === y;
  }
  const x = a == null ? '' : String(a).trim();
  const y = b == null ? '' : String(b).trim();
  return x === y;
}

// 기존 제품(existing: {code->row}) 대비 변경점 계산.
// 반환: { isNew, changes: { field: {from,to} }, syd_changed }
export function diffProduct(parsed, existing) {
  if (!existing) return { isNew: true, changes: {}, syd_changed: parsed.syd_codes.length > 0, app_changed: (parsed.applications || []).length > 0 };
  const changes = {};
  for (const f of UPDATABLE_FIELDS) {
    if (!(f in parsed)) continue; // 파일에 해당 컬럼 없음 → 건드리지 않음
    const isNum = NUMERIC_FIELDS.has(f);
    if (!eq(parsed[f], existing[f], isNum)) {
      changes[f] = { from: existing[f] ?? null, to: parsed[f] ?? null };
    }
  }
  // 0228 — 열이 파일에 없으면 비교 자체를 하지 않는다(= 바꾸지 않는다).
  const has = parsed.has || { scode: true, app: true, oe: 'oe' in parsed };
  // SyD 개별코드 집합 비교
  let syd_changed = false;
  if (has.scode) {
    const cur = new Set((existing.syd_codes || []).map(String));
    const next = new Set(parsed.syd_codes.map(String));
    syd_changed = cur.size !== next.size || [...next].some((c) => !cur.has(c));
  }
  // 적용차종 원문 집합 비교
  let app_changed = false;
  if (has.app) {
    const curApp = new Set((existing.app_texts || []).map(String));
    const nextApp = new Set((parsed.applications || []).map((a) => a.app_text));
    app_changed = curApp.size !== nextApp.size || [...nextApp].some((a) => !curApp.has(a));
  }
  // OE 분해표 비교 — 원문(oe)이 같아도 분해표가 비어 있으면(0228 직후) 다시 채운다.
  let oe_changed = false;
  if (has.oe) oe_changed = !sameOe(existing.oe_codes || [], parsed.oe_codes || []);
  // 판매상태 — 칸에 값이 있을 때만(빈칸 = 그대로)
  let status_to = null;
  if (has.estado && (parsed.estado === 'active' || parsed.estado === 'inactive')) {
    const cur = existing.is_active === false ? 'inactive' : 'active';
    if (cur !== parsed.estado) status_to = parsed.estado;
  }
  return { isNew: false, changes, syd_changed, app_changed, oe_changed, status_to };
}

// 전체 미리보기 집계
// parsedRows: parseRow 결과 배열(null 제외), existingByCode: {code: {fields..., syd_codes}}
export function buildPreview(parsedRows, existingByCode) {
  const result = { total: parsedRows.length, new_items: [], updated: [], unchanged: 0, errors: [], duplicates: [],
    // 0228 — OE 요약: 바뀌는 제품 수 · 올라가는 번호 수 · **OE 가 통째로 지워지는 제품**(빨간 경고)
    oe_products: 0, oe_added_codes: 0, oe_cleared: [],
    // 2026-09-24 — 판매상태 일괄 지정
    status_to_inactive: 0, status_to_active: 0 };
  const seen = new Set();
  for (const p of parsedRows) {
    if (seen.has(p.code)) { result.duplicates.push(p.code); continue; }
    seen.add(p.code);
    const ex = existingByCode[p.code];
    // 0228 — 제품명은 **신규**에만 필수. 기존 제품은 열이 없어도 된다(OE 두 열 파일 등).
    //   단, 제품명 열이 있는데 칸이 비었으면 이름을 지우게 되므로 여전히 오류.
    if (!p.name && (!ex || (p.has && p.has.name))) { result.errors.push({ code: p.code, reason: 'name_missing' }); continue; }
    if (p.estado === 'invalid') { result.errors.push({ code: p.code, reason: 'estado_invalid' }); continue; }
    const d = diffProduct(p, ex);
    if (d.isNew) {
      result.new_items.push({ code: p.code, name: p.name, list_price: p.list_price ?? null, syd_count: p.syd_codes.length,
        oe_count: (p.oe_codes || []).length, estado: p.estado || null });
      if (p.estado === 'inactive') result.status_to_inactive += 1;
      result.oe_added_codes += (p.oe_codes || []).length;
    } else if (Object.keys(d.changes).length > 0 || d.syd_changed || d.app_changed || d.oe_changed || d.status_to) {
      const u = { code: p.code, name: p.name || ex.name, changes: d.changes, syd_changed: d.syd_changed,
        syd_from: ex.syd_codes || [], syd_to: p.syd_codes, app_changed: d.app_changed,
        app_count: (p.applications || []).length, oe_changed: d.oe_changed, status_to: d.status_to || null };
      if (d.status_to === 'inactive') result.status_to_inactive += 1;
      if (d.status_to === 'active') result.status_to_active += 1;
      if (d.oe_changed) {
        u.oe_from = (ex.oe_codes || []).map(oeToken); u.oe_to = (p.oe_codes || []).map(oeToken);
        if ((ex.oe_codes || []).length && !(p.oe_codes || []).length) result.oe_cleared.push(p.code);
        result.oe_products += 1;
        result.oe_added_codes += (p.oe_codes || []).length;
      }
      result.updated.push(u);
    } else {
      result.unchanged += 1;
    }
  }
  return result;
}
