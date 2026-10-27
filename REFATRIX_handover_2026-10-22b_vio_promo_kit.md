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

### 추가(같은 날) — 제품 찾기에서 키트 구성품 하위 줄
- 키트 행: 코드 옆 `🧰 KIT · 3종` · 재고 칸은 **세트 N**(지금 구성품 재고로 만들 수 있는 수)
- 바로 아래 구성품 줄(├ └): 코드 · **×1세트 수량** · 장착 위치 · List price · 상태 · 제품명 · 바코드 · **랙(랙별 수량 · FM · 위치 미지정)** · 소재 · **재고**(1세트 수량보다 적으면 빨강) · **Backorder · 입고 예정(수량 · ETA)** · List(×수량 금액) · (권한자) 평균원가 · 재고 평가액
- 서버: `GET /api/products` 가 키트 행에 `kit:{promo_no, buildable, items:[…]}` 를 붙임(가격·원가는 권한대로)
- 바뀐 파일: `refatrix-api/src/routes/productRoutes.js` · `refatrix-products.html` · 시험 `vio_promos.test.mjs` · `test/helpers/pos_e2e_server.mjs`
- 배포: 백엔드 `productRoutes.js` → Railway Success → 프론트 `refatrix-products.html` (마이그레이션 없음)

### 추가 — 제품 찾기 오른쪽 List Price 열 뺌
- 코드 옆에 List price 칸이 있어 누적판매 오른쪽 List Price 열은 없앰(디렉터 지시). 키트 구성품 줄은 코드 옆 칸에 `×2 = $672.00` 함께 표시. 화면 파일 `refatrix-products.html` 만.

### 추가(같은 날) — 제품 찾기 목록 정리(찌그러짐)
- 화면 폭 920px → **1320px**(가장 큰 원인 — 큰 화면에서도 920px 안에 12열을 넣고 있었음)
- 오른쪽 List Price 열 빼기(코드 옆 칸으로 대신) · **바코드 열 빼기** → 경쟁사(SyD)·OE 칸 아래 작은 회색 `▥ 750…`
- 코드 칸: 코드 한 줄 + 아래 배지 줄(장착 위치 · List price · KIT) · 열 제목 줄바꿈 없음 · 적용차종 40 → 70자
- 바뀐 파일: `refatrix-products.html` 만(배포 = 그 파일 Push)

### 추가(10-23 · vf17c) — 이미지에 프로모션 번호
- 저장(번호 받기 · 새 번호)하면 이미지에 **「Producto promoción: K0001」** 알약 표시 — A 왼쪽 위(머리글 위) · B 가운데 위
- 저장 뒤 수량·품목·할인을 바꾸면 번호를 잠시 뺌(다른 내용에 번호가 붙지 않게) → 다시 저장하면 들어감
- WhatsApp 문구 끝에도 `Producto promoción: K0001.`
- 바뀐 파일: `refatrix-viofinder.html`(build `vf17c`) · 시험 `viopromo_front.test.mjs`

### 추가(10-23 · vf17d) — 프로모션 삭제
- 📋 프로모션 목록 각 줄에 **🗑 삭제** — 키트 제품이 제품 카탈로그(제품 마스터)에 **아직 없을 때만** 보이고 동작(서버도 409로 막음)
- 만든 사람 또는 디렉터만 · 확인 창 후 삭제 · 구성품 줄도 같이 삭제 · 감사 기록
- **지운 번호는 다시 쓰지 않음**(K0003 지워도 다음은 K0004) — 이미 나간 이미지·WhatsApp 의 번호와 겹치지 않게
- 열려 있던 만들기 창의 프로모션이면 번호를 비움(이미지에서 번호 빠짐)
- 바뀐 파일: `refatrix-api/src/routes/vioPromoRoutes.js`(DELETE /api/vio-promos/:id) · `refatrix-viofinder.html`(build `vf17d`) · 시험 2개
- 배포: 백엔드 → Railway Success → 프론트 (마이그레이션 없음)

### 추가(10-23 · vf17f) — 키트 사진 자동 생성(R2) · 키트 등록 권한
**키트 사진**
- 「🧰 키트 제품 만들기」 하면 곧바로 구성품 사진(R2 `{코드}_1~12.webp` 중 처음 찾은 것)을 1200×1200 한 장으로 합쳐 **R2 `products/K0001/K0001_1.webp`** 에 저장 → 제품 찾기 📷 · 견적 · 카탈로그가 코드로 찾는 곳에 그대로 나옴
- 배치: 2 좌우 · 3 위1+아래2 · 4 2×2 · 5 3+2 · 6 3×3 … · 부품마다 코드 · 품명 · 수량 2 이상 `×2` · 위 「KIT K0001 · 차종 연식」 · 아래 CTR 정식 로고 · 「Producto promoción: K0001」 · OE 마크
- 목록 키트 칸에 썸네일 + 「🖼 사진 (다시) 만들기」. R2 키가 아직 없으면 **미리보기만** 만들고 안내(Railway 변수 이름 표시)
- 서버: `src/r2.js`(SDK 없이 AWS SigV4 — botocore 서명값과 같음 검증) · `GET /api/vio-promos/r2-status` · `POST /api/vio-promos/:id/kit-image`(키트 코드 K숫자 폴더만 · PNG/WebP/JPEG 내용 검사 · 5MB)
- 필요한 Railway 변수: `R2_ACCOUNT_ID` · `R2_ACCESS_KEY_ID` · `R2_SECRET_ACCESS_KEY` · `R2_BUCKET` (· `R2_PUBLIC_BASE` 선택)

**키트 등록 권한 (0294)**
- 관리 › 사용자·권한 사용자 줄에 **「🧰 키트 등록」** 칩(💲 판매가 옆) — 켜면 그 사람도 키트 제품 등록 · 키트 사진 만들기 가능(제품 화면 「수정」 권한 필요). 디렉터는 항상
- 마이그레이션 `0294_kit_create_permission.sql`(user_field_access 허용 키에 kit_create)
- 바뀐 파일: `migrations/0294_kit_create_permission.sql` · `src/r2.js`(신규) · `src/routes/vioPromoRoutes.js` · `refatrix-viofinder.html`(vf17f) · `refatrix-users.html` · 시험 `vio_promos` · `r2`(신규) · `viopromo_front` · `helpers/authGuardStub.mjs`(x-test-fields)
- 배포: 백엔드 → Railway Success → **`npm run migrate`(0294)** → 프론트 → 관리 › 사용자·권한에서 palomino 「🧰 키트 등록」 체크

### 추가(10-27 · vf17g) — 다시 열면 전에 작업하던 그대로 · 차량 사진 AI 고르기 · 후보 갤러리
**디자인 저장 (0301)**
- 저장한 프로모션(K번호)은 화면을 바꿀 때마다 1.5초 뒤 **서버에 자동 저장**: 템플릿 · 문구 · 할인/가격 표시 · 세대 · 차량 사진 출처 · 크기/좌우/위아래 · 가장자리 · **직접 가린 곳** · B 배경
- 내가 올린 차량 사진 · 누끼 딴 사진 · B 배경은 R2 `vio-promos/K0001/veh-….webp|png` · `bg-…` 에 저장(이름에 시각 → 캐시 문제 없음). 위키 사진은 주소만 저장
- 다시 열면(목록 「열기」 · 대기열에서 같은 차종) 서버 디자인을 먼저 불러 그대로 보여 줌 → 「저장한 디자인을 불러왔습니다 (K0001)」. 불러오는 동안은 저장하지 않음
- 저장 전(번호 없음) 차종도 이 브라우저에 **고른 사진 주소**를 기억(예전엔 후보 번호라 순서가 바뀌면 다른 사진이 나왔음)
- 만든 사람·디렉터만 저장(다른 사람 프로모션은 안내만). 「＋ 새 번호」로 저장하면 사진도 새 번호 폴더로 다시 올림
- 서버: `PUT /api/vio-promos/:id/design` · `POST /api/vio-promos/:id/asset` · 목록/한 건에 `design · veh_url · bg_url`

**차량 사진 후보 · AI**
- 후보: 위키백과(es·en) + **위키미디어 공용(Commons)** — 차종+연식, VIO 세대 코드(예: K13 · SL · NX4)로 찾음 · 실내/엔진/로고/세로 사진 제외 · 최대 20장 · 「후보 더 찾기」
- ④ 아래 **후보 갤러리**(썸네일) — 눌러서 바로 고름 · AI 점수 배지
- **🤖 AI로 맞는 사진 찾기**: 후보 12장(작은 썸네일)을 AI 가 보고 「이 모델·이 세대 · 차 전체 · 3/4 앞이나 옆 · 깔끔한 배경」 기준 0~100점 → 점수 순 정렬 + 가장 맞는 사진 선택. 처음 여는 차종은 자동으로 한 번(결과는 이 브라우저에 기억). 저장한 사진이 있으면 자동 선택은 안 함
- 서버: `POST /api/promo-img/rank`(허용 호스트 사진만 · 요청 20MB 안 · 결과 캐시) — **`ANTHROPIC_API_KEY` 필요**(없으면 버튼이 안내만, 갤러리에서 직접 고르기)
- 바뀐 파일: `migrations/0301_vio_promo_design.sql` · `src/routes/vioPromoRoutes.js` · `src/routes/promoImgRoutes.js` · `refatrix-viofinder.html`(vf17g) · 시험 `vio_promos` · `promo_img` · `viopromo_front`
- 배포: 백엔드 → Railway Success → **migrate(0301)** (`/mise/installs/node/18.20.8/bin/node scripts/migrate.js`) → 프론트

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
