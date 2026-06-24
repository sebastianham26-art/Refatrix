// 제품 마스터 업로드 순수 함수
// 파일 컬럼(헤더) → 시스템 필드 매핑. 헤더 이름으로 인식(순서 무관).
import { vioKey, vioStem } from './vioKey.js';

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
};

// 업로드 시 갱신 대상 필드(코드는 키라 제외. 재고·평균원가는 절대 제외).
export const UPDATABLE_FIELDS = [
  'scode', 'app', 'name', 'sat_code', 'origin', 'list_price', 'iva_rate', 'ean',
  'location', 'list_price_syd', 'price_customer_syd', 'price_customer_ctr',
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
  // VIO 순위 매칭용 키. maker/model이 비어도 vioKey가 안전 처리.
  const model_key = vioKey(maker, model);
  const model_stem = vioStem(maker, model);
  return { app_text, maker: maker || null, model: model || null, year_from, year_to, model_key, model_stem };
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
    obj[f] = NUMERIC_FIELDS.has(f) ? toNum(raw) : clean(raw);
  }
  obj.syd_codes = splitSyd(obj.scode);
  obj.applications = parseApplications(obj.app);
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
  // SyD 개별코드 집합 비교
  const cur = new Set((existing.syd_codes || []).map(String));
  const next = new Set(parsed.syd_codes.map(String));
  const syd_changed = cur.size !== next.size || [...next].some((c) => !cur.has(c));
  // 적용차종 원문 집합 비교
  const curApp = new Set((existing.app_texts || []).map(String));
  const nextApp = new Set((parsed.applications || []).map((a) => a.app_text));
  const app_changed = curApp.size !== nextApp.size || [...nextApp].some((a) => !curApp.has(a));
  return { isNew: false, changes, syd_changed, app_changed };
}

// 전체 미리보기 집계
// parsedRows: parseRow 결과 배열(null 제외), existingByCode: {code: {fields..., syd_codes}}
export function buildPreview(parsedRows, existingByCode) {
  const result = { total: parsedRows.length, new_items: [], updated: [], unchanged: 0, errors: [], duplicates: [] };
  const seen = new Set();
  for (const p of parsedRows) {
    if (seen.has(p.code)) { result.duplicates.push(p.code); continue; }
    seen.add(p.code);
    if (!p.name) { result.errors.push({ code: p.code, reason: 'name_missing' }); continue; }
    const ex = existingByCode[p.code];
    const d = diffProduct(p, ex);
    if (d.isNew) {
      result.new_items.push({ code: p.code, name: p.name, list_price: p.list_price ?? null, syd_count: p.syd_codes.length });
    } else if (Object.keys(d.changes).length > 0 || d.syd_changed || d.app_changed) {
      result.updated.push({ code: p.code, name: p.name, changes: d.changes, syd_changed: d.syd_changed,
        syd_from: ex.syd_codes || [], syd_to: p.syd_codes, app_changed: d.app_changed,
        app_count: (p.applications || []).length });
    } else {
      result.unchanged += 1;
    }
  }
  return result;
}
