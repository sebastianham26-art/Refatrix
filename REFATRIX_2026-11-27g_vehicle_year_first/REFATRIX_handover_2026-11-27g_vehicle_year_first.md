# REFATRIX 인수인계 · 2026-11-27g · 차종 선택 순서 메이커 → 연식 → 모델 · 제품 `ps-1127vr` · 견적 `qt-1127vn`

## ① 설명
- 차종 선택 순서를 **메이커 → 연식 → 모델**로 바꿨다. 제품 화면(차종으로 제품찾기)과 견적 화면(차종으로 찾기)에 같이 적용된다(공용 모듈 하나).
  - **메이커**를 고르면 그 메이커의 연식 목록과 모델 전체가 나온다.
  - **연식**을 고르면 **그 연식이 적용 범위에 드는 모델만** 남는다(예: 2021 → 2021년에 해당하는 모델만).
  - 연식을 바꿔도 이미 고른 모델이 새 목록에 있으면 그대로 두고, 없으면 비운다.
  - 연식을 「전체 연식」으로 두면 예전처럼 메이커의 모든 모델이 나온다.
- 서버 `GET /api/products/app-models` 에 `?year=` 를 추가했다. 이름 키 · 메이커 낱개 규칙(11-27b · e)은 그대로 적용된다.

## ② 배포단계
1. 백엔드(Fetch/Pull 먼저): BACKEND zip → push → Railway **Success** — 마이그레이션 없음
2. 프론트: FRONTEND zip 3개 파일(`refatrix-vehiclemap.js` · `refatrix-products.html` · `refatrix-quote.html`) → push → `Ctrl+Shift+R`
   - 두 화면 모두 `refatrix-vehiclemap.js?v=20261127g` 로 불러오므로 브라우저 캐시 문제 없음
3. 탭 제목: 제품 **`ps-1127vr`** · 견적 **`qt-1127vn`**

## ③ 테스트방법
1. 제품 › 차종으로 제품찾기: 칸 순서가 메이커 · 연식 · 모델인지
2. NISSAN → 연식 2021 → 모델 목록이 2021년 모델만인지 → 「전체 연식」으로 돌리면 전체 모델
3. 견적 › 고객 선택 › 차종으로 찾기에서 같은 동작

## ④ 변경파일
| 저장소 경로 | 내용 |
|---|---|
| `refatrix-vehiclemap.js` (루트) | 메이커 → 연식 → 모델 연결 · 모델 유지/비움 |
| `refatrix-products.html` (루트) | 칸 순서 · 안내 문구 · build `ps-1127vr` · 모듈 `?v=20261127g` |
| `refatrix-quote.html` (루트) | 칸 순서 · build `qt-1127vn` · 모듈 `?v=20261127g` |
| `refatrix-api/src/routes/productRoutes.js` | `app-models?year=` |
| `refatrix-api/test/quote_vehicle_pick_front.test.mjs` | ⑥ 순서 · 연식별 모델 · 모델 유지/비움 |
| `refatrix-api/test/vehicle_map_e2e.test.mjs` | ⑨ `app-models?year=` |
| `refatrix-api/test/` 견적 화면 시험 6개 · `product_positions_ctr` | build 토큰 |

## ⑤ 검증결과
- `node --check` · pglast 통과
- 견적 jsdom 5/5(⑥ 화면 순서 · 메이커 → 연식 목록 → 모델 / 연식 → 그 연식 모델 · 유지/비움)
- 제품 jsdom 12/12 · `product_positions_ctr` 2/2
- 실 PostgreSQL E2E **10/10**(⑨ 2017 → 2015-2019 모델만 · 2005 → 2003-2011 모델 · 1990 → 없음)
- 견적 화면 기존 시험 재실행 통과(변경 전부터 실패하던 시험은 그대로)
- 기준 커밋: live `main` 78b6359 (11-27f 반영 확인)

## ⑥ 결정사항
- 연식은 「선택」이 아니라 「전체 연식」이 기본 — 연식을 모르면 건너뛰고 모델로 바로 갈 수 있다.

## ⑦ 오픈이슈
- 없음

## ⑧ 다음액션
- 없음
