# REFATRIX 인수인계 — 2026-11-23 · 가격표 엑셀 다운로드 · FOB MXN · Total Cost MXN

빌드: `pm-1123fc` (탭 제목) · 마이그레이션 **없음**

## ① 설명
제품마케팅 › 가격 마스터 › ① 가격표
1. **📥 엑셀 다운로드** — 기존 「엑셀 내보내기」 버튼을 눈에 띄는 기본 버튼으로 바꾸고 이름을 「엑셀 다운로드」로 변경. 지금 검색·원산지·보기·비활성 조건 그대로 **전체 행**(최대 20,000)을 받습니다. 새 열 포함 13열.
2. **FOB MXN (오늘)** — FOB(USD) 바로 옆. `FOB USD × 최신 등록 환율(fx_rates USD→MXN 최근일)`. 환율 일자는 KPI 「환율 USD→MXN」과 엑셀 머리글 `FOB MXN (TC 18.3500 · 2026-11-23)`에 표시.
3. **Total Cost MXN** — 그동안 실적(승인된 수입 배치) 기준 1개당 원가.
   - 식: `Σ(수입수량 × 입고단가 MXN) ÷ Σ수입수량` — **평균원가원칙(단순가중평균)**
   - 입고단가 = FOB × 당시 환율 + 운임·통관·관세 등 부대비용 배분액(수입원가 배치에서 계산된 `import_lines.unit_cost_mxn`)
   - 대상 배치 = 입고 승인 때 제품 평균원가를 다시 계산하는 식(`flatAvgCost.js`의 `APPLIED_BATCH_COND`)과 **완전히 같은 조건**: 삭제·원가제외·대기·반려 배치와 입고단가 미계산 줄은 제외
   - 원가가 바뀐 새 배치가 승인되면 다음 조회부터 자동으로 평균에 섞임 (예: 100개@200 + 50개@260 = 220 → 50개@300 추가 → 240)
   - 수입 기록이 없는 제품은 저장된 평균원가(`products.avg_cost > 0`)로 대신하고 `*` 표시, 둘 다 없으면 `—`
   - 셀에 마우스를 올리면 근거 표시: 「승인된 수입 2회 · 누적 150개 가중평균」
4. 두 열 모두 제목을 눌러 **전체 기준 정렬** 가능 (서버 정렬).

## ② 배포단계
1. GitHub Desktop → **Fetch / Pull** 먼저
2. **백엔드**: `REFATRIX_2026-11-23_pricetable_cost_BACKEND.zip` 풀어서 덮어쓰기 → Push → Railway **Success** 확인
3. `npm run migrate` — 이번엔 새 마이그레이션 없음(생략 가능)
4. **프런트**: `REFATRIX_2026-11-23_pricetable_cost_FRONTEND.zip` → 저장소 루트에 `refatrix-pricemaster.html` 덮어쓰기 → Push
5. 브라우저 `Ctrl+Shift+R` → 탭 제목에 `pm-1123fc` 확인
   - 프런트만 먼저 올라가면 새 두 열이 `—` 로만 보입니다(오류 없음). 순서대로 올리면 됩니다.

## ③ 테스트방법
1. 가격 마스터 › ① 가격표 — FOB (USD) 옆에 **FOB MXN (오늘)**, **Total Cost MXN** 열이 보이는지
2. 수입 실적이 있는 코드 하나: Total Cost 셀에 마우스 → 「승인된 수입 N회」. 구매 › 수입원가 배치 화면의 평균원가와 같은 값인지
3. **Total Cost MXN** 제목 클릭 → 비싼 순/싼 순 정렬
4. **📥 엑셀 다운로드** → `Refatrix_precios_YYYY-MM-DD.xlsx` · 열: Clave CTR · Producto · Origen · FOB USD · FOB MXN (TC…) · Total Cost MXN · Base costo · Importaciones · List Price MXN · Multiplo · SYD List · CTR/SYD · Ultimo cambio
5. 받은 파일에서 List 하나만 고쳐 「FOB·List 엑셀 올리기」 → 미리보기에 그 List 1건만 변경(FOB MXN 열이 FOB 로 잘못 읽히지 않음)

## ④ 변경파일
| 저장소 경로 | 배포 | 내용 |
|---|---|---|
| `refatrix-api/src/routes/priceMasterRoutes.js` | Railway | `/api/price-master/table` 에 `fob_mxn` · `total_cost_mxn` · `cost_basis` · `cost_batches` · `cost_qty`, 정렬키 `fobmxn`·`cost` |
| `refatrix-pricemaster.html` (루트) | GitHub Pages | 두 열 · 📥 엑셀 다운로드(13열) · 올리기 머리글 인식(`FOB MXN` 제외) · 빌드 `pm-1123fc` |
| `refatrix-api/test/price_table_cost_pg.test.mjs` | 테스트 | 실 PostgreSQL 종단 6건 |
| `refatrix-api/test/pricemaster_table_cost_ui.test.mjs` | 테스트 | jsdom 화면 7건 |

## ⑤ 검증결과
- `node --input-type=module --check` priceMasterRoutes.js · 화면 스크립트 `node --check` — OK
- **실 PostgreSQL 16** (migrations/*.sql 전부 적용한 DB 복제) + 실제 `priceMasterRoutes` + Fastify inject — **6/6 통과**
  - FOB MXN = 10 × 18.35 = 183.50 · 환율 없으면 null
  - 가중평균 220, 수입 2회·150개 · 삭제/반려/대기/원가제외 배치 · 입고단가 없는 줄 제외 · `flatAvgCost()` 결과와 일치
  - 수입 없음 → 저장 평균원가(150.456 → 150.46, stored) · 모두 없음 → null
  - 정렬 cost asc/desc · offset/limit · `view=mult_lt`(환율 파라미터) + LATERAL 동시 사용
  - 새 배치 승인 후 240 으로 변동
- **jsdom** — 7/7 통과: 머리글 순서 11열 · 값/툴팁/`*` · sort=cost 재조회 · 엑셀 13열·파일명·값 · 다시 올리기 머리글 인식
- 기존 `price_master_pg.test.mjs` 는 이번 변경과 무관하게 테스트용 인증 스텁이 현재 `authGuard`와 맞지 않아(401) 돌지 않음 — 오픈이슈 참조

## ⑥ 결정사항
- Total Cost MXN 의 「평균원가원칙」 = 시스템 기본 원가 방식인 **단순가중평균**(입고 승인 시 평균원가 재계산과 같은 식). 판매 타이밍과 무관
- 값은 **화면을 열 때마다 수입 실적에서 계산**(저장값 아님) — 배치 삭제·원가제외도 즉시 반영
- 원가 열은 이 화면의 다른 원가 정보(⑦ 제품 수익성 · ⑧ 매출원가 분석)와 같은 권한: **가격 마스터 화면 권한이 있는 사람**에게 보임
- 엑셀 머리글은 기존처럼 스페인어

## ⑦ 오픈이슈
- 「오늘 환율」= fx_rates 에 등록된 **가장 최근 환율**. 오늘 환율이 아직 없으면 직전 일자 환율을 씀(KPI·엑셀 머리글에 일자 표시)
- 원가 열을 디렉터·소시오만 보게 제한하려면 말씀 주세요 (`canSeeCost` 적용 — 5분 작업)
- `test/price_master_pg.test.mjs` 의 인증 스텁 정비 필요(기존 문제)

## ⑧ 다음액션
1. 백엔드 → 프런트 순서로 Push, `pm-1123fc` 확인
2. 엑셀 다운로드 파일로 Total Cost 와 List 를 비교해 마진 점검
