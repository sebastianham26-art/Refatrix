// =====================================================================
// 고객 상세 「상담·방문 이력」 로직 테스트 (2026-08-19)
//   · visitTags   : 스페인어/한국어 텍스트 → 카테고리 단어 자동 추출
//   · customerVisits : 방문 + 수기미팅 → 날짜 최신순 통합 이력
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagsFromText, visitTags, tagChips, hasWord, TAG_DEFS, TAG_MAX, normText } from '../src/visitTags.js';
import { assembleVisitHistory, splitPlanAi, fupOf, clip } from '../src/customerVisits.js';

// ── 1. 카테고리 태깅 ────────────────────────────────────────────────
test('태깅: 스페인어 견적/가격 키워드(발음기호 무시)', () => {
  assert.deepEqual(tagsFromText('Pidió una cotización con descuento del 12%'), ['quote']);
  assert.deepEqual(tagsFromText('COTIZACION urgente'), ['quote']);
});

test('태깅: 한국어 키워드도 인식', () => {
  assert.deepEqual(tagsFromText('견적 보내달라고 함'), ['quote']);
  assert.deepEqual(tagsFromText('브레이크 패드 불량 클레임 접수'), ['claim']);
});

test('태깅: 여러 카테고리는 정의 순서대로 — 추출 단계에서는 자르지 않는다', () => {
  // 잘라내면 고객 카테고리 통계가 앞쪽 정의로 편향되므로 tagsFromText 는 전부 돌려준다.
  const t = tagsFromText('cotizacion y pedido, hay una queja por la entrega, no hay existencia, falta el pago');
  assert.deepEqual(t, ['quote', 'order', 'claim', 'delivery', 'stock', 'payment']);
});

test('태깅: 스페인어 복수형/굴절도 인식(-s/-es)', () => {
  assert.deepEqual(tagsFromText('Pidió cotizaciones de balatas'), ['quote']);
  assert.deepEqual(tagsFromText('Revisamos los costos de importación'), ['quote']);
  assert.deepEqual(tagsFromText('El cliente quiere descuentos adicionales'), ['quote']);
  assert.ok(tagsFromText('hubo reclamaciones por las devoluciones').includes('claim'));
});

test('태깅: 짧은 약어는 복수형 확장을 하지 않는다(오탐 방지)', () => {
  // 'oc'+s = 'ocs' / 'po'+s = 'pos'(=pues 구어) 로 번지지 않아야 한다.
  assert.deepEqual(tagsFromText('pos no se pudo, estaba ocupado'), []);
  assert.ok(tagsFromText('levantamos la OC hoy').includes('order'));
});

test('hasWord: 낱말 경계 + 복수형 규칙 단건 검증', () => {
  assert.equal(hasWord('pidio cotizaciones', 'cotizacion'), true);
  assert.equal(hasWord('el precio', 'precio'), true);
  assert.equal(hasWord('preciosidad', 'precio'), false);
  assert.equal(hasWord('견적 요청', '견적'), true);
});

test('태깅: 낱말 경계 — 부분 문자열은 매칭하지 않음', () => {
  // 'oc' 는 낱말일 때만(orden de compra 약어). 'ocupado' 안의 oc 는 무시.
  assert.ok(!tagsFromText('el cliente estaba ocupado').includes('order'));
  assert.ok(tagsFromText('levantamos la OC hoy').includes('order'));
  // 'pago' 는 낱말, 'pagoda' 는 아님
  assert.ok(!tagsFromText('visitamos la pagoda').includes('payment'));
});

test('태깅: 빈 텍스트 → 빈 배열 / 매칭 없으면 빈 배열', () => {
  assert.deepEqual(tagsFromText(''), []);
  assert.deepEqual(tagsFromText('   '), []);
  assert.deepEqual(tagsFromText('zzz qqq'), []);
});

test('태깅: 방문 1건 — 노트 + AI요약 + 펜딩 텍스트를 모두 훑음', () => {
  const tags = visitTags(
    { talk_note: 'saludo general', insight_note: '' },
    { resumen: 'Hablamos del inventario', insights: '', next_step: 'Enviar catalogo', action_items: [{ content: 'Revisar la factura vencida', due_date: null }], products: ['CL0001'] },
    [{ content: 'mandar muestras' }],
  );
  assert.ok(tags.includes('stock'), '요약에서 inventario');
  assert.ok(tags.includes('payment'), 'action_items 에서 factura');
  assert.ok(tags.includes('promo'), '펜딩/next_step 에서 catalogo·muestras');
});

test('tagChips: key → {key,label,color}, 순서 유지, 미지의 key 는 제거', () => {
  const chips = tagChips(['claim', 'nope', 'quote']);
  assert.deepEqual(chips.map((c) => c.key), ['claim', 'quote']);
  assert.equal(chips[0].label, TAG_DEFS.find((t) => t.key === 'claim').label);
  assert.ok(/^#[0-9a-f]{6}$/i.test(chips[0].color));
});

test('normText: 발음기호 제거 + 소문자 + 공백 정규화', () => {
  assert.equal(normText('  Cotización   URGENTE '), ' cotizacion urgente ');
});

// ── 2. 보조 함수 ────────────────────────────────────────────────────
test('splitPlanAi: [AI요약] 앞은 사전계획, 뒤는 AI 블록', () => {
  assert.deepEqual(splitPlanAi('precio nuevo 설명 예정\n[AI요약]\nResumen del cliente'),
    { plan: 'precio nuevo 설명 예정', ai: 'Resumen del cliente' });
  assert.deepEqual(splitPlanAi('그냥 메모'), { plan: '그냥 메모', ai: null });
  assert.deepEqual(splitPlanAi(''), { plan: null, ai: null });
});

test('fupOf: 펜딩 상태 → 한 단어', () => {
  assert.equal(fupOf([], '2026-08-19').fup, 'none');
  assert.equal(fupOf([{ done: true }, { done: true }], '2026-08-19').fup, 'done');
  assert.equal(fupOf([{ done: false, due_date: '2026-08-10' }], '2026-08-19').fup, 'overdue');
  assert.equal(fupOf([{ done: false, due_date: '2026-08-25' }], '2026-08-19').fup, 'open');
  assert.equal(fupOf([{ done: false, due_date: null }], '2026-08-19').fup, 'open');
  const f = fupOf([{ done: true }, { done: false, due_date: '2026-08-01' }], '2026-08-19');
  assert.deepEqual([f.total, f.done, f.overdue, f.fup], [2, 1, 1, 'overdue']);
});

test('clip: 길이 초과 시 말줄임', () => {
  assert.equal(clip('abcdefg', 5), 'abcd…');
  assert.equal(clip('  hi  ', 10), 'hi');
  assert.equal(clip(null, 10), '');
});

// ── 3. 이력 조립 ────────────────────────────────────────────────────
const BASE = {
  visits: [
    { id: 10, visit_date: '2026-08-18', visit_time: '11:20', met_person: 'Luis', by_name: 'Oscar',
      talk_note: 'plan: hablar de precios\n[AI요약]\nResumen ES', insight_note: 'Maneja SYD' },
    { id: 11, visit_date: '2026-08-12', visit_time: '09:05', met_person: null, by_name: 'Oscar',
      talk_note: 'primera visita, nos presentamos', insight_note: '' },
  ],
  meetings: [
    { id: 5, meeting_date: '2026-08-15', note: 'Llamada: pago pendiente de la factura 992',
      by_name: 'Ana', stage_before_name: '3_견적', stage_after_name: '4_협상' },
  ],
  pendings: [
    { id: 1, visit_id: 10, content: 'Enviar cotizacion', due_date: '2026-08-10', done: false },
    { id: 2, visit_id: 10, content: 'Llamar', due_date: null, done: true },
  ],
  recordings: [
    { id: 77, visit_id: 10, status: 'done', summary_json: JSON.stringify({
      resumen: 'Resumen ES', insights: 'Compra a la competencia', next_step: 'Visitar en 2 semanas',
      action_items: [{ content: 'Enviar cotizacion', due_date: '2026-08-10' }], products: ['CL0001'] }) },
  ],
  mxToday: '2026-08-19',
};

test('조립: 방문+미팅 통합, 날짜 최신순', () => {
  const r = assembleVisitHistory(BASE);
  assert.deepEqual(r.items.map((i) => i.key), ['v10', 'm5', 'v11']);
  assert.deepEqual(r.items.map((i) => i.date), ['2026-08-18', '2026-08-15', '2026-08-12']);
  assert.equal(r.total, 3); assert.equal(r.visit_cnt, 2); assert.equal(r.meeting_cnt, 1);
  assert.equal(r.first_date, '2026-08-12'); assert.equal(r.last_date, '2026-08-18');
});

test('조립: 방문 줄 — AI 요약·펜딩·F/UP·rec_id·카테고리', () => {
  const v = assembleVisitHistory(BASE).items.find((i) => i.key === 'v10');
  assert.equal(v.source, 'visit');
  assert.equal(v.time, '11:20');
  assert.equal(v.plan, 'plan: hablar de precios');       // [AI요약] 앞부분만
  assert.equal(v.headline, 'Resumen ES');
  assert.equal(v.has_ai, true);
  assert.equal(v.rec_id, 77);
  assert.equal(v.rec_status, 'done');
  assert.equal(v.insight, 'Compra a la competencia');    // AI insights 우선
  assert.deepEqual([v.pend_total, v.pend_done, v.pend_overdue, v.fup], [2, 1, 1, 'overdue']);
  assert.equal(v.pendings[0].overdue, true);
  assert.ok(v.tags.includes('quote'));                    // precios / cotizacion
  assert.ok(v.tags.includes('competitor'));               // SYD / competencia
  assert.ok(v.tag_chips.every((c) => c.label && c.color));
});

test('조립: 미팅 줄 — 단계 이동 표기, AI 없음, 카테고리는 노트에서', () => {
  const m = assembleVisitHistory(BASE).items.find((i) => i.key === 'm5');
  assert.equal(m.source, 'meeting');
  assert.equal(m.stage_move, '3_견적 → 4_협상');
  assert.equal(m.has_ai, false);
  assert.equal(m.rec_id, null);
  assert.equal(m.fup, 'none');
  assert.ok(m.tags.includes('payment'));
  assert.ok(m.headline.startsWith('Llamada'));
});

test('조립: AI 요약 없는 방문 — headline 은 수기 노트, has_ai=false', () => {
  const v = assembleVisitHistory(BASE).items.find((i) => i.key === 'v11');
  assert.equal(v.has_ai, false);
  assert.equal(v.headline, 'primera visita, nos presentamos');
  assert.ok(v.tags.includes('newcust'));
});

test('조립: summary_json 이 객체(JSONB)로 와도 동일 동작', () => {
  const r = assembleVisitHistory({ ...BASE, recordings: [{ id: 77, visit_id: 10, status: 'done',
    summary_json: { resumen: 'Objeto', insights: '', action_items: [], products: [] } }] });
  assert.equal(r.items.find((i) => i.key === 'v10').headline, 'Objeto');
});

test('조립: 깨진 summary_json 은 무시(요약 없음으로 강등)', () => {
  const r = assembleVisitHistory({ ...BASE, recordings: [{ id: 77, visit_id: 10, status: 'failed', summary_json: '{oops' }] });
  const v = r.items.find((i) => i.key === 'v10');
  assert.equal(v.has_ai, false);
  assert.equal(v.rec_status, 'failed');
  assert.equal(v.headline, 'Resumen ES');   // talk_note 의 [AI요약] 블록으로 폴백
});

test('조립: 요약 있는 녹음이 여러 건이면 요약 보유 건을 채택', () => {
  const r = assembleVisitHistory({ ...BASE, recordings: [
    { id: 70, visit_id: 10, status: 'failed', summary_json: null },
    { id: 77, visit_id: 10, status: 'done', summary_json: { resumen: 'Bueno', action_items: [], products: [] } },
  ] });
  assert.equal(r.items.find((i) => i.key === 'v10').rec_id, 77);
});

test('조립: 빈 입력 → 빈 결과(화면 「기록 없음」)', () => {
  const r = assembleVisitHistory({ visits: [], meetings: [], pendings: [], recordings: [], mxToday: '2026-08-19' });
  assert.deepEqual(r.items, []);
  assert.equal(r.total, 0); assert.equal(r.last_date, null); assert.equal(r.open_pendings, 0);
  assert.deepEqual(r.tag_summary, []);
});

test('조립: 요약 통계 — 미완 후속 건수 + 카테고리 빈도(내림차순)', () => {
  const r = assembleVisitHistory(BASE);
  assert.equal(r.open_pendings, 1);
  assert.ok(r.tag_summary.length > 0);
  for (let i = 1; i < r.tag_summary.length; i += 1) {
    assert.ok(r.tag_summary[i - 1].cnt >= r.tag_summary[i].cnt, '빈도 내림차순');
  }
});


test('조립: 표시용 tag_chips 는 TAG_MAX 개로 자르고 나머지는 tag_more 로', () => {
  const many = 'cotizacion pedido queja entrega existencia pago';
  const r = assembleVisitHistory({ ...BASE,
    visits: [{ id: 20, visit_date: '2026-08-18', visit_time: '10:00', talk_note: many, insight_note: '', by_name: 'O' }],
    meetings: [], pendings: [], recordings: [] });
  const v = r.items[0];
  assert.equal(v.tags.length, 6, '통계용 tags 는 전부');
  assert.equal(v.tag_chips.length, TAG_MAX);
  assert.equal(v.tag_more, 2);
  // 통계도 잘린 태그를 포함해야 한다(관계·인사처럼 뒤쪽 정의가 영원히 0이 되지 않도록)
  assert.ok(r.tag_summary.some((c) => c.key === 'payment'));
});

test('조립: rec_status 는 최신 녹음, rec_id/요약은 요약이 있는 최신 녹음', () => {
  const r = assembleVisitHistory({ ...BASE, recordings: [
    { id: 5, visit_id: 10, status: 'done', summary_json: { resumen: 'Viejo', action_items: [], products: [] } },
    { id: 6, visit_id: 10, status: 'transcribing', summary_json: null },
  ] });
  const v = r.items.find((i) => i.key === 'v10');
  assert.equal(v.rec_status, 'transcribing', '재녹음이 처리 중임을 그대로 보여준다');
  assert.equal(v.rec_id, 5, '번역 토글은 남아 있는 최신 요약을 가리킨다');
  assert.equal(v.summary.resumen, 'Viejo');
});

test('조립: 같은 날·같은 시각이면 SQL 순서(최신 id 먼저)를 유지 — 문자열 tie-break 금지', () => {
  // SQL 은 id DESC 로 내려준다. m10 이 m9 보다 먼저 와야 한다('m10' < 'm9' 문자열 비교의 함정)
  const r = assembleVisitHistory({ visits: [], pendings: [], recordings: [], mxToday: '2026-08-19',
    meetings: [{ id: 10, meeting_date: '2026-08-10', note: 'nuevo', by_name: 'A' },
               { id: 9,  meeting_date: '2026-08-10', note: 'viejo', by_name: 'A' }] });
  assert.deepEqual(r.items.map((i) => i.key), ['m10', 'm9']);
});

test('조립: 같은 날이면 시각이 늦은 방문이 먼저, 시각 없는 미팅은 뒤로', () => {
  const r = assembleVisitHistory({ pendings: [], recordings: [], mxToday: '2026-08-19',
    visits: [{ id: 1, visit_date: '2026-08-18', visit_time: '09:00', talk_note: 'a', by_name: 'A' },
             { id: 2, visit_date: '2026-08-18', visit_time: '16:00', talk_note: 'b', by_name: 'A' }],
    meetings: [{ id: 3, meeting_date: '2026-08-18', note: 'c', by_name: 'A' }] });
  assert.deepEqual(r.items.map((i) => i.key), ['v2', 'v1', 'm3']);
});

test('조립: truncated 플래그 전달', () => {
  assert.equal(assembleVisitHistory({ ...BASE, truncated: true }).truncated, true);
  assert.equal(assembleVisitHistory(BASE).truncated, false);
});
