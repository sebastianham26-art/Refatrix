// =====================================================================
// 2026-10-22 · 제품 장착 위치(앞/뒤 · 상/하 · 좌/우) — 원본 읽기 · 정리 · 요약 (DB 없이 쓰는 순수 함수)
//   원본: REFATRIX Platform Export (CrossReference 시트) — H열 Block(Front/Rear) · J열 Position(Front Lower LH …)
//         코드는 W열 CTR, AI열 4th CTR(「X」 = 없음). 한 칸에 여러 코드면 ' // ' 로 구분.
//   규칙
//   - 앞/뒤: Position 이 Front/Rear 로 시작하면 그것, 아니면 Block.  상/하: Upper/Lower.  좌/우: LH/RH(끝 단어).
//   - 스페인어·한국어 표기도 받음(Delantera/Trasera · Superior/Inferior · Izq/Der · 앞/뒤 · 상/하 · 좌/우).
//   - 코드가 L/R 짝(같은 앞부분 + L, R 둘 다 있음)이면 좌우는 코드 접미사가 맞다:
//       원본이 「CQ0340L // CQ0340R」 를 LH 한 줄에 같이 적은 경우 등 → R 코드는 RH 로 고치고 side_fixed 표시.
//       원본에 좌우가 없으면(Front 등) 접미사로 채움(side_fixed).
// =====================================================================

export const KO = { front: '앞', rear: '뒤', upper: '상', lower: '하', lh: '좌', rh: '우' };
export const ES = { front: 'Delantera', rear: 'Trasera', upper: 'Superior', lower: 'Inferior', lh: 'Izquierda', rh: 'Derecha' };
const ORDER = { front: 0, rear: 1, upper: 0, lower: 1, lh: 0, rh: 1 };

// 악센트만 떼고 한글은 다시 합침(NFD 는 한글을 자모로 쪼갬)
const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC').toUpperCase().replace(/\s+/g, ' ').trim();

function blockOf(t) {
  if (/^(FRONT|DELANTER[OA]|DEL\.?|앞)\b/.test(t) || /^앞/.test(t)) return 'front';
  if (/^(REAR|TRASER[OA]|TRAS\.?|뒤)\b/.test(t) || /^뒤/.test(t)) return 'rear';
  return null;
}
// Position 글자 + Block → {block, level, side}. 앞/뒤를 못 정하면 null
export function parsePosition(blockText, posText) {
  const p = norm(posText), b = norm(blockText);
  const block = blockOf(p) || blockOf(b);
  if (!block) return null;
  let level = null;
  if (/\b(UPPER|SUPERIOR|SUP)\b|상/.test(p)) level = 'upper';
  else if (/\b(LOWER|INFERIOR|INF)\b|하/.test(p)) level = 'lower';
  let side = null;
  if (/\b(LH|LEFT|IZQUIERD[OA]|IZQ)\b|좌/.test(p)) side = 'lh';
  else if (/\b(RH|RIGHT|DERECH[OA]|DER)\b|우/.test(p)) side = 'rh';
  return { block, level, side };
}

// 'GV1031 // GV1032' · 'CB0166, CB0167' → ['GV1031','GV1032'] ('X'·빈칸·OE Missing 등은 버림)
export function splitCodes(text) {
  return String(text == null ? '' : text).split(/\s*(?:\/\/|[,;\n])\s*|\s+/).map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}\d{3,5}[A-Z0-9]{0,4}$/.test(c));
}
// 'CQ0340L' → {base:'CQ0340', s:'L'} (숫자 바로 뒤 L/R 만)
export function lrOf(code) { const m = /^(.*\d)([LR])$/.exec(String(code || '')); return m ? { base: m[1], s: m[2] } : null; }

export function yearsOf(text) {
  const m = /(\d{4})\s*[-–~]?\s*(\d{4})?/.exec(String(text || ''));
  if (!m) return { y_from: null, y_to: null };
  const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
  return { y_from: Math.min(a, b), y_to: Math.max(a, b) };
}

// 머리글 찾기 — 대소문자·악센트 무시. 필수: Block(또는 Position) + CTR(또는 4th CTR)
const HEAD = {
  ctr: ['CTR', 'CLAVE CTR', 'CODIGO CTR'], ctr4: ['4TH CTR'], block: ['BLOCK', 'BLOQUE'], position: ['POSITION', 'POSICION', 'POS'],
  part: ['PART', 'PARTE'], brand: ['BRAND', 'MARCA'], model: ['MODEL', 'MODELO'], gen: ['MODEL (GENERATION)', 'GENERATION', 'GENERACION'],
  years: ['MODEL YEARS', 'YEARS', 'ANOS', 'AÑOS'], status: ['STATUS', 'ESTADO'],
};
export function mapHeader(headerRow) {
  const idx = {};
  (headerRow || []).forEach((h, i) => {
    const n = norm(h);
    for (const [k, names] of Object.entries(HEAD)) if (idx[k] == null && names.includes(n)) idx[k] = i;
  });
  return idx;
}

// 원본 줄(배열 또는 {ctr, ctr4, block, position, …}) → 저장할 줄 + 통계
//   knownCodes: 제품 마스터에 있는 코드(대문자) Set — L/R 짝 판정과 「마스터에 없음」 집계에 씀
export function buildPositionRows(input, knownCodes = new Set()) {
  const stats = { rows_in: 0, rows_with_code: 0, no_position: 0, side_fixed: 0, rows_saved: 0, codes: 0, codes_known: 0, unknown_codes: [] };
  const raw = [];
  const allCodes = new Set();
  for (const r of input || []) {
    stats.rows_in++;
    const codes = [];
    for (const [col, v] of [['CTR', r.ctr], ['4th CTR', r.ctr4]]) for (const c of splitCodes(v)) codes.push({ c, col });
    if (!codes.length) continue;
    stats.rows_with_code++;
    const pos = parsePosition(r.block, r.position);
    if (!pos) { stats.no_position++; continue; }
    for (const x of codes) { allCodes.add(x.c); raw.push({ r, pos, ...x }); }
  }
  const has = (c) => knownCodes.has(c) || allCodes.has(c);
  const seen = new Set(); const out = [];
  for (const { r, pos, c, col } of raw) {
    let side = pos.side, fixed = false;
    const lr = lrOf(c);
    if (lr && has(lr.base + (lr.s === 'L' ? 'R' : 'L'))) {        // L/R 짝이 있는 코드 → 접미사가 맞다
      const want = lr.s === 'L' ? 'lh' : 'rh';
      if (side !== want) { side = want; fixed = true; }
    }
    const yrs = yearsOf(r.years);
    const row = {
      ctr_code: c, block: pos.block, level: pos.level, side, side_fixed: fixed,
      pos_raw: String(r.position == null ? '' : r.position).trim() || null, part: str(r.part, 80),
      brand: str(r.brand, 60), model: str(r.model, 80), generation: str(r.gen, 80), years: str(r.years, 30), ...yrs,
      status: str(r.status, 30), src_col: col,
    };
    const key = [c, row.block, row.level, row.side, row.brand, row.model, row.generation, row.years, row.part].join('|');
    if (seen.has(key)) continue;
    seen.add(key); out.push(row); if (fixed) stats.side_fixed++;
  }
  stats.rows_saved = out.length;
  const codes = [...new Set(out.map((x) => x.ctr_code))];
  stats.codes = codes.length;
  stats.codes_known = codes.filter((c) => knownCodes.has(c)).length;
  stats.unknown_codes = codes.filter((c) => !knownCodes.has(c)).sort().slice(0, 200);
  stats.unknown_n = codes.length - stats.codes_known;
  return { rows: out, stats };
}
const str = (v, n) => { const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return s ? s.slice(0, n) : null; };

// 여러 줄 → 요약 {blocks, levels, sides, ko:'앞·하·좌/우', es:'Delantera Inferior Izq./Der.'}
export function summarize(rows) {
  const b = new Set(), l = new Set(), s = new Set();
  for (const r of rows || []) { if (r.block) b.add(r.block); if (r.level) l.add(r.level); if (r.side) s.add(r.side); }
  const srt = (set) => [...set].sort((x, y) => ORDER[x] - ORDER[y]);
  const blocks = srt(b), levels = srt(l), sides = srt(s);
  const part = (arr, map) => arr.map((k) => map[k]).join('/');
  const ko = [part(blocks, KO), part(levels, KO), part(sides, KO)].filter(Boolean).join('·');
  return { blocks, levels, sides, ko };
}
