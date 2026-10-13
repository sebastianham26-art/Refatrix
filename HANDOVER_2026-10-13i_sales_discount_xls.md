# REFATRIX 인수인계 — 매출확정목록 「할인율로 매출액 수정」 + 「최종단가 엑셀」 (2026-10-13 · 13i)

**마이그레이션 없음** · **nav.js 변경 없음** · 백엔드 4파일 + 프런트 1파일 + 시험 2파일 · 산출물 `refatrix_sales_discount_13i.zip`
**베이스**: 라이브 `main` `7b28d84` (2026-10-13 14:06 「whatsapp 다운받기」) · 프런트 빌드 `20261013dc`

---

## ① 설명

매출확정목록(영업 > 매출확정 > 이미 발행 → 인보이스 펼침)의 **매출액 수정** 박스를 두 칸으로 나눴다.

**① 할인율로 계산 (신규)** — 할인율만 넣으면 IVA 제외 매출액·IVA·총계가 자동 계산된다.
- **기준 2가지**
  - **정가 대비 할인율** (기본): 모든 품목 단가 = 정가 × (1 − 할인율). 몇 번 적용해도 결과가 같다(누적 안 됨). 예: 45% → 50% 로 바꾸면 정가 기준 50% 로 다시 매겨진다.
  - **현재 매출액에서 추가 할인**: 단가 = 현재 실효단가 × (1 − 할인율). 적용할 때마다 누적된다.
  - 정가가 0인 품목이 있으면 「정가 대비」는 비활성, 「현재 대비」가 기본.
- 입력 즉시 미리보기: `총계(IVA 미포함) · IVA · 총계(IVA 포함) (현재 대비 ±차액)`. 미리보기 숫자 = 서버가 저장하는 숫자(같은 계산식).
- 박스 하단에 **현재 정가 대비 실효 할인율** 표시.
- 계산 규칙: 단가는 소수 2자리 → 라인금액 = 단가 × 수량 → 소계 = Σ라인금액 → IVA = 소계 × 인보이스 세율(16%) → 총계. 그래서 **수량 × 단가 = 금액이 모든 줄에서 정확히 맞는다**.
- 저장 시 함께 바뀌는 것: 라인 단가·금액·`discount_rate`(정가 대비 실효값), 인보이스 소계·IVA·총계, **입금예정(AR) 금액**, 감사로그(`adjustDiscount`), 고객 독점정책 재계산 훅.
- 권한·조건은 기존 총액 수정과 동일: **디렉터 전용**, 게시된 인보이스, 당월(마이그레이션 기간 스위치 ON 이면 과거 달도).

**② 총액 직접 입력 (기존 그대로)** — 총계·IVA 를 넣어 비례 역산.

**⬇ 최종단가 엑셀 (신규)** — 펼친 인보이스의 「⬇ 엑셀」 옆. **디렉터 + 영업지원(sales_support = Maria)** 에게만 보인다.
- 시트 `Precios finales` (스페인어): `# · Código CTR · SYD · Descripción · Cant. · Precio lista · Desc. % · Precio unit. final (sin IVA) · Importe (sin IVA) · IVA · Importe (con IVA)` + Subtotal/IVA/Total + **Verificación** 줄.
- 최종단가 = 라인금액 ÷ 수량. 2자리로 딱 떨어지면 2자리, ② 총액 직접 입력으로 비례 조정돼 안 떨어지는 줄은 **6자리**(CFDI ValorUnitario 허용 범위)로 금액을 맞춘다 — Verificación 줄에 표시.
- 파일명 `precios_finales_{SAT}_{YYYY-MM-DD}.xlsx`.

## ② 배포단계

1. zip 의 `refatrix-api/` 를 repo 같은 경로에 덮어쓰기 → GitHub Desktop **Fetch → Commit/Push** → Railway **Success** 확인.
2. **`npm run migrate` 불필요** (기존 컬럼만 사용).
3. `refatrix-funnel.html` repo 최상위 덮어쓰기 → Push → Pages 1~2분 → **Ctrl+Shift+R** → 탭 제목 `build 20261013dc` 확인.

배포 확인:
```bash
B=https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main
curl -s "$B/refatrix-api/src/routes/salesRoutes.js?nc=$(date +%s)"      | grep -c "adjust-discount"     # 2+
curl -s "$B/refatrix-api/src/sales.js?nc=$(date +%s)"                   | grep -c "repriceByDiscount"   # 1
curl -s "$B/refatrix-api/src/routes/devRequestRoutes.js?nc=$(date +%s)" | grep -c "can_price_xls"       # 1
curl -s "$B/refatrix-funnel.html?nc=$(date +%s)"                        | grep -c "build 20261013dc"    # 1
```
반쪽 배포: 프런트만 먼저 올라가면 「할인율 적용」이 「서버가 아직 이 기능을 모릅니다」로 멈추고 데이터는 안 바뀐다. 최종단가 엑셀 버튼은 백엔드가 `can_price_xls` 를 줄 때까지 안 보인다.

## ③ 테스트방법

1. 디렉터: 매출확정 → 이미 발행 → 당월 인보이스 펼침 → 「매출액 수정」 박스에 ① 할인율 / ② 총액 직접 입력이 보이는지.
2. 기준 「정가 대비」, 할인율 50 입력 → 미리보기 숫자 확인 → 「할인율 적용」 → 확인 → 목록·총계·품목 단가가 바뀌는지, 재무 입금예정 금액도 같은지.
3. 같은 50% 다시 적용 → 숫자 그대로(누적 안 됨). 「현재 매출액에서 추가 할인」 10% → 10% 더 내려가는지.
4. 「⬇ 최종단가 엑셀」 → Σ Importe = Subtotal ✔, 수량×단가=금액 확인.
5. Maria 계정: 매출액 수정 박스 **없음**, 「⬇ 최종단가 엑셀」 **있음**. 영업사원 계정: 둘 다 없음.

## ④ 변경파일

| repo 경로 | 변경 |
|---|---|
| `refatrix-api/src/sales.js` | `repriceByDiscount()` · `effectiveDiscountPct()` 순수 함수 추가 |
| `refatrix-api/src/routes/salesRoutes.js` | `POST /api/sales/:id/adjust-discount` (디렉터) |
| `refatrix-api/src/routes/devRequestRoutes.js` | `invoice-lines` 응답에 `list_price`·`discount_rate`·`iva_rate`·`can_price_xls` |
| `refatrix-api/src/exclusivity.js` | 독점정책 재계산 훅에 `adjust-discount` 추가 |
| `refatrix-funnel.html` (repo 최상위) | 할인율 박스·미리보기·적용, 최종단가 엑셀, build `20261013dc` |
| `refatrix-api/test/sales_discount_adjust.test.mjs` | 신규 — 순수 + 실 PostgreSQL 종단 |
| `refatrix-api/test/sales_discount_front.test.mjs` | 신규 — jsdom(운영 HTML 직접 로드) |

## ⑤ 검증결과

- `node --check` 백엔드 4파일 + funnel 인라인 스크립트 ✅ · pglast 신규/변경 SQL 6개 ✅
- **실 PostgreSQL 16 + 마이그레이션 0001~0273 전량 + Fastify app.inject — 13/13** (권한 403, 정가 대비 50% 라인·인보이스·AR 동기화, 재적용 불변, 현재 대비 누적, 400/404/409, 정가 0 품목)
- **jsdom 7/7** — 박스 렌더, 미리보기 = 서버 계산, POST body, 확인 취소 시 미전송, 정가 0 처리, Maria/영업사원 노출, 엑셀 내용·파일명, 6자리 단가
- 실제 SheetJS 0.18.5 로 xlsx 생성 → openpyxl 로 다시 읽어 값·서식(`#,##0.00####`) 확인 ✅
- 회귀: `customer_exclusivity_e2e` 14/14, `customer_exclusivity_front` 6/6. `quote_customer_po_front`·`tablesort_front` 의 실패 3건은 **작업 전과 동일**(기존 실패, 이번 변경과 무관).

## ⑥ 결정사항 (조정 가능)

- 할인 기준 기본값 = **정가 대비**(누적 안 됨). 다른 기준이 기본이길 원하면 한 줄.
- 최종단가 엑셀 권한 = **역할 기준**(director·sales_support). 특정 계정만으로 좁히려면 알려 주세요.
- 할인율 적용은 디렉터 전용(기존 매출액 수정과 동일).

## ⑦ 오픈이슈

- 이미 수금된 인보이스도 기존 총액 수정과 마찬가지로 막지 않는다(입금예정 금액만 동기화).
- 다른 모듈(커미션·실적 등)에 미치는 영향은 기존 「총액 직접 입력」과 같다 — 같은 테이블·같은 컬럼(라인 단가·금액, 인보이스 합계, AR 금액)만 바꾼다.

## ⑧ 다음액션

- 필요하면: 월 단위 「최종단가 엑셀」 일괄 다운로드(선택 월 인보이스 전부를 한 파일에).
