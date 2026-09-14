// =====================================================================
// Refatrix ERP · surveyAi.js — 「제품·마케팅 › 고객 설문 분석」 순수 함수 모음 (2026-09-11)
//
//   ① 문항 정의(questions JSON) 정규화 — 화면에서 고친 표를 서버가 믿을 수 있는 모양으로
//   ② 빈 양식 → 문항 추출 프롬프트/파서
//   ③ 설문지 1장 → 붉은 번호 + 문항별 답 프롬프트/파서 (보기와 대조해 정규화)
//   ④ 붉은 번호 정규화 · 파일명 계산
//   ⑤ 서술형 주제 묶기 · 세그먼트 한 줄 해석 프롬프트/파서
//   ⑥ 무압축(STORE) zip 쓰기 — 원본 전체 다운로드용(외부 라이브러리 없음)
//
//   네트워크·DB 호출 없음. surveyRoutes.js 가 사용하고, 전부 단위 테스트한다.
// =====================================================================

export const Q_TYPES = ['single', 'multi', 'scale', 'number', 'text', 'info'];
export const Q_TYPE_LABEL = {
  single: '단일선택', multi: '복수선택', scale: '척도', number: '숫자', text: '서술형', info: '기재정보',
};
const MAX_Q = 80;
const MAX_OPTS = 40;

export function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) : t;
}
function clipKeepLines(s, n) {
  const t = String(s == null ? '' : s).replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > n ? t.slice(0, n) : t;
}

// 비교용 접기 — 대소문자·악센트·구두점·공백 무시 ("Taller mecánico" == "taller mecanico")
export function fold(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9가-힣]+/g, ' ').trim();
}

// ── ① 문항 정의 정규화 ─────────────────────────────────────────────
//   · key(q1, q2…)는 한번 정해지면 바뀌지 않는다 — 답이 key 로 저장되기 때문.
//   · 새 문항은 지금까지 쓴 가장 큰 번호 다음을 받는다(지운 번호를 재사용하지 않음).
export function normalizeQuestions(list, prevQuestions) {
  const errors = [];
  const src = Array.isArray(list) ? list.slice(0, MAX_Q) : [];
  const used = new Set();
  let maxN = 0;
  for (const q of (Array.isArray(prevQuestions) ? prevQuestions : [])) {
    const m = /^q(\d{1,3})$/.exec(String(q && q.k || ''));
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  for (const q of src) {
    const m = /^q(\d{1,3})$/.exec(String(q && q.k || ''));
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  const out = [];
  src.forEach((raw, i) => {
    const q = raw && typeof raw === 'object' ? raw : {};
    let k = String(q.k || '');
    if (!/^q\d{1,3}$/.test(k) || used.has(k)) { maxN += 1; k = 'q' + maxN; }
    used.add(k);
    const type = Q_TYPES.includes(q.type) ? q.type : 'single';
    const text = clip(q.text, 300);
    if (!text) errors.push({ at: i + 1, error: 'no_text' });
    const item = { k, no: out.length + 1, text, ko: clip(q.ko, 200), type };
    if (type === 'single' || type === 'multi') {
      const seen = new Set();
      const opts = []; const optsKo = [];
      const rawOpts = Array.isArray(q.options) ? q.options : String(q.options || '').split(/\n|,/);
      const rawKo = Array.isArray(q.options_ko) ? q.options_ko : [];
      rawOpts.forEach((o, j) => {
        const v = clip(o, 120);
        if (!v || seen.has(fold(v))) return;
        seen.add(fold(v));
        opts.push(v); optsKo.push(clip(rawKo[j], 120));
      });
      item.options = opts.slice(0, MAX_OPTS);
      item.options_ko = optsKo.slice(0, MAX_OPTS);
      if (!item.options_ko.some(Boolean)) item.options_ko = [];
      if (item.options.length < 2) errors.push({ at: i + 1, error: 'few_options' });
      item.seg = type === 'single' && !!q.seg;
    } else if (type === 'scale') {
      let mn = Number.isInteger(Number(q.min)) ? Number(q.min) : 1;
      let mx = Number.isInteger(Number(q.max)) ? Number(q.max) : 5;
      if (mn < 0 || mn > 10) mn = 1;
      if (mx <= mn || mx - mn > 10) mx = mn + 4;
      item.min = mn; item.max = mx;
      item.min_label = clip(q.min_label, 60);
      item.max_label = clip(q.max_label, 60);
    }
    out.push(item);
  });
  return { questions: out, errors };
}

export function scaleOptions(q) {
  const a = [];
  for (let v = Number(q.min); v <= Number(q.max); v++) a.push(v);
  return a;
}

// ── 공통: 응답에서 JSON 한 덩어리 꺼내기 ────────────────────────────
export function extractJson(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { return null; }
}

// ── ② 빈 양식 → 문항 추출 ───────────────────────────────────────────
export function buildTemplatePrompt() {
  return [
    'Eres un asistente que digitaliza formularios de encuesta impresos para un distribuidor de autopartes en México.',
    'La imagen es el FORMULARIO VACÍO (o uno contestado — ignora las respuestas). Extrae TODAS las preguntas en orden.',
    '',
    'Devuelve SOLO un objeto JSON, sin texto adicional, con esta forma:',
    '{"title":"título del formulario","number_hint":"dónde está el número de folio escrito en ROJO (p.ej. esquina superior derecha)",',
    ' "questions":[{"text":"texto original de la pregunta","ko":"번역(한국어, 짧게)","type":"single|multi|scale|number|text|info",',
    '   "options":["opción 1","opción 2"],"options_ko":["한국어","..."],"min":1,"max":5,"min_label":"","max_label":"","seg":false}]}',
    '',
    'Reglas de tipo:',
    '- single: casillas/círculos donde se elige UNA opción. multi: "puede marcar varias" o casillas múltiples.',
    '- scale: escala numérica o de satisfacción (1-5, 1-10, estrellas). Pon min y max. Si hay palabras en los extremos (p.ej. "Malo"/"Excelente") ponlas en min_label/max_label.',
    '- number: se escribe una cantidad (piezas al mes, empleados, años).',
    '- text: opinión/comentario abierto (se resumirá por temas).',
    '- info: datos de contacto o identificación escritos a mano (nombre, negocio, teléfono, correo, dirección, RFC). No se analizan.',
    '- Si una opción es "Otro: ____" incluye la opción "Otro" tal cual.',
    '- Si hay una tabla/matriz (p.ej. calificar varias marcas), crea UNA pregunta por fila: "Pregunta — Fila".',
    '- seg=true SOLO para preguntas single de perfil del cliente (giro/tipo de negocio, estado/ciudad, tamaño, antigüedad).',
    '- El número de folio en rojo NO es una pregunta.',
    '- Conserva el texto original en español; "ko" y "options_ko" son traducciones cortas al coreano.',
  ].join('\n');
}

export function parseTemplateJson(text) {
  const j = extractJson(text);
  if (!j || !Array.isArray(j.questions)) return null;
  const { questions } = normalizeQuestions(j.questions.map((q) => ({ ...q, k: '' })));
  if (!questions.length) return null;
  return { title: clip(j.title, 200), number_hint: clip(j.number_hint, 300), questions };
}

// ── ③ 설문지 1장 판독 ──────────────────────────────────────────────
export function schemaForPrompt(questions) {
  return questions.map((q) => {
    const o = { k: q.k, type: q.type, text: q.text };
    if (q.type === 'single' || q.type === 'multi') o.options = q.options;
    if (q.type === 'scale') { o.min = q.min; o.max = q.max; }
    return o;
  });
}

export function buildPagePrompt(questions, numberHint) {
  return [
    'Eres un capturista experto. La imagen es UNA hoja de encuesta contestada a mano por un cliente (México, español).',
    'Lee el NÚMERO DE FOLIO escrito o sellado en color ROJO' + (numberHint ? ' (ubicación habitual: ' + clip(numberHint, 200) + ')' : '') + ' y las respuestas de cada pregunta.',
    '',
    'Preguntas del formulario (usa exactamente estas claves k y, para opciones, el texto exacto de "options"):',
    JSON.stringify(schemaForPrompt(questions)),
    '',
    'Devuelve SOLO un objeto JSON:',
    '{"red_number":"0137 o null si no hay/ilegible","red_number_confidence":"high|low",',
    ' "answers":{"q1":"opción exacta","q2":["opción","opción"],"q3":4,"q4":"texto transcrito"},',
    ' "others":{"q1":"lo escrito en Otro: ____"},"low_confidence":["q2"],"not_survey":false,"notes":""}',
    '',
    'Reglas:',
    '- single: una opción de la lista (texto exacto) o null si no contestó. Si marcó "Otro" y escribió algo, pon "Otro" y el texto en others.',
    '- multi: arreglo con las opciones marcadas (texto exacto); [] si ninguna.',
    '- scale / number: número; null si no contestó.',
    '- text / info: transcribe literalmente lo escrito, en su idioma original, sin corregir ni resumir; "" si está vacío.',
    '- Una marca puede ser ✓, ✗, círculo, relleno o subrayado. Ignora marcas tachadas/borradas.',
    '- Si hay dos opciones marcadas en una pregunta single, elige la más clara y agrega la clave a low_confidence.',
    '- Agrega a low_confidence toda clave cuya lectura sea dudosa (letra ilegible, marca ambigua, foto borrosa).',
    '- No inventes respuestas. Si la hoja NO es este formulario, pon "not_survey": true.',
  ].join('\n');
}

// 보기 대조 — 정확히 같으면 그것, 아니면 접은 값이 같거나 한쪽이 다른 쪽을 품는 유일한 보기
export function matchOption(value, options) {
  if (value == null) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (options.includes(v)) return v;
  const fv = fold(v);
  if (!fv) return null;
  const eq = options.filter((o) => fold(o) === fv);
  if (eq.length === 1) return eq[0];
  const part = options.filter((o) => { const fo = fold(o); return fo && (fo.startsWith(fv) || fv.startsWith(fo)); });
  if (part.length === 1) return part[0];
  return null;
}
const OTHER_RE = /^(otro|otra|otros|otras|other|기타)$/;
function otherOption(options) { return options.find((o) => OTHER_RE.test(fold(o))) || null; }

export function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).replace(/[$,\s]/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// 붉은 번호 — 숫자 덩어리만 남기고 4자리로 채운다 ("Nº 137" → "0137"). 숫자가 없으면 null.
export function normRedNumber(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || /^(null|none|n\/?a|-|\?+)$/i.test(s)) return null;
  const m = s.match(/\d+/g);
  if (!m) return null;
  let d = m.join('');
  if (m.length > 1 && m[0].length >= 3) d = m[0];      // "137 / 2026" 같은 경우 첫 덩어리
  d = d.replace(/^0+(?=\d)/, '');
  if (d.length > 8) d = d.slice(0, 8);
  return d.padStart(4, '0');
}

export function normalizeAnswers(rawAnswers, rawOthers, rawLow, questions) {
  const A = rawAnswers && typeof rawAnswers === 'object' ? rawAnswers : {};
  const O = rawOthers && typeof rawOthers === 'object' ? rawOthers : {};
  const low = new Set((Array.isArray(rawLow) ? rawLow : []).map(String));
  const answers = {}; const others = {};
  for (const q of questions) {
    const v = A[q.k];
    if (q.type === 'single') {
      let m = null;
      if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) {
        const cand = Array.isArray(v) ? v[0] : v;
        if (Array.isArray(v) && v.length > 1) low.add(q.k);
        m = matchOption(cand, q.options);
        if (!m) {
          const oth = otherOption(q.options);
          if (oth) { m = oth; others[q.k] = clip(cand, 200); }
          low.add(q.k);
        }
      }
      answers[q.k] = m;
      if (m && O[q.k] && OTHER_RE.test(fold(m))) others[q.k] = clip(O[q.k], 200);
    } else if (q.type === 'multi') {
      const arr = Array.isArray(v) ? v : (v == null || v === '' ? [] : String(v).split(/[;,|]/));
      const got = new Set();
      for (const x of arr) {
        const m = matchOption(x, q.options);
        if (m) got.add(m);
        else if (String(x || '').trim()) {
          const oth = otherOption(q.options);
          if (oth) { got.add(oth); others[q.k] = clip(x, 200); }
          low.add(q.k);
        }
      }
      answers[q.k] = q.options.filter((o) => got.has(o));
      if (O[q.k] && answers[q.k].some((o) => OTHER_RE.test(fold(o)))) others[q.k] = clip(O[q.k], 200);
    } else if (q.type === 'scale') {
      const n = toNumber(v);
      if (n == null) answers[q.k] = null;
      else if (Number.isInteger(n) && n >= q.min && n <= q.max) answers[q.k] = n;
      else { answers[q.k] = null; low.add(q.k); }
    } else if (q.type === 'number') {
      const n = toNumber(v);
      if (v != null && v !== '' && n == null) low.add(q.k);
      answers[q.k] = n;
    } else {
      answers[q.k] = clipKeepLines(Array.isArray(v) ? v.join(', ') : v, 2000);
    }
  }
  const keys = new Set(questions.map((q) => q.k));
  return { answers, others, low_conf: [...low].filter((k) => keys.has(k)) };
}

export function parsePageJson(text, questions) {
  const j = extractJson(text);
  if (!j || typeof j !== 'object') return null;
  if (j.not_survey === true) return { not_survey: true };
  const red_raw = j.red_number == null ? null : clip(j.red_number, 40);
  const red_number = normRedNumber(red_raw);
  const n = normalizeAnswers(j.answers, j.others, j.low_confidence, questions);
  if (red_number && String(j.red_number_confidence || '').toLowerCase() === 'low') n.low_conf.push('_no');
  return { red_raw, red_number, ...n, notes: clip(j.notes, 500) };
}

// ── ④ 파일명 ────────────────────────────────────────────────────────
export function extOf(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  return 'jpg';
}
export function normPrefix(v) {
  return String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9-]+/g, '').slice(0, 16);
}
// 정상  : EXPO26_0137.jpg      중복 : EXPO26_0137-2.jpg
// 번호없음: EXPO26_SIN-NUM_007.jpg  (판독 전: EXPO26_P007.jpg)
export function pageFileName({ prefix, red_number, dup_idx, seq, mime, status }) {
  const p = normPrefix(prefix) || 'ENC';
  const ext = extOf(mime);
  const s3 = String(Number(seq) || 0).padStart(3, '0');
  if (red_number) return `${p}_${red_number}${Number(dup_idx) > 1 ? '-' + Number(dup_idx) : ''}.${ext}`;
  if (status === 'done') return `${p}_SIN-NUM_${s3}.${ext}`;
  return `${p}_P${s3}.${ext}`;
}

// ── ⑤ 서술형 주제 묶기 · 한 줄 해석 ─────────────────────────────────
export function buildThemePrompt(q, items) {
  const list = items.map((it) => ({ id: Number(it.id), t: clip(it.text, 400) }));
  return [
    'Agrupa las respuestas abiertas de una encuesta a clientes de autopartes (México) en temas.',
    'Pregunta: ' + q.text + (q.ko ? ' (' + q.ko + ')' : ''),
    'Respuestas (id, texto): ' + JSON.stringify(list),
    '',
    'Devuelve SOLO JSON: {"themes":[{"name":"tema corto en español","ko":"짧은 한국어 이름","summary_ko":"한 문장 한국어 설명","ids":[1,2]}]}',
    'Reglas: máximo 8 temas, ordenados de más a menos respuestas. Cada id en UN solo tema.',
    'Respuestas sin contenido útil ("n/a", "ninguno", "todo bien") van al tema "Sin comentario relevante".',
    'No inventes ids. Usa sólo los ids dados.',
  ].join('\n');
}

export function parseThemeJson(text, validIds) {
  const j = extractJson(text);
  if (!j || !Array.isArray(j.themes)) return null;
  const valid = new Set((validIds || []).map(Number));
  const taken = new Set();
  const themes = [];
  for (const t of j.themes.slice(0, 10)) {
    const ids = [];
    for (const x of Array.isArray(t && t.ids) ? t.ids : []) {
      const n = Number(x);
      if (valid.has(n) && !taken.has(n)) { taken.add(n); ids.push(n); }
    }
    if (!ids.length) continue;
    themes.push({ name: clip(t.name, 80) || 'Tema', ko: clip(t.ko, 60), summary_ko: clip(t.summary_ko, 200), ids });
  }
  const rest = [...valid].filter((id) => !taken.has(id));
  if (rest.length) themes.push({ name: 'Otros', ko: '기타', summary_ko: '', ids: rest });
  themes.sort((a, b) => b.ids.length - a.ids.length);
  return themes;
}

// 세그먼트 교차 요약(프롬프트용 텍스트) — 비율만 보낸다(원문·개인정보는 보내지 않는다)
export function crossSummaryText(questions, rows) {
  const cats = questions.filter((q) => q.type === 'single' || q.type === 'multi' || q.type === 'scale');
  const segs = questions.filter((q) => q.seg);
  const lines = [];
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const distLine = (q, rs) => {
    if (q.type === 'scale') {
      const vals = rs.map((r) => r.answers && r.answers[q.k]).filter((v) => v != null);
      const avg = vals.length ? (vals.reduce((a, b) => a + Number(b), 0) / vals.length).toFixed(2) : '-';
      return `avg ${avg} (n=${vals.length})`;
    }
    const cnt = {}; q.options.forEach((o) => { cnt[o] = 0; });
    let n = 0;
    for (const r of rs) {
      const v = r.answers && r.answers[q.k];
      if (q.type === 'multi') { if (Array.isArray(v) && v.length) { n++; v.forEach((x) => { if (x in cnt) cnt[x]++; }); } }
      else if (v != null && v in cnt) { n++; cnt[v]++; }
    }
    return q.options.map((o) => `${o} ${pct(cnt[o], n)}%`).join(', ') + ` (n=${n})`;
  };
  lines.push(`Total respuestas: ${rows.length}`);
  for (const q of cats) lines.push(`[${q.k}] ${q.text}: ${distLine(q, rows)}`);
  for (const s of segs) {
    for (const so of s.options) {
      const rs = rows.filter((r) => r.answers && r.answers[s.k] === so);
      if (!rs.length) continue;
      for (const q of cats) {
        if (q.k === s.k) continue;
        lines.push(`  ${s.text}=${so} (n=${rs.length}) → [${q.k}] ${distLine(q, rs)}`);
      }
    }
  }
  return lines.join('\n').slice(0, 24000);
}

export function buildInsightPrompt(title, summaryText) {
  return [
    '당신은 멕시코 자동차 부품 유통사(Refatrix, CTR 브랜드)의 마케팅 분석가다.',
    `아래는 고객 설문 「${clip(title, 120)}」 의 집계(비율)다. 세그먼트 간 차이가 뚜렷한 점 위주로 한국어 bullet 4~6개를 써라.`,
    '- 숫자는 집계에 있는 것만 인용한다. 지어내지 않는다.',
    '- n 이 10 미만인 세그먼트는 「표본 적음」 이라고 붙인다.',
    '- 각 bullet 은 한 문장, 120자 이내.',
    '- 마지막 bullet 하나는 영업·마케팅 제안(근거 수치 포함).',
    '출력은 JSON 만: {"bullets":["...","..."]}',
    '',
    summaryText,
  ].join('\n');
}
export function parseInsightJson(text) {
  const j = extractJson(text);
  if (!j || !Array.isArray(j.bullets)) return null;
  const b = j.bullets.map((x) => clip(x, 240)).filter(Boolean).slice(0, 8);
  return b.length ? b : null;
}

// ── ⑥ 무압축 zip ────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function dosDateTime(d) {
  const t = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date();
  const time = (t.getHours() << 11) | (t.getMinutes() << 5) | Math.floor(t.getSeconds() / 2);
  const date = ((Math.max(t.getFullYear(), 1980) - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate();
  return { time, date };
}
// 스트리밍 zip — entries 는 async iterable of {name, data:Buffer, date}. 청크(Buffer)를 차례로 내놓는다.
export async function* zipStream(entries) {
  const central = [];
  let offset = 0;
  for await (const e of entries) {
    const name = Buffer.from(String(e.name), 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || []);
    const crc = crc32(data);
    const { time, date } = dosDateTime(e.date);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    yield lh; yield name; yield data;
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, name]));
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  yield cd; yield end;
}
