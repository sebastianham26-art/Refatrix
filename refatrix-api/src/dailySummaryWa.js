// =====================================================================
// Refatrix ERP · dailySummaryWa.js — 「오늘 요약」 WhatsApp 요약본 템플릿 (1014)
//   디렉터 지시(2026-10-14): 일정 › 오늘 요약의 WhatsApp 발송이 템플릿이 없어
//   24시간 창 안일 때만 도착한다 → 승인 템플릿으로 보내되, 내용은 그날의
//   ① 팀 업무(직원 업무일지) ② 나의 기록(디렉터 일지) ③ ERP 당일 기록을 스캔해 작성.
//
//   흐름
//   · 창이 열려 있으면(최근 24시간 안에 디렉터가 회사 번호로 보낸 적 있음) → 예전처럼 전체 텍스트.
//   · 창 밖·모름 → 요약본 템플릿(DAILY_SUMMARY_WA_TEMPLATE, 기본 daily_summary_ko · 한국어):
//       {{1}} 날짜 {{2}} 팀 업무 {{3}} 나의 기록 {{4}} ERP 기록 {{5}} 챙길 일 + 버튼 「전체 보기」
//     섹션 글은 AI(Anthropic) 가 원본 기록 + 전체 요약을 읽고 쓴다. AI 를 못 쓰면 원본에서 바로 만든다.
//   · 「전체 보기」를 누르면(웹훅 · payload DSUM:날짜) 그날 전체 요약을 텍스트로 이어서 보낸다
//     — 버튼을 누른 순간 24시간 창이 열리므로 자유 텍스트가 도착한다.
//
//   환경변수(관리 › 외부 서비스 키 › WhatsApp 에서도 설정)
//   · DAILY_SUMMARY_WA_TEMPLATE       요약본 템플릿 이름. 비우면 daily_summary_ko · 「-」 = 안 씀(예전 동작)
//   · DAILY_SUMMARY_WA_TEMPLATE_LANG  템플릿 언어 코드. 비우면 ko (Meta 의 Korean)
// =====================================================================
import { query } from './db.js';
import { normalizeWaNumber, mdToWaText, sendWaText } from './waSend.js';
import { buildWaSectionsPrompt, parseWaSections, fallbackWaSections, fitWaSections, waSectionParams,
  splitWaText, krDate, extractText, DAILY_WA_BUTTON_PREFIX } from './dayDigest.js';
import { logEvent } from './audit.js';

export const DEFAULT_DAILY_WA_TEMPLATE = 'daily_summary_ko';
export const dailyWaTemplate = () => {
  const v = String(process.env.DAILY_SUMMARY_WA_TEMPLATE || '').trim();
  return v === '-' ? '' : (v || DEFAULT_DAILY_WA_TEMPLATE);
};
export const dailyWaTemplateLang = () => String(process.env.DAILY_SUMMARY_WA_TEMPLATE_LANG || '').trim() || 'ko';

const SECTION_MODEL = () => process.env.DAILY_SUMMARY_WA_MODEL || process.env.DAILY_SUMMARY_MODEL || 'claude-sonnet-4-5-20250929';
const AI_TIMEOUT_MS = 60000;

async function callAi(prompt) {
  if (!process.env.ANTHROPIC_API_KEY || process.env.DAILY_SUMMARY_ENABLED === '0') return { ok: false, error: 'no_api_key' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: SECTION_MODEL(), max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: (data && data.error && data.error.message) || ('http_' + resp.status) };
    return { ok: true, text: extractText(data) };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally { clearTimeout(timer); }
}

// 요약본 변수 5개 만들기 → { params, fitted, source:'ai'|'fallback', ai_error? }
export async function buildDailyWaSections(dateStr, digest, contentMd) {
  let sec = null;
  let aiError = null;
  const ai = await callAi(buildWaSectionsPrompt(dateStr, digest || {}, contentMd));
  if (ai.ok) {
    sec = parseWaSections(ai.text);
    if (!sec) aiError = 'unparsable';
  } else aiError = ai.error;
  const source = sec ? 'ai' : 'fallback';
  if (!sec) sec = fallbackWaSections(digest || {});
  const fitted = fitWaSections(sec, krDate(dateStr));
  return { params: waSectionParams(fitted), fitted, source, ai_error: aiError };
}

// 그날 전체 요약을 텍스트로(길면 나눠서) 보낸다 — 「전체 보기」 버튼 응답
export async function sendFullDailySummary(dateStr, to, q = query) {
  const row = (await q(`SELECT content_md FROM daily_summaries WHERE summary_date=$1`, [dateStr])).rows[0];
  const parts = row && row.content_md
    ? splitWaText(mdToWaText(`📋 Refatrix 오늘 요약 · ${krDate(dateStr)}`, row.content_md, 20000))
    : [`📋 ${krDate(dateStr)} 요약이 아직 없습니다. ERP 일정 › 오늘 요약에서 만들어 주세요.`];
  const results = [];
  for (let i = 0; i < parts.length; i++) {
    const body = parts.length > 1 ? `${parts[i]}\n\n(${i + 1}/${parts.length})` : parts[i];
    const r = await sendWaText(body, to);
    results.push(r);
    if (!r.ok) break;
  }
  return { ok: results.length > 0 && results.every((r) => r.ok), parts: parts.length, results };
}

// 웹훅 수신 메시지 1건 → 「전체 보기」 버튼이면 처리. 반환: 처리했으면 결과, 아니면 null
//   · 디렉터 수신 번호(DAILY_SUMMARY_WA_TO)에서 온 것만(다른 번호가 payload 를 흉내 내도 무시)
export async function handleDailySummaryButton(m, q = query) {
  if (!m || m.type !== 'button' || !m.button) return null;
  const payload = String(m.button.payload || '');
  if (!payload.startsWith(DAILY_WA_BUTTON_PREFIX)) return null;
  const date = payload.slice(DAILY_WA_BUTTON_PREFIX.length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const from = normalizeWaNumber(m.from);
  const director = normalizeWaNumber(process.env.DAILY_SUMMARY_WA_TO);
  if (!from || !director || from !== director) return { handled: false, reason: 'not_director' };
  const out = await sendFullDailySummary(date, from, q);
  logEvent({ userId: null, action: 'export', target: `daily_summary_wa_full:${date}`, detail: { parts: out.parts, ok: out.ok } });
  return { handled: true, date, ...out };
}
