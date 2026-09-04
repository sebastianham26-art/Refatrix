// 연동 관리 화면의 「입구」 계약 테스트 — 네비 등록이 빠지면 화면이 통째로 접근 불가가 된다.
//   (2026-09-04 custreg 세션의 「입구 없는 탭」 사고와 같은 실패를 막는다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAV = readFileSync(path.join(ROOT, 'refatrix-nav.js'), 'utf-8');

test('SCREENS 에 integrations(연동 관리)가 등록되어 있다', () => {
  assert.match(NAV, /integrations:\{file:'refatrix-integrations\.html'/);
});

test('연동 관리는 디렉터 전용이고 「관리」 그룹에 노출된다', () => {
  assert.match(NAV, /integrations:'__director__'/);
  assert.match(NAV, /screens:\[[^\]]*'integrations'[^\]]*\][^\]]*$/m);
  const admin = NAV.match(/\{key:'admin'[^}]*\}/);
  assert.ok(admin && admin[0].includes("'integrations'"), '관리 그룹에 없다');
});

test('네비가 가리키는 화면 파일이 실제로 있다', () => {
  const files = new Set(readdirSync(ROOT).filter((f) => f.endsWith('.html')));
  const refs = [...NAV.matchAll(/file:'(refatrix-[a-z0-9-]+\.html)'/g)].map((m) => m[1]);
  const missing = [...new Set(refs)].filter((f) => !files.has(f));
  assert.deepEqual(missing, [], '네비에는 있는데 파일이 없는 화면: ' + missing.join(', '));
});

test('모든 화면이 같은 nav 캐시 마커를 쓴다(반쪽 갱신 방지)', () => {
  const markers = new Set();
  for (const f of readdirSync(ROOT).filter((x) => x.endsWith('.html'))) {
    const m = readFileSync(path.join(ROOT, f), 'utf-8').match(/refatrix-nav\.js\?v=([A-Za-z0-9_]+)/);
    if (m) markers.add(m[1]);
  }
  assert.equal(markers.size, 1, '마커가 갈려 있다: ' + [...markers].join(', '));
  assert.ok(NAV.includes([...markers][0]), 'nav.js 의 버전 로그와 마커가 어긋난다');
});
