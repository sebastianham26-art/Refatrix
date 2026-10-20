// =====================================================================
// Refatrix ERP · factoryInfo.js — 공장 SKU 정보(원산지 · MOQ · 생산 상태) 업로드 해석 (2026-10-20)
//   구매검토 화면의 엑셀 업로드 / 붙여넣기 → 미리보기 → 반영.
//   순수 함수만 둔다(DB 없음) — 시험에서 표기 흔들림을 마음대로 넣어 본다.
//
//   칸 규칙(디렉터 결정 · 업로드 양식 안내문과 같다)
//   · 빈 칸  = 바꾸지 않음(지금 값 유지)
//   · 「-」  = 값 지우기
//   · 원산지 = CN·TR·KR·VN 등. China/Chino/Turquía/Corea/Vietnam 같은 표기도 코드로 바꿔 저장.
//   · MOQ    = 0 이상의 수. 비워 두면 원산지 기본값(CN 10 · TR 40 · 그 외 없음).
//   · 생산 상태 = 생산중 · 단산 · 개발 · 개발보류 (스페인어·영어 표기도 인식)
// =====================================================================

export const FACTORY_STATUS = {
  production:   { ko: '생산중',   es: 'En producción' },
  discontinued: { ko: '단산',     es: 'Descontinuado' },
  development:  { ko: '개발',     es: 'En desarrollo' },
  dev_hold:     { ko: '개발보류', es: 'Desarrollo en pausa' },
};

// 원산지 기본 MOQ — 공장 업로드로 SKU 별 MOQ 가 있으면 그 값이 우선한다.
export const MOQ_BY_ORIGIN = { CN: 10, TR: 40 };

const CLEAR = new Set(['-', '–', '—', '삭제', 'CLEAR', 'BORRAR', 'NULL']);
const squash = (v) => String(v == null ? '' : v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
  .toUpperCase().replace(/\s+/g, ' ').trim();

const STATUS_WORDS = [
  ['dev_hold', ['개발보류', '개발 보류', '보류', 'DEV HOLD', 'DEV_HOLD', 'ON HOLD', 'HOLD', 'DESARROLLO EN PAUSA', 'EN PAUSA', 'PAUSA', 'SUSPENDIDO']],
  ['development', ['개발', '개발중', '개발 중', 'DEVELOPMENT', 'DEV', 'DESARROLLO', 'EN DESARROLLO', 'NUEVO', 'NEW']],
  ['discontinued', ['단산', '단종', '생산중단', '생산 중단', 'DISCONTINUED', 'DESCONTINUADO', 'DISCONTINUADO', 'BAJA', 'EOL']],
  ['production', ['생산중', '생산', '생산 중', 'PRODUCTION', 'PRODUCCION', 'EN PRODUCCION', 'ACTIVO', 'ACTIVE', 'PROD']],
];

/** 생산 상태 칸 → { skip } | { clear } | { value } | { error } */
export function parseFactoryStatus(raw) {
  const s = squash(raw);
  if (!s) return { skip: true };
  if (CLEAR.has(s)) return { clear: true };
  if (FACTORY_STATUS[s.toLowerCase()]) return { value: s.toLowerCase() };
  for (const [k, words] of STATUS_WORDS) if (words.includes(s)) return { value: k };
  return { error: `생산 상태를 알 수 없음: "${String(raw).trim()}" (생산중·단산·개발·개발보류)` };
}

/** 원산지 표기 → 코드(CN/TR/KR/VN). 모르는 표기는 대문자 그대로. */
export function normOrigin(raw) {
  const s = squash(raw);
  if (!s) return null;
  if (/^(CN|CHN)$|CHIN|중국/.test(s)) return 'CN';
  if (/^(TR|TUR)$|TURK|TURQ|터키|튀르키예/.test(s)) return 'TR';
  if (/^(KR|KOR)$|KOREA|COREA|한국/.test(s)) return 'KR';
  if (/^(VN|VNM)$|VIET|베트남/.test(s)) return 'VN';
  return s.slice(0, 20);
}
export function parseOrigin(raw) {
  const s = squash(raw);
  if (!s) return { skip: true };
  if (CLEAR.has(s)) return { clear: true };
  return { value: normOrigin(raw) };
}

export function parseMoq(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return { skip: true };
  if (CLEAR.has(squash(t))) return { clear: true };
  const n = Number(t.replace(/[,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return { error: `MOQ 는 0 이상의 숫자여야 합니다: "${t}"` };
  return { value: Math.round(n * 1000) / 1000 };
}

// 머리글 → 칸. 양식(CTR · 제품명 · 원산지 · MOQ · 생산 상태)과 흔한 다른 표기.
const HEAD = [
  ['code', /^(CTR|CTR ?CODE|CLAVE ?CTR|CODIGO|CODE|SKU|품번|코드)$/],
  ['name', /^(제품명|NOMBRE|NAME|DESCRIPCION|PRODUCTO)$/],
  ['origin', /^(원산지|ORIGEN|ORIGIN|PAIS|COUNTRY)$/],
  ['moq', /^(MOQ|최소주문수량|최소 주문수량|MINIMO|CANTIDAD MINIMA)$/],
  ['status', /^(생산 ?상태|공장 ?상태|상태|STATUS|ESTADO|ESTATUS|ESTADO FABRICA)$/],
];

/**
 * 표(2차원 배열) → 행 객체. 첫 줄이 머리글이면 머리글로 칸을 찾고,
 * 아니면 양식 순서(CTR · 원산지 · MOQ · 생산 상태)로 읽는다 — 붙여넣기에서 머리글을 빼먹어도 된다.
 *   반환: { rows:[{row, code, origin, moq, status}], header:bool }
 */
export function tableToRows(table) {
  const t = (table || []).filter((r) => Array.isArray(r) && r.some((c) => String(c == null ? '' : c).trim() !== ''));
  if (!t.length) return { rows: [], header: false };
  let map = null;
  const first = t[0].map((c) => squash(c));
  const hits = {};
  first.forEach((h, i) => { for (const [k, re] of HEAD) if (hits[k] == null && re.test(h)) hits[k] = i; });
  if (hits.code != null && (hits.origin != null || hits.moq != null || hits.status != null)) map = hits;
  const body = map ? t.slice(1) : t;
  const m = map || { code: 0, origin: 1, moq: 2, status: 3 };
  const cell = (r, k) => (m[k] == null ? '' : r[m[k]]);
  const rows = body.map((r, i) => ({
    row: i + (map ? 2 : 1),
    code: String(cell(r, 'code') == null ? '' : cell(r, 'code')).trim().toUpperCase(),
    origin: cell(r, 'origin'), moq: cell(r, 'moq'), status: cell(r, 'status'),
  }));
  return { rows, header: !!map };
}

/** 붙여넣기 텍스트(엑셀 복사 = 탭 구분) → 표 */
export function pasteToTable(text) {
  return String(text || '').replace(/\r/g, '').split('\n').map((l) => l.split('\t'));
}

/**
 * 행 → 바꿀 내용(제품 현재값과 비교).
 *   cur: Map(code → {id, code, name, origin, moq, factory_status})
 *   반환: { items:[{row, code, product_id, name, changes:{field:{from,to}}}], unchanged, errors:[{row, code, msg}], not_found:[code], dup }
 */
export function planFactoryChanges(rows, cur) {
  const out = { items: [], unchanged: 0, errors: [], not_found: [], dup: 0 };
  // 같은 CTR 이 여러 번 나오면 마지막 줄이 이긴다(엑셀에서 아래로 갈수록 최신으로 보는 습관)
  const last = new Map();
  for (const r of rows || []) {
    if (r.code && last.has(r.code)) out.dup++;
    last.set(r.code || `__blank${r.row}`, r);
  }
  for (const r of last.values()) {
    if (!r.code) { out.errors.push({ row: r.row, code: '', msg: 'CTR 코드가 비어 있음' }); continue; }
    const p = cur.get(r.code);
    if (!p) { out.not_found.push(r.code); continue; }
    const o = parseOrigin(r.origin), q = parseMoq(r.moq), s = parseFactoryStatus(r.status);
    const errs = [o, q, s].filter((x) => x.error).map((x) => x.error);
    if (errs.length) { out.errors.push({ row: r.row, code: r.code, msg: errs.join(' · ') }); continue; }
    const changes = {};
    const put = (field, parsed, now) => {
      if (parsed.skip) return;
      const to = parsed.clear ? null : parsed.value;
      const a = now == null ? null : (field === 'moq' ? Number(now) : String(now));
      if ((a == null && to == null) || (a != null && to != null && String(a) === String(to))) return;
      changes[field] = { from: a, to };
    };
    put('origin', o, p.origin == null || p.origin === '' ? null : p.origin);
    put('moq', q, p.moq);
    put('factory_status', s, p.factory_status);
    if (!Object.keys(changes).length) { out.unchanged++; continue; }
    out.items.push({ row: r.row, code: r.code, product_id: Number(p.id), name: p.name || null, changes });
  }
  out.not_found = [...new Set(out.not_found)];
  return out;
}
