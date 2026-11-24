# REFATRIX 인수인계 — 2026-11-23b · 가격표 판매 누적수량 + 빈칸 원인 수정

빌드: `pm-1123fd` · 마이그레이션 없음

## ① 설명
- **빈칸 원인**: 앞 커밋(f4e21bc)에서 `priceMasterRoutes.js` 가 `refatrix-api/src/routes/` 가 아니라 저장소 루트 `./priceMasterRoutes.js` 와 `Claude outputs/` 에 들어가 Railway 서버가 예전 코드 → 화면은 새 열을 그렸지만 서버가 값을 보내지 않음.
- **판매 누적 (개)** 열 추가(Total Cost MXN 옆): 지금까지 게시(posted)된 매출 인보이스의 판매수량 합, 삭제 인보이스 제외. ⑦ 제품 수익성의 누적 판매수량과 같은 기준. 셀에 마우스 → 「인보이스 N건 · 마지막 판매 YYYY-MM-DD」. 제목 클릭 정렬.
- 엑셀 다운로드 16열: … Total Cost MXN · Base costo · Importaciones · **Vendido acumulado · Facturas · Ultima venta** · List Price MXN …

## ② 배포단계
파일을 PC 저장소의 올바른 경로에 이미 넣어 두었음 → GitHub Desktop 에서 아래 4개 체크 → Commit → Push → Railway Success → `Ctrl+Shift+R` → 탭 제목 `pm-1123fd`.
(백엔드·프런트가 같은 저장소라 한 번에 Push 해도 됨. `_tmp_stage/` 는 체크하지 말 것)

## ③ 테스트방법
1. 가격표에 FOB MXN · Total Cost MXN · 판매 누적 값이 나오는지
2. 판매 많은 코드 하나 → ⑦ 제품 수익성의 판매수량과 같은지
3. 「판매 누적」 제목 클릭 → 많이 팔린 순
4. 📥 엑셀 다운로드 → 16열 확인

## ④ 변경파일
| 저장소 경로 | 배포 |
|---|---|
| `refatrix-api/src/routes/priceMasterRoutes.js` | Railway |
| `refatrix-pricemaster.html` (루트) | GitHub Pages |
| `refatrix-api/test/price_table_cost_pg.test.mjs` | 테스트 |
| `refatrix-api/test/pricemaster_table_cost_ui.test.mjs` | 테스트 |

## ⑤ 검증결과
- ESM/스크립트 문법 OK
- 실 PostgreSQL 16(전체 마이그레이션) 7/7 — 판매 누적: 게시 인보이스 합 42 · 2건 · 마지막 11-15, `status='deleted'`·`deleted_at` 인보이스 제외, 판매 없음 0, sold 정렬
- jsdom 7/7 — 12열 · 판매 셀·툴팁 · 엑셀 16열 · 다시 올리기 머리글 인식(FOB=4열, List=12열)

## ⑥ 결정사항
- 판매 누적 = 순판매가 아닌 **인보이스 판매수량 합**(NC 반품 차감 안 함, 수익성 탭과 동일)

## ⑦ 오픈이슈
- 앞 커밋으로 저장소에 올라간 정리 대상: 루트 `priceMasterRoutes.js`, `Claude outputs/` 폴더, 루트 `REFATRIX_2026-11-23_*.zip` 2개 · handover md — 운영엔 영향 없음, 지워도 됨
- NC 반품을 빼고 싶으면 말씀 주세요

## ⑧ 다음액션
Push 후 `pm-1123fd` 확인
