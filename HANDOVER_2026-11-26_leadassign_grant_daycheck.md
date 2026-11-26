# REFATRIX 인수인계 — 2026-11-26 · 영업 할당 권한(Emmanuel · marketing) + 전날 할당 점검

## 0. 기준
- origin/main 46dc28c(고객개발_17) 위에 다시 만든 패키지(1126b). 고객개발_16·17 의 prospects · consult 변경 그대로 포함(nav 마커 한 줄만 다름).

## 1. 요청
- Emmanuel · marketing 계정이 디렉터(Sebastian)와 같은 권한으로 「Meta 광고 문의」 할당 · 「영업 할당 · 실적」 화면의 모든 기능을 쓰게 한다.
- 매일 전날 할당받은 대화를 담당자별로 얼마나 진행했는지 한눈에 본다.

## 2. 결과
- 새 사용자별 화면 권한 `leadassign`(관리 › 사용자 › 제품·마케팅 «Meta 문의 할당 · 실적 관리»).
  - 수정 = 디렉터와 같다: 대상자 · 하루 목표 · 비율(%) 저장, ⚡ 지금 분배, 담당 바꾸기/풀기, 상태 · 메모, 남의 할당 📞 전화함 · 메모 지우기, 전체 목록 · 실적.
  - 열람 = 할당 · 실적 · 전체 목록 보기만(바꾸려 하면 «열람 권한만»).
  - 디렉터 · 소시오는 지금처럼 항상.
- 마이그레이션 0340이 아이디 `emmanuel` / `marketing` 또는 이름이 «Emmanuel…» / «marketing»인 계정에 `leadassign` 수정 권한을 넣는다(여러 번 돌려도 같음).
- 「영업 할당 · 실적」 맨 위에 **🗓 전날 할당 점검** 카드(기본 = 어제, ◀ ▶ 날짜 이동, 엑셀).
  - 사람별: 목표 · 할당 · 당일 대화 · 다음 날 이후 대화 · 아직 대화 전 · 넘김 · 답장 필요 · 메모 · 연결/판매 · 처리율(당일/합계) · 판정(당일 90%↑ ✅ · 60%↑ 🟡 · 그 밖 🔴).
  - 아직 대화 전 손님 이름 칩(답장 필요는 빨강) → 누르면 그 대화가 열림. 13건 넘으면 「+n」 → 아래 목록이 그날 · 그 사람 · 대화 전으로 좁혀짐.

## 3. 바뀐 파일 (repo 경로)
- refatrix-api/migrations/0340_leadassign_grant.sql (신규)
- refatrix-api/src/routes/metaAssignRoutes.js — `LA_PAGE`, `laLevel` · `isAdmin`(열람) · `canManage`(수정), config 응답 `can_manage`, 쓰기 = canManage, list = 열람
- refatrix-api/src/routes/metaLeadsRoutes.js · refatrix-api/src/leadPortal.js — PM_KEYS 에 `leadassign` (Meta 광고 문의 화면 열람 · 편집)
- refatrix-leadassign.html (build la-1126) — 전날 할당 점검 카드 · 권한 안내 문구
- refatrix-metaleads.html — 권한 오류 문구
- refatrix-users.html — 권한 목록에 `leadassign`
- refatrix-nav.js — `leadassign:'__socio_or__leadassign'`, metaleads 배열에 `leadassign`, 버전 로그 v20261126la
- 모든 *.html — nav 캐시 마커 `refatrix-nav.js?v=20261126la` 로 통일(기존 20261120qr · 20261126dv 섞여 있던 것)
- 테스트: refatrix-api/test/meta_assign.test.mjs (B9), refatrix-api/test/lead_assign_page_front.test.mjs

## 4. 배포 순서
1. zip 을 repo 루트에 풀어 덮어쓰기 → GitHub push(프런트 GitHub Pages · API Railway 자동 배포).
2. Railway 콘솔 `npm run migrate` (0340).
3. 관리 › 사용자에서 Emmanuel · marketing 계정에 «Meta 문의 할당 · 실적 관리 = 수정»이 켜졌는지 확인. 아이디/이름이 달라 안 잡혔으면 여기서 직접 켠다.
4. 두 계정은 다시 로그인(권한은 로그인 때 읽음).

## 5. 검증
- meta_assign (PostgreSQL) 12/12 — B9: 수정 권한 = 설정 저장 · 지금 분배 · 담당 바꾸기 · 상태 변경 200, 열람 권한 = run 403 read_only, 0340 두 번 실행 · 다른 사람 영향 없음.
- lead_assign_page_front 6/6, meta_assign_front 9/9, meta_reply 6/6, meta_reply_front 2/2, wa_erp_media_front 6/6, lead_portal 9/9, users_wa_phone_card 8/8, integration_nav 4/4(마커 통일로 기존 실패 해소), prospects 22/22.
- Playwright 화면 확인(전날 할당 점검 카드).

## 6. 결정 · 규칙
- 판정 기준: 당일 처리율(그날 맡은 것 중 그날 안에 대화) 90% / 60%.
- 「당일」은 멕시코 시각 날짜 기준. 대화함 = 답장 · 상태 변경 · 📞 전화함(기존 규칙 그대로).

## 7. 남은 일 · 제안
- 매일 아침 전날 점검 요약을 WhatsApp 으로 Sebastian · Emmanuel 에게 보내기(원하면).
- Instagram App Review — 보류 중.

## 8. 주의
- 0340 은 아이디/이름으로 찾는다. 실제 계정 아이디가 다르면 관리 › 사용자에서 켜면 된다(코드 변경 불필요).
