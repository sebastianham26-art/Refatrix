# REFATRIX 인수인계 — 고객 설문 결과 「외부 열람 계정」 (2026-09-30d, build `20260930sv7`)

> ⚠ 직전 패키지(09-30c, sv6 · `mx_survey_data.js` 공개 파일 방식)는 **배포하지 말 것**. 이번 패키지가 대체한다. `mx_survey_data.js`는 레포에 절대 올리지 않는다(레포·Pages 공개).

## ① 설명
특정인만 아이디·비밀번호로 로그인해 설문 결과를 보게 한다. ERP는 노출되지 않는다.
- **열람 페이지** `https://erp.refatrix.com/mx_survey_analysis.html` — 전부 스페인어. 로그인 전에는 로그인 화면만(데이터 없음). 로그인하면 서버에서 **익명 집계**만 받아 지도·문항별 결과·세그먼트 필터/비교·서술형 주제 건수를 보여 준다. 세션 8시간, [Cerrar sesión].
- **ERP와 분리된 계정**(`survey_viewers`): 열람 토큰으로는 ERP API 전부 401(authGuard 차단). 허락한 설문만 열림(나머지 404).
- **서버가 보내지 않는 것**: 이름·상호·전화(기재정보), 서술형 원문, 붉은 번호, 손글씨 원문, 페이지 id. 행 순서는 매번 섞는다.
- **보안**: 비밀번호 scrypt 해시 · 8자 이상 영문+숫자 · 5회 실패 15분 잠금 · 없는 아이디와 틀린 비밀번호 같은 응답 · 비밀번호 재발급/정지/삭제 시 기존 토큰 즉시 무효 · API 주소 고정(피싱 링크로 주소 바꾸기 불가) · 모든 로그인/실패 audit_log.
- **관리(디렉터 전용)**: 고객 설문 분석 › 분석 리포트 › **[🔐 외부 열람 계정]** — 계정 만들기(🎲 비밀번호 자동 생성, 열람 설문 선택) → **스페인어 안내문(주소·아이디·비밀번호) 복사** → 전달. 목록에서 설문 변경·비밀번호 재발급·잠금 해제·정지/재개·삭제. 비밀번호는 만들 때만 보인다.
- 커버리지 사이트 3개 화면 헤더에 「Encuesta de clientes ↗」 링크.

## ② 배포 단계
1. Fetch/Pull
2. 백엔드 5개 push → Railway **Success**
3. Railway 콘솔 `npm run migrate` → `apply 0239_survey_viewers.sql`
4. 프런트 5개(루트) push → GitHub Pages·VPS(erp.refatrix.com) 자동 배포
5. 설문 화면 `Ctrl+Shift+R` → 탭 제목 **build 20260930sv7**

## ③ 테스트 방법
1. 리포트 탭 [🔐 외부 열람 계정] → 아이디 `prueba1`, 🎲 → 설문 체크 → 계정 만들기 → 안내문 복사
2. 시크릿 창에서 `https://erp.refatrix.com/mx_survey_analysis.html` → 로그인 → 결과 확인(스페인어)
3. 같은 창에서 `https://erp.refatrix.com/refatrix-portal.html` → ERP 로그인 화면(열람 계정으로 못 들어감)
4. ERP에서 그 계정 [정지] → 열람 창 새로고침 → 「Tu sesión terminó」
5. 확인 후 테스트 계정 삭제

## ④ 변경 파일
| 레포 경로 | 구분 |
|---|---|
| `refatrix-api/src/surveyViewer.js` | 신규 — 열람 로그인·데이터·관리 API |
| `refatrix-api/src/surveyPublic.js` | 신규 — 익명 집계 생성 |
| `refatrix-api/src/middleware/authGuard.js` | 수정 — 열람 토큰 ERP 차단(2줄) |
| `refatrix-api/src/routes/surveyRoutes.js` | 수정 — 열람 라우트 등록(server.js 변경 없음) |
| `refatrix-api/migrations/0239_survey_viewers.sql` | 신규 |
| `refatrix-survey.html` (루트) | 수정 — [🔐 외부 열람 계정] · 공개 파일 내보내기 제거 · sv7 |
| `mx_survey_analysis.html` (루트) | 신규 — 스페인어 로그인 + 결과 |
| `mx_parts_coverage_dashboard.html` · `mx_coverage_map.html` · `mx_dev_projects.html` (루트) | 수정 — 링크 1줄씩 |
| `refatrix-api/test/survey_public.test.mjs` | 신규 테스트 |

## ⑤ 검증 결과
- 실 PostgreSQL 16(0001~0239) 종단 + jsdom: **29/29 통과**(기존 설문 22 + 신규 7)
  - 응답에 개인정보·원문·번호 없음 / 열람 토큰 → ERP 4개 엔드포인트 401 / ERP 토큰 → 열람 API 401 / 미허락 설문 404 / 설문 추가 즉시 반영 / 재발급·정지 후 기존 토큰 401 / 5회 실패 429 → 잠금 해제 / 디렉터 외 관리 403 / 약한 비밀번호·중복 아이디 거절 / 삭제 후 로그인 불가
  - 페이지: 로그인 전 데이터 요청 없음·오류 스페인어·결과 한글 0자·필터·로그아웃·만료 시 로그인 화면
  - ERP: 디렉터만 버튼·만들기 요청 형식·안내문
- `node --check` 전 파일, pglast(신규 SQL 14 + 마이그레이션) 통과, 헤드리스 Chromium 로그인 화면 캡처 확인

## ⑥ 결정사항
- ERP 사용자 계정이 아닌 **별도 열람 계정**(ERP 권한 실수로 새는 일 차단)
- 비밀번호는 서버에 해시만 — 잊으면 재발급
- 계정 관리는 디렉터만

## ⑦ 오픈이슈
- 커버리지 사이트 페이지들 자체는 여전히 공개(이번 범위 밖)
- 판독 대기 중인 장이 있으면 끝난 뒤 자동 반영(열람 페이지는 매번 최신 조회)

## ⑧ 다음 액션
- 배포 → ③ 테스트 → 개발자별 계정 생성·안내문 전달
