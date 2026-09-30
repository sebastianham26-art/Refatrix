# REFATRIX 인수인계 — 고객 설문을 REFATRIX Platform(refatrix-platform.netlify.app)으로 (2026-09-30f, ERP build `20260930sv9`)

## ① 설명
- 플랫폼 상단 메뉴에 **「고객 설문」** 추가 → 플랫폼에 로그인한 사람(CTR 개발자·디렉터)이 **별도 아이디·비밀번호 없이** 바로 본다. 화면 내용은 sv8과 같다(스페인어 · 리포트·AI 요약·서술형·응답 목록·원본 이미지).
- 동작: 플랫폼 안 `survey.html`(같은 사이트)이 플랫폼 세션(sessionStorage `rfx_sess`)을 ERP 서버 `POST /api/survey-viewer/platform-login` 에 넘긴다 → **ERP 서버가 플랫폼(Supabase) RPC `app_log` 로 세션을 직접 확인**(무효면 `SESION_INVALIDA`) → 1시간짜리 열람 토큰. 만료되면 플랫폼 세션으로 자동 재확인. 열람은 플랫폼 활동 로그에 「고객 설문 결과 열람 (ERP 연동)」으로 이름과 함께 남는다.
- **누가 보나** = 플랫폼 사용자 관리(가입 승인·PIN·비활성)가 결정. **무엇을 보나** = ERP 디렉터가 설문별로 「🌐 REFATRIX Platform 공개」 체크(기본 꺼짐). 끄면 이미 열린 화면도 다음 요청부터 404.
- 열람 토큰으로 ERP API 전부 401(기존과 동일). 플랫폼 로그아웃 시 설문 iframe 비움.
- erp.refatrix.com 의 기존 열람 계정 방식(`mx_survey_analysis.html`)은 그대로 남아 있음(원하면 제거).

## ② 배포 단계
**A. ERP (먼저)**
1. Fetch/Pull → `surveyViewer.js`, `0242_survey_platform_visible.sql` push → Railway **Success**
2. `npm run migrate` → `apply 0242_survey_platform_visible.sql`
3. `refatrix-survey.html`, `mx_survey_analysis.html`(루트) push → `Ctrl+Shift+R` → build **20260930sv9**
4. 고객 설문 분석 › 리포트 › [🔐 외부 열람 계정] → **「🌐 REFATRIX Platform 공개」에서 RUJAC_01 체크**

**B. Netlify (플랫폼)**
1. app.netlify.com › refatrix-platform › Deploys › 최신 배포 **Download**(전체 폴더 — ctr_download.js·PDF 등 포함)
2. 그 폴더의 `index.html`을 새 `index.html`로 **교체**, `survey.html` **추가**
3. 폴더 전체를 Deploys 화면에 **드래그&드롭** (파일 2개만 올리면 나머지 파일이 사라지니 반드시 폴더 전체)

## ③ 테스트 방법
1. 플랫폼 로그인 → 메뉴 「고객 설문」 → 로그인 없이 결과 표시
2. 관리·로그 → 활동 로그에 「고객 설문 결과 열람 (ERP 연동)」
3. ERP에서 플랫폼 공개 체크 해제 → 플랫폼 설문 화면 새로고침 → 결과 안 보임
4. 플랫폼 로그아웃 → 다시 로그인 전에는 설문 화면 접근 불가

## ④ 변경 파일
| 위치 | 경로 | 구분 |
|---|---|---|
| ERP 레포 | `refatrix-api/src/surveyViewer.js` | 수정 — 플랫폼 세션 확인·공개 설정 API |
| ERP 레포 | `refatrix-api/migrations/0242_survey_platform_visible.sql` | 신규 |
| ERP 레포 | `refatrix-survey.html` (루트) | 수정 — 🌐 플랫폼 공개 체크 · sv9 (nav 토큰 라이브 값 유지) |
| ERP 레포 | `mx_survey_analysis.html` (루트) | 수정 — 플랫폼 모드 지원(`data-auth="platform"`) |
| ERP 레포 | `refatrix-api/test/survey_public.test.mjs` | 수정 |
| Netlify | `index.html` | 수정 — 메뉴 「고객 설문」·화면·로그아웃 시 비우기 (15줄) |
| Netlify | `survey.html` | 신규 — `mx_survey_analysis.html` 플랫폼 모드판 |

## ⑤ 검증 결과
- 실 PostgreSQL + jsdom: 설문 테스트 **32/32 통과**(신규 3)
  - uuid 아닌 토큰 → 플랫폼에 묻지 않고 401 · 무효 세션 401 · 플랫폼 무응답 502 · 공개 설정 디렉터만 · 공개 설문만 목록/데이터 · 비공개 404 · 공개 끄면 기존 토큰도 즉시 404 · ERP API 401
  - survey.html: 플랫폼 세션으로 자동 열람(별도 로그인 없음) · 세션 없으면 안내+플랫폼 링크(ERP 호출 없음) · 401 → 재확인 후 이어서
- 실제 플랫폼 Supabase에 가짜 토큰으로 `app_log` 호출 → `SESION_INVALIDA` 확인(유효 세션 거절 로직 근거)
- `node --check`, pglast(19 + 마이그레이션), 플랫폼 index.html 인라인 스크립트 파싱 통과

## ⑥ 결정사항
- 플랫폼 로그인 하나로(디렉터 결정). 접근자 관리는 플랫폼, 공개 설문 선택은 ERP 디렉터.
- 플랫폼 코드는 최소 변경(메뉴+iframe). 설문 화면은 ERP 쪽 코드 하나(`mx_survey_analysis.html`)를 두 곳에서 씀.

## ⑦ 오픈이슈
- 플랫폼 전 사용자(개발자 역할 포함)가 개인정보 포함 응답 목록을 봄 — 필요 시 「디렉터만」 등으로 제한 가능
- `survey.html`은 `mx_survey_analysis.html`을 고치면 함께 다시 만들어 올려야 함(첫 줄 `data-auth="platform"`만 다름)

## ⑧ 다음 액션
- A → B 순서 배포 → ③ 확인 → 공급자 안내 메일의 주소를 플랫폼으로 변경
