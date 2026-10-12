# REFATRIX 2026-10-12f — 원가 분석 FOB·수입부대비용 구분 + 매출원가/판매가 대비 %

## ① 설명
- 입고 카드마다 「개당 구성: FOB x (a%) + 부대비용 y (b%)」 줄 추가
- 원가 분석 하단에 원가 구성 합계(FOB 금액·% / 부대비용 금액·% / 개당)
- 매출총이익 패널에 「매출원가 구성」 표: FOB 구매단가·수입부대비용·매출원가 합계·매출총이익·매출 — 금액 / 개당 / 매출원가 대비 % / 판매가 대비 %
- 매출원가는 판매 시점 동결값이라 그 안에 FOB·부대 구분이 없음 → 원가 분석 입고 이력의 구성비로 나눔(표 아래 안내문)

## ② 배포단계
1. Fetch/Pull → 백엔드 productRoutes.js Push → Railway Success
2. 프론트 refatrix-products.html Push → Ctrl+Shift+R, 탭 제목 ps-1012mix1 확인
(마이그레이션 없음)

## ③ 테스트방법
CE0536L 펼치기 → 카드별 개당 구성 줄, 원가 구성 합계 줄, 우측 「매출원가 구성」 표 확인

## ④ 변경파일
| 파일 | 레포 경로 |
|---|---|
| productRoutes.js | refatrix-api/src/routes/productRoutes.js |
| refatrix-products.html | refatrix-products.html (레포 루트) |

## ⑤ 검증결과
node --check OK · 화면 수치 재현 테스트(백엔드 로직 실행 → jsdom 렌더): FOB+부대=매출원가, 매출원가%+이익%=100% 일치

## ⑥ 결정사항
표시 전용. 저장 평균원가·COGS 불변.

## ⑦ 오픈이슈
TEST-1781907423501(FOB 0, 부대 3,586) 배치가 원가에 포함되어 구성비가 부대비용 쪽으로 크게 왜곡됨 → 원가 제외 처리 필요

## ⑧ 다음액션
TEST 배치 원가 제외 여부 결정
