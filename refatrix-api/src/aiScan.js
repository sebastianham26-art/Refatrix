// =====================================================================
// Refatrix ERP · aiScan.js  (Layer 2 — AI 미결 스캐너 순수 로직)
//   자유 텍스트(일정·회의메모·지시)를 읽고 "미이행 약속/미결 액션"을 감지하도록
//   프롬프트를 조립하고, 모델 응답(JSON)을 안전 파싱한다.
//   ※ 여기엔 네트워크/DB 없음 — 순수 함수라 단독 테스트 가능.
//   ※ 원칙: AI는 "감지·제안"만. 자동 실행 없음. 최종 등록은 디렉터 확인 후 todo.
// =====================================================================

// items: [{ ref, kind, date, text }]  (최소화된 자유 텍스트 목록)
export function buildPrompt(items) {
  const lines = (items || []).map((it, i) => `${i + 1}. [${it.kind}${it.date ? ' ' + it.date : ''}] ${String(it.text || '').replace(/\s+/g, ' ').trim()}`).join('\n');
  return [
    '다음은 회사 시스템에 기록된 최근 일정/회의메모/지시 내용입니다.',
    '이 중 "아직 이행되지 않은 약속·해야 할 일(미결 액션 아이템)"으로 보이는 것만 골라내세요.',
    '',
    '판단 규칙:',
    '- 이미 완료된 것으로 보이면 제외.',
    '- 단순 정보·기록(약속/할 일이 아님)은 제외.',
    '- 애매하면 포함하되 reason에 근거를 짧게.',
    '- 각 항목마다 담당자가 바로 실행할 수 있는 짧은 "할 일 제목"으로 정리.',
    '',
    '출력은 오직 JSON 배열. 다른 설명·코드펜스 금지.',
    '각 원소: {"index": 원문번호(정수), "title": "할 일 제목(한국어, 40자 이내)", "reason": "미결로 본 근거(20자 이내)"}',
    '해당 없으면 빈 배열 [] 만 출력.',
    '',
    '[기록]',
    lines,
  ].join('\n');
}

// 모델 응답 텍스트 → 제안 배열(안전 파싱). items 로 원문 역참조.
export function parseSuggestions(apiText, items) {
  let t = String(apiText || '').trim();
  // 코드펜스 제거
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  let arr = null;
  try { arr = JSON.parse(t); } catch (_) {
    const m = t.match(/\[[\s\S]*\]/);       // 본문 중 첫 배열만 추출 재시도
    if (m) { try { arr = JSON.parse(m[0]); } catch (__) { arr = null; } }
  }
  if (!Array.isArray(arr)) return [];
  const list = Array.isArray(items) ? items : [];
  const out = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    const title = String(s.title || '').slice(0, 80).trim();
    if (!title) continue;
    const idx = Number(s.index);
    const it = (Number.isInteger(idx) && idx >= 1 && idx <= list.length) ? list[idx - 1] : null;
    out.push({
      title,
      reason: String(s.reason || '').slice(0, 60).trim(),
      source_kind: it ? it.kind : null,
      source_ref: it ? it.ref : null,
      source_text: it ? String(it.text || '').slice(0, 160) : null,
      source_date: it ? (it.date || null) : null,
    });
  }
  return out;
}
