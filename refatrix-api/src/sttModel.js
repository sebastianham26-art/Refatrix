// =====================================================================
// Refatrix ERP · sttModel.js — 전사(Whisper) 모델명 방어 + 오류문 키 가리기 (2026-11-02)
//
//   사고: API 키 화면의 「전사 모델」(VISIT_STT_MODEL, 평문 필드) 칸에 OpenAI 키가
//   들어가, 모델명으로 키가 전송됐다 → OpenAI 가 "The model `sk-proj-…` does not exist"
//   로 거절하고, 그 오류문(키 포함)이 녹음 카드에 그대로 찍혔다.
//
//   · sttModelName(): 키처럼 생긴 값·모델명이 아닌 값은 버리고 whisper-1 로 간다
//   · redactSecrets(): 외부 오류문에 sk-… 가 섞여 있으면 가려서 저장·표시한다
//   네트워크·DB 접근 없음 — consultRoutes / visitRecRoutes / secrets 가 함께 쓴다.
// =====================================================================

export const STT_DEFAULT_MODEL = 'whisper-1';

const KEY_LIKE = /^sk-/i;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function looksLikeApiKey(v) {
  const s = String(v == null ? '' : v).trim();
  return KEY_LIKE.test(s) && s.length >= 12;
}

export function sttModelName(v) {
  const m = String(v == null ? '' : v).trim();
  if (!m) return STT_DEFAULT_MODEL;
  if (KEY_LIKE.test(m)) return STT_DEFAULT_MODEL;          // 키가 잘못 들어간 경우
  if (!MODEL_RE.test(m)) return STT_DEFAULT_MODEL;         // 공백·특수문자 등 모델명이 아닌 값
  return m;
}

// sk-… / sk-proj-… 를 앞 4글자만 남기고 가린다(중간에 , 같은 문자가 끼어 있어도)
export function redactSecrets(s) {
  return String(s == null ? '' : s).replace(/sk-[A-Za-z0-9_,.*-]{6,}/g, 'sk-***');
}
