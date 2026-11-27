# REFATRIX 인수인계 — 2026-11-26b · 고객개발 루트 기준에 연료비 → 유류비 예산

## 0. 기준
- origin/main e4313f7(고객개발_23) 위에서 작업.

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
