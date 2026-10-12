# REFATRIX 2026-10-12i — ⑧ 매출원가 분석 · IVA 포함/제외 표시

## ① 설명
- 「입력 판매단가」 선택: IVA 제외(기본) / IVA 포함(÷1.16 으로 환산해 계산). 붙여넣은 단가도 이 기준으로 읽음.
- 표: List · 판매단가 칸 아래에 다른 기준 금액(IVA 포함 또는 제외)을 작게 표시. 빈 단가 칸 안내값도 입력 기준에 맞춰 표시.
- KPI: 매출 IVA 제외 / IVA 포함(IVA 금액), List 합 IVA 포함, 고객 추가 할인 비용 옆에 「고객이 덜 내는 금액(IVA 포함)」.
- 원가 · 매출총이익 · 할인 비용은 계속 IVA 제외(IVA 는 이익이 아님).
- 엑셀: 입력 기준 머리줄, List · 판매단가 IVA 제외/포함 두 열씩.

## ② 배포단계
※ 직전 패키지(2026-10-12h 고객별 추가 할인)가 아직 main 에 없음 — 이 패키지에 포함되어 있으니 이것만 올리면 됨.
백엔드 priceMasterRoutes.js Push → Railway Success → 프론트 refatrix-pricemaster.html Push → Ctrl+Shift+R → 탭 제목 build pm-1012cs3 (마이그레이션 없음)

## ③ 테스트방법
⑧ → 입력 판매단가 「IVA 포함」 → 단가 116 입력 시 IVA 제외 100 으로 계산되는지

## ④ 변경파일
| 파일 | 레포 경로 |
|---|---|
| priceMasterRoutes.js | refatrix-api/src/routes/priceMasterRoutes.js (12-10h 고객 검색 API 포함) |
| refatrix-pricemaster.html | refatrix-pricemaster.html (레포 루트) |

## ⑤ 검증결과
JS 문법 OK · jsdom + PostgreSQL: IVA 포함 230 → 198.28(할인율 60.3%), 매출 2,650.00 → IVA 포함 3,074.00(IVA 424.00), 추가 할인 309.00 → 고객 절감 358.44 수기 계산 일치

## ⑥ 결정사항
IVA 16% 고정(견적과 동일).

## ⑦ 오픈이슈 / ⑧ 다음액션
—
