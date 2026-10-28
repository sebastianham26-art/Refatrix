# REFATRIX 인계 · 2026-10-28d — 키트 묶음 포장지시 + Orden de surtido 하단 잘림 수정

## ① 설명
키트(K0001…)로 구성된 오더를 창고가 **키트 단위로 알아보고 포장**하도록, 견적 줄에 키트 번호를 남기고 포장 화면·출력물에 묶어 보여준다.
키트는 **키트 번호 기준**으로 정리한다(차종 이름으로 묶지 않음 — 디렉터 지시 2026-10-28). 순서도 키트 번호 순(K0009 → K0012 → K0016).

- **견적 줄 `quote_lines.kit_no`** (마이그레이션 0306): 키트가 구성 부품 줄로 풀릴 때 각 줄에 키트 번호를 저장. 화면 견적 저장·견적목록 편집·복제·CRM 수신·리드포털 — 저장 경로 다섯 곳 모두(공통 `stampLineMeta`).
  재고·금액·예약은 지금처럼 부품 줄 그대로 — kit_no 는 표시용 라벨.
- **창고 › 포장지시(refatrix-warehouse.html)**: 품목표를 `🧰 KIT K0009 · 1세트 · 4 SKU 5개 · 진행 0/5` 머리줄 → 구성품(보라색 왼쪽 띠) → 「단품」 순으로. 머리줄에 「한 봉투에 함께 담고 같은 박스에 — 봉투에 KIT 번호 표시」.
  진행바 아래 키트별 진행 칩, 박스 카드의 부품에 KIT 태그, 스캔 안내 `✓ CR0490 · 🧰 KIT K0009 → Box 1`. 창고 계정(스페인어)은 스페인어 문구.
  경고: 구성 수량이 키트와 다르면 「구성 수량이 키트와 다릅니다」, 재고 부족으로 구성품이 빠졌으면 「빠진 구성품이 있습니다」.
- **ORDEN DE SURTIDO Y EMPAQUE(견적목록 출력)**: 1장 위에 「Kits en este pedido」 표(키트 번호 · 세트 수 · 구성), 줄마다 `KIT K0009` 표시. 피킹 순서(랙 경로)는 그대로.
- **Lista de empaque(출고 출력)**: 「Kits incluidos」 표 + 박스 안에서 KIT 머리줄 → 구성품 → 「Piezas sueltas」.
- **창고 도면 피킹 목록**: 부품 옆 KIT 태그.
- **하단 잘림 수정(Orden de surtido)**: 원인 = 한 장 18줄 고정 + 인쇄 때 장 높이를 풀어(`min-height:auto`) 품명 줄바꿈·「Existencia por rack」 줄이 많은 장은 서명란이 다음 쪽으로 밀리거나 잘림.
  수정 = 장 높이 고정(A4) + 줄 높이 어림으로 1차 분할 + **출력 창에서 실제 높이를 재서** 넘치는 줄은 다음 장으로, 남는 자리는 다음 장 줄로 채움(장 수 최소). 장마다 머리·서명란·「Página n de N」 온전.
- 덤(같은 SKU 가 두 키트에 들어간 경우): 포장 목록·스캔·포장완료 판정이 SKU 합계 기준으로(예전엔 첫 줄 수량만 봐서 「초과」로 막힐 수 있었음).

## ② 배포단계
1. **백엔드 먼저** — zip 의 `refatrix-api/` 를 로컬 repo 에 덮어쓰기 → GitHub Desktop Fetch/Pull → Commit/Push → Railway **Success** 확인
2. Railway 콘솔 **`npm run migrate`** → `apply 0306_quote_line_kit_no.sql` 확인
   (0306 은 Q-2026-0339 의 빈 줄에 키트 번호를 한 번 채운다: K0009 · K0012 · K0016)
3. **화면** — `refatrix-warehouse.html`, `refatrix-quotelist.html`, `refatrix-whmap.html` repo 최상위 덮어쓰기 → Commit/Push → 1~2분 → **Ctrl+Shift+R**
4. 탭 제목으로 확인: 창고 포장 `build 1028kit` · 견적 목록 `ql-1028kit` · 창고 도면 `wm-1028kit`

> 화면을 먼저 올려도 깨지지 않는다(키트 정보가 없으면 예전 표 그대로). 마이그레이션 전 서버도 kit_no 없이 그대로 동작.

## ③ 테스트방법
1. 창고 › 포장지시 › **Q-2026-0339** → 보라색 머리줄 3개(KIT K0009 · K0012 · K0016) → 「단품 · 11 SKU 56개」 확인
2. 견적목록 › Q-2026-0339 › 매출 전환 창 › **포장작업지시서 재출력** → 1장 위 「Kits en este pedido (3)」, 줄마다 KIT 표시, 2장 모두 아래 서명란·「Página n de 2」 확인
3. 새 견적에 키트 코드(K0009 등) 입력 → 저장 → 견적 상세 줄에 🧰 K0009 배지
4. 포장에서 키트 부품 스캔 → 안내에 「🧰 KIT K0009」, 박스 카드에 KIT 태그

## ④ 변경파일
| 저장소 경로 | 구분 |
|---|---|
| `refatrix-api/migrations/0306_quote_line_kit_no.sql` | 신규 — `quote_lines.kit_no` + Q-2026-0339 백필 |
| `refatrix-api/src/vioPromos.js` | 키트 번호·세트 수·키트 요약·저장 함수 추가 |
| `refatrix-api/src/quoteBuild.js` | `buildLines` 가 kit_no 를 줄에 실음, `stampLineMeta` 가 kit_no 도 저장 |
| `refatrix-api/src/routes/quoteRoutes.js` | 복제 시 kit_no 유지, convert-preview 에 `kit_no` · `kits` |
| `refatrix-api/src/routes/warehouseRoutes.js` | 포장지시·출고 출력에 `kit_no` · `kits`, 같은 SKU 합산(스캔·추가·출고대기) |
| `refatrix-api/src/packedGate.js` | 포장완료 판정 SKU 합산 |
| `refatrix-api/test/kit_packing_e2e.test.mjs` | 신규 — 실 PostgreSQL 11건 |
| `refatrix-api/test/kit_packing_front.test.mjs` | 신규 — 화면 7건(jsdom) |
| `refatrix-api/test/warehouse_pickmap_front.test.mjs` | 빌드 토큰 갱신 |
| `refatrix-api/test/quote_wa_front.test.mjs` | 빌드 토큰 갱신 |
| `refatrix-warehouse.html` (repo 최상위) | 포장지시 키트 묶음 · Lista de empaque · build 1028kit |
| `refatrix-quotelist.html` (repo 최상위) | Orden de surtido 키트 표·KIT 표시·하단 잘림 수정 · 편집 시 kit_no 유지 · ql-1028kit |
| `refatrix-whmap.html` (repo 최상위) | 피킹 목록 KIT 태그 · wm-1028kit |

## ⑤ 검증결과
- ESM 문법 `node --check` 5개 파일 · 화면 인라인 스크립트 11블록 통과
- pglast: 0306 + 새 쿼리 7개 파싱 통과
- **실 PostgreSQL 16**(빈 DB에 0001~0306 전체 마이그레이션): `kit_packing_e2e` **11/11** — 저장·편집(PUT)·복제·convert-preview·포장지시·출고 출력·재고부족 partial·0306 백필(두 번 실행해도 같음)·두 키트 공유 SKU 스캔(ok, ok, 초과)
- jsdom: `kit_packing_front` **7/7** — 머리줄 순서(키트 번호 순, 차종 이름 없음)·스페인어·키트 없는 오더 무변화·Lista de empaque·Orden 분할/밀기/채우기
- **Chromium 실제 인쇄(A4 PDF)**: Q-2026-0339 데이터 19줄 → 2장(12 + 7), 두 장 모두 서명란·쪽번호 있음, 넘침 0
- 관련 기존 시험 재실행: 포장·랙·피킹·도면·견적목록·예약·CRM 수신 등 14개 묶음 통과.
  `packing_rack_sql`(4)·`quote_devreq_on_save`(1)·`vio_promos`(1)·`tablesort_front`(2) 실패는 **변경 전 코드에서도 똑같이 실패**(시험 환경 문제, 이번 변경과 무관)

## ⑥ 결정사항
- 키트는 **키트 번호 기준**으로 묶고 정렬한다 — 차종 이름으로 묶지 않음(디렉터 2026-10-28)
- Orden de surtido 의 줄 순서는 **랙 경로 그대로**(피킹 동선 유지), 키트는 줄 표시 + 1장 키트 표로 알린다. 묶어서 담는 일은 창고 화면이 키트 단위로 안내
- Q-2026-0339 의 CQ0166L/R 은 같은 구성의 Sportage 키트가 K0014 · K0016 두 개라 **K0016** 으로 채움

## ⑦ 오픈이슈
- VIO 프로모션 목록에 같은 구성 키트 중복(K0014 · K0016 Sportage) — 하나를 정리할지 결정 필요
- 0306 이전에 저장된 다른 키트 견적은 키트 번호가 없다(Q-2026-0339 만 백필) — 필요한 견적 번호를 알려 주면 같은 방식으로 채운다

## ⑧ 다음액션
- 배포 후 Q-2026-0339 포장작업지시서 재출력 → 창고에서 실제 출력물 확인
- 창고 박스 라벨(Etiquetas)에도 KIT 표시가 필요한지 확인
