// 2026-09-24 핫픽스 — 자동번역된 연동 관리 화면에서 저장 시 「메서드는 … 중 하나여야」 거절
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { normalizeMethods, validatePatch } from '../src/integrations.js';

test('서버: 빈칸은 바꾸지 않음, 공백·소문자는 고쳐 받는다', () => {
  const p = normalizeMethods({ method_upsert: ' post ', method_delete: '' , label: 'x' });
  assert.equal(p.method_upsert, 'POST');
  assert.ok(!('method_delete' in p));
  assert.equal(validatePatch(p), null);
  assert.equal(validatePatch(normalizeMethods({ method_upsert: 'CORREO' })), 'method_invalid');
});

const html = readFileSync(new URL('../../refatrix-integrations.html', import.meta.url), 'utf8');
const doc = new JSDOM(html).window.document;

test('화면: 선택칸 글자가 번역돼도 값은 영어 그대로', () => {
  for (const [id, map] of [['fMethodUpsert', { POST: 'CORREO', GET: 'OBTENER', PUT: 'PONER' }],
                           ['fMethodDelete', { DELETE: 'BORRAR', POST: 'CORREO' }]]) {
    const sel = doc.getElementById(id);
    assert.equal(sel.getAttribute('translate'), 'no');
    for (const o of sel.options) if (map[o.value]) o.textContent = map[o.value];   // Google 번역 흉내
    for (const v of Object.keys(map)) { sel.value = v; assert.equal(sel.value, v); }
  }
});

test('화면: 저장된 값이 목록에 없으면 추가해서 선택(빈칸 저장 방지)', () => {
  assert.match(html, /function setMethodSel\(id,v\)/);
  assert.match(html, /setMethodSel\('fMethodDelete',e\.method_delete\|\|'DELETE'\)/);
  assert.ok([...doc.getElementById('fMethodDelete').options].some(o => o.value === 'GET'));
  assert.match(html, /build 20260924mth/);
});
