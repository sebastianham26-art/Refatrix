// =====================================================================
// 20261012 · 관리 › 사용자 — 📲 WhatsApp 수신번호 카드
//
//   디렉터 지적: "관리>사용자 페이지에 디렉터 연락처 입력란이 없네"
//
//   실제로는 **있었다.** 사용자 목록 표의 10번째 열에. 다만 그 앞에 「페이지 권한」(min-width
//   380px)·「계좌 권한」(230px)·추가 팀 칩이 있어 1280px 화면에서 입력란이 **x=1314px**,
//   즉 화면 밖이었다(가로 399px 스크롤해야 보인다). 브라우저로 재 보고 확인한 수치다.
//
//   있는데 못 찾는 것은 없는 것과 같다. 그래서 위에 전용 카드를 올렸고,
//   여기서 잠그는 것은 **두 자리가 같은 값을 쓴다**는 사실이다 — 한쪽만 고치면
//   두 화면이 다른 말을 하고, 그런 불일치는 아무도 버그로 신고하지 않는다.
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const H = readFileSync(new URL('../../refatrix-users.html', import.meta.url), 'utf8');
const R = readFileSync(new URL('../src/routes/userRoutes.js', import.meta.url), 'utf8');

test('① 전용 카드가 사용자 목록 **위에** 있다 — 가로 스크롤 없이 보이는 자리', () => {
  assert.ok(/id="waCard"/.test(H) && /id="waList"/.test(H));
  const card = H.indexOf('id="waCard"');
  const table = H.indexOf('id="userList"');
  assert.ok(card > 0 && table > 0);
  assert.ok(card < table, '표보다 뒤에 있으면 또 스크롤해서 찾아야 한다');
});

test('② 디렉터가 맨 위에 온다 — 접수 알림은 디렉터가 항상 받는다', () => {
  assert.ok(/\(c\.role==='director'\)-\(a\.role==='director'\)/.test(H),
    '디렉터를 먼저 보여 줘야 가장 먼저 채워야 할 번호가 눈에 든다');
});

test('③ 번호가 없는 사람을 숨기지 않고 「받지 못합니다」로 말한다', () => {
  assert.ok(/번호 없음 — 받지 못합니다/.test(H));
  assert.ok(/명<\/b>은 번호가 없어/.test(H), '몇 명인지 숫자로도 말해야 행동이 바뀐다');
  assert.ok(/다음 점검\(60초\)/.test(H), '번호를 채우면 언제 나가는지 알려 줘야 한다');
});

test('④ 번호의 용도를 사실대로 적는다 — 아침 브리핑 + 가입신청 알림', () => {
  // 0268 전에는 「아침 브리핑 수신번호」라고만 적혀 있었다. 그대로 두면 디렉터는
  //   이 번호가 가입신청 알림에도 쓰인다는 것을 모른 채 비워 둔다.
  assert.ok(/아침 브리핑/.test(H) && /웹 가입신청 알림/.test(H));
  assert.equal(/title="아침 브리핑 수신번호 — 비우면 발송 제외"/.test(H), false,
    '옛 설명이 남아 있으면 용도가 하나인 줄 안다');
  assert.equal(/title="아침 브리핑 WhatsApp 수신번호 \(멕시코/.test(H), false,
    '표 머리글 설명도 함께 갱신돼야 한다');
});

test('⑤ 두 자리가 같은 값을 쓴다 — 저장 뒤 양쪽 입력란이 함께 바뀐다', () => {
  // 카드와 표 둘 다 같은 onchange 를 쓰고, 둘 다 data-wa-uid 로 찾을 수 있어야 한다.
  assert.equal((H.match(/onchange="setWaPhone\(/g) || []).length, 2,
    '카드와 표가 각각 하나씩 — 저장 경로가 둘로 갈라지면 안 된다');
  assert.equal((H.match(/data-wa-uid=/g) || []).length, 3,
    '카드 입력란 · 표 입력란 · 동기화 선택자');
  assert.ok(/input\[data-wa-uid="'\+userId\+'"\]/.test(H), '저장 뒤 양쪽을 함께 갱신해야 한다');
  assert.ok(/renderWaList\(\);/.test(H));
  // 한 번 조회해서 두 곳을 그린다 — 카드가 따로 조회하면 숫자가 어긋나는 순간이 생긴다.
  assert.ok(/renderWaList\(\);\n    \}catch|renderWaList\(\);/.test(H));
  assert.equal((H.match(/\/api\/users'/g) || []).length >= 1, true);
});

test('⑥ 서버가 번호를 정규화하고, 틀린 형식은 400 으로 돌려준다', () => {
  // 화면은 서버가 돌려준 값을 그대로 쓴다(스스로 정규화하지 않는다) — 규칙은 한 곳에.
  assert.ok(/normalizeWaNumber/.test(R), '정규화는 서버의 공용부가 한다');
  assert.ok(/error: 'bad_phone'/.test(R));
  assert.ok(/wa_phone: value/.test(R), '정규화된 값을 돌려줘야 화면이 그대로 반영할 수 있다');
  // 디렉터 자신의 번호도 막지 않는다(이번 지적의 핵심).
  assert.equal(/role <> 'director'/.test(R.slice(R.indexOf("wa-phone"), R.indexOf("device-lock"))), false,
    '디렉터 번호를 막으면 가입신청 접수 알림을 받을 사람이 없다');
});

test('⑦ 값은 속성 안으로 들어가므로 이스케이프한다', () => {
  assert.ok(/function waEsc\(v\)/.test(H), '이 파일에는 공용 esc 가 없다');
  assert.ok(/waEsc\(u\.name\)/.test(H) && /waEsc\(u\.wa_phone/.test(H));
});

test('⑧ 빌드 마커가 올라갔다(하드 리프레시 확인용)', () => {
  assert.match(H, /<title>[^<]*build u17wa<\/title>/);
});
