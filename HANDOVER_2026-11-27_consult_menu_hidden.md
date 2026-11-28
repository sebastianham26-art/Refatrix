# HANDOVER 2026-11-27 · 영업 › 고객상담 메뉴 — Sebastian 전용 (기능은 유지)

## ① 설명
- 「영업 › 고객상담」 메뉴 단추를 Sebastian(이름/아이디가 sebastian 으로 시작)에게만 보이게 함. 다른 사람(디렉터 포함)은 메뉴에서 안 보임.
- 화면 파일·API·권한(canSee/requirePage)·데이터는 그대로. 🎙 빠른 녹음 · 📍 고객개발 방문(이 화면을 열어 씀)도 그대로 동작.
- 다시 모두에게 보이게 하려면 `MENU_ONLY_FOR={ consult:['sebastian'] }` 에서 consult 를 지우면 됨(nav.js · portal 두 곳).

## ② 배포단계
- 프론트만(GitHub Pages). 백엔드·마이그레이션 없음. push → Ctrl+Shift+R → 탭 제목 `build 20261127mh` 확인(포털).

## ③ 테스트방법
- Sebastian 로그인: 상단 영업 하위메뉴·모바일 ☰ 전체메뉴·포털 트리에 「고객상담」 보임.
- 다른 계정: 위 세 곳에서 안 보임. 하단 🎙/📍 버튼은 그대로 있고 누르면 녹음 시작.

## ④ 변경파일
| repo 경로 | 내용 |
|---|---|
| `refatrix-nav.js` (루트) | `MENU_ONLY_FOR` + `menuSee()` 추가, 상단 하위메뉴·그룹 첫 화면·모바일 하단탭·전체메뉴에서 canSee→menuSee, 로그 v20261127mh |
| `refatrix-portal.html` (루트) | 같은 `menuSee()`, 탭/트리에서 사용, 타이틀 build 20261127mh |
| 루트 `*.html` 64개 | `refatrix-nav.js?v=20261126fu` → `?v=20261127mh` (캐시 무효화만) |

## ⑤ 검증결과
- `node --check refatrix-nav.js` OK, 포털 인라인 스크립트 2개 `node --check` OK
- jsdom: Sebastian=보임 / Jang(디렉터)=숨김 / Oscar(영업)=숨김, 영업활동 메뉴 정상, 빠른녹음 함수 유지

## ⑥ 결정사항
- 메뉴만 감추고 기능·권한·직접 URL 접근은 막지 않음(Sebastian: "기능을 없애지 않을 것").

## ⑦ 오픈이슈
- 빠른 녹음 화면 안의 「📋 고객상담 전체 화면」 단추는 그대로(녹음 흐름의 일부). 감출지 결정 필요.
- `refatrix-api/src/routes/refatrix-nav.js` 는 오래된 사본이라 건드리지 않음.

## ⑧ 다음액션
- push 후 Sebastian·영업 계정으로 확인.
