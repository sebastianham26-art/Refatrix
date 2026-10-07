# REFATRIX 인수인계 · 2026-10-07b · 제품찾기 목록 전체 열 정렬

## ① 설명
제품·마케팅 › 제품(제품 찾기) 목록에서 **모든 열 제목을 눌러 정렬**할 수 있게 했다.
- 기존: 랙·재고·Backorder·누적판매·평균원가·재고 평가액만 정렬 가능.
- 추가: **코드 · 상태 · 경쟁사(SyD) · 적용차종 · 바코드 · 소재 · List Price**.
- 정렬은 서버측(현재 페이지가 아니라 **검색 결과 전체** 기준), 정렬을 바꾸면 1페이지로 돌아감.
- 첫 클릭 방향: 텍스트 열(코드·SyD·적용차종·바코드·랙·소재) = A→Z ▲ / 숫자 열 = 큰 순 ▼ / 상태 = 활성 먼저. 같은 열을 다시 누르면 반대로.
- 텍스트 정렬은 대소문자 무시, 빈 값은 방향과 관계없이 맨 뒤. 같은 값끼리는 코드순.
- 체크박스 열(디렉터 일괄점검 선택)만 정렬 없음.

## ② 배포단계
1. GitHub Desktop → Fetch/Pull.
2. `refatrix-api/src/routes/productRoutes.js` 교체 → push → Railway **Success** 확인. (마이그레이션 없음)
3. `refatrix-products.html` 교체 → push → `Ctrl+Shift+R`.
4. 탭 제목에 `ps-1007srt1` 확인.

## ③ 테스트방법
1. 제품 찾기에서 아무 검색 → 「적용차종」 클릭 → ▲, A→Z(빈 칸은 맨 아래). 다시 클릭 → ▼.
2. 「상태」 클릭 → 활성 먼저, 비활성 뒤.
3. 「List Price」 클릭 → 비싼 순. (sale_price 권한 없는 계정은 열 자체가 안 보임)
4. 정렬 후 「다음 →」 → 같은 정렬로 다음 페이지.

## ④ 변경파일
| 파일 | repo 경로 |
|---|---|
| 제품 화면 | `refatrix-products.html` (repo 루트) |
| 제품 API | `refatrix-api/src/routes/productRoutes.js` |
| 테스트(신규) | `refatrix-api/test/product_sort_all.test.mjs` |

## ⑤ 검증결과
- `node --check productRoutes.js` OK
- pglast: 13개 정렬 키 × ASC/DESC = 28개 쿼리 파싱 OK
- `product_sort_all.test.mjs` 10/10 (pg-mem 실제 ORDER BY 실행 + jsdom 헤더 클릭)
- 회귀: product_delete_front 13/13, product_ref_new_front 25/25. product_oe_front(2 fail)·product_history_front(8 fail)은 **변경 전 코드에서도 동일하게 실패** — 이번 변경과 무관(기존 테스트 노후).

## ⑥ 결정사항
- List Price 정렬은 sale_price 권한이 있을 때만(없으면 코드순 폴백) — 원가 정렬과 같은 원칙.
- 「경쟁사(SyD) · OE」 열은 SyD 코드 기준으로 정렬.

## ⑦ 오픈이슈
- product_oe_front / product_history_front 기존 실패 테스트 정비 필요.

## ⑧ 다음액션
- 배포 후 탭 제목 `ps-1007srt1` 확인.
