# REFATRIX 인수인계 — 2026-11-23c · 가격표 총 매출액 · 매출이익액 · 매출이익률 + 누적 카드

빌드: `pm-1123ff` · 마이그레이션 없음

## ① 설명
- 열 추가(판매 누적 옆): **총 매출액 (MXN)** · **매출이익액 (MXN)** · **매출이익률** — 셋 다 제목 클릭 정렬
  - 총 매출액 = 게시 인보이스 판매금액 합(`line_amount_mxn`, IVA 제외, 삭제 인보이스 제외)
  - 매출이익액 = 총 매출액 − 판매 누적 × Total Cost MXN (Sebastian 결정: 판매 시점 원가가 아닌 **현재 평균원가**로 재계산)
  - 매출이익률 = 매출이익액 ÷ 총 매출액 · Total Cost 없는 제품은 이익·이익률 `—` · 손실은 빨간색
- 카드(환율 카드 바로 옆): **누적 매출액 (MXN)** · **매출총이익률** · **매출이익금액 (MXN)**
  - 지금 조건(검색·원산지·보기·비활성)에 맞는 제품 **전체** 기준(화면에 불러온 200줄만이 아님)
  - 이익률 분모 = 원가를 아는 제품의 매출. 원가 없는 제품 매출이 있으면 카드에 마우스 → 「원가 없는 제품 매출 $ … 제외」
  - 원가는 화면에 보이는 Total Cost(소수 2자리)로 계산 → 줄 합계와 카드가 센트까지 일치
- 엑셀 다운로드 19열: … Ultima venta · **Ventas totales MXN · Utilidad bruta MXN · Margen bruto %** · List Price MXN …

## ② 배포단계
파일은 PC 저장소의 올바른 경로에 이미 들어가 있음 → GitHub Desktop에서 아래 4개만 체크 → Commit → Push → Railway Success → `Ctrl+Shift+R` → 탭 제목 `pm-1123ff`. `_tmp_stage/` 는 체크하지 말 것.

## ③ 테스트방법
1. 카드: 환율 옆에 누적 매출액 · 매출총이익률 · 매출이익금액
2. 원산지 등 조건을 바꾸면 카드 값도 바뀌는지
3. 매출이익률 제목 클릭 → 이익률 높은/낮은 순
4. 엑셀 19열 확인

## ④ 변경파일
| 저장소 경로 | 배포 |
|---|---|
| `refatrix-api/src/routes/priceMasterRoutes.js` | Railway |
| `refatrix-pricemaster.html` (루트) | GitHub Pages |
| `refatrix-api/test/price_table_cost_pg.test.mjs` | 테스트 |
| `refatrix-api/test/pricemaster_table_cost_ui.test.mjs` | 테스트 |

## ⑤ 검증결과
- ESM·스크립트 문법 OK
- 실 PostgreSQL 16(전체 마이그레이션) 9/9 — 매출 12,600 / 이익 3,360 / 26.67% · 저장원가 제품 598.16 · KPI 13,800 / 3,958.16 / 28.68% · 원가 없는 매출 600 은 분모 제외 · 조건별 KPI · gp/gpm/rev 정렬 · 원가 변동 시 이익 재계산
- jsdom 8/8 — 15열 · 값/손실 빨강 · 카드 순서·값 · 엑셀 19열 · 다시 올리기 머리글 인식

## ⑥ 결정사항
- 매출이익 = 판매 누적 × 현재 Total Cost (평균원가원칙) 기준

## ⑦ 오픈이슈
- 반품(NC)은 매출·수량에서 빼지 않음
- 이 작업 중 같은 파일을 다른 Claude 창도 수정하고 있었음 — 이 창에서 이어 완성함. 그 창은 닫아 주세요
- 정리 대상: `_tmp_stage/`, 루트 `priceMasterRoutes.js`, `Claude outputs/`, 루트 zip·handover md

## ⑧ 다음액션
Push 후 `pm-1123ff` 확인
