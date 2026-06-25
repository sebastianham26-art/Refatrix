# REFATRIX 인수인계 — NC(할인 승인 증빙 / Nota de crédito) 1단계: 사내 통제 + 비현금 반제
**작성일**: 2026-06-25 · **마이그레이션**: 0085 · **nav 캐시 마커**: `v20260625d`(settlement만)
**범위**: 1단계(사내 통제 전용). CFDI de egreso(세금계산서) 연동은 2단계로 보류 — `cfdi_uuid` 컬럼만 미리 마련.

---

## ① 무엇을, 왜 (설명)

인보이스를 **발행한 뒤** 고객이 결제조건보다 빨리 입금하면(예: 15일 내 입금 시 3% descuento) 잔액보다 적게 받습니다. 그 **할인분**을 닫기 위해 **NC(Nota de crédito · 할인 승인 증빙)** 를 발기하고, 디렉터 서명 증빙을 받아 **비현금 반제**로 인보이스 잔액을 0으로 마감합니다.

### 핵심 — NC는 "비현금" 반제
기존 현금 반제는 배분(allocation) 1건당 **거래(transactions, category 4010, kind=payment)** 를 1건 만들어 현금/수금에 잡힙니다. NC는 **배분은 만들되 4010 거래는 만들지 않습니다**(`payment_id`·`txn_id` 모두 NULL, `kind='nota_credito'`). 따라서:
- **미수 잔액** = `총액 − Σ배분(현금+NC)` → NC도 차감되어 **완납 처리됨**.
- **현금/현금흐름/수금 총액** = `transactions(4010)` 기준 → NC는 거래가 없어 **자동 제외** → 받지도 않은 할인분이 수금으로 잡히는 **이중계상이 구조적으로 불가능**.

### 절차 (상태머신: draft → approved → applied → void)
1. **발기(영업지원/디렉터)** — 수금/정산 화면 오픈 인보이스 행의 **[NC]** → concepto(메모)·할인률(%) 또는 금액 입력 → 발기. (IVA 16% base/iva 자동 분리, 잔액 초과 불가)
2. **인쇄·서명** — NC 목록에서 **🖨 인쇄** → 인보이스 머리글 + **상단에 Concepto** + **담당자/디렉터 서명란** → 디렉터 서명.
3. **서명본 업로드(영업지원)** — **서명본 업로드**(이미지·PDF, 8MB↓).
4. **승인(디렉터 전용)** — 서명 증빙이 있어야 **승인** 버튼 활성. 승인 = 디렉터의 시스템 확정.
5. **적용(영업지원, settlement)** — **적용(비현금 반제)** → 인보이스 잔액 마감(완납).
6. **취소(디렉터)** — 적용된 NC도 취소 시 배분 제거 → **인보이스 잔액 원복**.

### 권한 분리
- **발기·적용**: settlement 권한(영업지원). · **승인·취소**: 디렉터 전용. → 영업지원이 할인을 스스로 승인·적용까지 하지 못함.

---

## ② 배포 단계 (순서 중요)

### A. 백엔드
1. `refatrix-api/migrations/0085_notas_credito.sql` (신규) 추가.
2. `refatrix-api/src/routes/notaCreditoRoutes.js` (신규) 추가.
3. `refatrix-api/src/server.js` 에 **2줄** 추가:
   ```js
   import notaCreditoRoutes from './routes/notaCreditoRoutes.js';   // 상단 import 블록(다른 *Routes import 옆)
   app.register(notaCreditoRoutes);                                 // register 블록(app.register(financeRoutes) 근처)
   ```
4. **GitHub Desktop** commit & push → **Railway** 자동 재배포 → Deployments **Success** 확인.
5. Railway APP 콘솔에서 **`npm run migrate`** 실행(0085 적용).

### B. 프런트엔드
6. `refatrix-settlement.html` repo 최상위에 덮어쓰기 → push → GitHub Pages 1~2분.
7. 수금/정산 화면 **`Ctrl+Shift+R`** (이 파일 nav 마커 `v20260625d`).

> nav.js 자체는 **변경 없음** → 다른 HTML 파일들의 마커는 **bump 불필요**(탭이 settlement 내부에 있어서).

### C. 배포 검증 (raw URL)
```bash
curl -s "https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main/refatrix-api/src/routes/notaCreditoRoutes.js" | grep -c "/api/nc"
# 0보다 크면 라우트 반영됨
curl -s -o /dev/null -w "%{http_code}\n" "https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main/refatrix-api/migrations/0085_notas_credito.sql"
# 200이면 마이그레이션 반영
curl -s "https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main/refatrix-settlement.html" | grep -c "toggleNc"
# 0보다 크면 화면 반영됨
```

---

## ③ 테스트 방법 (운영 스모크)

1. **(영업지원)** 수금/정산 → 미수 인보이스 행 **[NC]** → concepto `pago anticipado en 15 días, 3% descuento`, 방식 `할인률(%)` 3 입력 → 미리보기에 `총액 = base + IVA` 확인 → **발기**.
2. 아래 **NC 목록**(초안)에서 **🖨 인쇄** → 새 창에 머리글+Concepto+서명란 → 인쇄/서명.
3. **서명본 업로드** → 증빙 칸 **👁 보기** 동작 확인.
4. **(디렉터 로그인)** NC 목록에서 **승인**(증빙 있어야 활성).
5. **(영업지원)** **적용(비현금 반제)** → 메시지 “적용 완료 · 잔액 …(완납)”. 위 오픈 인보이스에서 그 인보이스가 **완납**으로 바뀌는지 확인.
6. **이중계상 점검**: 재무 거래목록에 **NC 관련 4010 수금거래가 생기지 않음**(현금 입금분만 존재) 확인.
7. **(디렉터)** 적용된 NC **취소** → 인보이스 잔액이 할인분만큼 **다시 미수**로 복원되는지 확인.

---

## ④ 변경 파일

| 파일 | 변경 |
|---|---|
| `refatrix-api/migrations/0085_notas_credito.sql` | 신규: `notas_credito`, `nota_credito_docs` 테이블 + `sales_payment_allocations`에 `kind`·`nc_id` 추가, `payment_id` NULL 허용 |
| `refatrix-api/src/routes/notaCreditoRoutes.js` | 신규: NC 엔드포인트 8개 |
| `refatrix-api/src/server.js` | **(수동 2줄)** import + `app.register(notaCreditoRoutes)` |
| `refatrix-settlement.html` | NC 카드(목록·상태필터) + 오픈 인보이스 행 **[NC]** 발기 폼 + 인쇄/업로드/승인/적용/취소 JS; nav `v20260625d` |

---

## ⑤ API 명세

| 메서드/경로 | 권한 | 설명 |
|---|---|---|
| `POST /api/nc` | settlement | 발기. body `{invoice_id, concepto, rate_pct? \| total_mxn?}`. 잔액 캡·IVA 분리. → draft |
| `GET /api/nc?status=&invoice_id=&q=` | settlement | 목록(분류 조회). status=draft\|approved\|applied\|void\|all |
| `GET /api/nc/:id` | settlement | 상세(+`invoice_outstanding`, `has_doc`) |
| `POST /api/nc/:id/doc` | settlement | 서명 증빙 업로드(data URL, image/*·pdf) |
| `GET /api/nc/:id/doc/file` | settlement | 증빙 파일 보기 |
| `POST /api/nc/:id/approve` | **디렉터** | 승인(증빙 있어야 가능) → approved |
| `POST /api/nc/:id/apply` | settlement | **비현금 반제** 적용(approved + 잔액 이내) → applied. 4010 미생성 |
| `POST /api/nc/:id/void` | **디렉터** | 취소. 적용분 배분 제거 → 인보이스 잔액 복원 → void |

---

## ⑥ 데이터 모델

- `notas_credito`: id, invoice_id→sales_invoices, customer_id→customers, concepto, rate_pct(nullable), **total_mxn**(IVA포함=반제금액), base_mxn, iva_mxn, **status**(draft\|approved\|applied\|void), **cfdi_uuid**(2단계용·현재 NULL), created/approved/applied/voided by·at.
- `nota_credito_docs`: id, nc_id→notas_credito(ON DELETE CASCADE), file_name, mime_type, file_data(base64), uploaded_by·at.
- `sales_payment_allocations` 확장: **`kind`** TEXT DEFAULT `'cash'`('cash'\|'nota_credito'), **`nc_id`** BIGINT→notas_credito, **`payment_id` NOT NULL 해제**(NC 배분은 payment 없이).

> node-pg는 NUMERIC/BIGINT를 문자열로 반환 → 라우트에서 `Number()` 변환 적용함.

---

## ⑦ 검증 내역 (이번 세션)

- `node --check`: notaCreditoRoutes.js · settlement.html 인라인 스크립트 — OK
- **pglast**: 0085 마이그레이션 parse OK
- **pg-mem 7/7**: 현금 반제 후 잔액=2000 · 4010 1건 / **NC 적용 후 잔액=0(완납)** / **NC는 4010 미생성(이중계상 없음)** / NC 배분 payment_id NULL / **취소 후 잔액 복원** / 취소 후에도 현금 4010 1건 유지
- **jsdom 18/18**: AR 행 NC 버튼(미완납만) / IVA 분리(3%→3000=2586.21+413.79, 금액2000=1724.14+275.86) / 상태별 액션(draft·approved·applied·디렉터 게이트) / 목록 렌더(concepto·상태칩) / **인쇄 HTML**(Concepto 상단·담당자+디렉터 서명란·base/IVA/총액·회사 머리글 재사용)

> pg-mem는 상관 서브쿼리 미지원 → outstanding은 LEFT JOIN 집계 형태로 검증(실제 운영 쿼리와 동일).

---

## ⑧ 남은 과제 / 향후 (2단계 이후)

- **CFDI de egreso 연동(세무)**: 멕시코 SAT 규정상, 인보이스 발행 후 할인은 CFDI de egreso(nota de crédito, UsoCFDI **G02**, 원 인보이스 UUID 연결, IVA 비례 차감)를 발행해야 ISR·IVA가 정확히 차감됨(CFF 29조·Anexo 20). 2단계에서 facturación/PAC 발행 후 **`cfdi_uuid` 저장 + 적용 게이트에 UUID 필수화** 추가 예정. 발행 시 forma de pago 코드 등 세부는 contador 확인 필요.
- **인쇄 양식**: 현재 머리글은 `/api/company`(명세서와 동일 소스) 재사용. 인보이스 전용 양식과 픽셀 단위로 맞추려면 인보이스 인쇄 템플릿에서 직접 이식 가능.
- **표시 반올림**: 인쇄 금액은 앱 표준(`fmt`, 소수점 0자리)으로 표기 — 저장값은 2자리 정밀. 필요 시 인쇄만 2자리 표기로 변경 가능.
- 이전 세션 잔여 항목(마이그레이션 서버 시작 자동실행, 계정과목 관리 UI, recost 평균원가 통합 등) 유효.

---

*이 문서는 인수인계용 스냅샷입니다. 큰 변경이 생기면 갱신해서 다시 올려주세요.*
