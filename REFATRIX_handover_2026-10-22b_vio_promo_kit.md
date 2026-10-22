# REFATRIX 인수인계 — VIO 프로모션: 부품별 수량 · 합계/할인 금액 · K번호 · 키트 제품 · 견적 주문 (2026-10-22)

**마이그레이션 0293** · 새 라우트 `/api/vio-promos/*` · 견적 조립(quoteBuild) 키트 풀기 · 화면 `refatrix-viofinder.html` build `vf17b` + `refatrix-quote.html` · 기준 커밋 `5632e2d`(origin/main)

## ① 설명

디렉터 요청(2026-10-22): 프로모션 만들기에서 부품별 수량 입력 → 총 합계 · 할인율에 따른 금액 → 디자인에 넣을지 묻기 → 프로모션 번호 자동 연번 · 목록 → 그 프로모션으로 제품(키트)을 만들고 주문까지.

디렉터 결정
- 범위: 주문까지 한 번에
- 번호: **K + 4자리 전체 연번**(K0001, K0002 … 연도 없음)
- 키트 재고: **구성 부품으로 풀기** — 키트 자체 재고 없음. 견적·주문에 키트를 넣으면 부품 줄로 풀려 각 부품 재고가 예약·출고
- 키트 List price: **정가 합계**(부품 정가 × 수량). 할인은 견적에서 고객 할인율로
- 키트 이름: `KIT T {모델} {연식}_{코드}_{코드}…` (예 `KIT T SPORTAGE 2016-2022_CE0342L_CE0342R_CR0297`, 수량 2 이상은 `CR0297x2`). 등록 전에 고칠 수 있음

**프로모션 만들기 창 › ①**
- 코드마다 **수량 칸**(기본 1, 넣은 코드만 입력 가능). 이미지 카드에 `CQ0280 L/R ×2`처럼 표시(L/R 수량이 같을 때)
- ① 아래 **합계 칸**: 구성(코드 수 · 개수) · 정가 합계 · 할인 %(할인 배지와 같은 값) · 할인 금액 · **할인 적용 금액** · IVA 별도
- **「이 금액을 이미지(디자인)에 넣을까요?」 넣기 / 넣지 않음** — 넣기면 A는 오른쪽 아래, B는 왼쪽 아래에 상자(KIT 번호 · pzas · 정가 취소선 · −% · 할인 금액 · + IVA)
- **💾 저장(번호 받기)** → K번호. 바꾸면 「바뀐 내용 있음 · 💾 다시 저장」, 「＋ 새 번호」로 한 번 더. 키트 제품을 만든 프로모션은 고칠 수 없고 새 번호로 저장
- 이미지 뱅크에 저장하면 메모에 `promo:K0001`, 프로모션에 이미지 번호 연결
- 금액은 판매가 권한(💲 판매가)이 있는 사람에게만(없으면 수량·번호만)

**📋 프로모션 목록 (K번호) 탭** — 번호 · 차종·연식 · 구성(코드×수량) · 정가 합계 · 할인 · 할인 적용 · **세트**(지금 재고로 만들 수 있는 키트 수) · 키트 제품 · 작성자. 「열기」 = 그 구성·수량·할인·연식으로 만들기 창. 디렉터는 **🧰 키트 제품 만들기**(이름 확인·수정 → 제품 마스터 등록).

**견적(주문)** — 견적 화면에서 `K0001`을 입력(자동완성에 🧰 KIT 배지)하면 구성 부품 줄로 바뀌고 줄마다 🧰 K0001 표시. 수량 2 → 각 부품 수량 × 2. 고객 할인율·재고 예약·부족분·매출 전환은 일반 부품 줄과 같음. 엑셀 업로드·CRM(웹) 수신 견적도 같은 조립기라 같이 풀림. 외부 카탈로그 API에는 키트 코드(K숫자)를 내보내지 않음.

## ② 배포 순서

1. zip을 repo 루트에 풀기 → GitHub Desktop **Fetch/Pull**
2. **백엔드 먼저**: `refatrix-api/migrations/0293_vio_promos.sql` · `src/vioPromos.js` · `src/routes/vioPromoRoutes.js` · `src/server.js` · `src/quoteBuild.js` · `src/routes/quoteRoutes.js` · `src/catalogPull.js` → Commit → Push → Railway **Success**
3. **`npm run migrate`** (0293) — 마이그레이션 전에도 견적은 그대로 동작(키트 기능만 쉼)
4. 프론트: `refatrix-viofinder.html` · `refatrix-quote.html` · (아직이면) `refatrix-products.html` → Ctrl+Shift+R, 탭 제목 `vf17b`

## ③ 테스트방법

1. VIO 프로모션 › Sportage → ① 수량 바꾸기 → 합계 · 할인 금액 확인 → 「넣기」 → 이미지에 상자
2. 💾 저장 → K0001 → 📋 프로모션 목록에 보이는지
3. (디렉터) 🧰 키트 제품 만들기 → 제품 찾기에서 K0001 · 이름 · List price(정가 합계)
4. 견적 화면에서 고객 고르고 K0001 수량 2 → 부품 줄 3개(각 ×2) · 🧰 K0001 · 할인율 · 재고 확인 → 저장
5. 견적 목록에서 그 견적이 부품 줄로 저장됐는지

## ④ 변경파일

| repo 경로 | 변경 |
|---|---|
| `refatrix-api/migrations/0293_vio_promos.sql` | **신규** — `vio_promo_no_seq` · `vio_promos` · `vio_promo_items` |
| `refatrix-api/src/vioPromos.js` | **신규** — 번호 · 금액 · 키트 이름 · 세트 수 · `expandKitLines`(키트 → 부품 줄) |
| `refatrix-api/src/routes/vioPromoRoutes.js` | **신규** — 목록 · 한 건 · 저장 · 고치기 · 키트 제품 만들기(디렉터) |
| `refatrix-api/src/server.js` | import + register 두 줄 |
| `refatrix-api/src/quoteBuild.js` | `buildLines` 시작에서 키트 풀기(화면 저장·복제·수정·CRM 수신 공통) |
| `refatrix-api/src/routes/quoteRoutes.js` | 미리보기 키트 풀기 + `input_lines` · 자동완성/코드 해석에 `kit` |
| `refatrix-api/src/catalogPull.js` | 외부 카탈로그에서 `K숫자` 코드 제외 |
| `refatrix-viofinder.html` (루트) | build `vf17b` · 수량 · 합계 칸 · 이미지 상자 · 저장 · 📋 목록 탭 · 키트 만들기 |
| `refatrix-quote.html` (루트) | 키트 풀린 줄로 목록 교체 · 🧰 표시 · 자동완성 배지 |
| `refatrix-products.html` (루트) | (앞 커밋) 목록 코드 옆 List price |
| `refatrix-api/test/vio_promos.test.mjs` | **신규** 3건(실 PG) |
| `refatrix-api/test/vio_kit_quote_front.test.mjs` | **신규** 1건(jsdom) |
| `refatrix-api/test/viopromo_front.test.mjs` | +1건 (13건) |

## ⑤ 검증결과

- `vio_promos` **3/3**(실 PostgreSQL 16): 번호 연번 · 금액 · 이름 규칙 · 코드 중복 합침 · 없는 코드 거절 · 판매가 권한 없으면 금액 숨김 · 남의 것 수정 403 · 키트 제품(디렉터만 · 정가 합계 · 두 번 409 · 그 뒤 품목 잠김) · `expandKitLines`(코드/ID) · `buildLines` 부품 줄·고객 할인 · 미리보기 `input_lines` · 자동완성/코드 해석 `kit`
- `viopromo_front` **13/13** · `vio_kit_quote_front` **1/1** (jsdom)
- 헤드리스 Chromium 전체 흐름 FAILS 0 — 수량 ×2 · 합계 상자 A/B 이미지 확인 · 저장 K번호
- 회귀(같은 결과): catalog_pull 21 · crm_inbound 23 · crm_quote_inbound 19 · quote_customer_po_crm 3 · quote_devreq_on_save 1 · quote_pricelist_qty_e2e 1 · quote_revalidate_sql/front · quote_wa_front · quote_summary_front 20 · quote_customer_po_sql 3. 원래 main 에서도 실패하던 것 그대로: quote_devreq_front(1건) · quote_region_excel · quote_customer_po_front(시간 초과)
- 전체 앱 `buildApp()` 기동 + `/api/vio-promos` 등록(미인증 401)

## ⑥ 결정사항

- 키트는 제품 마스터의 한 줄(코드 = K번호)이지만 재고는 0 그대로 — 재고·예약은 부품 줄에서
- 키트 List price는 만든 시점의 정가 합계로 고정. 견적 금액은 부품 정가 × 고객 할인율이라, 부품 정가가 바뀌면 그쪽을 따름
- 프로모션 저장은 제품 화면 「수정」 권한, 키트 제품 등록은 디렉터만(제품 신규 등록과 같은 규칙)

## ⑦ 오픈이슈

- 키트 List price는 부품 정가가 바뀌어도 자동으로 다시 계산되지 않음(제품 화면에서 손으로)
- 프로모션 할인율은 이미지·목록 금액용. 견적에는 고객 할인율이 적용됨 — 프로모션 할인을 견적에 강제로 넣으려면 다음 단계에서 결정
- 재고 화면·실사 목록에 키트 코드가 재고 0으로 보일 수 있음

## ⑧ 다음액션

1. 배포 후 Sportage로 K0001 만들어 키트 등록 → 시험 견적
2. 프로모션 할인을 견적에 자동 적용할지 결정
