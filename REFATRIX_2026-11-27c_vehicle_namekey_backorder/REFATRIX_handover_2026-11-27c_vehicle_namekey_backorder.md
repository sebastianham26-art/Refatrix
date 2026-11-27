# REFATRIX 인수인계 · 2026-11-27c · 차종 이름 키 + 생산 중 백오더 · build `ps-1127vo`

> 11-27b(이름 키)를 포함한 누적 패키지입니다. 11-27b 는 배포하지 말고 이것만 배포하세요.

## ① 설명
- 차종으로 제품찾기에서 메이커 · 모델 이름의 **대소문자 · 하이픈 · 공백 · 점 · 슬래시 · 악센트 차이를 무시**하고 같은 이름으로 본다. 카탈로그 마스터(적용차종 원문)는 **바꾸지 않는다**.
  - 예: `CR-V` = `CRV` = `Cr V` · `Mercedes-Benz` = `MERCEDES BENZ` · `Citroën` = `CITROEN`
- **드롭다운**: 같은 이름 키는 한 줄로 묶인다.
  - 가장 많이 쓰인 표기가 대표로 보이고, 묶인 다른 표기를 괄호로 함께 보여 준다. 예: `NISSAN  (Nissan · nissan)`. 옵션에 마우스를 올리면 전체 목록이 나온다.
- **찾기**: 어떤 표기를 골라도 그 키에 속한 모든 표기의 제품이 나온다. 적용되는 곳은 연식 목록 · 차량 도면 · 예전 차종 검색 API(`by-vehicle`).
- **경쟁사 마스터(APLICACIÓN)**: 같은 규칙으로 맞춘다. 낱말 경계는 지켜서 `Versa` 가 `Versailles` 에 걸리지 않는다.
- **장착위치 업로드 줄**(차종별 위치)도 같은 이름 키로 비교한다.

- **백오더 기준 변경(11-27c)**: 차량 도면의 시계 아이콘 = **생산 중(En producción)**.
  - 정의: max(0, 공장 발주 미입고 잔량 v_backorder − 운송 중). 견적 엑셀 En producción 과 같은 회사 공통 정의(quoteQtyCols).
  - 이전 값은 고객 주문 미출고 부족분이었다(CQ0280L 338 이 이것). 지금은 상세 카드에 참고로 따로 보인다.
  - 상세 카드에 「발주 미입고 잔량 = 운송 + 생산 중」 한 줄을 추가했다.

## ② 배포단계
1. 백엔드(Fetch/Pull 먼저) — BACKEND zip 을 같은 경로에 넣고 push → Railway **Success**
2. 마이그레이션 **없음**
3. 프론트 `refatrix-products.html` push → `Ctrl+Shift+R`
4. 탭 제목 **`ps-1127vo`** 확인 (nav.js 변경 없음)

## ③ 테스트방법
1. 차종으로 제품찾기 → 메이커 드롭다운에서 예전에 두세 줄로 갈라져 있던 메이커가 한 줄인지(괄호에 묶인 표기)
2. 모델도 같은 방식 · 연식 목록이 묶인 표기 전체의 연식으로 나오는지
3. 찾기 → 이전에 다른 표기 쪽에만 있던 제품도 같이 나오는지
4. API: `/api/products/app-models?maker=nissan` 의 `groups[].variants`
5. CQ0280L 이 들어가는 차종 → 상세 카드: 시계 아이콘 = 생산 중, 아래 줄 「발주 미입고 잔량 = 운송 + 생산 중」이 제품목록 Backorder 와 맞는지

## ④ 변경파일
| 저장소 경로 | 내용 |
|---|---|
| `refatrix-api/src/vehicleMap.js` | `nameKey` · `NK_SQL` · `hasName` 추가 · 차종 맞춤 · 위치 비교에 적용 |
| `refatrix-api/src/routes/productRoutes.js` | `app-makers` · `app-models` · `app-years` · `by-vehicle` 이름 키 묶음 · 검색 |
| `refatrix-api/src/routes/vehicleMapRoutes.js` | 제품 · 경쟁사 마스터 조회를 이름 키로 · 백오더 = 생산 중(v_backorder − 운송) · po_open_qty · short_qty |
| `refatrix-api/test/vehicle_map_e2e.test.mjs` | ⑥ 이름 키 시험 추가 |
| `refatrix-api/test/vehicle_map_front.test.mjs` | 드롭다운 묶음 표기 시험 추가 |
| `refatrix-api/test/product_positions_ctr.test.mjs` | build 토큰 |
| `refatrix-products.html` (루트) | 드롭다운 묶음 표기 · 생산 중 백오더 표시 · build `ps-1127vo` |

## ⑤ 검증결과
- `node --check` 전체 통과 · pglast 새 SQL 통과 · PostgreSQL 이름 키 결과 확인(`Citroën cr-v Ñandú Mercedes-Benz` → `CITROENCRVNANDUMERCEDESBENZ`)
- 순수 함수 시험 9/9 · 실 PostgreSQL E2E **7/7**(③에 발주 1,500 − 운송 200 = 생산 중 1,300 · 부족분 참고값 확인 추가)(⑥: 소문자 메이커 · 하이픈 모델 · 공백 마스터 표기 → 드롭다운 한 줄 · 대표 표기 · 연식 합침 · 세 가지 표기로 같은 결과 · by-vehicle) · jsdom 12/12(상세 카드 「발주 미입고 잔량 = 운송 + 생산 중」 확인) · `product_positions_ctr` 2/2
- 기준 커밋: live `main` 2350dd3 (작업 중 올라온 prospects 커밋과 겹치는 파일 없음)

## ⑥ 결정사항
- 같은 이름의 기준 = 글자 · 숫자가 같으면 같다(기호 · 공백 · 대소문자 · 악센트만 무시). `Jetta A4` 와 `Jetta` 는 다른 모델로 둔다.
- 백오더 아이콘 = 생산 중. 발주 미입고 잔량(제품목록 Backorder)과 고객 미출고 부족분은 상세 카드 참고 줄에만 보인다.
- 줄임말(`VW` ↔ `VOLKSWAGEN`, `CHEVY` ↔ `CHEVROLET`)은 드롭다운에서 **합치지 않았다**(글자가 다름). 경쟁사 마스터 맞춤에서는 예전처럼 줄임말을 인정한다.

## ⑦ 오픈이슈
- 줄임말 · 오타(예: `VOLKSWAGEM`)까지 합치려면 별칭표(마스터는 그대로, 별도 표)가 필요하다.

## ⑧ 다음액션
- 배포 후 드롭다운에서 아직 갈라져 보이는 메이커 · 모델을 알려 주면 별칭표 대상으로 정리
