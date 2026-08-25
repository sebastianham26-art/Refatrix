import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageLabel, stripStageLabel } from '../src/stageLabel.js';

test('6단계 + 미지정 전부 스페인어가 병기된다', () => {
  assert.equal(stageLabel('00_미지정'), '00_미지정 (Sin definir)');
  assert.equal(stageLabel('01_잠재'), '01_잠재 (Potencial)');
  assert.equal(stageLabel('02_접촉'), '02_접촉 (Contacto)');
  assert.equal(stageLabel('03_견적'), '03_견적 (Cotización)');
  assert.equal(stageLabel('04_협상'), '04_협상 (Negociación)');
  assert.equal(stageLabel('05_수주'), '05_수주 (Pedido)');
  assert.equal(stageLabel('06_거래중'), '06_거래중 (En operación)');
});

test('번호 접두어가 없어도 붙는다(구 데이터 호환)', () => {
  assert.equal(stageLabel('잠재'), '잠재 (Potencial)');
  assert.equal(stageLabel('거래중'), '거래중 (En operación)');
});

test('번호 접두어는 보존된다 — 화면 색상·정렬이 접두어를 쓰기 때문', () => {
  for (const n of ['01_잠재', '06_거래중']) {
    assert.match(stageLabel(n), /^\d+_/);
  }
});

test('두 번 적용해도 괄호가 겹치지 않는다', () => {
  const once = stageLabel('01_잠재');
  assert.equal(stageLabel(once), once);
});

test('모르는 단계 이름은 손대지 않는다(디렉터가 단계를 추가해도 안전)', () => {
  assert.equal(stageLabel('07_보류'), '07_보류');
  assert.equal(stageLabel('Prospecto'), 'Prospecto');
});

test('빈 값 방어', () => {
  assert.equal(stageLabel(null), null);
  assert.equal(stageLabel(undefined), undefined);
  assert.equal(stageLabel(''), '');
});

test('stripStageLabel 은 원래 DB 이름으로 되돌린다(엑셀 업로드 매칭용)', () => {
  assert.equal(stripStageLabel('01_잠재 (Potencial)'), '01_잠재');
  assert.equal(stripStageLabel('06_거래중 (En operación)'), '06_거래중');
  assert.equal(stripStageLabel('01_잠재'), '01_잠재');   // 원본은 그대로
  assert.equal(stripStageLabel('  02_접촉  '), '02_접촉');
});

test('왕복(label → strip)이 항상 원래 이름으로 돌아온다', () => {
  for (const n of ['00_미지정', '01_잠재', '02_접촉', '03_견적', '04_협상', '05_수주', '06_거래중']) {
    assert.equal(stripStageLabel(stageLabel(n)), n);
  }
});
