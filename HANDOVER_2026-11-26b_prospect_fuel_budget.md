# REFATRIX 인수인계 — 2026-11-26b · 고객개발 루트 기준에 연료비 → 유류비 예산

## 0. 기준
- origin/main e4313f7(고객개발_23) 위에서 작업. 1126d 는 3d18dda(고객개발_24) 위.

## 1. 요청
- 루트 추정 기준에 연료비를 넣고, 넣으면 유류비 예산이 나오게.

## 2. 결과
- 고객개발 › 목표 화면 「⏱ 루트 소요시간·연료·유류비 추정 기준」에 **연료비(페소/리터)** 입력칸(0~200, 소수 둘째 자리).
- 유류비 예산 = 필요 연료(L) × 연료비. 표시 위치: 오늘 루트 예상, 구역/자동 루트 제안(코스별 + 모든 코스 합계), 저장된 루트 목록(짧은 표시).
- 저장 전 기본 연료비 24페소/L. 0을 넣으면 유류비 예산 표시 안 함.

## 3. 바뀐 파일
- refatrix-api/src/prospectCore.js — `ROUTE_SETTINGS_DEFAULT.fuel_price=24`, `estimateRoute()` → `fuel_cost`
- refatrix-api/src/routes/prospectRoutes.js — PUT /api/prospect-settings 에 `fuel_price`(0~200)
- refatrix-prospects.html — 입력칸 · 저장 · `fuelMoney` · `estText` · 제안 합계
- refatrix-api/test/prospects.test.mjs — 유류비 단위 테스트
- refatrix-nav.js — **1126 leadassign 메뉴 권한 복구**(다른 패치에서 `__dirsocio__` 로 되돌아가 Emmanuel · marketing 메뉴에 「영업 할당 · 실적」이 안 보이던 것) · 버전 v20261126fu
- 모든 *.html — nav 캐시 마커 20261126fu 로 통일

## 4. 배포
- zip 을 repo 루트에 덮어쓰고 push. **마이그레이션 없음**(prospect_settings 테이블 0341 그대로 · 새 키 fuel_price 는 저장할 때 들어감).
- 목표 화면에서 실제 연료비 입력 → 「기준 저장」.

## 5. 검증
- prospects 24/24, lead_assign_page_front 6/6, meta_assign_front 9/9, integration_nav 4/4.
- 서버: PUT fuel_price 24.89 → 200, 500 → 400 bad_value, GET 에 반영.
- 화면 스크립트 문법 검사.

## 6. 결정
- 유류비 = 직선거리 × 도로 보정 ÷ 연비 × 연료비(추정치). 실제 주유 영수증과 대조는 아직 없음.

## 7. 남은 일 · 제안
- 담당자별 · 주/월 유류비 예산 합계(루트 기준) 표, 실제 주유비 입력과 비교.

## 8. 주의
- nav.js 는 여러 작업이 함께 고치는 파일 — 덮어쓸 때 leadassign 줄이 `'__socio_or__leadassign'` 인지 확인.

---
# 추가 (1126d) · 담당별 주/월 유류비 예산 합계 — 디렉터 본인만

## 결과
- 고객개발 › 목표 화면, 루트 추정 기준 아래 **⛽ 담당별 유류비 예산 합계** 표. 월별(최근 6개월) / 주별(최근 8주, 월~일) 선택 · 엑셀.
- 칸마다 유류비($) · L · km · 루트 수, 오른쪽 합계 · 기간 평균, 맨 아래 전체. 이번 기간 빨간 제목.
- 날짜가 정해진 루트(오늘 루트 · 코스 저장)만 계산, 날짜 없는 방문 목록은 제외. 계획된 루트 전체(체크인 여부 무관). 제외(descartado)·삭제 후보 중 방문 안 한 곳은 빼고 셈(루트 화면과 같은 규칙).
- **보이는 사람: role = director 계정만**. 고객개발 「관리자」로 지정된 사람 · 소시오 · 영업은 표가 안 보이고 API 도 403.

## 파일
- refatrix-api/src/routes/prospectRoutes.js — `fuelPeriods()`(export), `GET /api/prospect-fuel?unit=week|month&n=`
- refatrix-prospects.html — `#g-fuel` 카드 · `loadFuel` · 엑셀(xlsx 필요할 때 불러옴)
- refatrix-api/test/prospects_fuel.test.mjs (신규)

## 검증
- prospects_fuel 2/2(기간 계산 · 서버 합계 · 날짜 없는 목록 제외 · 영업/관리자 403), prospects 24/24, integration_nav 4/4.
- 로컬 서버 + Playwright 로 표 화면 확인.

## 배포
- 덮어쓰기 + push. 마이그레이션 없음.
