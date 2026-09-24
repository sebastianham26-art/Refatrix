# REFATRIX 인수인계 — 견적작성 「📚 전체 견적」 차종 지역 선택 (2026-09-24)

**빌드 토큰 `qt-0923oe` → `qt-0924rg`** · **프런트 1개 수정 + 테스트 1개 신규** · **백엔드·마이그레이션·nav.js 변경 없음**
**베이스**: 라이브 main의 `refatrix-quote.html`(qt-0923oe) — 작업 직후 라이브와 재대조, 변경 없음 확인.
**산출물 zip**: `refatrix_quote_region_v1.zip`

## ① 설명
영업>견적작성의 **📚 전체 견적**을 누르면 바로 다운로드하지 않고 **「차종 지역 선택」 창**이 뜬다.
- 체크박스 5개: **아시아차종**(일본·한국) · **유럽차종** · **미국차종**(GM·Ford·Chrysler 그룹) · **중국차종** · 적용차종 미표기(Sin aplicación). 기본값은 앞의 4개 선택.
- 창을 열면 전체 SKU를 한 번 불러와 **지역마다 SKU 수·행 수**를 옆에 보여준다(선택 바꿔도 다시 조회하지 않음).
- 방식 2가지:
  - **지역별 시트로 나누기(기본)** — 엑셀 아래 탭 `Asia · Europa · América · China · Sin aplicación`. 시트마다 할인율(G6)·Subtotal·IVA·Total이 따로 계산된다. 제목줄 `Catálogo CTR · Vehículos europeos …`.
  - **한 시트로 합치기** — 선택한 지역만 기존과 같은 VIO 순서로 1시트(`Selección`). 5개 전부 + 합치기 = 기존 전체 견적과 동일(`Completo`).
- 양식·열·수식·색(빨강 중복·파랑 대표·재고 음영)은 **기존 전체 견적 그대로**.
- 파일명: `cotizacion_completa_asia_europa_…_<고객>.xlsx` (전체 선택이면 기존 이름 그대로).

**판정 규칙** — 차종 그룹의 원래 브랜드(Aplicación 첫 단어)로 판정. 기존 VIO 차종명으로 이름이 바뀐 그룹도 원 브랜드 기준.
| 지역 | 브랜드 |
|---|---|
| 아시아 AS | Nissan, Toyota, Honda, Acura, Mazda, Mitsubishi, Hyundai, KIA, Suzuki, Subaru, Isuzu, Infiniti, Lexus |
| 유럽 EU | Volkswagen, Audi, SEAT, Cupra, BMW, Mini, Mercedes Benz, Smart, Renault, Peugeot, Fiat, Alfa Romeo, Volvo, Porsche, Jaguar, Land Rover |
| 미국 AM | Chevrolet/GMC, Buick, Cadillac, Pontiac, Oldsmobile, Saturn, Geo, **Saab(GM 그룹 라벨)**, Ford/Mercury, Lincoln, Dodge/Chrysler, Jeep, RAM, Plymouth, Eagle |
| 중국 CN | JAC, Chirey, **MG(SAIC)**, Omoda, Jaecoo, BYD, Geely, Changan, GWM/Great Wall, Haval, BAIC, Jetour, JMC, Foton, GAC, Dongfeng, Chery, SEV |

**여러 지역에 걸친 부품**(예: 닛산·VW 공용)은 해당 지역 시트 **모두에** 들어간다. 시트 안에서 중복(빨강)·대표(파랑)를 다시 매겨 **각 시트 Subtotal = 그 시트 고유 SKU 합**. 따라서 지역 시트 Subtotal을 더하면 전체 견적 Subtotal보다 클 수 있다(공용 부품이 여러 번 들어가므로 — 의도된 동작).

**부수 변경**: 차종 파서 브랜드 목록에 중국 브랜드 추가. 이전엔 `MG`·`OMODA` 등으로 시작하는 적용차종이 파싱되지 않아 Sin aplicación으로 빠졌는데, 이제 해당 차종 그룹으로 들어간다(Top 500·CTR vs SYD의 차종 라벨에도 같은 개선 적용).

## ② 배포단계 (프런트만)
1. zip의 `refatrix-quote.html`을 repo 최상위에, `refatrix-api/test/quote_region_excel.test.mjs`를 그 경로에 덮어쓰기.
2. GitHub Desktop **Fetch/Pull → Commit → Push** → Actions `pages build and deployment` Success.
3. 견적작성 화면 **Ctrl+Shift+R** → 탭 제목 끝 `qt-0924rg` 확인.
```bash
curl -s "https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main/refatrix-quote.html?nc=$(date +%s)" | grep -c "qt-0924rg"   # 1 이상
curl -s "https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main/refatrix-quote.html?nc=$(date +%s)" | grep -c "rgModal"     # 1 이상
```

## ③ 테스트방법
1. 📚 전체 견적 → 창이 뜨고 잠시 후 지역별 SKU/행 수가 채워지는지.
2. 기본(4개·지역별 시트) 다운로드 → 탭 4개, 각 시트 제목에 지역명, Europa 시트엔 VW/Audi/SEAT… 차종만.
3. China 시트 — JAC·Chirey·MG 차종 확인(베이스 기준 약 15 SKU).
4. 유럽+아시아만, 「한 시트로 합치기」 → `Selección` 1시트, 미국·중국 차종 없음, VIO순.
5. 전체 선택 + 합치기 → 기존과 동일(`Completo`, 파일명 `cotizacion_completa_<고객>`).
6. 고객 선택 시 할인율이 모든 시트 G6에 반영, 시트에서 수량 바꾸면 해당 시트 Subtotal만 변하는지.
7. 회귀: ⭐ Top 500은 창 없이 바로 다운로드 · 🆚 CTR vs SYD 정상.

## ④ 변경파일
| 파일 | repo 경로 | 구분 |
|---|---|---|
| `refatrix-quote.html` | 최상위 `refatrix-quote.html` | 수정 — 토큰 qt-0924rg · 모달 HTML/CSS · VEH에 REGION/G2B/regionOfGroup + 중국 브랜드 · `loadVioPlan`/`openRegionModal`/`subsetPlanRows`/`regionCounts`/`rgDownload` 신규 · `downloadVioQuote(all,opt)` 다중 시트화 · 시트 생성부 `vioSheet()`로 분리(내용 동일) |
| `quote_region_excel.test.mjs` | `refatrix-api/test/quote_region_excel.test.mjs` | 신규 — jsdom 6건 |
| 백엔드 / 마이그레이션 / nav.js | — | **없음** |

## ⑤ 검증결과
- `node --check` 인라인 스크립트 2블록 통과 · 함수 중복 정의 0.
- **jsdom 6/6** (실제 `xlsx-js-style@1.2.0`로 write→read 왕복): 모달·지역별 카운트·기본 선택 / 지역별 시트명·제목·대표행 재계산·SUMPRODUCT 범위·할인율 G6 / 합치기 필터·VIO순 / 전체+합치기 = 기존 동일 / 전체 해제 시 버튼 비활성·Top 500 회귀 / 브랜드→지역 매핑 누락 0.
  - 실행: repo 루트에서 `npm i jsdom xlsx-js-style@1.2.0` 후 `node --test refatrix-api/test/quote_region_excel.test.mjs`.
- 베이스 파일(1,730 SKU) 실데이터 분류: 아시아 918 SKU/1,976행 · 유럽 404/1,481 · 미국 576/1,999 · 중국 15/21 · 미표기 0.

## ⑥ 결정사항
- 지역 = 제조사 국적 기준(그룹사 기준 GM/Ford/Chrysler = 미국). Saab는 기존 라벨이 General Motors라 미국, MG는 중국.
- 기본 출력 = 지역별 시트 분리, 미표기(Sin aplicación)는 기본 해제.
- 시트별 독립 합계(공용 부품은 지역마다 대표 1행).

## ⑦ 오픈이슈
- Stellantis 유럽 브랜드(Peugeot·Fiat)는 유럽, Dodge/Jeep/RAM은 미국으로 분류 — 필요 시 REGION 표 한 줄로 변경.
- Top 500에는 지역 선택 미적용(요청 범위 밖). 같은 모달 재사용으로 쉽게 확장 가능.

## ⑧ 다음액션
- 배포 후 실제 전체 견적에서 China 시트 구성 확인 → 누락 브랜드 있으면 REGION/BRANDS에 추가.
