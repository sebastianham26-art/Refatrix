# REFATRIX 인수인계 — 외부 열람 화면 = ERP 분석 리포트와 동일 (2026-09-30e, build `20260930sv8`)

## ① 설명
sv7(열람 계정·로그인) 위에 얹는 변경.
1. **ERP 분석 리포트와 동일하게** (디렉터 결정: 개인정보 포함 전부 공개)
   - **Resumen IA** — ERP의 AI 요약(한국어)을 열람 시 스페인어로 **한 번 번역해 캐시**(`surveys.ai_cache.es`). ERP에서 [AI 요약 다시 만들기]를 하면 다음 열람 때 다시 번역. AI 요약이 없으면 안내만.
   - **Comentarios abiertos** — 서술형 문항별 AI 주제 + 주제 요약(스페인어) + 대표 인용(#번호). 주제가 없으면 원문 목록.
   - **Respuestas 탭** — ERP 「응답 업로드·목록」과 같은 읽기 전용 목록: 썸네일·붉은 번호·파일명·이름·상호·전화·상태·확신 낮음 표시, 필터(전체/확신 낮음/번호 없음/대기), 검색(번호·이름·상호). 행 클릭 → 설문지 원본 이미지 + 모든 답 + [Descargar original].
   - 이미지·파일도 열람 토큰으로만(허락된 설문의 페이지만, ERP 토큰으로는 불가).
2. **헤더 링크 제거** — 결과 페이지 헤더에는 제목·사용자명·[Cerrar sesión]만. 하단 안내문은 「Confidencial」(고객 개인정보 포함 경고)로 변경.
- ERP [🔐 외부 열람 계정] 창에 「⚠ 응답 목록에 고객 이름·상호·전화가 그대로 보입니다」 경고 추가.

## ② 배포 단계 (마이그레이션 없음)
1. Fetch/Pull
2. 백엔드 2개 push → Railway **Success**
3. 프런트 2개(루트) push
4. `Ctrl+Shift+R` → 설문 화면 탭 제목 **build 20260930sv8**

## ③ 테스트 방법
1. 열람 계정으로 `https://erp.refatrix.com/mx_survey_analysis.html` 로그인 → 헤더에 링크 없음
2. Reporte: 「Resumen IA」 스페인어(처음 열 때 번역으로 몇 초 걸릴 수 있음) · 「Comentarios abiertos」 주제·인용
3. Respuestas 탭: 목록·검색·필터 → 행 클릭 → 원본 이미지·답·원본 다운로드
4. ERP에서 [AI 요약 다시 만들기] 후 열람 화면 새로고침 → 새 요약이 스페인어로

## ④ 변경 파일
| 레포 경로 | 구분 |
|---|---|
| `refatrix-api/src/surveyViewer.js` | 수정 — 응답 목록·이미지 API·AI 요약 스페인어 번역 캐시 |
| `refatrix-api/src/routes/surveyRoutes.js` | 수정 — 열람 라우트에 AI 호출 연결(1줄) |
| `mx_survey_analysis.html` (루트) | 수정 — Reporte/Respuestas 탭·AI 요약·서술형·상세 · 헤더 링크 제거 |
| `refatrix-survey.html` (루트) | 수정 — 계정 창 안내 문구 · build sv8 |
| `refatrix-api/test/survey_public.test.mjs` | 수정 |

## ⑤ 검증 결과
- 실 PostgreSQL + jsdom: 설문 테스트 **29/29 통과**
  - 응답 목록에 이름·번호·파일명 / 문항·AI 요약에 한글 없음 / 번역 캐시(두 번째 열람 AI 호출 0, 요약 재생성 시 재번역) / 이미지 200·원본 파일명 / 다른 설문 페이지 404 / ERP 토큰 401
  - 화면: 헤더 링크 0 · AI 요약·주제·인용 · Respuestas 목록·필터·검색·상세·이미지 토큰 요청 · 한글 0자
- 헤드리스 Chromium 데모 캡처로 Reporte·Respuestas·상세 레이아웃 확인
- pglast(열람 SQL 16개) 통과

## ⑥ 결정사항
- 외부 열람 = ERP와 동일 공개(이름·상호·전화·번호·원본 이미지) — 디렉터 결정(2026-09-30)
- AI 요약 스페인어는 번역 캐시(요약 재생성 시에만 다시 번역 · 비용 최소)

## ⑦ 오픈이슈
- 공개 범위가 넓어졌으므로 계정은 필요한 사람에게만, 끝나면 [정지]/[삭제]

## ⑧ 다음 액션
- 배포 → ③ 확인
