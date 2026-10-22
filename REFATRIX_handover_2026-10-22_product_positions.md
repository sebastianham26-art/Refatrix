# REFATRIX 인수인계 — 제품 장착 위치(앞/뒤 · 상/하 · 좌/우) (2026-10-22)

**마이그레이션 0292** · 새 라우트 `/api/products/positions/*` · 화면 `refatrix-products.html`(업로드 · 목록 배지 · 상세) + `refatrix-viofinder.html` build `vf16z`(프로모션 부품 목록 배지) · 기준 커밋 `0b4ce51`(origin/main)

## ① 설명

디렉터 요청: 부품의 장착 위치를 앞/뒤 · 좌/우로 구분. 원본(REFATRIX Platform Export 4th)을 **제품 마스터 업로드** 화면에서 올리고, 그 정보를 다음 세 곳에서 본다:
- **제품 찾기 목록**: 코드 옆 작은 배지 (예 `앞·하·좌`). 파랑 = 앞, 주황 = 뒤, 보라 = 앞/뒤 둘 다
- **제품 상세(행 펼침)**: 「장착 위치」 칸. 위치별로 묶고 차종 칩(브랜드 · 모델 · 세대 · 연식)을 보여 줌. 점선 칩 = Candidate(확정 전), ↔ = 코드 끝 L/R 로 좌우를 정한 줄
- **VIO 프로모션 만들기 › ① 넣을 품목**: 코드 옆 배지. **이 차종 + 고른 VIO 세대** 줄이 있으면 그것(실선), 없으면 코드 전체 요약(점선), 자료 없으면 `—`

**원본 읽기 규칙** (디렉터 지정: H열 Block · J열 Position)
- 코드: W열 `CTR` + AI열 `4th CTR`(`X` = 없음). 한 칸에 코드가 여러 개(` // `)면 모두
- 앞/뒤: Position 이 Front/Rear 로 시작하면 그것, 아니면 Block. 상/하: Upper/Lower. 좌/우: LH/RH
- **L/R 짝 코드는 코드 끝 L/R 가 좌우를 정한다** — 원본이 `CQ0166L // CQ0166R` 를 「Front Lower LH」 한 줄에 같이 적은 경우 R 코드는 RH 로 저장(369줄)
- 같은 코드라도 차종마다 위치가 다를 수 있어 **코드 × 차종**마다 저장. 배지는 그 합(예 `뒤·좌/우`)
- 업로드는 **전체 교체**(미리보기 → 「반영하기」). 제품 마스터(이름 · 가격 · 재고)는 바뀌지 않음. 마스터에 아직 없는 코드도 저장해 두고, 나중에 제품이 등록되면 바로 보임

## ② 배포 순서

1. zip 을 repo 루트에 풀기 → GitHub Desktop **Fetch/Pull**
2. **백엔드 먼저**: `migrations/0292_product_positions.sql` · `src/productPositions.js` · `src/routes/positionRoutes.js` · `src/server.js` Commit → Push → Railway **Success**
3. **`npm run migrate`** (0292)
4. 프론트: `refatrix-products.html` · `refatrix-viofinder.html` Push → Ctrl+Shift+R (VIO 화면 탭 제목 `vf16z`)
5. 제품·마케팅 › 제품 찾기 › **제품 마스터 업로드** › 🧭 장착 위치 원본 업로드 → 원본 xlsx 고르기 → 미리보기 확인 → 「반영하기(전체 교체)」

## ③ 테스트방법

1. 업로드 미리보기에 코드 약 2,560개 · 위치 줄 약 14,790 · L/R 접미사로 좌우 정함 369 가 나오는지 → 반영
2. 제품 찾기에서 `CQ0166` 검색 → CQ0166L `앞·하·좌` · CQ0166R `앞·하·우` 배지
3. CQ0166L 행을 펼쳐 「장착 위치」에 KIA Sportage 3세대(SL) 2011-2016 칩이 있는지
4. VIO 프로모션 › Sportage 열기 → ① 넣을 품목 코드 옆 배지 · 세대 칩을 바꾸면 배지가 그 세대 기준으로 바뀌는지

## ④ 변경파일

| repo 경로 | 변경 |
|---|---|
| `refatrix-api/migrations/0292_product_positions.sql` | **신규** — `product_position_batches`(업로드 기록) · `product_positions`(코드 × 차종 × 위치) |
| `refatrix-api/src/productPositions.js` | **신규** — 원본 읽기 · 머리글 찾기 · L/R 짝 처리 · 요약(순수 함수) |
| `refatrix-api/src/routes/positionRoutes.js` | **신규** — `POST preview`·`commit`(디렉터, 20MB) · `POST lookup`(권한 `products`) · `GET status` |
| `refatrix-api/src/server.js` | import + `app.register(positionRoutes)` 두 줄 |
| `refatrix-products.html` (루트) | 업로드 칸 · 목록 배지 · 상세 「장착 위치」 |
| `refatrix-viofinder.html` (루트) | build `vf16z` · 프로모션 부품 목록 배지 |
| `refatrix-api/test/product_positions.test.mjs` | **신규** 5건 |
| `refatrix-api/test/viopromo_front.test.mjs` | 배지 시험 +1 (12건) |
| `refatrix-api/test/helpers/pos_e2e_server.mjs` | **신규** — 브라우저 시험용 서버(운영 미사용) |

## ⑤ 검증결과

- `product_positions` **5/5** (실 PostgreSQL 16) — 읽기 규칙(영 · 스페인어 · 한국어) · 코드 나누기 · L/R 짝 · 중복 제거 · 미리보기는 저장 안 함 · 디렉터만 · 전체 교체 · 조회 요약/내역 · **실제 원본 파일**: 14,790줄 · 2,560코드, 반영 약 0.5초 · 본문 2MB
- `viopromo_front` **12/12** (jsdom) — 이 차종·세대 줄 우선 · 코드 전체(점선) · 자료 없음 `—`
- **헤드리스 Chromium 실제 화면**(실 PG 서버 + 실제 xlsx 업로드) 7/7 — 업로드 현황 → 미리보기 → 반영 → 현황 갱신 → 목록 배지 4개 → 상세 Sportage 칩 · 페이지 오류 0

## ⑥ 결정사항

- 위치는 제품 마스터 열이 아니라 별도 표(코드 × 차종). 같은 코드라도 차종마다 다를 수 있어서
- L/R 짝 코드는 원본 좌우보다 코드 접미사를 믿음(↔ 표시로 남김)
- 앞/뒤를 알 수 없는 줄은 버림(이번 원본에는 0줄)

## ⑦ 오픈이슈

- 원본에 좌우가 없는 품목(예: CB0336 `앞·하`)은 배지에 좌/우가 안 나옴 — 원본 자료 그대로
- 프로모션 **이미지 안**에는 위치를 넣지 않음(목록에서 구분만). 필요하면 카드에 `Delantera Inferior Izq.` 같은 스페인어 표기를 붙일 수 있음

## ⑧ 다음액션

1. 배포 후 원본 업로드 → CQ0166 확인
2. 원본이 갱신되면 같은 칸에 다시 올리면 됨(전체 교체)
