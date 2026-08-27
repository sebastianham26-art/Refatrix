// 운영 소스에서 그대로 가져와 실행한다(복붙 아님).
//  ① rackMoveRoutes.replaceRackToken — 마스터 랙 칸의 나머지 랙 보존
//  ② refatrix-relocate.html findRack — 통짜 문자열이면 첫 랙으로 매칭
import fs from 'fs';
import { replaceRackToken, normRack, sameRack } from '/home/claude/repo/refatrix-api/src/routes/rackMoveRoutes.js';
import { splitRacks, rackGroup, sortRacks } from '/home/claude/repo/refatrix-api/src/routes/zoneRoutes.js';

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n + (e !== undefined ? ' — ' + JSON.stringify(e) : '')); } };

// ── ① splitRacks
t('콤마 분리', JSON.stringify(splitRacks('AA3-2, B2-2')) === '["AA3-2","B2-2"]');
t('공백·빈칸 정리', JSON.stringify(splitRacks('  B2-2 ,, B10-1  ')) === '["B2-2","B10-1"]');
t('줄바꿈도 구분자', JSON.stringify(splitRacks('A1-1\nA1-2')) === '["A1-1","A1-2"]');
t('단일 랙', JSON.stringify(splitRacks('AA1-1')) === '["AA1-1"]');
t('빈 값', splitRacks(null).length === 0 && splitRacks('  ').length === 0);

// ── ② 그룹 — 쪼갠 뒤에는 AA 와 B 가 갈린다(현장 보고의 핵심)
{
  const master = 'AA3-2, B2-2';
  t('통짜면 AA 그룹(버그 재현)', rackGroup(master) === 'AA');
  const gs = splitRacks(master).map(rackGroup);
  t('쪼개면 AA / B 로 갈림', JSON.stringify(gs) === '["AA","B"]', gs);
}
{
  // 스크린샷의 실제 값
  const raw = ['AA1-1', 'AA1-2', 'AA1-3', 'AA1-5', 'AA2-1', 'AA2-1, AA2-5', 'AA2-2', 'AA2-3',
    'AA2-5', 'AA3-2, B2-2', 'AA3-2, C1-2', 'AA3-2, D2-3'];
  const uniq = [];
  raw.flatMap(splitRacks).forEach((r) => { if (!uniq.some((x) => sameRack(x, r))) uniq.push(r); });
  const rows = sortRacks(uniq.map((r) => ({ rack: r, group: rackGroup(r) })));
  const inAA = rows.filter((r) => r.group === 'AA').map((r) => r.rack);
  t('AA 그룹에 B/C/D 랙 없음', !inAA.some((r) => /^[BCD]/.test(r)), inAA);
  t('AA 그룹 = AA1-1..AA3-2 9개', inAA.length === 9, inAA);
  t('B2-2 는 B 그룹', rows.find((r) => r.rack === 'B2-2').group === 'B');
  t('C1-2 는 C 그룹', rows.find((r) => r.rack === 'C1-2').group === 'C');
  t('D2-3 는 D 그룹', rows.find((r) => r.rack === 'D2-3').group === 'D');
  t('콤마 남은 행 없음', !rows.some((r) => r.rack.includes(',')));
}

// ── ③ replaceRackToken — 이동해도 나머지 랙이 살아남는다
t('여러 랙 중 하나만 교체', replaceRackToken('AA3-2, B2-2', 'AA3-2', 'F1-1') === 'F1-1, B2-2');
t('뒤쪽 랙 교체', replaceRackToken('AA3-2, B2-2', 'B2-2', 'F1-1') === 'AA3-2, F1-1');
t('대소문자 무시', replaceRackToken('AA3-2, B2-2', 'aa3-2', 'F1-1') === 'F1-1, B2-2');
t('공백 있는 원본', replaceRackToken(' AA3-2 , B2-2 ', 'AA3-2', 'F1-1') === 'F1-1, B2-2');
t('3개 중 가운데', replaceRackToken('A1-1, B2-2, C3-3', 'B2-2', 'Z9-9') === 'A1-1, Z9-9, C3-3');
t('중복 생기면 합쳐짐', replaceRackToken('AA3-2, B2-2', 'AA3-2', 'B2-2') === 'B2-2');
t('일치 없으면 null(마스터 안 건드림)', replaceRackToken('AA3-2, B2-2', 'ZZ9-9', 'F1-1') === null);
t('빈 마스터는 null', replaceRackToken('', 'A', 'B') === null && replaceRackToken(null, 'A', 'B') === null);
t('단일 랙도 교체됨', replaceRackToken('AA3-2', 'AA3-2', 'F1-1') === 'F1-1');

// ── ④ 이동 라우트의 마스터 결정 로직(운영 코드와 같은 분기)을 재현해 확인
const src = fs.readFileSync('/home/claude/repo/refatrix-api/src/routes/rackMoveRoutes.js', 'utf8');
t('이동: 여러 랙이면 replaceRackToken 사용', /list\.length > 1\) masterTo = replaceRackToken\(masterFrom, fromRack, toRack\)/.test(src));
t('이동: 단일 랙은 기존 동작 유지', /else if \(!sameRack\(masterFrom, toRack\)\) masterTo = toRack;/.test(src));
t('되돌리기도 같은 규칙', /list\.length > 1\) masterTo = replaceRackToken\(masterFrom, m\.to_rack, m\.from_rack\)/.test(src));
t('통짜 덮어쓰기(rack_location=toRack) 사라짐', !/rack_location=\$1[^)]*\)', \[toRack,/.test(src));
t('스캔 응답에 racks 목록', /racks: rackList/.test(src));
t('유형은 첫 랙 기준', /kindOf\(rackList\[0\]\)/.test(src));

// ── ⑤ 프런트 findRack — 통짜 문자열이면 첫 랙으로
{
  const html = fs.readFileSync('/home/claude/repo/refatrix-relocate.html', 'utf8');
  const a = html.indexOf('  function rackKey(r){');
  const b = html.indexOf('  function kindLabel(', a);
  const block = html.slice(a, b);
  const f = new Function('RACKS', 'RACKMAP', 'bare',
    block + '\n; return {findRack, kindOf, firstRack};');
  const RACKS = [{ rack: 'AA3-2', kind: 'carton' }, { rack: 'B2-2', kind: 'fast' }];
  const RACKMAP = {}; RACKS.forEach((r) => { RACKMAP[r.rack.toUpperCase()] = r; });
  const bare = (v) => String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const api = f(RACKS, RACKMAP, bare);
  t('프런트: 단일 랙 그대로', api.kindOf('AA3-2') === 'carton');
  t('프런트: 통짜면 첫 랙 유형', api.kindOf('AA3-2, B2-2') === 'carton');
  t('프런트: 첫 랙이 fast 면 fast', api.kindOf('B2-2, AA3-2') === 'fast');
  t('프런트: 모르는 랙은 null', api.kindOf('ZZ9-9') === null);
  t('프런트: firstRack 트림', api.firstRack(' AA3-2 , B2-2 ') === 'AA3-2');
}

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
