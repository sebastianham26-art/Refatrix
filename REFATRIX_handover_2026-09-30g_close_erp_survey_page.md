# REFATRIX 인수인계 — ERP 설문 결과 페이지 닫기 → REFATRIX Platform으로만 (2026-09-30g, build `20260930sv10`)

## ① 설명 (디렉터 결정: ERP 주소가 회사 밖에 알려지지 않게)
- `erp.refatrix.com/mx_survey_analysis.html` → **내용을 모두 지우고 즉시 `https://refatrix-platform.netlify.app/` 로 자동 이동**하는 한 장짜리 페이지로 교체(검색엔진 noindex, API·데이터 흔적 없음). 예전 안내 메일 링크를 누른 사람도 플랫폼으로 간다.
  - 파일을 지우지 않고 바꾼 이유: VPS 배포(rsync)는 레포에서 지운 파일을 서버에서 지우지 않는다 → 덮어써야 확실히 닫힌다.
- 아이디·비밀번호 **외부 열람 계정 폐쇄**: 로그인 `410`, 예전 계정 토큰 `401`, 계정 만들기 `410`. 열람은 **플랫폼 로그인으로만**(`platform-login`).
- ERP 버튼 [🔐 외부 열람 계정] → **[🌐 플랫폼 공개]**: 설문별 플랫폼 공개 체크만 남김(계정 만들기·ERP 열람 주소 안내 제거).
- 커버리지 사이트 3개 화면의 「Encuesta de clientes ↗」 링크 제거.
- 플랫폼용 화면 원본은 `refatrix-api/templates/survey_platform.html` 로 이동(= Netlify `survey.html` 과 동일, erp 도메인에는 올라가지 않음). **Netlify 는 다시 올릴 필요 없음.**

## ② 배포 단계 (마이그레이션 없음)
1. Fetch/Pull
2. 백엔드: `refatrix-api/src/surveyViewer.js`, `surveyPublic.js`, `templates/survey_platform.html` push → Railway **Success**
3. 프런트(루트): `mx_survey_analysis.html`, `refatrix-survey.html`, `mx_parts_coverage_dashboard.html`, `mx_coverage_map.html`, `mx_dev_projects.html` push → VPS·Pages 자동 배포
4. `Ctrl+Shift+R` → 설문 화면 탭 제목 **build 20260930sv10**

## ③ 테스트 방법
1. `https://erp.refatrix.com/mx_survey_analysis.html` 열기 → 바로 플랫폼으로 이동
2. 플랫폼 로그인 → 「고객 설문」 정상
3. ERP 고객 설문 분석 › 리포트 › [🌐 플랫폼 공개] → 체크만 보임

## ④ 변경 파일
| 레포 경로 | 구분 |
|---|---|
| `mx_survey_analysis.html` (루트) | 교체 — 플랫폼으로 자동 이동만 |
| `refatrix-survey.html` (루트) | 수정 — [🌐 플랫폼 공개]만 · sv10 (nav 토큰 라이브 값 유지) |
| `mx_parts_coverage_dashboard.html` · `mx_coverage_map.html` · `mx_dev_projects.html` (루트) | 수정 — 링크 1줄씩 제거 |
| `refatrix-api/src/surveyViewer.js` | 수정 — 계정 로그인·토큰·만들기 닫음 |
| `refatrix-api/src/surveyPublic.js` | 주석만 |
| `refatrix-api/templates/survey_platform.html` | 신규 위치 — 플랫폼 화면 원본(= Netlify survey.html) |
| `refatrix-api/test/survey_public.test.mjs` | 재작성 |

## ⑤ 검증 결과
- 실 PostgreSQL + jsdom: 설문 테스트 **30/30 통과**
  - 계정 로그인 410 · 예전 계정 토큰 401 · 계정 만들기 410 · 플랫폼 경로(세션 확인·공개 설문만·번역 캐시·이미지·ERP 차단·끄면 즉시 404) 유지
  - 이동 페이지: 플랫폼 주소로만 이동·API/데이터 흔적 없음 · 커버리지 3개 화면 링크 없음 · ERP 화면에 계정 만들기·ERP 열람 주소 없음
  - 레포 원본 = Netlify survey.html 동일 확인

## ⑥ 결정사항
- 설문 결과 외부 열람은 REFATRIX Platform 로그인으로만.

## ⑦ 오픈이슈
- survey_viewers 표(예전 계정)는 데이터만 남음 — 원하면 삭제 마이그레이션.

## ⑧ 다음 액션
- 배포 → ③ 확인
