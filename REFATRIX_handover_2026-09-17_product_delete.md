# REFATRIX 인수인계 — 제품 마스터 「🗑 제품 영구 삭제」 (디렉터 PIN) · 2026-09-17

**마이그레이션 0222 (`npm run migrate` 필요)** · 백엔드 3파일(신규 1) + 프런트 1파일 + 테스트 2파일
**산출물 zip**: `refatrix_product_delete_v1.zip` · **베이스**: 라이브 main (productRoutes.js `c67504a…`, 2026-09-17 기준 최신)
**빌드 마커**: `pd-0917a` · **nav 캐시버스터 변경 없음**(`?v=20260917cotiz2` 그대로 — nav.js 무변경이고 `integration_nav.test.mjs` 가 전 화면 동일 마커를 요구한다)

---

## ① 무엇을·왜

**요구(디렉터)** — 제품/마케팅 > 제품 마스터 업로드에서 제품을 삭제할 수 있게.
**한 번이라도 판매가 되었으면 삭제 불가**, **구매도 없고 판매도 없으면 디렉터가 PIN 으로만 삭제.**

**확정한 규칙**

| 항목 | 결정 |
|---|---|
| 삭제 방식 | **완전 삭제(행 제거)**. soft delete 는 쓰지 않는다 — `products.code` 가 UNIQUE 라 soft delete 하면 그 코드를 영영 다시 못 쓴다(지금도 `code_used_by_deleted` 오류가 난다). **잘못 등록한 코드를 되살리는 것**이 이 기능의 목적이다 |
| 차단 범위 | 판매·구매뿐 아니라 **products 를 참조하는 어떤 기록이라도 1건 있으면 차단**(견적·재고원장·부족분·오퍼시트·개발요청·입고·제품찾기 견적 …). **재고수량이 0이 아니어도 차단** |
| 함께 지우는 것 | 파생 데이터·제품 전용 이력만 — SyD 코드 · 적용차종 · 경쟁사 교차참조(+백업 행) · 판매상태 전환 이력 · 판매상태 점검 항목/메모 |
| 남기는 것 | **제품 변경 이력(`product_change_log`)** — `product_id` 만 비우고 **코드 스냅샷은 그대로** 둔다. 그리고 「삭제」 한 줄이 새로 쌓인다(누가·언제·사유·함께 정리한 항목) |
| 권한 | 디렉터 전용 + **삭제 순간 PIN 재확인**(수입입고 마감·창고 잠금과 같은 방식) |
| 위치 | 업로드 탭 「수정할 제품 검색」 결과 행의 **🗑 삭제** 버튼 → 그 자리에서 점검 결과를 먼저 보여 주고, 삭제 가능할 때만 PIN 칸이 나온다 |

> **판매 기록이 있는 제품은 앞으로도 지울 수 없다.** 지우면 과거 매출·매출원가(P&L)가 어긋난다.
> 그 경우 화면이 **「판매중단(비활성)」** 을 대안으로 안내한다(0179 기능).

### 참조 탐색을 코드에 박지 않은 이유

표 목록을 상수로 적어 두면 **나중에 만든 표를 놓치고**, 그 제품이 조용히 지워진다.
그래서 삭제 직전에 **DB 에 물어본다**:

1. `information_schema` — 현재 스키마에서 `product_id` 컬럼을 가진 표 **전부**
   (`finder_quote_lines` 처럼 **외래키가 없는** 표도 이 방법이면 잡힌다 — DB 는 이걸 못 막는다)
2. `pg_constraint` — `products(id)` 를 가리키는 외래키(컬럼 이름이 다른 경우 대비, 예: `offer_sheet_items.sku_id`)

**모르는 표에 행이 있으면 차단**이 기본값이다(안전한 쪽으로 틀린다). 화면에는 표 이름이 그대로 나온다.
그래도 빠져나간 참조가 있으면 **Postgres 외래키가 2차로 막고**, 500 대신 409 로 이유를 돌려준다.

---

## ② 배포 단계 (순서 엄수)

1. **백엔드 먼저** — zip 의 `refatrix-api/` 를 같은 경로에 덮어쓰기(신규 `src/productDelete.js` 포함)
   → GitHub Desktop **Commit / Push** → Railway **Success** 확인.
2. 🔴 Railway 콘솔 **`npm run migrate`** → `apply 0222_product_delete_log.sql` 확인.
   - 0222 없이 프런트를 올려도 **삭제는 동작한다** — 다만 이력 줄이 「삭제」가 아니라 「수정」으로 남는다(코드가 자동 폴백).
3. **프런트** — `refatrix-products.html` 을 repo 최상위에 덮어쓰기 → Push → GitHub Pages 1~2분.
4. 제품 화면 **Ctrl+Shift+R** → 콘솔에 `[refatrix-products] build pd-0917a (제품 영구 삭제 · 디렉터 PIN)`.

**Push 전 확인** — GitHub Desktop diff 가 `refatrix-products.html` **+127 / −5**, `productRoutes.js` **+96 / −0**,
`productHistory.js` **+11 / −0** 인지(삭제 우세면 낡은 사본이다).

```bash
R=https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main
curl -s "$R/refatrix-products.html?nc=$(date +%s)"                | grep -c "pd-0917a"        # 1
curl -s "$R/refatrix-products.html?nc=$(date +%s)"                | grep -c "pe-del"          # 3
curl -s "$R/refatrix-api/src/productDelete.js?nc=$(date +%s)"     | grep -c "REF_COLUMNS_SQL" # 2
curl -s "$R/refatrix-api/src/routes/productRoutes.js?nc=$(date +%s)" | grep -c "delete-check"  # 2
```

---

## ③ 테스트 방법 (디렉터가 5분에 확인)

1. 제품/마케팅 > **제품 마스터 업로드** > 「수정할 제품 검색」에 코드 2자 이상 입력 → 후보 행에 **🗑 삭제** 버튼이 보이는지(디렉터만).
2. **팔린 적 있는 코드**로 눌러 본다 → 「**삭제할 수 없습니다**」 + 「판매 이력이 있습니다 (n건)」 + 걸려 있는 기록 목록.
   **PIN 칸이 아예 없다.** 아래에 「판매중단(비활성)을 쓰세요」 안내.
3. **시험용 제품을 하나 만들어** 본다: ➕ 신규 제품 추가 → 코드 `ZZTEST01` 저장 → 다시 검색 → 🗑 삭제 →
   「판매·구매 기록이 없습니다 — 삭제할 수 있습니다」 + 「함께 정리되는 항목」(SyD 코드·적용차종 건수) 확인.
4. **PIN 없이** 「영구 삭제」 → 「디렉터 PIN을 입력하세요」. **틀린 PIN** → 「PIN이 올바르지 않습니다」.
5. 맞는 PIN + 확인창 **확인** → 행이 사라지고 「삭제 완료 — ZZTEST01 …」.
6. **같은 코드로 다시 등록**된다(➕ 신규 제품 추가 → `ZZTEST01`). ← soft delete 였다면 막혔을 부분.
7. **이력 확인** — 업로드 탭 하단 「제품 변경 이력」에 빨간 **삭제** 줄(코드·사유·함께 정리 내용),
   📜 제품 이력 탭에서도 같은 줄이 보인다(제품은 없어도 코드로 남는다).
8. **회귀** — 제품 찾기·드릴다운, 업로드 미리보기/반영, ✎ 수정, 📄 이 코드로 신규, 소재 일괄지정, 교차참조 업로드.

---

## ④ 변경 파일

| 파일 | repo 경로 | 구분 | 내용 |
|---|---|---|---|
| `productDelete.js` | `refatrix-api/src/` | **신규** | 참조 탐색(카탈로그 조회) · 표 분류(차단/정리/연결해제) · 차단 판정 · 정리 실행 |
| `productRoutes.js` | `refatrix-api/src/routes/` | 수정 (+96/−0) | `GET /api/products/:id/delete-check` · `DELETE /api/products/:id` 신규, import 2줄, `logProductChange` 가 성공/실패를 반환 |
| `productHistory.js` | `refatrix-api/src/` | 수정 (+11/−0) | `action='delete'` 한 줄 요약 + 라벨 3개(`_deleted`·`_removed`·`_reason`) |
| `0222_product_delete_log.sql` | `refatrix-api/migrations/` | **신규** | `product_change_log.action` 에 `'delete'` 허용(0141 의 CHECK 교체) · `product_id` NULL 허용 보장 · 멱등 |
| `product_delete.test.mjs` | `refatrix-api/test/` | **신규** | 순수 로직 8 + 실 DB 종단 2 (탐색·차단·삭제·코드 재사용·마이그레이션 멱등) + 이력 문장 1 |
| `product_delete_front.test.mjs` | `refatrix-api/test/` | **신규** | jsdom 10 (버튼 노출·차단 화면·PIN 필수·confirm·본문·오류·접힘·XSS) |
| `refatrix-products.html` | repo 최상위 | 수정 (+127/−5) | 🗑 버튼 · 확인 패널(점검→PIN→confirm) · CSS · 안내문 · 이력 라벨 「삭제」 · 빌드 마커 |

**신규 엔드포인트 (둘 다 디렉터 전용)**

```
GET    /api/products/:id/delete-check   → { can_delete, reasons[], blockers[], cleanups[], sold_count, purchase_count }
DELETE /api/products/:id                body { pin, code?(확인용), reason? }
        403 bad_pin · 409 has_refs(+check) · 409 code_mismatch · 404 not_found
```

---

## ⑤ 검증 (이 세션, 전부 통과 ✅)

- **실 PostgreSQL 16 종단** — 임시 스키마에 운영 구조를 축소 재현(FK 있는 표 · **FK 없는 `finder_quote_lines`** · **컬럼명이 다른 FK**)
  - 탐색이 세 경로를 모두 잡는다 / 판매·구매·제품찾기견적·재고 각각 **차단** /
    깨끗한 제품은 **삭제되고** 파생 2건·상태이력 1건 **정리**, 변경이력 1건 **연결 해제** /
    **같은 코드 재등록 성공** / 점검을 건너뛰고 지우면 **FK 가 23503 으로 막는다**(2차 방어선 확인)
  - **0222 멱등** — 0141 스키마(create/update 만)에서 적용 전엔 `delete` 가 23514 로 막히고, 적용 후 통과, 두 번 돌려도 안전, `'purge'` 같은 값은 여전히 거부
- **jsdom 10/10** — 운영 `refatrix-products.html` 을 그대로 로드해서 검증(버튼·차단 화면에 PIN 칸 없음·PIN 미입력 시 무요청·confirm 취소 시 무요청·DELETE 본문 `{pin,code,reason}`·bad_pin 안내·패널 접힘·**XSS**)
- **테스트 합계 23/23**
- **문법** — 백엔드 `node --input-type=module --check`, 프런트 인라인 스크립트 2블록 `node --check`
- **SQL** — `pglast` 로 마이그레이션 + 신규 쿼리(카탈로그 조회·COUNT·정리·삭제) 전부 파싱
- **라우트 충돌 점검** — server.js 가 등록하는 **라우트 파일 57개 전부**를 받아 `app.delete('/api/products…')` 를 훑었다.
  기존은 `/api/products/status-checks/:id` · `/api/products/xref/snapshots/:id` 뿐 — **새 `DELETE /api/products/:id` 와 충돌 없음**
- **라이브 main 대비 diff** = 위 파일들뿐, **삭제 우세 파일 0건**

---

## ⑥ 결정사항 (왜 이렇게 했나)

1. **완전 삭제** — `products.code` UNIQUE 때문. soft delete 면 코드가 잠겨 이 기능의 목적(오등록 코드 회수)을 못 이룬다.
2. **판정은 서버가, 화면은 서버 말을 그대로 표시** — 화면에서 판단하면 두 벌이 갈라진다.
3. **점검을 두 번 한다** — 버튼 눌렀을 때 한 번, 삭제할 때 **행을 잠그고(FOR UPDATE)** 한 번 더.
   그 사이에 견적이 들어오면 삭제가 409 로 막힌다.
4. **이력 기록은 커밋 뒤에** — 0222 가 아직 안 돈 DB 에서 트랜잭션 안에 넣으면 CHECK 위반으로 **삭제 전체가 롤백**된다.
   커밋 후 기록하고, `delete` 가 거부되면 같은 내용을 `update` 로 남긴다.
5. **재고수량 0 조건** — 재고는 `stock_movements` 로만 변하므로 사실상 원장이 없으면 0이지만, 방어적으로 한 번 더 본다.
6. **확인 3단계(점검 → PIN → confirm)** — 되돌릴 수 없는 작업이다. 코드도 본문에 실어 보내 **다른 제품을 지우는 사고**를 막는다.

---

## ⑦ 오픈 이슈 / 메모

- **삭제된 제품의 이력은 코드로만 남는다.** 같은 코드를 다시 등록하면 옛 줄과 새 줄이 같은 코드로 섞여 보인다
  (줄마다 시각·작업이 달라 구분은 되지만, 「이전 제품의 이력」이라는 표시는 없다). 필요하면 배지를 붙일 수 있다.
- **참조 점검은 표마다 COUNT 1회**(현재 `product_id` 컬럼을 가진 표 기준). 각 표에서 501행만 세고 끊는다.
  인덱스가 없는 큰 표(예: `xref_snapshot_rows`)가 있으면 점검이 1~2초 걸릴 수 있다 — 디렉터 1회 작업이라 그대로 뒀다.
- **일괄 삭제는 없다.** 한 건씩만 지운다(사고 위험 대비 의도적).
- **판매상태 점검(일괄 점검) 스냅샷**에 그 제품이 들어 있으면 그 **항목 행은 함께 지워진다** — 점검 배치 자체는 남는다.
- **제품 마스터 엑셀 업로드는 삭제하지 않는다.** 파일에서 빠진 코드가 있어도 그대로 둔다(기존 원칙 유지).

---

## ⑧ 다음 액션

1. ② 순서대로 배포 — 백엔드 → Railway Success → **`npm run migrate` (0222)** → 프런트 → Ctrl+Shift+R.
2. ③ 의 시험용 제품(`ZZTEST01`)으로 한 바퀴 돌려 보기 — 특히 **6번(같은 코드 재등록)**.
3. 실제로 지우고 싶은 오등록 코드가 있으면, 먼저 🗑 를 눌러 **점검 결과만** 보고 판단하기(점검은 아무것도 바꾸지 않는다).

*이 문서는 인수인계용 스냅샷입니다.*
