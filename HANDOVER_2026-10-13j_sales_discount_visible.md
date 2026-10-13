# REFATRIX 인수인계 — 매출확정 「추가 할인 적용 내역」 표시 (2026-10-13 · 13j)

**마이그레이션 0274 (신규)** · nav.js 변경 없음 · 프런트 빌드 `20261013dd` · 산출물 `refatrix_sales_discount_visible_13j.zip`
**베이스**: 라이브 `main` `f437464` (2026-10-13 14:32 「할인률」 = 13i 배포본)

---

## ① 설명

13i 에서는 할인율을 적용하면 금액만 바뀌고 **할인을 적용했다는 사실이 화면에 남지 않았다.** 이제 수정 내역을 저장해서 보여 준다.

- **매출확정 목록 · 총액 칸**: 총액 아래 배지 `🏷 추가 할인 10%` / `🏷 정가 대비 50% 할인` / `🏷 총액 직접 수정`. 마우스를 올리면 수정 전 총계(IVA 포함)가 보인다.
- **인보이스 펼침 맨 위 배너**: `🏷 추가 할인 10% 적용 · 총계(IVA 미포함) ~~2,666.69~~ → 2,400.02 (−266.67) · 총계(IVA 포함) ~~3,093.36~~ → 2,784.02 · 2026-10-13 14:50 · Sebastian`
- **품목 표 · 단가 칸**: 수정 전 단가를 취소선으로, 그 아래 최종단가를 굵게 표시한다.
- **⬇ 최종단가 엑셀**: 머리에 `Ajuste aplicado | Descuento adicional 10% | Subtotal antes … | Subtotal final …` 줄이 붙고, 마지막 열에 `Precio unit. antes del ajuste`(수정 전 단가)가 추가된다.

**누적 규칙**
- 추가 할인을 이어서 적용하면 **누적률**로 보인다. 10% → 10% = **19%**. 「수정 전」은 첫 추가 할인 직전 금액을 계속 유지한다.
- 정가 대비 할인을 다시 적용하면 마지막 입력값(예: 50%)으로 보이고, 「수정 전」은 첫 수정 직전 금액이다.
- 방식이 바뀌면(추가 할인 → 정가 대비, 또는 → 총액 직접 입력) 그 직전 금액이 새 「수정 전」이 된다.
- 기존 「총액 직접 입력」도 이제 `총액 직접 수정`으로 기록된다.

**대상 범위**: 이번 배포 **이후에** 수정하는 인보이스부터 기록된다. 13i 로 이미 할인한 인보이스는 기록이 없다 → 필요하면 그 인보이스에 같은 할인율을 한 번 더 적용한다. 정가 대비는 결과가 같아서 기록만 생긴다. 추가 할인은 금액이 다시 내려가므로 재적용하지 않는다.

## ② 배포단계

1. zip 의 `refatrix-api/` 를 repo 같은 경로에 덮어쓰기 → GitHub Desktop **Fetch → Commit/Push** → Railway **Success**.
2. **🔴 `npm run migrate`** (Railway 콘솔) — 0274 적용.
   빠뜨려도 수정·조회는 정상 동작하고, **기록만 생략**된다(화면에 배지·배너 없음). 시험으로 확인함.
3. `refatrix-funnel.html` repo 최상위 덮어쓰기 → Push → **Ctrl+Shift+R** → 탭 제목 `build 20261013dd`.

```bash
B=https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main
curl -s -o /dev/null -w "%{http_code}\n" "$B/refatrix-api/migrations/0274_sales_invoice_price_adj.sql"   # 200
curl -s "$B/refatrix-api/src/routes/salesRoutes.js?nc=$(date +%s)"      | grep -c "recordPriceAdj"   # 3
curl -s "$B/refatrix-api/src/routes/devRequestRoutes.js?nc=$(date +%s)" | grep -c "price_adj"        # 5+
curl -s "$B/refatrix-funnel.html?nc=$(date +%s)"                        | grep -c "build 20261013dd" # 1
```

## ③ 테스트방법

1. 당월 인보이스 펼침 → ① 「현재 매출액에서 추가 할인」 10% 적용.
2. 다시 펼쳐진 화면 위쪽에 `🏷 추가 할인 10% 적용` 배너와 수정 전→후 금액이 보이는지, 단가 칸에 취소선 단가가 보이는지 확인한다.
3. 목록 총액 칸에 `🏷 추가 할인 10%` 배지가 보이는지 확인한다.
4. 한 번 더 10% 적용 → `19%`로 바뀌고, 수정 전 금액은 그대로인지 확인한다.
5. Maria 계정으로 같은 인보이스 → 배너·배지가 보이고, ⬇ 최종단가 엑셀에 `Ajuste aplicado` 줄과 수정 전 단가 열이 있는지 확인한다.

## ④ 변경파일

| repo 경로 | 변경 |
|---|---|
| `refatrix-api/migrations/0274_sales_invoice_price_adj.sql` | 신규 — `sales_invoices` 수정 내역 6열, `sales_invoice_lines.pre_adj_unit_price` |
| `refatrix-api/src/sales.js` | `priceAdjMeta()` 순수 함수(누적률·수정 전 유지 규칙) |
| `refatrix-api/src/routes/salesRoutes.js` | `recordPriceAdj()` — adjust-discount·adjust-total 에서 기록(0274 없으면 건너뜀), 응답에 `cumulative_rate` |
| `refatrix-api/src/routes/devRequestRoutes.js` | invoice-lines `price_adj`·라인 `pre_adj_unit_price`, 목록 `price_adj_basis/rate/pre_adj_total_mxn` (to_jsonb 로 0274 전에도 안전) |
| `refatrix-funnel.html` | 목록 배지, 펼침 배너, 단가 취소선, 엑셀 머리줄·열, build `20261013dd` |
| `refatrix-api/test/sales_discount_adjust.test.mjs` | 확장 — priceAdjMeta, 기록·누적 19%·목록 값·총액 수정 기록 |
| `refatrix-api/test/sales_discount_front.test.mjs` | 확장 — 배너·단가 취소선·엑셀·배지 |

## ⑤ 검증결과

- `node --check` 백엔드 3파일 + funnel 인라인 ✅ · pglast 0274 + 신규 SQL 5개 ✅
- **실 PostgreSQL 16 (0001~0274) 종단 14/14** — 정가 대비 50% 기록(수정 전 2,933.31/3,402.64, 라인 수정 전 단가 550/183.33), 추가 할인 10%×2 → 누적 19%·수정 전 2,666.69 유지, 목록 행 값, 총액 직접 수정 기록
- **0274 미적용 DB**에서 adjust-discount·adjust-total·invoice-lines 모두 200, `price_adj=null` ✅
- **jsdom 9/9** (운영 HTML 직접 로드)
- 회귀: exclusivity e2e/front 통과, `quote_customer_po_front`·`tablesort_front` 실패 3건은 작업 전과 동일(기존)

## ⑥ 결정사항

- 연속 추가 할인은 **누적률** 하나로 표시한다(10%+10% → 19%). 단계별 이력(10% → 10%)은 감사로그에 남는다.
- 인보이스 출력(PDF)·고객용 「⬇ 엑셀」에는 표시하지 않았다(내부용 정보). 고객 문서에도 「Descuento adicional」을 넣길 원하면 알려 주세요.

## ⑦ 오픈이슈

- 13i 배포~13j 배포 사이에 할인한 인보이스는 기록이 없다(①의 「대상 범위」 참고).

## ⑧ 다음액션

- 필요하면 목록에 「추가 할인 적용 건만」 필터, 월 단위 최종단가 엑셀 일괄 다운로드.
