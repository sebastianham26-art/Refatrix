// REFATRIX — 마케팅 지출계획 「집행 처리」 + 「변경표시(diff)」 순수 로직 테스트
//
// 실행: node test/mktspend_exec_diff.test.mjs      (DB 불필요)
//
// diff 는 운영 화면(refatrix-mktspend.html)의 MSDIFF-CORE 블록을 마커로 잘라내
// 그대로 실행한다 → "화면에 실제로 들어 있는 코드"를 검증한다(사본 검증이 아님).
// 집행 상태 판정은 백엔드(execStateOf)와 화면(msExecState)이 같은 답을 내는지 교차 확인한다.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { execStateOf, canExecute } from '../src/routes/marketingSpendRoutes.js';

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(here, '..', '..', 'refatrix-mktspend.html');
const html = readFileSync(htmlPath, 'utf-8');

const START = '// ==== MSDIFF-CORE-START ====';
const END = '// ==== MSDIFF-CORE-END ====';
const i0 = html.indexOf(START), i1 = html.indexOf(END);
assert.ok(i0 > 0 && i1 > i0, 'MSDIFF-CORE 마커를 찾지 못했습니다 — 화면 파일이 바뀌었는지 확인하세요.');
const core = html.slice(i0 + START.length, i1);

const sandbox = { window: {} };
vm.createContext(sandbox);
new vm.Script(core).runInContext(sandbox);
const { msDiff, msExecState, msNormSnap } = sandbox.window;
assert.ok(typeof msDiff === 'function', 'msDiff 가 노출되지 않았습니다');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n     ', e.message); fail++; }
}

// ---- 픽스처 ---------------------------------------------------------------
const line = (id, kind, due, amount, memo) => ({ id, kind, due_date: due, amount, memo: memo || null });
const base = () => ({
  title: '몬테레이 전시회', category: '전시회', event_date: '2026-10-10', purpose: '신규 고객 확보',
  items: [
    { id: 1, name: '장소 대관', memo: 'Cintermex', lines: [line(11, 'adv', '2026-09-15', 30000), line(12, 'fin', '2026-10-15', 30000)] },
    { id: 2, name: '케이터링', memo: null, lines: [line(21, 'one', '2026-10-10', 25000)] },
  ],
  targets: [{ customer_id: 100, is_general: false }, { customer_id: null, is_general: true }],
});
const clone = (o) => JSON.parse(JSON.stringify(o));

console.log('\n[1] 변경표시(diff)');

t('① 동일한 스냅샷 → 변경 없음', () => {
  const d = msDiff(base(), base());
  assert.equal(d.changed, false);
  assert.equal(d.summary.total_before, 85000);
  assert.equal(d.summary.total_after, 85000);
  assert.equal(d.summary.total_delta, 0);
});

t('② 금액 1건 변경 → lines_changed 1 · 이전값 보존 · 총액 델타', () => {
  const h = clone(base()); h.items[0].lines[1].amount = 42000;
  const d = msDiff(base(), h);
  assert.equal(d.changed, true);
  assert.equal(d.summary.lines_changed, 1);
  assert.equal(d.summary.lines_added, 0);
  assert.equal(d.summary.lines_removed, 0);
  assert.equal(d.summary.items_changed, 1);
  assert.equal(d.summary.total_delta, 12000);
  assert.equal(d.byItem[0].state, 'changed');
  assert.equal(d.byItem[0].lines[1].state, 'changed');
  assert.equal(d.byItem[0].lines[1].fields.amount.before, 30000);
  assert.equal(d.byItem[0].lines[1].fields.amount.after, 42000);
  assert.equal(d.byItem[1].state, 'same');   // 손대지 않은 항목은 그대로
});

t('③ 지급 줄 추가 → lines_added 1 · 그 줄만 added', () => {
  const h = clone(base()); h.items[1].lines.push(line(null, 'fin', '2026-11-01', 5000));
  const d = msDiff(base(), h);
  assert.equal(d.summary.lines_added, 1);
  assert.equal(d.summary.lines_removed, 0);
  assert.equal(d.byItem[1].lines[1].state, 'added');
  assert.equal(d.byItem[1].lines[0].state, 'same');
});

t('④ 지급 줄 삭제 → lines_removed 1 · removedLines 에 원본 보존(유령 행 렌더용)', () => {
  const h = clone(base()); h.items[0].lines.splice(1, 1);
  const d = msDiff(base(), h);
  assert.equal(d.summary.lines_removed, 1);
  assert.equal(d.byItem[0].removedLines.length, 1);
  assert.equal(d.byItem[0].removedLines[0].amount, 30000);
  assert.equal(d.byItem[0].removedLines[0].kind, 'fin');
  assert.equal(d.summary.total_delta, -30000);
});

t('⑤ 집행 항목 추가 → items_added 1 · 그 항목의 줄은 전부 신규로 집계', () => {
  const h = clone(base());
  h.items.push({ id: null, name: '판촉물', memo: null, lines: [line(null, 'adv', '2026-09-20', 8000), line(null, 'fin', '2026-10-20', 8000)] });
  const d = msDiff(base(), h);
  assert.equal(d.summary.items_added, 1);
  assert.equal(d.summary.lines_added, 2);
  assert.equal(d.byItem[2].state, 'added');
});

t('⑥ 집행 항목 삭제 → removedItems + 그 줄 수만큼 lines_removed', () => {
  const h = clone(base()); h.items.splice(1, 1);
  const d = msDiff(base(), h);
  assert.equal(d.summary.items_removed, 1);
  assert.equal(d.summary.lines_removed, 1);
  assert.equal(d.removedItems.length, 1);
  assert.equal(d.removedItems[0].name, '케이터링');
});

t('⑦ 항목명 변경(id 유지) → items_changed + fields.name', () => {
  const h = clone(base()); h.items[0].name = '장소 대관 (Cintermex A홀)';
  const d = msDiff(base(), h);
  assert.equal(d.byItem[0].state, 'changed');
  assert.equal(d.byItem[0].fields.name.before, '장소 대관');
  assert.equal(d.summary.lines_changed, 0);   // 줄은 안 바뀜
});

t('⑧ 초안처럼 id 가 매번 새로 생겨도 내용이 같으면 "변경 없음"', () => {
  // 비승인 계획 저장은 백엔드가 라인을 전부 지우고 다시 넣어 id 가 바뀐다.
  // id 가 달라도 (구분+날짜+금액) 으로 짝지어져 오탐(전부 신규+전부 삭제)이 나면 안 된다.
  const b = clone(base()), h = clone(base());
  let n = 900;
  h.items.forEach((it) => { it.id = ++n; it.lines.forEach((l) => { l.id = ++n; }); });
  const d = msDiff(b, h);
  assert.equal(d.changed, false, '내용이 같은데 변경으로 잡혔습니다');
  assert.equal(d.summary.lines_added, 0);
  assert.equal(d.summary.lines_removed, 0);
});

t('⑨ id 없이 금액만 바뀐 줄도 "구분" 으로 짝지어 변경으로 잡는다', () => {
  const b = clone(base()), h = clone(base());
  b.items.forEach((it) => { it.id = null; it.lines.forEach((l) => { l.id = null; }); });
  h.items.forEach((it) => { it.id = null; it.lines.forEach((l) => { l.id = null; }); });
  h.items[1].lines[0].amount = 27000;
  const d = msDiff(b, h);
  assert.equal(d.summary.lines_changed, 1);
  assert.equal(d.summary.lines_added, 0);
  assert.equal(d.summary.lines_removed, 0);
  assert.equal(d.byItem[1].lines[0].fields.amount.before, 25000);
});

t('⑩ 계획 기본정보 변경 → plan.* 에 이전/이후', () => {
  const h = clone(base()); h.title = '과달라하라 전시회'; h.event_date = '2026-11-02';
  const d = msDiff(base(), h);
  assert.equal(d.plan.title.before, '몬테레이 전시회');
  assert.equal(d.plan.title.after, '과달라하라 전시회');
  assert.equal(d.plan.event_date.after, '2026-11-02');
  assert.equal(d.summary.fields_changed, 2);
});

t('⑪ 대상 추가·삭제 집계', () => {
  const h = clone(base());
  h.targets = [{ customer_id: 100, is_general: false }, { customer_id: 200, is_general: false }];
  const d = msDiff(base(), h);
  assert.equal(d.summary.targets_added, 1);    // 200 추가
  assert.equal(d.summary.targets_removed, 1);  // 불특정 다수 제거
});

t('⑫ 기준선이 없으면(null) 전부 신규', () => {
  const d = msDiff(null, base());
  assert.equal(d.has_base, false);
  assert.equal(d.summary.items_added, 2);
  assert.equal(d.summary.lines_added, 3);
  assert.equal(d.summary.total_before, 0);
  assert.equal(d.summary.total_after, 85000);
});

t('⑬ 날짜만 바뀐 줄 · 메모만 바뀐 줄', () => {
  const h = clone(base());
  h.items[0].lines[0].due_date = '2026-09-20';
  h.items[1].lines[0].memo = '점심 포함';
  const d = msDiff(base(), h);
  assert.equal(d.summary.lines_changed, 2);
  assert.equal(d.summary.total_delta, 0);
  assert.equal(d.byItem[0].lines[0].fields.due_date.before, '2026-09-15');
  assert.equal(d.byItem[1].lines[0].fields.memo.before, null);
  assert.equal(d.byItem[1].lines[0].fields.memo.after, '점심 포함');
});

t('⑭ 빈 문자열과 null 은 같은 값으로 본다(오탐 방지)', () => {
  const b = clone(base()), h = clone(base());
  b.items[1].memo = null; h.items[1].memo = '';
  b.items[0].lines[0].memo = ''; h.items[0].lines[0].memo = null;
  assert.equal(msDiff(b, h).changed, false);
});

t('⑮ 금액 문자열/숫자 혼용에도 오탐 없음(화면 input 은 문자열)', () => {
  const b = clone(base()), h = clone(base());
  h.items[0].lines[0].amount = '30000';
  h.items[0].lines[1].amount = '30000.00';
  assert.equal(msDiff(b, h).changed, false);
});

t('⑯ normSnap 은 계획 내용만 남긴다(집행·지급 상태는 diff 대상이 아님)', () => {
  const s = msNormSnap({ title: 'x', items: [{ id: 1, name: 'a', lines: [{ id: 2, kind: 'one', due_date: '2026-01-01', amount: 1, paid: true, exec_total: 5, exec_closed: true }] }] });
  const l = s.items[0].lines[0];
  assert.equal(l.paid, undefined);
  assert.equal(l.exec_total, undefined);
  assert.equal(l.exec_closed, undefined);
  assert.equal(l.amount, 1);
});

console.log('\n[2] 집행 상태 판정 — 백엔드 execStateOf ≡ 화면 msExecState');

const cases = [
  ['미집행',                  [10000, 0, false, false], 'none'],
  ['부분집행',                [10000, 4000, false, false], 'partial'],
  ['집행완료',                [10000, 10000, true, false], 'closed'],
  ['집행 기록 없이 완결 표시', [10000, 0, true, false], 'closed'],
  ['재무 실적처리 우선',       [10000, 4000, true, true], 'paid'],
  ['재무 실적처리(미집행)',    [10000, 0, false, true], 'paid'],
];
for (const [name, args, want] of cases) {
  t(`${name} → ${want}`, () => {
    assert.equal(execStateOf(...args), want, '백엔드');
    assert.equal(msExecState(...args), want, '화면');
  });
}

console.log('\n[3] 집행 처리 권한 — 재무·디렉터만');
t('director / treasury 만 true', () => {
  assert.equal(canExecute({ role: 'director' }), true);
  assert.equal(canExecute({ role: 'treasury' }), true);
  assert.equal(canExecute({ role: 'marketing' }), false);
  assert.equal(canExecute({ role: 'sales' }), false);
  assert.equal(canExecute({ role: 'socio' }), false);
  assert.equal(canExecute({}), false);
  assert.equal(canExecute(null), false);
});

console.log('\n[4] 화면 마커 회귀 — 이번 작업으로 들어간 요소가 실제로 파일에 있는가');
const markers = [
  ['집행 처리 API 호출', "/executions'"],
  ['되돌리기 API 호출', "/revert'"],
  ['대사 API 호출', '/api/mktspend/reconcile?ym='],
  ['집행 선택 체크박스', 'class="exsel"'],
  ['집행 바', "id=\"execBar\""],
  ['집행 패널', "id=\"execPanel\""],
  ['대사 패널', "id=\"reconBox\""],
  ['변경표시 배너', "id=\"diffBox\""],
  ['변경분만 보기', "data-act=\"diffonly\""],
  ['항목별 증빙 추가 버튼', 'data-evadd='],
  ['줄별 증빙 펼침 버튼', 'data-evline='],
  ['줄별 증빙 행', "class=\"evrow\""],
  ['줄 증빙 전송', 'line_id:pendingUpload.line_id'],
  ['증빙 열 헤더', '<span>증빙</span>'],
  ['증빙 점검 요약', 'id="evSum"'],
  ['증빙 종류 전송', 'doc_kind:pendingUpload.doc_kind'],
  ['계획 공통 증빙 라벨', '계획 공통 증빙'],
  ['빌드 마커', 'build 20260903a'],
];
for (const [name, needle] of markers) {
  t(`${name} (${needle})`, () => { assert.ok(html.includes(needle), '없음'); });
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
if (fail) process.exit(1);
