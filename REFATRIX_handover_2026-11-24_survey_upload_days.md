# REFATRIX 인수인계 — 고객 설문 분석: 날짜별 업로드 내역 · 날짜 단위 삭제 (2026-11-24, build 20261124sv13)

## 1. 요청
- ERP › 제품마케팅 › 고객설문분석에서 업로드한 설문지를 **날짜별로** 보고, 특정 날짜에 올린 스캔을 **한꺼번에 삭제**.
- 삭제하면 REFATRIX Platform 「고객 설문」에도 반영.

## 2. 결과(화면)
- ② 응답 업로드·목록 탭에 **📅 날짜별 업로드 내역** 카드 추가(멕시코 시간 기준).
  - 열: 업로드 날짜 · 장수 · 판독(완료/대기/실패) · 붉은 번호 범위 · 올린 사람 · 시간.
  - 날짜 버튼 → 아래 응답 목록이 그 날짜만 보임(다시 누르면 해제). 응답 목록에도 「업로드 날짜」 선택칸 추가.
  - **⬇ zip**: 그 날짜 원본 zip(지우기 전 백업용, 누구나).
  - **🗑 이 날짜 삭제**: 디렉터만. 확인창 → 날짜를 직접 입력해야 실행.

## 3. 삭제 규칙
- 그 날짜(멕시코 시간 00:00~23:59)에 올린 장의 원본·판독 결과·가린 사본을 **영구 삭제**(되돌릴 수 없음).
- 서버가 화면에서 본 장수(`expect`)와 실제 장수를 비교 — 그 사이 바뀌었으면 409 `count_changed`, 아무것도 지우지 않음.
- 옛 응답 기준 **AI 요약(한국어·스페인어 번역 포함)은 지움** → 삭제 후 ③ 분석 리포트에서 [🤖 AI 요약 만들기] 다시 누르면 플랫폼에도 새 요약이 스페인어로 나감.
- 감사 기록(audit_log): `delete survey:<id>` · detail에 날짜·장수·각 장의 id/번호/상태.

## 4. 플랫폼 반영
- 플랫폼(`survey.html`·`index.html`)은 열 때마다 ERP DB를 그대로 읽으므로 **Netlify 파일 변경 없음**.
- 삭제 즉시 플랫폼의 집계·지도·응답 목록·[⬇ 설문지 전체 다운로드](가린 사본 장수)에서 빠짐. 테스트로 확인.

## 5. API
| 메서드 | 경로 | 권한 | 내용 |
|---|---|---|---|
| GET | `/api/surveys/:id/upload-days` | 마케팅 열람 | 날짜별 묶음 `{day,total,done,error,running,first_at,last_at,num_min,num_max,uploaders}` |
| DELETE | `/api/surveys/:id/upload-days/:day?expect=N` | 디렉터 | 그 날짜 전부 삭제 → `{deleted, ai_cache_cleared, counts, days}` |
- `GET /api/surveys/:id/pages` 각 장에 `up_day`(멕시코 날짜) 추가.
- 오류: `bad_date` 400 · `no_expect` 400 · `no_pages` 404 · `count_changed` 409(+count) · 디렉터 아님 403.

## 6. 변경 파일
| 파일 | 배포처 |
|---|---|
| `refatrix-survey.html` | GitHub Pages + VPS(erp.refatrix.com) |
| `refatrix-api/src/routes/surveyRoutes.js` | Railway |
| `refatrix-api/test/survey_upload_days.test.mjs` (신규) · `survey_public/survey_download.test.mjs`(빌드 토큰) | 레포 |
- 마이그레이션 없음. 환경변수 없음. nav 토큰 변경 없음.

## 7. 검증
- `node --check`, 페이지 인라인 스크립트 문법 검사.
- 실 PostgreSQL 16(전체 마이그레이션 0001~0333) 종단: 설문 테스트 5묶음 **33/33 통과**
  - 신규: UTC 자정 넘긴 업로드가 멕시코 날짜로 묶임 / 권한·형식·장수 불일치 거부 시 0장 삭제 / 그 날짜만 삭제 / AI 요약 삭제 / 감사 기록 / 플랫폼 응답·다운로드 장수 반영.
- Playwright 화면 확인(날짜 카드·날짜 필터, 콘솔 오류 없음).

## 8. 배포 순서 · 남은 것
1. Railway: `refatrix-api/src/routes/surveyRoutes.js` 교체 → 배포.
2. 프론트: `refatrix-survey.html` 교체(GitHub Pages + VPS rsync). 콘솔에 `[survey] build 20261124sv13`.
3. 삭제 후 AI 요약을 쓰려면 ERP에서 다시 만들기.
- 남은 것: 없음. (선택) 휴지통처럼 되살리기가 필요하면 별도 작업.
