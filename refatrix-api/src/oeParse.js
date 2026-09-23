// =====================================================================
// Refatrix ERP · oeParse.js — OE(순정) 부품번호 규칙 (순수 함수, DB 없음) · 0228
//
//   설계서: claude/REFATRIX_설계_2026-09-23_oe_codes.md
//
//   엑셀 원문 한 칸 = 여러 OE 를 ' // ' 로 구분 (Clave SyD 와 같은 규칙).
//   토큰 하나의 모양:
//     54500-8H310            직접 OE                      rel='oe'  source='master'
//     FOR 54500-8H310        이 부품이 들어가는 조립품의 OE   rel='for' source='master'
//     48530-3S125 (SYD)      Clave SyD 칸에서 복사한 OE      rel='oe'  source='syd'
//   애프터마켓형 코드(MEVOTECH-… 등)·설명 문구도 **그대로 OE 로** 받는다 (디렉터 결정 D7, 2026-09-23).
//   버리는 것은 「값 없음」 표기(None · #N/A · 0 · 빈칸)와 같은 제품 안의 완전 중복뿐.
//
//   매칭 키(oe_norm) = 대문자 + 영숫자만 — '54500-8H310' == '54500 8H310' == '545008H310'.
//   xrefRoutes.normCode 와 같은 규칙이다(두 벌로 두면 반드시 어긋난다).
// =====================================================================

/** FOR 표기 부연설명 — 화면·견적서·API 에서 같은 문장을 쓴다 (디렉터 지정 문구). */
export const OE_FOR_NOTE = '해당 OE번호 부품의 조립품에 해당하는 OE부품입니다';
/** 고객 문서(스페인어)용 같은 뜻. */
export const OE_FOR_NOTE_ES = 'OE del conjunto (ensamble) al que pertenece esta pieza';

export const normOe = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');

const NULL_TOKENS = new Set(['NONE', 'NAN', 'NULL', '#N/A', 'N/A', 'NA', '0', '-', '—']);
const SYD_MARK = /\s*\(\s*SYD\s*\)\s*$/i;
const FOR_MARK = /^FOR\s+/i;

/**
 * 원문 → [{ oe_code, oe_norm, rel, source }]
 *   · 구분자: ' // ' (앞뒤 공백 유무 무관). 예전 원본에서 쓰던 ';' 도 받는다(OE 에 ';' 는 없다).
 *   · 같은 제품 안에서 oe_norm 이 겹치면 첫 것만 — 단 직접 OE 가 FOR 보다 우선.
 */
export function parseOe(raw) {
  if (raw == null) return [];
  const out = [];
  const byNorm = new Map();
  for (let t of String(raw).split(/\s*(?:\/\/|;)\s*/)) {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (NULL_TOKENS.has(t.toUpperCase())) continue;
    let source = 'master';
    if (SYD_MARK.test(t)) { source = 'syd'; t = t.replace(SYD_MARK, '').trim(); }
    let rel = 'oe';
    if (FOR_MARK.test(t)) { rel = 'for'; t = t.replace(FOR_MARK, '').trim(); }
    if (!t || NULL_TOKENS.has(t.toUpperCase())) continue;
    const oe_norm = normOe(t);
    if (!oe_norm) continue;
    const prev = byNorm.get(oe_norm);
    if (prev) {
      if (prev.rel === 'for' && rel === 'oe') { prev.rel = 'oe'; prev.oe_code = t; prev.source = source; }
      continue;
    }
    const item = { oe_code: t.slice(0, 120), oe_norm: oe_norm.slice(0, 120), rel, source };
    byNorm.set(oe_norm, item);
    out.push(item);
  }
  return out;
}

/** 한 토큰의 표기(원문 규칙 그대로) — 'FOR x' / 'x (SYD)' / 'x'. */
export function oeToken(it) {
  if (!it) return '';
  return (it.rel === 'for' ? 'FOR ' : '') + it.oe_code + (it.source === 'syd' ? ' (SYD)' : '');
}

/** 항목 배열 → 저장용 정규 원문. 비면 null. products.oe 에 이 값이 들어간다(재업로드 멱등). */
export function formatOe(items) {
  const s = (items || []).map(oeToken).filter(Boolean).join(' // ');
  return s || null;
}

/** 원문 → 정규 원문 (None 류 제거·중복 제거·공백 정리). */
export function canonicalOe(raw) { return formatOe(parseOe(raw)); }

/** 두 목록이 같은가 (norm·rel·source 집합 비교 — 순서 무관). */
export function sameOe(a, b) {
  const key = (x) => `${x.oe_norm}|${x.rel}|${x.source}`;
  const A = new Set((a || []).map(key)); const B = new Set((b || []).map(key));
  return A.size === B.size && [...A].every((k) => B.has(k));
}

/**
 * 고객 견적서용 「Referencia OE」 칸 — 직접 OE 만, 앞에서 max 개, 내부 표식(SYD) 없이.
 *   FOR 번호는 고객 문서에 싣지 않는다(조립품 번호라 오해를 부른다).
 */
export function customerOeText(items, max = 3) {
  const d = (items || []).filter((x) => x.rel === 'oe').map((x) => x.oe_code);
  if (!d.length) return '';
  return d.slice(0, max).join(' / ') + (d.length > max ? ` (+${d.length - max})` : '');
}
