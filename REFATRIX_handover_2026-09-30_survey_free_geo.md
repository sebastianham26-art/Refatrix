# REFATRIX 인수인계 — 고객 설문 분석: 손으로 적은 지역 찾기 (2026-09-30, build `20260930sv4`)

## ① 설명
설문 양식에 **지역 문항이 없어서** 고객이 여백·이름 칸 옆·뒷면 등에 **도시·주를 손으로 적은 경우**를 찾아 기록한다.

- 리포트 탭에 지역 문항이 없으면 **「✍ 손으로 적은 지역 찾기」** 카드가 뜬다 → 버튼 한 번에
  1. 「손으로 적은 지역」 문항(`type:'geo'`, `free:true`)을 문항 목록 끝에 추가하고
  2. 이미 읽은 장에서 **지역만** AI로 다시 찾는다(`POST /api/surveys/:id/geo-scan`). 다른 답·붉은 번호·사람이 고친 칸은 바뀌지 않는다.
- AI 규칙: 인쇄된 글자(우리 주소·꼬리말·로고)와 붉은 번호는 무시, 고객이 **손으로 적거나 도장 찍은** 도시·주만. 전화 LADA·상호로 추측 금지. 어디에 적혀 있었는지(`donde`)도 저장 → 상세 화면에 「적힌 그대로: Mty, N.L. (margen superior)」.
- 결과는 기존 지역 기능 그대로: 멕시코 32개 주 지도·주 순위·도시 표·세그먼트·엑셀.
  - 적힌 지역이 없는 장 = **무응답**(확인 필요 아님)
  - Guadalupe·San Pedro·Santa Catarina 같은 모호한 도시만 적힌 장 = **주 미확인** → 목록에서 사람이 주를 고름
- 앞으로 올리는 설문지는 본 판독 때 함께 찾는다(추가 AI 호출 없음).
- 지도 카드에 진행 표시(「✍ 찾는 중 N장」)와 「손글씨 지역 다시 찾기」 버튼(전체 · 사람이 고른 칸 유지), 실패가 있으면 「실패한 장 다시 찾기」.

## ② 배포 단계
1. GitHub Desktop **Fetch/Pull** 먼저
2. 백엔드 3개 파일 교체 → push → Railway **Success** 확인
3. Railway 콘솔 `npm run migrate` → `apply 0238_survey_free_geo.sql`
4. 프런트 `refatrix-survey.html` 교체 → push
5. 설문 분석 화면 `Ctrl+Shift+R` → 탭 제목에 **build 20260930sv4** 확인

## ③ 테스트 방법
1. 제품·마케팅 › 고객 설문 분석 → 해당 설문 → **리포트** 탭
2. 「✍ 손으로 적은 지역 찾기」 → [손글씨 지역 찾기] → 확인
3. 상단 칩 「✍ 지역 찾는 중 N」이 0이 될 때까지 대기(4초마다 자동 갱신)
4. 지도 카드: 「손으로 지역을 적은 응답 X건 / 읽은 Y장」 확인
5. 「⚠ 주 미확인」 칩 → 목록에서 해당 장 열어 주 선택
6. 지역을 적은 것으로 아는 설문지 1~2장을 열어 「적힌 그대로 … (위치)」가 맞는지 대조

## ④ 변경 파일
| 레포 경로 | 구분 |
|---|---|
| `refatrix-api/src/surveyAi.js` | 수정 — `free` 플래그 보존, 본 판독 프롬프트 규칙, `buildGeoScanPrompt`·`parseGeoScanJson`·`freeGeoQuestions` |
| `refatrix-api/src/routes/surveyRoutes.js` | 수정 — 지역 찾기 대기열(`claimNextGeo`·`processGeoScan`), `POST /api/surveys/:id/geo-scan`, counts `geo_pending`·`geo_error`, 기동 시 멈춘 건 복구 |
| `refatrix-api/migrations/0238_survey_free_geo.sql` | 신규 — `survey_pages.geo_scan`, `geo_scan_attempts`, `geo_scan_error` + 부분 인덱스 |
| `refatrix-survey.html` (레포 루트) | 수정 — 카드·버튼·진행 칩·상세 위치 표시, build `20260930sv4` |
| `refatrix-api/test/survey_free_geo.test.mjs` | 신규 테스트 |
| `refatrix-api/test/survey.test.mjs` | 수정 — 빌드 토큰 검사를 날짜 무관하게 |

## ⑤ 검증 결과
- `node --check` 전 파일 통과, 프런트 인라인 스크립트 파싱 통과
- 실 PostgreSQL 16(마이그레이션 0001~0238 전체 적용) + 가짜 Claude 종단: **21/21 통과** (기존 설문 15 + 신규 6)
  - 지역만 찾기 후 다른 답·번호·사람 수정 칸 불변 / 없음=무응답 / 모호=주 미확인 / 사람 선택은 전체 재탐색에도 유지 / 429 자동 재시도 / `scope:new`는 안 찾은 장만 / 새 업로드는 본 판독에서 함께 / free 문항 없으면 409 / 무AI 재정리 동작
- jsdom: 지역 문항 없는 설문 → 카드 → PUT(`free:true`, 기존 문항 유지) → `geo-scan(new)` 호출, 전체 재판독은 호출 안 함, 진행 칩 표시
- pglast: 신규 마이그레이션 파싱 통과(라우트 SQL은 실 PG 종단에서 실행 검증)

## ⑥ 결정사항
- 전체 재판독 대신 **지역만 따로** 찾는다 — 이미 쓰고 있는 AI 답이 흔들리지 않게, 비용도 1장당 짧은 호출 1회
- 모호한 도시는 기존 원칙대로 **추측하지 않음**(주 미확인)
- 전화 지역번호(LADA)로 주를 추정하지 않음 — "손으로 적은 지역"만 기록

## ⑦ 오픈이슈
- 몬테레이 행사라면 Guadalupe·San Pedro·Santa Catarina·Juárez·Escobedo 외 NL 시군 표기가 「주 미확인」으로 많이 남을 수 있음 → 필요하면 설문별 「행사 지역 기본 주」 옵션 검토
- 실제 스캔본으로 AI가 인쇄 주소를 확실히 무시하는지 첫 배치에서 2~3장 대조 필요

## ⑧ 다음 액션
- 배포 후 해당 설문에서 [손글씨 지역 찾기] 실행 → 주 미확인 건수 공유 주시면 기본 주 옵션 여부 결정
