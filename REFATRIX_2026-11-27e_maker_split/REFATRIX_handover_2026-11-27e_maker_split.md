# REFATRIX 인수인계 · 2026-11-27e · 메이커 칸에 여럿(FORD, MERCURY) → 낱개 메이커로

## ① 설명
- 적용차종 메이커 칸에 `FORD, MERCURY` · `Ford/Mercury` · `FORD & LINCOLN` 처럼 여러 메이커가 적힌 경우, 원문은 그대로 두고 **낱개 메이커로 나눠** 본다.
  - **드롭다운**: `FORD, MERCURY` 줄이 없어지고 FORD · MERCURY 가 각각 한 줄. 대소문자 · 하이픈 차이는 11-27b 처럼 한 줄로 묶인다.
  - **FORD 를 고르면**: 모델 목록 · 연식 · 차량 도면 · 예전 차종 검색에 FORD 단독 칸 + `FORD, MERCURY` 칸 차종이 함께 나온다. MERCURY 도 마찬가지.
  - **경쟁사 마스터 APLICACIÓN**: `Ford, Mercury Grand Marquis` 처럼 같이 적힌 짝 메이커는 「다른 메이커」로 거르지 않는다. 실제 다른 메이커(예: Chevrolet Aveo)는 여전히 거른다.
- 구분자: `,` · `/` · `&` · `+` · `;`

## ② 배포단계
1. 백엔드만(Fetch/Pull 먼저): BACKEND zip → push → Railway **Success**
2. 마이그레이션 · 프론트 변경 없음 — 화면 새로고침만(`Ctrl+Shift+R`)

## ③ 테스트방법
1. 차종으로 제품찾기 → 메이커 드롭다운에 `FORD, MERCURY` 같은 합친 줄이 사라지고 FORD · MERCURY 가 따로 있는지
2. FORD → 모델 목록에 Grand Marquis(원래 FORD, MERCURY 칸) 도 보이는지 · MERCURY 도 같은 모델이 보이는지
3. 찾기 결과가 두 메이커에서 같은지

## ④ 변경파일
| 저장소 경로 | 내용 |
|---|---|
| `refatrix-api/src/vehicleMap.js` | `makerParts` · `MK_PARTS_SQL` · `MAKER_COND_SQL` · appMatch 짝 메이커 처리 |
| `refatrix-api/src/routes/productRoutes.js` | app-makers 낱개 묶음 · app-models · app-years · by-vehicle 메이커 조건 |
| `refatrix-api/src/routes/vehicleMapRoutes.js` | 차량 도면 메이커 조건 |
| `refatrix-api/test/vehicle_map_e2e.test.mjs` | ⑦ 한 칸 여러 메이커 시험 |
| `refatrix-api/test/vehicle_map_front.test.mjs` · `product_positions_ctr.test.mjs` | 11-27d 시험 파일(저장소에 아직 안 들어감 · 시험 전용) |

## ⑤ 검증결과
- `node --check` · pglast 통과 · PostgreSQL 에서 `'FORD, Mercury'` 칸이 MERCURY 로 맞는 것 확인
- 순수 함수 11/11 · 실 PostgreSQL E2E **8/8** · jsdom 12/12 · `product_positions_ctr` 2/2
- 기준 커밋: live `main` e8906d2 (11-27d 반영 확인)

## ⑥ 결정사항
- 메이커 칸만 나눈다(모델 칸은 나누지 않음 — `CR-V`, `F-150` 같은 이름에 기호가 들어가므로).

## ⑦ 오픈이슈
- 줄임말(VW ↔ VOLKSWAGEN) · 오타는 여전히 별개. 필요하면 별칭표.

## ⑧ 다음액션
- 배포 후 드롭다운에 아직 이상하게 묶이거나 갈라진 메이커가 있으면 알려 주기
