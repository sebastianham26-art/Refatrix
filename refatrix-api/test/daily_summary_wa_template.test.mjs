// =====================================================================
// 1014 · 오늘 요약 WhatsApp 요약본 템플릿 + 팀 업무(업무일지) 반영 — 실제 PostgreSQL 통합 테스트
//   · 팀 업무(workplan_items / workplan_days)가 하루 digest·프롬프트에 들어간다
//   · 24시간 창 밖이면 요약본 템플릿(변수 5개 + 「전체 보기」 payload)으로 간다
//   · 변수는 줄바꿈·탭 없음, 본문 전체 1,024자 이하(Meta #132018 · #132005)
//   · 「전체 보기」 버튼(웹훅) → 디렉터 번호에서 온 것만 전체 요약을 텍스트로 보낸다
//   Anthropic · Graph API 는 fetch 스텁(과금·네트워크 없음).
//
// 실행: DATABASE_URL=postgres://… (마이그레이션 적용된 테스트 DB) node --test test/daily_summary_wa_template.test.mjs
// =====================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test';
process.env.WHATSAPP_TOKEN = 'tok';
process.env.WHATSAPP_PHONE_ID = '111';
process.env.DAILY_SUMMARY_WA_TO = '528126075311';
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify-token';
process.env.WHATSAPP_APP_SECRET = 'secret';
delete process.env.WHATSAPP_TEMPLATE;
delete process.env.DAILY_SUMMARY_WA_TEMPLATE;
delete process.env.DAILY_SUMMARY_WA_TEMPLATE_LANG;
globalThis.__refatrixDailyWaScheduler = true;

const { query, pool } = await import('../src/db.js');
const DS = await import('../src/routes/dailySummaryRoutes.js');
const DD = await import('../src/dayDigest.js');
const { applyWebhook } = await import('../src/waWebhook.js');
const { handleDailySummaryButton } = await import('../src/dailySummaryWa.js');

const DAY = '2026-10-13';   // 화요일(근무일)

// ── fetch 스텁 ──
let aiReply = null;         // 문자열 = AI 응답 텍스트 · null = AI 실패(500)
let graphRule = () => ({ ok: true });
const graph = [];
const ai = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('api.anthropic.com')) {
    const body = JSON.parse(opts.body);
    ai.push(body);
    const prompt = body.messages[0].content;
    if (prompt.includes('4개 칸을 JSON')) {
      if (aiReply == null) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: aiReply }] }) };
    }
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: '### 오늘 한눈에\n- 팀 업무 3건 완료\n### 일정·할일 활동\n- Karina: 견적 정리 완료' }] }) };
  }
  if (u.includes('graph.facebook.com')) {
    const body = JSON.parse(opts.body);
    graph.push(body);
    const r = graphRule(body);
    if (r.ok) return { ok: true, json: async () => ({ messages: [{ id: 'wamid.' + graph.length }] }) };
    return { ok: false, status: 400, json: async () => ({ error: { code: r.code, message: r.message || 'err' } }) };
  }
  return realFetch(url, opts);
};

async function seed() {
  await query(`DELETE FROM workplan_items`); await query(`DELETE FROM workplan_days`);
  await query(`DELETE FROM daily_summaries`); await query(`DELETE FROM wa_inbound`);
  await query(`DELETE FROM users WHERE id > 1`);
  await query(`INSERT INTO users (id, name, role, pin_hash, workplan_enabled) OVERRIDING SYSTEM VALUE VALUES
    (21,'Karina','sales','x',true),(22,'Luis','warehouse','x',true),(23,'Oscar','sales','x',true)`);
  await query(`INSERT INTO workplan_days (user_id, work_date, plan_saved_at, plan_late, done_saved_at, done_late, extra_done) VALUES
    (21,$1,'2026-10-13T15:05:00Z',false,'2026-10-14T00:10:00Z',false,'Tony 고객 긴급 견적 대응'),
    (22,$1,'2026-10-13T17:00:00Z',true,NULL,false,'')`, [DAY]);
  await query(`INSERT INTO workplan_items (user_id, work_date, title, sort, status, note, carry_count) VALUES
    (21,$1,'견적 정리',1,'done','5건 발송',0),
    (21,$1,'Monterrey 방문',2,'partial','2곳 중 1곳',1),
    (22,$1,'재고 실사 A존',1,'missed','',3)`, [DAY]);
  await query(`INSERT INTO calendar_journal (user_id, entry_date, content) VALUES (1,$1,'CIOSA 입점 서류 마감 확인. 금요일까지 가격표 확정.')
               ON CONFLICT DO NOTHING`, [DAY]).catch(() => {});
}

test.before(async () => { await seed(); });
test.after(async () => { globalThis.fetch = realFetch; await pool.end(); });

// ── 순수 함수 ──
test('fitWaSections: 줄바꿈·탭 제거, 빈 칸 대체, 본문 1,024자 이하', () => {
  const f = DD.fitWaSections({ team: '가\n나\t다  라'.repeat(80), journal: '', erp: '**견적** 3건\n- 매출 1건', followup: '' }, DD.krDate(DAY));
  const params = DD.waSectionParams(f);
  assert.equal(params.length, 5);
  for (const p of params) {
    assert.ok(!/[\n\t]/.test(p), '변수에 줄바꿈·탭 없음');
    assert.ok(!/ {4,}/.test(p), '연속 공백 4칸 이상 없음');
    assert.ok(p.trim().length > 0, '빈 변수 없음');
  }
  assert.equal(f.journal, '기록 없음');
  assert.equal(f.followup, '특이사항 없음');
  assert.ok(!f.erp.includes('**'), '마크다운 제거');
  assert.ok([...DD.renderDailyWaBody(params)].length <= 1024, '본문 전체 1,024자 이하');
});

test('fitWaSections: 모든 칸이 최대여도 1,024자 이하', () => {
  const big = '한'.repeat(2000);
  const f = DD.fitWaSections({ team: big, journal: big, erp: big, followup: big }, DD.krDate(DAY));
  assert.ok([...DD.renderDailyWaBody(DD.waSectionParams(f))].length <= 1024);
});

test('parseWaSections: 코드블록에 싸인 JSON 도 읽고, 쓰레기는 null', () => {
  const o = DD.parseWaSections('```json\n{"team":"Karina: 완료","journal":"j","erp":"e","followup":"f"}\n```');
  assert.equal(o.team, 'Karina: 완료');
  assert.equal(DD.parseWaSections('그냥 문장'), null);
  assert.equal(DD.parseWaSections('{"team":"","journal":"","erp":"","followup":""}'), null);
});

test('템플릿 본문: 변수 5개, 변수로 시작·끝나지 않음(Meta 승인 규칙)', () => {
  const vars = DD.DAILY_WA_TPL_BODY.match(/\{\{\d\}\}/g);
  assert.deepEqual(vars, ['{{1}}', '{{2}}', '{{3}}', '{{4}}', '{{5}}']);
  assert.ok(!/^\{\{/.test(DD.DAILY_WA_TPL_BODY.trim()) && !/\}\}$/.test(DD.DAILY_WA_TPL_BODY.trim()));
});

// ── 팀 업무 수집 ──
test('collectDayDigest: 팀 업무(직원별 항목·상태·계획 외·지연·미작성자)를 담는다', async () => {
  const dg = await DS.collectDayDigest(DAY);
  assert.ok(!dg.errors.includes('workplan'), '수집 오류 없음: ' + dg.errors.join(','));
  const names = dg.workplan.members.map((m) => m.name);
  assert.deepEqual(names, ['Karina', 'Luis']);
  const k = dg.workplan.members[0];
  assert.equal(k.items.length, 2);
  assert.equal(k.items[0].status, 'done');
  assert.equal(k.extra_done, 'Tony 고객 긴급 견적 대응');
  assert.equal(k.plan_hm, '09:05', '멕시코 시각');
  assert.equal(dg.workplan.members[1].plan_late, true);
  assert.deepEqual(dg.workplan.missing, ['Oscar'], '대상 직원 중 아무것도 안 쓴 사람');
  const text = DD.condenseDigest(DAY, dg);
  assert.ok(text.includes('[팀 업무] 작성 2명 · 항목 3 (완료 1 · 일부 1 · 못함 1 · 미체크 0) · 미작성 1명'));
  assert.ok(text.includes('[못함] 재고 실사 A존') && text.includes('이월 3회'));
  assert.ok(text.includes('계획 외 한 일: Tony 고객 긴급 견적 대응'));
  assert.ok(DD.buildDailyPrompt(DAY, dg).includes('「팀 업무」(직원 업무일지)를 먼저'));
  assert.equal(DD.digestStats(dg).workplan, 2);
});

// ── 발송 ──
test('창 밖(웹훅 설정 + 최근 수신 없음) → 요약본 템플릿 · 변수 5개 · 「전체 보기」 payload', async () => {
  graph.length = 0; ai.length = 0;
  aiReply = '{"team":"Karina: 견적 정리 완료, 방문 일부 | Luis: 재고 실사 못함(3회 이월) | 미작성: Oscar","journal":"CIOSA 서류 마감 확인, 금요일 가격표 확정","erp":"견적 0건","followup":"Luis 재고 실사 일정 재확인"}';
  const out = await DS.runDailyWaJob({ force: true, dateStr: DAY, userId: 1 });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.mode, 'template_summary');
  assert.equal(out.sections_source, 'ai');
  assert.equal(graph.length, 1, '한 통만');
  const t = graph[0].template;
  assert.equal(t.name, 'daily_summary_ko');
  assert.equal(t.language.code, 'ko');
  const body = t.components.find((c) => c.type === 'body');
  assert.equal(body.parameters.length, 5);
  assert.equal(body.parameters[0].text, DD.krDate(DAY));
  assert.ok(body.parameters[1].text.startsWith('Karina: 견적 정리 완료'));
  const btn = t.components.find((c) => c.type === 'button');
  assert.equal(btn.sub_type, 'quick_reply');
  assert.equal(btn.parameters[0].payload, 'DSUM:' + DAY);
  const row = (await query(`SELECT wa_status, wa_sent_at FROM daily_summaries WHERE summary_date=$1`, [DAY])).rows[0];
  assert.equal(row.wa_status, 'sent_template_summary');
  assert.ok(row.wa_sent_at);
  // 섹션 AI 에는 팀 업무 원본이 들어간다
  const secPrompt = ai.find((b) => b.messages[0].content.includes('4개 칸을 JSON')).messages[0].content;
  assert.ok(secPrompt.includes('[팀 업무]') && secPrompt.includes('나의 기록'));
});

test('AI 실패 → 원본 기록으로 섹션 작성(fallback)해서 그래도 보낸다', async () => {
  graph.length = 0; aiReply = null;
  const out = await DS.runDailyWaJob({ force: true, dateStr: DAY, userId: 1 });
  assert.equal(out.ok, true);
  assert.equal(out.sections_source, 'fallback');
  const p = graph[0].template.components.find((c) => c.type === 'body').parameters.map((x) => x.text);
  assert.ok(p[1].includes('Karina: 완료 1/2') && p[1].includes('미작성: Oscar'), p[1]);
});

test('버튼 없이 승인된 템플릿(#132000) → 버튼 빼고 다시 보내 성공', async () => {
  graph.length = 0; aiReply = '{"team":"t","journal":"j","erp":"e","followup":"f"}';
  graphRule = (b) => (b.template && b.template.components.some((c) => c.type === 'button') ? { ok: false, code: 132000, message: 'param mismatch' } : { ok: true });
  const out = await DS.runDailyWaJob({ force: true, dateStr: DAY, userId: 1 });
  graphRule = () => ({ ok: true });
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'template_summary');
  assert.equal(graph.length, 2);
  assert.ok(!graph[1].template.components.some((c) => c.type === 'button'));
});

test('요약본 템플릿 미승인(#132001) + 창 밖 → 한 줄 템플릿도 없으면 실패로 기록(자유 텍스트는 안 보냄)', async () => {
  graph.length = 0;
  graphRule = () => ({ ok: false, code: 132001, message: 'template does not exist' });
  const out = await DS.runDailyWaJob({ force: true, dateStr: DAY, userId: 1 });
  graphRule = () => ({ ok: true });
  assert.equal(out.ok, false);
  assert.ok(graph.every((b) => b.type === 'template'), '창 밖이면 텍스트를 보내지 않는다');
  const row = (await query(`SELECT wa_status, wa_error FROM daily_summaries WHERE summary_date=$1`, [DAY])).rows[0];
  assert.equal(row.wa_status, 'failed');
  assert.ok(row.wa_error.includes('daily_summary_ko') && row.wa_error.includes('132001'), row.wa_error);
});

test('창 열림(최근 24시간 안에 디렉터가 보냄) → 예전처럼 전체 텍스트, 섹션 AI 호출 없음', async () => {
  graph.length = 0; ai.length = 0;
  await query(`INSERT INTO wa_inbound (wa_from, last_at, last_type, msg_count) VALUES ('528126075311', now(), 'text', 1)`);
  const out = await DS.runDailyWaJob({ force: true, dateStr: DAY, userId: 1 });
  await query(`DELETE FROM wa_inbound`);
  assert.equal(out.mode, 'text');
  assert.equal(graph[0].type, 'text');
  assert.ok(!ai.some((b) => b.messages[0].content.includes('4개 칸을 JSON')));
});

test('DAILY_SUMMARY_WA_TEMPLATE="-" → 요약본 템플릿을 쓰지 않는다(예전 동작)', async () => {
  graph.length = 0;
  process.env.DAILY_SUMMARY_WA_TEMPLATE = '-';
  process.env.WHATSAPP_TEMPLATE = 'refatrix_aviso';
  const out = await DS.runDailyWaJob({ force: true, dateStr: DAY, userId: 1 });
  delete process.env.DAILY_SUMMARY_WA_TEMPLATE; delete process.env.WHATSAPP_TEMPLATE;
  assert.equal(out.mode, 'template');
  assert.equal(graph[0].template.name, 'refatrix_aviso');
});

// ── 「전체 보기」 버튼 ──
const btnMsg = (from, id, payload = 'DSUM:' + DAY) => ({ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'button', button: { payload, text: '전체 보기' } });

test('전체 보기: 디렉터 번호면 전체 요약을 텍스트로 보낸다 · 다른 번호는 무시', async () => {
  graph.length = 0;
  const r = await handleDailySummaryButton(btnMsg('528126075311', 'w1'));
  assert.equal(r.handled, true);
  assert.equal(graph[0].type, 'text');
  assert.ok(graph[0].text.body.includes('Refatrix 오늘 요약') && graph[0].text.body.includes('Karina'));
  graph.length = 0;
  const r2 = await handleDailySummaryButton(btnMsg('5215555555555', 'w2'));
  assert.equal(r2.handled, false);
  assert.equal(graph.length, 0);
  assert.equal(await handleDailySummaryButton(btnMsg('528126075311', 'w3', 'DSUM:bad')), null);
});

test('전체 보기: 긴 요약은 4,096자 이하로 나눠 보낸다', () => {
  const parts = DD.splitWaText(('가'.repeat(100) + '\n').repeat(100), 3800);
  assert.ok(parts.length >= 3);
  assert.ok(parts.every((p) => p.length <= 3800));
});

test('웹훅: 버튼 메시지 → 1번 보내고, Meta 재전송(같은 wamid)은 다시 보내지 않는다', async () => {
  graph.length = 0;
  const wh = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages: [btnMsg('528126075311', 'wamid.BTN1')] } }] }] };
  const o1 = await applyWebhook(wh);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(o1.summary_button, 1);
  const sent1 = graph.filter((b) => b.type === 'text').length;
  assert.ok(sent1 >= 1, '전체 요약 발송');
  const o2 = await applyWebhook(wh);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(o2.summary_button || 0, 0, '중복 웹훅은 처리 안 함');
  assert.equal(graph.filter((b) => b.type === 'text').length, sent1);
  const win = (await query(`SELECT last_at > now() - interval '1 minute' AS fresh FROM wa_inbound WHERE wa_from='528126075311'`)).rows[0];
  assert.ok(win && win.fresh, '버튼을 누르면 24시간 창이 열린 것으로 기록');
});
