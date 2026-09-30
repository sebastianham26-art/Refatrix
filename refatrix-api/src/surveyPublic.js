// =====================================================================
// Refatrix ERP · surveyPublic.js — 설문 결과의 **익명 공개용** 데이터 (2026-09-30)
//
//   외부 열람 페이지(mx_survey_analysis.html, 스페인어)가 받는 모양으로 만든다.
//   ★ 넣지 않는 것: 기재정보(이름·상호·전화)·서술형 원문·붉은 번호·손글씨 원문·페이지 id.
//     행 순서도 섞는다(번호 순서로 되짚지 못하게). 서술형은 AI 주제 이름과 건수만.
//   네트워크·DB 호출 없음 — surveyViewer.js 가 사용.
// =====================================================================
const PUB_TYPES = ['single', 'multi', 'scale', 'number', 'geo'];

function shuffle(a, rnd = Math.random) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * @param {{title,survey_date,questions,ai_cache}} survey
 * @param {Array<{status,answers,geo}>} pages   — 해당 설문의 페이지(판독 끝난 것만 쓴다)
 * @param {{uploaded?:number, today?:string, rnd?:Function}} opt
 */
export function buildPublicSurveyData(survey, pages, opt = {}) {
  const allQs = Array.isArray(survey && survey.questions) ? survey.questions : [];
  const qs = allQs.filter((q) => q && PUB_TYPES.includes(q.type));
  const done = (pages || []).filter((p) => p && p.status === 'done');
  const rows = done.map((p) => qs.map((q) => {
    const A = p.answers || {};
    const v = A[q.k];
    if (q.type === 'single') { const i = v == null ? -1 : (q.options || []).indexOf(v); return i >= 0 ? i : null; }
    if (q.type === 'multi') return (Array.isArray(v) ? v : []).map((x) => (q.options || []).indexOf(x)).filter((i) => i >= 0);
    if (q.type === 'geo') {
      const g = (p.geo || {})[q.k] || {};
      if (v) return [String(v), g.ciudad ? String(g.ciudad) : null, 0];
      return g.raw ? [null, null, 1] : null;                     // 적혔지만 주 미확인 — 원문은 보내지 않는다
    }
    if (v == null || v === '') return null;
    const n = Number(v); return Number.isFinite(n) ? n : null;
  }));
  shuffle(rows, opt.rnd);
  const th = (survey && survey.ai_cache && survey.ai_cache.themes) || {};
  const themes = Object.keys(th).map((k) => {
    const q = allQs.find((x) => x && x.k === k);
    if (!q || !Array.isArray(th[k])) return null;
    const basis = done.filter((p) => String(((p.answers || {})[k]) || '').trim()).length;
    const items = th[k].map((t) => ({ name: String((t && t.name) || '').slice(0, 80), count: Array.isArray(t && t.ids) ? t.ids.length : 0 }))
      .filter((t) => t.name && t.count > 0);
    return items.length ? { title: String(q.text || ''), basis, items } : null;
  }).filter(Boolean);
  return {
    v: 1,
    title: String((survey && survey.title) || ''),
    date: (survey && survey.survey_date) || '',
    generated_at: opt.today || new Date().toISOString().slice(0, 10),
    uploaded: Number.isFinite(Number(opt.uploaded)) ? Number(opt.uploaded) : done.length,
    questions: qs.map((q) => {
      const o = { k: q.k, no: q.no, type: q.type, text: String(q.text || ''), seg: !!q.seg };
      if (q.free) o.free = true;
      if (q.type === 'single' || q.type === 'multi') o.options = (q.options || []).slice();
      if (q.type === 'scale') { o.min = q.min; o.max = q.max; o.min_label = q.min_label || ''; o.max_label = q.max_label || ''; }
      return o;
    }),
    rows,
    themes,
  };
}
