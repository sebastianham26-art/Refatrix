# REFATRIX 핫픽스 — 제품 검색 「pro 로 찾으면 PRO 제품이 안 나온다」 (2026-09-18)

**백엔드 1파일 + 프런트 1파일** · 마이그레이션 없음 · 빌드 마커 `pd-0918c`
**배포 순서: 백엔드 먼저 → Railway Success → 프런트** (프런트만 올리면 안내 문구만 바뀌고 순서는 그대로다)

---

## ① 증상

업로드 탭 「수정할 제품 검색」에 `pro` 를 넣으면 **CB0280 · CB0282 · CB0578 · CE0456 · CE0988L …** 만 나오고,
정작 코드가 `PRO…` 인 마케팅 상품은 한 건도 보이지 않았다. (제품 찾기 화면에서는 보였다 — 거기는 50건씩 받는다)

## ② 원인

`GET /api/products` 의 검색은 **코드·바코드·제품명·SyD·적용차종**을 전부 훑고, 정렬은 **코드순(`p.code ASC`)** 이 기본이다.

- `pro` 는 적용차종 **RAM PROMASTER** 에 들어 있어 CB·CE 계열이 대량으로 걸린다.
- 코드순이라 `CB…` · `CE…` 가 앞을 채우고, `PRO…` 는 알파벳 뒤라 **후보 8건 밖으로 밀려났다.**
- 화면은 「없음」과 구분이 안 되니 **제품이 없는 것처럼 보였다.**

즉 검색 자체는 정상이고 **정렬과 건수 제한**의 문제였다.

## ③ 수정

**백엔드 `productRoutes.js`** — 검색어가 있고 사용자가 정렬을 고르지 않았을 때만 **관련도 순**으로 세운다.

```
0 코드 정확일치 → 1 코드 접두 → 2 코드 포함 → 3 바코드 접두
→ 4 SyD 포함 → 5 제품명 포함 → 6 그 외(적용차종 등)      (같은 등급 안에서는 코드순)
```
- 정렬 헤더를 누르면(`sort=`) 종전 동작 그대로. 검색어가 없으면 종전대로 코드순.
- 전체 건수(count) 쿼리는 **파라미터 스냅샷 이후**에 관련도 파라미터를 붙여 영향 없음.

**프런트 `refatrix-products.html`**
- 후보 조회 8건 → **12건**.
- 잘렸을 때 **「전체 57건 중 가까운 12건만 표시 — 코드를 더 입력하면 좁혀집니다」** 안내를 붙인다.

## ④ 변경 파일

| 파일 | repo 경로 | 변경 |
|---|---|---|
| `productRoutes.js` | `refatrix-api/src/routes/` | +21 / −1 (`const orderBy` → `let`, 관련도 CASE 블록) |
| `refatrix-products.html` | repo 최상위 | +11 / −2 (limit 12 · 잘림 안내 · 빌드 마커) |
| `product_delete_front.test.mjs` | `refatrix-api/test/` | jsdom 2케이스 추가(⑨-b·⑨-c) |

## ⑤ 검증

- **실 PostgreSQL 16** — 운영과 같은 모양의 데이터(RAM PROMASTER 적용차종 8건 + `PROGORRA`·`PRO-CAP` + 이름에 `PROTECTOR` 가 있는 제품)로
  실제 쿼리 실행 → 결과 순서 **PRO-CAP · PROGORRA · ZZ001(이름) · CB0280 · CB0282 …** 확인.
- `pglast` 파싱 통과 · `node --input-type=module --check`(백엔드) · 인라인 스크립트 2블록 `node --check`.
- **jsdom 13/13** (기존 11 + 신규 2: `limit=12` 로 조회하는지 · 잘림 안내 문구 · 안 잘렸을 때 안내 없음).
- 라이브 main 대비 diff = 위 2파일뿐, 삭제 우세 아님.

## ⑥ 배포

1. `refatrix-api/src/routes/productRoutes.js` 덮어쓰기 → Push → Railway **Success**
2. `refatrix-products.html` 덮어쓰기 → Push → Pages 1~2분 → **Ctrl+Shift+R**
3. 콘솔 `[refatrix-products] build pd-0918c` 확인 → 업로드 탭에서 `pro` 검색 → **PRO 계열이 맨 위**에 오는지

## ⑦ 메모

- 제품 찾기 화면도 같은 엔드포인트를 쓰므로 **검색 결과 순서가 함께 좋아진다**(코드로 찾으면 그 코드가 맨 위).
  정렬 헤더를 눌러 쓰던 방식은 그대로다.
- 적용차종만으로 걸린 결과를 아예 빼지는 않았다 — SyD·경쟁사 코드로 찾는 실제 용례가 있어 **뒤로 미루기만** 했다.
