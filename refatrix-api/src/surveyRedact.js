// =====================================================================
// Refatrix ERP · surveyRedact.js — 설문지 일괄 다운로드용 「개인정보 가림」 + 책임 확인 문구 (2026-09-30)
//
//   디렉터 요청: 플랫폼(CTR 개발자, 해외)에서 설문지 전체를 한 번에 받게 하되
//     ① 개인정보(이름·상호·전화·메일·주소·RFC·서명)는 **자동으로 가린 사본만** 내려간다
//     ② 받기 전에 「개인정보 유출 책임은 CTR 이 진다」를 확인 체크 → 그 내용을 기록한다
//
//   가림 순서
//     1) 서버 큐가 한 장씩 Claude 에 보내 **가릴 영역(사각형)** 을 받는다 — 이 파일의 buildRedactPrompt/parseRedactJson
//     2) ERP 화면(디렉터)이 원본 그림 위에 검은 사각형을 칠한 JPEG 를 만들어 올린다(브라우저 canvas — 서버에 새 라이브러리 없음)
//     3) 다운로드 zip 에는 **가린 사본만** 들어간다. 원본·화면용 그림은 절대 넣지 않는다.
//   AI 가 놓친 칸은 다른 장들에서 같은 칸의 위치(중앙값)로 메운다(fallbackFor) — 스캔본은 위치가 거의 같다.
//
//   네트워크·DB 호출 없음.
// =====================================================================
import crypto from 'node:crypto';
import { extractJson, clip } from './surveyAi.js';

// ── 가릴 영역 찾기 프롬프트 ──────────────────────────────────────────
export function buildRedactPrompt(questions) {
  const info = (Array.isArray(questions) ? questions : []).filter((q) => q && q.type === 'info')
    .map((q) => ({ k: q.k, campo: clip(q.text, 120) }));
  return [
    'La imagen es UNA hoja de encuesta contestada a mano por un cliente (México). Vamos a compartirla SIN datos personales.',
    'Encuentra TODOS los lugares donde aparecen datos personales y devuelve rectángulos para taparlos.',
    '',
    'Campos de datos personales del formulario (usa su clave k en "k"):',
    JSON.stringify(info),
    '',
    'Tapa (texto escrito a mano o sello del cliente, con todo el renglón del campo):',
    '- nombre de persona, nombre de empresa / taller / refaccionaria, teléfono / WhatsApp, correo, dirección, RFC, firma;',
    '- y cualquier nombre de persona, teléfono o correo escrito en OTRA parte de la hoja (márgenes, comentarios, reverso) → k:"otro".',
    'NO tapes: el número de folio en ROJO, la ciudad / estado, las casillas o respuestas marcadas, el texto impreso del formulario.',
    '',
    'Coordenadas en milésimas (0–1000) del ANCHO y del ALTO de la imagen: x0,y0 = esquina superior izquierda; x1,y1 = esquina inferior derecha.',
    'Sé generoso: el rectángulo debe cubrir toda la escritura con margen. Si un campo está vacío, no lo incluyas.',
    '',
    'Devuelve SOLO JSON: {"boxes":[{"k":"q1","x0":80,"y0":120,"x1":920,"y1":165}],"notas":""}',
  ].join('\n');
}

const PAD_X = 0.025;                 // 여백 — AI 좌표 오차를 덮는다
const PAD_Y = 0.012;
const MIN_H = 0.025;
const MAX_BOXES = 24;
const r4 = (v) => Math.round(v * 10000) / 10000;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** 사각형 하나를 0~1 비율로 정규화 + 여백. 잘못된 값이면 null */
export function normBox(b, keys) {
  if (!b || typeof b !== 'object') return null;
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : NaN; };
  let [x0, y0, x1, y1] = [n(b.x0), n(b.y0), n(b.x1), n(b.y1)];
  if ([x0, y0, x1, y1].some(Number.isNaN)) return null;
  const scale = Math.max(x0, y0, x1, y1) > 1.5 ? 1000 : 1;          // 천분율 또는 이미 비율
  [x0, y0, x1, y1] = [x0, y0, x1, y1].map((v) => v / scale);
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  if (x1 - x0 < 0.005 || y1 - y0 < 0.003) return null;
  if (x1 - x0 > 0.98 && y1 - y0 > 0.9) return null;                // 「장 전체」는 무시(쓸모없는 답)
  x0 = clamp01(x0 - PAD_X); x1 = clamp01(x1 + PAD_X);
  y0 = clamp01(y0 - PAD_Y); y1 = clamp01(y1 + PAD_Y);
  if (y1 - y0 < MIN_H) { const c = (y0 + y1) / 2; y0 = clamp01(c - MIN_H / 2); y1 = clamp01(c + MIN_H / 2); }
  const k = keys && keys.has(String(b.k)) ? String(b.k) : 'otro';
  return { k, x0: r4(x0), y0: r4(y0), x1: r4(x1), y1: r4(y1) };
}

/** AI 응답 → {boxes:[...]} | null(해석 불가) */
export function parseRedactJson(text, questions) {
  const j = extractJson(text);
  if (!j || !Array.isArray(j.boxes)) return null;
  const keys = new Set((Array.isArray(questions) ? questions : []).filter((q) => q && q.type === 'info').map((q) => String(q.k)));
  const boxes = j.boxes.map((b) => normBox(b, keys)).filter(Boolean).slice(0, MAX_BOXES);
  return { boxes };
}

const median = (a) => { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** 칸(k)별 위치 중앙값 — AI 가 그 칸을 찾은 장들에서 */
export function medianBoxes(pages) {
  const byK = new Map();
  for (const p of pages || []) {
    const seen = new Set();
    for (const b of (Array.isArray(p && p.redact_boxes) ? p.redact_boxes : [])) {
      if (!b || b.k === 'otro' || seen.has(b.k)) continue;
      seen.add(b.k);
      if (!byK.has(b.k)) byK.set(b.k, []);
      byK.get(b.k).push(b);
    }
  }
  const out = {};
  for (const [k, list] of byK) {
    if (list.length < 3) continue;                                    // 근거가 적으면 쓰지 않는다
    out[k] = { k, x0: r4(median(list.map((b) => b.x0))), y0: r4(median(list.map((b) => b.y0))),
      x1: r4(median(list.map((b) => b.x1))), y1: r4(median(list.map((b) => b.y1))) };
  }
  return out;
}

/**
 * 한 장에 실제로 칠할 사각형 — AI 가 찾은 것 + (답이 적혀 있는데 AI 가 놓친 칸은) 중앙값 위치.
 * @returns {{boxes:Array, filled:string[], missing:string[]}}  missing = 답은 있는데 위치를 모르는 칸(사람 확인 필요)
 */
export function boxesForPage(page, questions, medians) {
  const own = Array.isArray(page && page.redact_boxes) ? page.redact_boxes.slice() : [];
  const have = new Set(own.map((b) => b.k));
  const filled = []; const missing = [];
  const A = (page && page.answers) || {};
  for (const q of (Array.isArray(questions) ? questions : []).filter((x) => x && x.type === 'info')) {
    const v = A[q.k];
    if (v == null || !String(v).trim() || have.has(q.k)) continue;
    if (medians && medians[q.k]) { own.push({ ...medians[q.k] }); filled.push(q.k); } else missing.push(q.k);
  }
  return { boxes: own, filled, missing };
}

// ── 책임 확인 문구 (플랫폼 화면에 그대로 보이고, 이 문구 전체가 기록된다) ──────────────
//   플랫폼(한국어 화면) — 한국어 본문 + 스페인어 병기. 기록되는 문구 = 두 언어 전문.
export const ACK_VERSION = '2026-09-30';
export const ACK_LINES_KO = [
  '개인정보 책임 확인 — REFATRIX 고객 설문지 일괄 다운로드',
  '확인을 누르면 저는 CTR(소속 회사)을 대표하여 다음을 확인합니다.',
  '1. 내려받는 이미지는 REFATRIX 의 멕시코 고객이 작성한 설문지입니다. 개인정보(이름·회사명·전화·이메일·주소·RFC·서명)는 자동으로 가려지지만, 자동 가림이 완벽하지 않을 수 있습니다.',
  '2. 파일은 CTR 제품 개발 목적으로만 사용하며, 제3자에게 공유하거나 공개하지 않습니다.',
  '3. 가려지지 않은 개인정보를 발견하면 사용하지 않고 해당 이미지를 삭제한 뒤 REFATRIX 에 알립니다.',
  '4. 이 다운로드 이후 REFATRIX 시스템 밖에서 발생하는 개인정보의 유출·이전·부정 사용에 대한 책임은 CTR 이 집니다.',
  '5. 이 확인은 제 이름, 일시, IP 주소, 파일 수와 함께 기록됩니다.',
];
export const ACK_LINES = [
  'Declaración de responsabilidad — descarga de encuestas de clientes de REFATRIX',
  'Al confirmar, declaro en nombre de CTR (mi empresa) que:',
  '1. Las imágenes son encuestas contestadas por clientes de REFATRIX en México. Los datos personales (nombre, empresa, teléfono, correo, dirección, RFC y firma) se ocultan automáticamente; el ocultamiento automático puede no ser perfecto.',
  '2. Usaré los archivos únicamente para el desarrollo de productos de CTR. No los compartiré con terceros ni los publicaré.',
  '3. Si encuentro algún dato personal visible, no lo usaré, borraré esa imagen y avisaré a REFATRIX.',
  '4. CTR asume la responsabilidad por cualquier filtración, transferencia o uso indebido de datos personales que ocurra a partir de esta descarga, fuera de los sistemas de REFATRIX.',
  '5. Esta confirmación queda registrada con mi nombre, fecha y hora, dirección IP y número de archivos.',
];
export const ACK_TEXT = ACK_LINES_KO.join('\n') + '\n\n— Versión en español —\n' + ACK_LINES.join('\n');
export const ACK_SHA = crypto.createHash('sha256').update(ACK_TEXT, 'utf8').digest('hex');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

// ── 데이터 CSV — 개인정보(기재정보)·서술형은 넣지 않는다 ─────────────────
const CSV_TYPES = ['single', 'multi', 'scale', 'number', 'geo'];
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export function buildCsv(questions, pages, includedIds) {
  const qs = (Array.isArray(questions) ? questions : []).filter((q) => q && CSV_TYPES.includes(q.type));
  const head = ['Folio', 'Archivo', 'Imagen incluida'];
  qs.forEach((q) => { const t = 'P' + q.no + ' ' + clip(q.text, 80); if (q.type === 'geo') head.push(t + ' — Estado', t + ' — Ciudad'); else head.push(t); });
  const lines = [head.map(csvCell).join(',')];
  for (const p of pages || []) {
    if (!p || p.status !== 'done') continue;
    const A = p.answers || {};
    const row = [p.red_number || '', p.file_name || '', includedIds && includedIds.has(Number(p.id)) ? 'Sí' : 'No'];
    qs.forEach((q) => {
      const v = A[q.k];
      if (q.type === 'geo') { const g = (p.geo || {})[q.k] || {}; row.push(v || '', g.ciudad || ''); return; }
      if (q.type === 'multi') { row.push(Array.isArray(v) ? v.join(' | ') : ''); return; }
      row.push(v == null ? '' : v);
    });
    lines.push(row.map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function readmeText({ survey, ack, included, omitted, generatedAt }) {
  return [
    'REFATRIX — Encuesta de clientes: ' + (survey.title || ''),
    'Generado: ' + generatedAt,
    '',
    'Contenido',
    '- ' + included + ' imágenes de encuestas con los datos personales ocultos (cuadros negros).',
    '- datos.csv: respuestas por encuesta, sin datos personales ni comentarios abiertos.',
    omitted ? '- ' + omitted + ' encuestas leídas no se incluyen porque su ocultamiento todavía no estaba listo o fue excluido.' : '',
    '',
    'Confirmación registrada',
    '- N.º de confirmación: ' + ack.id,
    '- Nombre: ' + (ack.viewer_name || ''),
    '- Fecha y hora (UTC): ' + ack.created_at,
    '- Versión del texto: ' + ack.ack_version,
    '',
    ack.ack_text,
    '',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\r\n');
}
