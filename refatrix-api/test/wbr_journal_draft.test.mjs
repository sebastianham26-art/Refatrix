// WBR 「📝 나의 기록 → 팀별 이슈 초안」 — 순수 로직 테스트
//   대상: src/wbrJournalDraft.js (프롬프트 구성 · 응답 파싱 · 기간 검증 · 압축)
//   실행: node --test test/wbr_journal_draft.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORG_KEYS, ORG_LABEL, buildDraftPrompt, parseDraft, draftIsEmpty,
  condenseEntries, isDateStr, daysBetween, dayLabel, MAX_RANGE_DAYS,
} from '../src/wbrJournalDraft.js';

// ── 날짜 유틸 ─────────────────────────────────────────────────────────
test('isDateStr — 형식·실재 날짜만 통과', () => {
  assert.equal(isDateStr('2026-09-04'), true);
  assert.equal(isDateStr('2026-02-29'), false);   // 2026년은 평년
  assert.equal(isDateStr('2026-13-01'), false);
  assert.equal(isDateStr('2026-9-4'), false);
  assert.equal(isDateStr(''), false);
  assert.equal(isDateStr("2026-09-04'; DROP TABLE users;--"), false);
});

test('daysBetween — 양끝 포함, 월경계도 정확', () => {
  assert.equal(daysBetween('2026-08-31', '2026-09-04'), 5);
  assert.equal(daysBetween('2026-09-04', '2026-09-04'), 1);
  assert.equal(daysBetween('2026-09-01', '2026-09-14'), MAX_RANGE_DAYS);
});

test('dayLabel — 9/4(금) 형태', () => {
  assert.equal(dayLabel('2026-09-04'), '9/4(금)');
  assert.equal(dayLabel('2026-08-31'), '8/31(월)');
});

// ── 압축 ─────────────────────────────────────────────────────────────
test('condenseEntries — 하루 상한(6,000자)으로 클립', () => {
  const out = condenseEntries([{ date: '2026-09-01', content: 'x'.repeat(9000) }]);
  assert.equal(out[0].content.length, 6000);
});

test('condenseEntries — 전체 상한 초과 시 오래된 날짜부터 줄이고 최신 날짜는 보존', () => {
  const entries = [1, 2, 3, 4, 5].map((n) => ({
    date: '2026-09-0' + n, content: String(n).repeat(6000),
  }));
  const out = condenseEntries(entries);
  const total = out.reduce((s, e) => s + e.content.length, 0);
  assert.ok(total <= 26000 + 40, '전체 상한 안으로 들어와야 함');
  assert.equal(out[4].content.length, 6000, '가장 최신 날짜는 온전히 남아야 함');
  assert.ok(out[0].content.length < 6000, '가장 오래된 날짜가 먼저 줄어야 함');
  assert.ok(out[0].content.includes('이하 생략'));
});

// ── 프롬프트 ─────────────────────────────────────────────────────────
test('buildDraftPrompt — 기록 원문·기간·5개 조직 키가 모두 들어간다', () => {
  const p = buildDraftPrompt(
    [{ date: '2026-09-01', content: 'Autozone 견적 발송' }],
    '2026-08-31', '2026-09-04'
  );
  assert.ok(p.includes('Autozone 견적 발송'));
  assert.ok(p.includes('2026-08-31 ~ 2026-09-04'));
  assert.ok(p.includes('9/1(화)'));
  for (const k of ORG_KEYS) {
    assert.ok(p.includes('"' + k + '"'), k + ' 키가 프롬프트에 있어야 함');
    assert.ok(p.includes(ORG_LABEL[k]), ORG_LABEL[k] + ' 라벨이 있어야 함');
  }
  assert.ok(p.includes('지어내지 마세요'), '환각 금지 지시');
  assert.ok(p.includes('JSON'), '출력 형식 지시');
});

// ── 응답 파싱 ────────────────────────────────────────────────────────
const OK_JSON = JSON.stringify({
  sales: { this: ['9/1 Autozone 견적 발송 → 9/3 수주 확정'], next: ['미결 견적 3건 팔로업'] },
  support: { this: [], next: [] },
  pm: { this: ['신규 품번 12개 카탈로그 반영'], next: [] },
  wh: { this: [], next: [] },
  mgmt: { this: [], next: [] },
});

test('parseDraft — 정상 JSON', () => {
  const d = parseDraft(OK_JSON);
  assert.deepEqual(Object.keys(d).sort(), ORG_KEYS.slice().sort());
  assert.equal(d.sales.this[0], '9/1 Autozone 견적 발송 → 9/3 수주 확정');
  assert.equal(d.sales.next.length, 1);
  assert.equal(d.support.this.length, 0);
  assert.equal(draftIsEmpty(d), false);
});

test('parseDraft — 코드펜스·앞뒤 설명이 붙어도 복구', () => {
  const d1 = parseDraft('```json\n' + OK_JSON + '\n```');
  assert.equal(d1.sales.this.length, 1);
  const d2 = parseDraft('아래와 같이 정리했습니다.\n' + OK_JSON + '\n확인해 주세요.');
  assert.equal(d2.pm.this.length, 1);
});

test('parseDraft — 누락된 조직은 빈 배열로 채워진다', () => {
  const d = parseDraft('{"sales":{"this":["a"]}}');
  for (const k of ORG_KEYS) {
    assert.ok(Array.isArray(d[k].this) && Array.isArray(d[k].next), k);
  }
  assert.deepEqual(d.sales.next, []);
  assert.deepEqual(d.wh.this, []);
});

test('parseDraft — 문자열이 아닌 값·빈 문자열·불릿 기호는 정리된다', () => {
  const d = parseDraft(JSON.stringify({
    sales: { this: ['- 앞 불릿 기호 제거', '  ', 42, null, { a: 1 }, '줄바꿈\n압축   테스트'], next: [] },
  }));
  assert.deepEqual(d.sales.this, ['앞 불릿 기호 제거', '줄바꿈 압축 테스트']);
});

test('parseDraft — 같은 문장 중복 제거 + 개수 상한(this 8 / next 6)', () => {
  const many = Array.from({ length: 20 }, (_, i) => '항목 ' + i);
  const d = parseDraft(JSON.stringify({
    sales: { this: ['같은 줄', '같은 줄'].concat(many), next: many },
  }));
  assert.equal(d.sales.this.length, 8);
  assert.equal(d.sales.this.filter((x) => x === '같은 줄').length, 1);
  assert.equal(d.sales.next.length, 6);
});

test('parseDraft — 한 항목 300자 상한', () => {
  const d = parseDraft(JSON.stringify({ sales: { this: ['가'.repeat(500)], next: [] } }));
  assert.equal(d.sales.this[0].length, 300);
});

test('parseDraft — 파싱 불가·빈 결과는 null', () => {
  assert.equal(parseDraft(''), null);
  assert.equal(parseDraft('죄송합니다, 요약할 수 없습니다.'), null);
  assert.equal(parseDraft('{ 깨진 JSON '), null);
  assert.equal(parseDraft('[1,2,3]'), null);
  assert.equal(parseDraft(JSON.stringify({ sales: { this: [], next: [] } })), null, '전부 비면 null');
});
