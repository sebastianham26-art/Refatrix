// =====================================================================
// Refatrix ERP · vehicleMap.js — 「차종으로 제품찾기」 차량 도면용 순수 함수 (2026-11-27 · 디렉터 요청)
//   화면: 제품마케팅 › 제품 › 제품 찾기 › 상단 토글 「🚗 차종으로 제품찾기」
//   API : GET /api/products/vehicle-map (routes/vehicleMapRoutes.js)
//
//   여기 함수는 DB 를 쓰지 않는다(시험 · 재사용용).
//   - partCat(text)      품명(DESCRIPCIÓN) → 부품 무리(랙엔드 · 타이로드엔드 · 부싱 · 컨트롤암 · 볼조인트 · 링크 · 쇽업소버 · 기타)
//   - posLoose(text)     경쟁사 마스터 UBICACIÓN · 품명처럼 자유 글 → {blocks, levels, sides} (모르는 낱말은 건너뜀)
//   - appMatch(text, v)  경쟁사 마스터 APLICACIÓN 글이 고른 차종(메이커 · 모델 · 연식)에 맞는지
//   - posForVehicle      제품 장착위치 — CTR 확인값(mount_pos) → 이 차종 업로드 줄 → 전체 업로드 줄 순
// =====================================================================
import { parsePosText, summarize } from './productPositions.js';

const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC')
  .toUpperCase().replace(/\s+/g, ' ').trim();

// 부품 무리 — 위에서부터 먼저 맞는 것. (TERMINAL INTERIOR 는 랙엔드, 그냥 TERMINAL 은 타이로드엔드)
export const CATS = [
  { k: 'rack', ko: '랙엔드', es: 'Terminal interior', re: /\b(TERMINAL\s+INT(ERIOR)?|BIELETA|AXIAL|INNER\s+TIE|RACK\s+END)\b|랙\s*엔드/ },
  { k: 'tie', ko: '타이로드엔드', es: 'Terminal exterior', re: /\b(TERMINAL|TIE\s*ROD|OUTER\s+TIE)\b|타이로드/ },
  { k: 'bush', ko: '부싱', es: 'Buje', re: /\b(BUJE|BUJES|BUSHING|SILENT\s*BLOCK)\b|부싱/ },
  { k: 'arm', ko: '컨트롤암', es: 'Horquilla / Brazo', re: /\b(HORQUILLA|BRAZO|CONTROL\s*ARM|TRAILING|WISHBONE)\b|컨트롤\s*암/ },
  { k: 'ball', ko: '볼조인트', es: 'Rótula', re: /\b(ROTULA|BALL\s*JOINT)\b|볼\s*조인트/ },
  { k: 'link', ko: '스태빌라이저 링크', es: 'Tornillo estabilizador', re: /\b(ESTABILIZADOR(A)?|STABILIZER|SWAY\s*BAR|LINK|BARRA\s+EST)\b|스태빌|링크/ },
  { k: 'shock', ko: '쇽업소버', es: 'Amortiguador', re: /\b(AMORTIGUADOR|SHOCK|STRUT|BASE\s+AMORT)\b|쇽|쇼크/ },
];
export const OTHER = { k: 'other', ko: '기타', es: 'Otros' };
export function partCat(text) {
  const t = norm(text);
  if (!t) return OTHER.k;
  for (const c of CATS) if (c.re.test(t)) return c.k;
  return OTHER.k;
}
export const CAT_LABEL = Object.fromEntries([...CATS, OTHER].map((c) => [c.k, { ko: c.ko, es: c.es }]));

// 자유 글 위치 — 낱말 단위로 찾되 모르는 낱말은 무시(마스터 글에는 품명 · 차종이 섞여 있다)
const W = {
  front: /^(FRONT|FR|DELANTER[OA]S?|DEL|DELANT)$/, rear: /^(REAR|RR|TRASER[OA]S?|TRAS|POSTERIOR(ES)?)$/,
  upper: /^(UPPER|UP|SUPERIOR(ES)?|SUP)$/, lower: /^(LOWER|LO|INFERIOR(ES)?|INF)$/,
  lh: /^(LH|LEFT|IZQUIERD[OA]S?|IZQ|IZQDO|IZQDA)$/, rh: /^(RH|RIGHT|DERECH[OA]S?|DER|DCHO|DCHA)$/,
};
const BOTH = /^(AMBOS|AMBAS|LR|L-R|PAR)$/;
export function posLoose(text) {
  const t = norm(text);
  if (!t) return null;
  const strict = parsePosText(t);
  if (strict && !strict.error) return strict;
  const got = { blocks: new Set(), levels: new Set(), sides: new Set() };
  for (const raw of t.split(/[\s\/·,;+&()|.\-]+/)) {
    const tk = raw.trim(); if (!tk) continue;
    if (BOTH.test(tk)) { got.sides.add('lh'); got.sides.add('rh'); continue; }
    if (W.front.test(tk)) got.blocks.add('front'); else if (W.rear.test(tk)) got.blocks.add('rear');
    else if (W.upper.test(tk)) got.levels.add('upper'); else if (W.lower.test(tk)) got.levels.add('lower');
    else if (W.lh.test(tk)) got.sides.add('lh'); else if (W.rh.test(tk)) got.sides.add('rh');
  }
  // 붙여 쓴 한글(앞하좌)
  for (const ch of t) {
    if (ch === '앞') got.blocks.add('front'); else if (ch === '뒤') got.blocks.add('rear');
    else if (ch === '상') got.levels.add('upper'); else if (ch === '하') got.levels.add('lower');
    else if (ch === '좌') got.sides.add('lh'); else if (ch === '우') got.sides.add('rh');
  }
  const O = { front: 0, rear: 1, upper: 0, lower: 1, lh: 0, rh: 1 };
  const srt = (s) => [...s].sort((a, b) => O[a] - O[b]);
  const out = { blocks: srt(got.blocks), levels: srt(got.levels), sides: srt(got.sides) };
  return out.blocks.length || out.levels.length || out.sides.length ? out : null;
}

// ── 2026-11-27b · 메이커 · 모델 이름 키 — 카탈로그 마스터는 그대로 두고 「같은 이름」으로 본다 ──
//   대소문자 · 하이픈 · 공백 · 점 · 슬래시 · 악센트 차이를 지운다.
//     'CR-V' = 'CRV' = 'Cr V' · 'Mercedes-Benz' = 'MERCEDES BENZ' · 'Peugeot 206' = 'PEUGEOT-206' · 'Citroën' = 'CITROEN'
//   숫자 · 글자 자체가 다르면(예: 'Jetta A4' ≠ 'Jetta') 다른 모델이다. 줄임말(VW ↔ VOLKSWAGEN)은 여기서 합치지 않는다.
export function nameKey(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC').toUpperCase().replace(/[^A-Z0-9가-힣]/g, '');
}
/** SQL 쪽 같은 키 — translate 로 악센트, regexp 로 기호 · 공백 제거(확장 모듈 없이). col 은 신뢰된 열 이름만. */
export const NK_SQL = (col) => `regexp_replace(upper(translate(COALESCE(${col},''), 'áéíóúàèìòùäëïöüâêîôûãõñçÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÂÊÎÔÛÃÕÑÇ', 'aeiouaeiouaeiouaeiouaonc' || 'AEIOUAEIOUAEIOUAEIOUAONC')), '[^A-Z0-9가-힣]', '', 'g')`;
// ── 2026-11-27e · 한 칸에 메이커가 여럿 — 'FORD, MERCURY' · 'Ford/Mercury' · 'FORD & LINCOLN' → 낱개 메이커로 본다 ──
//   드롭다운엔 FORD · MERCURY 가 따로 한 줄씩, FORD 를 고르면 'FORD, MERCURY' 칸의 차종도 함께 나온다(원문은 그대로).
export const MAKER_SEP_RE = /\s*(?:,|\/|&|\+|;)\s*/;
export function makerParts(s) {
  return String(s == null ? '' : s).split(MAKER_SEP_RE).map((x) => x.trim()).filter((x) => nameKey(x));
}
/** SQL: 메이커 칸 → 낱개 배열(같은 구분자) */
export const MK_PARTS_SQL = (col) => `regexp_split_to_array(COALESCE(${col},''), '\\s*[,/&+;]\\s*')`;
/** SQL 조건: 메이커 칸의 낱개 중 하나가 이름 키 $n 과 같다 */
export const MAKER_COND_SQL = (col, n) => `EXISTS (SELECT 1 FROM unnest(${MK_PARTS_SQL(col)}) AS mkp(x) WHERE ${NK_SQL('mkp.x')} = $${n})`;

/** 원문 → 낱말 키 배열('Honda CR-V 2015' → ['HONDA','CR','V','2015']) */
const tokens = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC').toUpperCase().split(/[^A-Z0-9가-힣]+/).filter(Boolean);
/**
 * 글 안에 이름이 「낱말 경계」로 들어 있는가 — 기호 · 공백 차이 무시.
 *   hasName('Honda CR V 2015', 'CR-V') → true · hasName('VERSAILLES', 'Versa') → false
 *   이어진 낱말 몇 개를 붙인 것이 이름 키와 같으면 맞음.
 */
export function hasName(text, name) {
  const k = nameKey(name);
  if (!k) return false;
  const t = tokens(text);
  for (let i = 0; i < t.length; i++) {
    let acc = '';
    for (let j = i; j < t.length && acc.length < k.length; j++) {
      acc += t[j];
      if (acc === k) return true;
    }
  }
  return false;
}

// ── 차종 맞춤 ─────────────────────────────────────────────────────────
const MAKER_ALIAS = {
  VOLKSWAGEN: ['VOLKSWAGEN', 'VW'], CHEVROLET: ['CHEVROLET', 'CHEVY', 'GM'], 'MERCEDES BENZ': ['MERCEDES', 'BENZ'],
  'GENERAL MOTORS': ['GM', 'CHEVROLET'],
};
export function makerWords(maker) {
  const m = norm(maker);
  if (!m) return [];
  const byKey = Object.keys(MAKER_ALIAS).find((k) => nameKey(k) === nameKey(m));
  return byKey ? MAKER_ALIAS[byKey] : [m];
}
// 'Versa 2012-2019' · 'VERSA 12-19' · '2015' → [[2012,2019], …]
export function yearRanges(text) {
  const t = String(text == null ? '' : text);
  const out = [];
  const re4 = /((?:19|20)\d{2})\s*(?:[-–~/]|A|AL)?\s*((?:19|20)\d{2}|\d{2})?/gi;
  let m;
  while ((m = re4.exec(t)) !== null) {
    const a = Number(m[1]);
    let b = a;
    if (m[2]) { b = m[2].length === 2 ? Number(String(a).slice(0, 2) + m[2]) : Number(m[2]); if (b < a) b = a; }
    out.push([a, b]);
  }
  if (!out.length) {   // 4자리가 하나도 없으면 '12-19' 같은 두 자리 범위
    const re2 = /\b(\d{2})\s*[-–~/]\s*(\d{2})\b/g;
    while ((m = re2.exec(t)) !== null) {
      const yy = (n) => (Number(n) > 50 ? 1900 : 2000) + Number(n);
      const a = yy(m[1]), b = yy(m[2]);
      out.push([Math.min(a, b), Math.max(a, b)]);
    }
  }
  return out;
}
/**
 * 경쟁사 마스터 APLICACIÓN 글 → 고른 차종에 맞으면 { ok:true, year_known } · 아니면 { ok:false }
 *   - 모델 글자(대소문자 · 악센트 무시)가 낱말로 들어 있어야 한다. 한 칸에 차종이 여럿이면 '//' · ',' · ';' 로 나눠 각각 본다.
 *   - 다른 메이커만 적힌 조각은 버린다(메이커가 안 적힌 조각은 받는다).
 *   - 연식을 고르면: 조각에 연식이 있으면 범위 안이어야 하고, 연식이 없으면 받되 year_known:false.
 */
export function appMatch(text, { maker = '', model = '', year = null } = {}, knownMakers = []) {
  if (!nameKey(model)) return { ok: false };
  const mk = makerWords(maker);
  const mkKeys = new Set(mk.map(nameKey));
  // 11-27e · 알려진 메이커 칸을 낱개로 — 내 메이커와 한 칸에 같이 적힌 메이커(FORD, MERCURY 의 MERCURY)는 「다른 메이커」로 치지 않는다
  const sib = new Set();
  const all = new Set();
  for (const raw of knownMakers || []) {
    const ps = makerParts(raw).map(norm);
    ps.forEach((x) => all.add(x));
    if (ps.some((x) => mkKeys.has(nameKey(x)))) ps.forEach((x) => sib.add(nameKey(x)));
  }
  const others = [...all].filter((x) => x && !mkKeys.has(nameKey(x)) && !sib.has(nameKey(x)));
  let best = null;
  for (const seg of String(text == null ? '' : text).split(/\s*(?:\/\/|;|,|\n)\s*/)) {
    const s = norm(seg);
    if (!s || !hasName(s, model)) continue;   // 11-27b · 대소문자 · 하이픈 · 공백 무시
    const hasMine = mk.some((w) => hasName(s, w));
    if (!hasMine && others.some((w) => hasName(s, w))) continue;
    if (year == null) return { ok: true, year_known: false, seg: seg.trim() };
    const rg = yearRanges(seg);
    if (!rg.length) { if (!best) best = { ok: true, year_known: false, seg: seg.trim() }; continue; }
    if (rg.some(([a, b]) => year >= a && year <= b)) return { ok: true, year_known: true, seg: seg.trim() };
  }
  return best || { ok: false };
}

/**
 * 제품 1개의 장착위치(이 차종 기준).
 *   own   = products.mount_pos 원문(CTR 확인값 · 플랫폼 카탈로그 점검) — 있으면 그것
 *   rows  = product_positions 줄들(그 코드 전부)
 *   veh   = {maker, model, year}
 *   반환 {blocks, levels, sides, src:'erp'|'vehicle'|'upload'} 또는 null
 */
export function posForVehicle(own, rows, veh = {}) {
  const p = own ? parsePosText(own) : null;
  if (p && !p.error) return { ...p, src: 'erp' };
  const list = rows || [];
  if (!list.length) return null;
  const mk = makerWords(veh.maker).map(nameKey), mdl = nameKey(veh.model);
  const mine = list.filter((r) => {
    const b = nameKey(r.brand), m = nameKey(r.model);   // 11-27b · 이름 키로 비교
    if (mk.length && b && !mk.some((w) => b.includes(w))) return false;
    if (mdl && m && !(m.includes(mdl) || mdl.includes(m))) return false;
    if (veh.year != null && r.y_from != null && r.y_to != null && (veh.year < r.y_from || veh.year > r.y_to)) return false;
    return !!(b || m);
  });
  const use = mine.length ? mine : list;
  const s = summarize(use);
  if (!s.blocks.length && !s.levels.length && !s.sides.length) return null;
  return { blocks: s.blocks, levels: s.levels, sides: s.sides, src: mine.length ? 'vehicle' : 'upload' };
}
