# REFATRIX 인수인계 · 2026-11-27f · 견적에서 「차종으로 찾기」 → 도면에서 골라 담기 · build 견적 `qt-1127vm` · 제품 `ps-1127vq`

## ① 설명
- **견적 › 품목 입력** 위에 토글 `⌨ 코드로 입력 | 🚗 차종으로 찾기` 를 달았다.
  - 고객을 고르기 전에는 「차종으로 찾기」가 꺼져 있다. 할인율 · 재고 예약이 고객 기준이라서다.
  - 고객을 비우면 코드 입력으로 돌아간다.
- **차종으로 찾기**: 제품 화면과 **같은 차량 도면**이 열린다(메이커 · 모델 · 연식 → 마커 · 목록 · OE · 수량 아이콘).
  - 부품을 고르면 상세 카드에 「담을 코드 · 수량 · ＋ 견적에 담기」가 나온다. 목록 각 줄의 노란 **＋** 버튼은 1개씩 바로 담는다.
  - 담은 줄은 바로 아래 견적 표에 들어가 미리보기(할인 · 가용 · 상태)가 계산된다.
  - 같은 제품을 다시 담으면 그 줄 수량에 더한다.
  - 도면 목록에 「견적 N」 배지로 이미 담긴 수량이 보인다.
- **기록은 지금과 똑같다**(새 규칙 없음).
  - **CTR 부품** → `{코드, product_id, 수량}`. 창고가 모자라면 미리보기 · 저장에서 재고 부족으로 표시되고, 기존 흐름(전환 · 만료)대로 재고부족분이 기록된다. 창고 0 부품은 담기 전에 안내가 뜬다.
  - **CTR 없는 부품(경쟁사만)** → SYD 또는 BAW 코드를 골라 `{코드, 브랜드, 수량}`. 미매칭 줄로 들어가 견적 저장 시 **개발요청(입력 브랜드 포함)** 으로 기록된다.
  - **비활성 제품** → 기존 비활성 경고가 그대로 뜬다.
- **공용 모듈** `refatrix-vehiclemap.js`(신규 · 저장소 루트): 차량 도면을 한 파일로 뺐다. 제품 화면(보기)과 견적 화면(담기)이 같은 코드를 쓰므로 한 곳만 고치면 둘 다 바뀐다.
- **권한**: 차량 도면 · 차종 드롭다운 API 를 제품 화면뿐 아니라 견적(`quote` · `sales`) 화면 권한으로도 열 수 있게 했다. 영업사원이 제품 화면 권한 없이도 견적에서 쓸 수 있다.

## ② 배포단계
1. **백엔드 먼저**(Fetch/Pull): BACKEND zip → push → Railway **Success** — 마이그레이션 없음
2. **프론트**: FRONTEND zip 의 **3개 파일 모두** 저장소 루트에 → push → `Ctrl+Shift+R`
   - `refatrix-vehiclemap.js` (신규 — 빠지면 제품 화면 차종 찾기도 「모듈을 불러오지 못했습니다」가 뜬다)
   - `refatrix-products.html`
   - `refatrix-quote.html`
3. 탭 제목 확인: 견적 **`qt-1127vm`** · 제품 **`ps-1127vq`** (nav.js 변경 없음)

## ③ 테스트방법
1. 견적 → 고객 선택 전: 「🚗 차종으로 찾기」 회색(꺼짐)
2. 고객 선택 → 「차종으로 찾기」 → NISSAN · Versa · 연식 → 찾기 → 도면
3. 재고 있는 부품 → 수량 3 → 「＋ 견적에 담기」 → 아래 견적 표에 들어감 · 목록에 「견적 3」
4. 창고 0 부품 담기 → 안내 문구 · 견적 표 상태가 재고부족
5. 회색 점선(경쟁사만) 부품 → 코드(SYD/BAW) 고르기 → 담기 → 견적 저장 → 「Fuera de catálogo」 안내 · 개발요청 화면에 그 코드 · 브랜드
6. 제품 화면 › 차종으로 제품찾기가 예전과 똑같이 동작하는지(공용 모듈로 바뀜)
7. 영업사원(제품 화면 권한 없음) 계정으로 견적에서 차종 찾기가 열리는지

## ④ 변경파일
| 저장소 경로 | 구분 | 내용 |
|---|---|---|
| `refatrix-vehiclemap.js` (루트) | **신규** | 차량 도면 공용 모듈(보기 · 담기 모드 · 스타일 · 사진 창) |
| `refatrix-quote.html` (루트) | 수정 | 입력 방식 토글 · 차종 패널 · 담기 → 견적 줄 · 고객 연동 · build `qt-1127vm` |
| `refatrix-products.html` (루트) | 수정 | 도면 코드 → 공용 모듈 사용(동작 동일) · build `ps-1127vq` |
| `refatrix-api/src/routes/productRoutes.js` | 수정 | app-makers · app-models · app-years 권한: products · quote · sales |
| `refatrix-api/src/routes/vehicleMapRoutes.js` | 수정 | vehicle-map 권한 동일 · `is_active` 포함 |
| `refatrix-api/test/quote_vehicle_pick_front.test.mjs` | 신규 | 견적 담기 화면 시험 |
| `refatrix-api/test/vehicle_map_e2e.test.mjs` | 수정 | 견적 전용 사용자 권한 · ⑧ 담은 줄 그대로 저장 → 재고부족 · 개발요청 |
| `refatrix-api/test/vehicle_map_front.test.mjs` · `product_positions_ctr.test.mjs` | 수정 | 공용 모듈 로드 · build 토큰 |
| `refatrix-api/test/` 견적 화면 시험 6개(`product_dims_front` · `quote_avail_partial_front` · `quote_devreq_front` · `quote_kit_filter_front` · `quote_kit_lines_front` · `xref_cols_front`) | 수정 | build 토큰 `qt-1127vm` |

## ⑤ 검증결과
- `node --check`(모듈 · 두 화면 인라인 스크립트 · 라우트) · pglast 통과
- 견적 담기 jsdom **4/4**
  - 고객 전 꺼짐 · 고객을 비우면 복귀
  - CTR 담기 · 같은 제품 합산 · 배지 · 저장 본문
  - 창고 0 · 비활성 안내
  - 경쟁사 SYD/BAW 미매칭 줄 · 저장 본문
- 제품 화면 jsdom **12/12** · `product_positions_ctr` **2/2**(공용 모듈로 바꾼 뒤에도 같음)
- **실 PostgreSQL** E2E **9/9**
  - 견적 전용 사용자 200 · 권한 없으면 403
  - ⑧ 도면에서 담은 모양 그대로 미리보기 → 저장
    - CTR 20개(창고 12) → `stock_flag` 부족 표시
    - BAW 코드 → `not_found` · `product_dev_requests` 에 `BW-99 / BAW` 기록
- 기존 견적 화면 시험 16종 재실행
  - 실패 5종(`customer_registration` 1건 · `customer_reg_alert` 4건 · `quote_kit_lines_front` · `quote_kit_build_front` · `quote_kit_filter_front` · `quote_region_excel` · `xref_master_front` 2건)은 **변경 전 원본에서도 똑같이 실패**(이번 변경과 무관)
- Chromium 스크린샷: 견적 화면 토글(고객 전 · 후) · 도면 담기 카드 · 견적 표 반영
- 기준 커밋: live `main` fa7e9fd

## ⑥ 결정사항
- 담기는 고객 선택 후에만(할인율 · 예약 기준)
- 경쟁사만 부품은 SYD 코드를 먼저(없으면 BAW) — 상세 카드에서 다른 코드로 바꿀 수 있음
- 같은 제품을 다시 담으면 수량 합산(줄을 새로 만들지 않음)

## ⑦ 오픈이슈
- 키트(K…) 단위로 담는 기능은 아직 없다(부품 단위로 담김)
- 견적 화면의 가격(할인 적용가)은 담은 뒤 아래 표에서 보인다. 도면 카드에는 가격을 넣지 않았다(제품 화면과 같은 권한 정책 유지).

## ⑧ 다음액션
- 영업 현장 사용 후 「도면 카드에 고객 할인가 표시」 필요 여부 결정
- 차형별(픽업 · SUV) 도면 · 키트 담기 여부
