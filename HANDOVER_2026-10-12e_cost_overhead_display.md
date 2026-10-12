# REFATRIX hotfix 2026-10-12e — 원가 분석 부대비용 0 표시 수정

## ① 설명
제품 상세 「원가 분석」 카드에서 부대비용 문서(수입부대비용) 승인분이 0으로 표시되던 문제 수정.
원인: 부대비용 문서 승인은 products.avg_cost 만 올리고 import_lines.unit_cost_mxn 은 그대로 둠.
화면은 부대비용을 「수량×입고단가 − 기본원가」로 역산하므로 0이 됨.
수정: 승인(approved·미삭제)된 import_cost_adjustments 의 배치×제품 단위당 부대비용을 입고단가에 더해 표시.
문서가 여러 건이면 합산, 같은 배치에 같은 제품 라인이 여러 줄이어도 중복 없음.

## ② 배포단계
1. GitHub Desktop Fetch/Pull → 파일 교체 → Push (백엔드만, 마이그레이션 없음)
2. Railway Success 확인 → 제품 화면 Ctrl+Shift+R

## ③ 테스트방법
CE0536L 펼치기 → D26-81319563 카드의 「부대비용(1/n 배분)」에 승인 금액이 보이고 입고단가가 90.48보다 커졌는지 확인.

## ④ 변경파일
| 파일 | 레포 경로 |
|---|---|
| productRoutes.js | refatrix-api/src/routes/productRoutes.js |
(프론트 변경 없음 — 루트의 refatrix-api/productRoutes.js 는 구버전 복사본이므로 건드리지 않음)

## ⑤ 검증결과
node --check OK · pglast OK · pg-mem: 승인 2건(25.5+4.5)=30 합산, 대기·삭제 문서 제외 확인

## ⑥ 결정사항
표시 전용. 저장 평균원가(products.avg_cost)·매출원가(COGS 동결값)는 바뀌지 않음.

## ⑦ 오픈이슈
- 화면 재계산 평균원가(합계 수입금액 ÷ 수량)는 부대비용 포함으로 올라감. 저장 평균원가와의 차이는 승인 경로가 부대비용을 현재 재고에 얹는 방식 때문(별건).
- TEST-1781907423501 배치가 원가에 포함됨(원가 제외 처리 검토).

## ⑧ 다음액션
배포 후 화면 확인.
