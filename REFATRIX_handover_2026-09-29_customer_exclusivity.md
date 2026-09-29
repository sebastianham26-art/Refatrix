# REFATRIX 인수인계 — 고객 독점 정책 · 판매 영업사원 · 서류 관문 (공지 2026-09-28)

- 작업일: 2026-09-29
- 마이그레이션: **0235**(`0235_customer_exclusivity.sql`) — `npm run migrate` 필수
  - ⚠ 번호 변경: 같은 날 전자결재가 **0234**(`0234_e_approval.sql`)를 먼저 썼다 → 이 패키지는 **0235**. 두 파일은 서로 테이블이 겹치지 않는다
- 베이스: GitHub `main` 라이브 clone (HEAD `1e2cf2f` 「결재기능」 — 전자결재·CTR 색상·09-28 커미션 모두 포함, 재작성 2026-09-29 10:30)
- 산출물: `refatrix_exclusivity_0929.zip` (레포 구조 그대로 → 루트에서 풀면 제자리) + 개별 파일
- 빌드 토큰: quote `qt-0929ex` · quotelist `ql-0929ex` · sales `sl0929ex` · customers `tx-0929ex` · custform `v20260929ex` · funnel `0929ex`
- nav.js 변경 **없음** — 라이브 토큰 `refatrix-nav.js?v=20260929ea`(전자결재)를 그대로 유지. 다른 HTML 손대지 않음

---

## ① 설명 — 무엇이 바뀌나

| 공지 항목 | 구현 |
|---|---|
| RFC 등록 → 30일 독점 | 기산일 = **디렉터 승인일**(RFC 가 나중에 승인되면 그 날). 기산일 포함 30일. 독점권자 = RFC 선점자 |
| 30일 안에 인보이스 없으면 소멸 | 날짜로 자동 판정(크론 없음). 소멸 후엔 **누구나** 판매 가능 |
| 첫 인보이스 → 1년 독점 | 인보이스 날짜부터 1년(포함). 개방 상태면 **그 인보이스의 판매 영업사원**이 가져감 |
| 1년 중 서로 다른 6개월 매출 → 자동 1년 연장 | 같은 달 여러 건 = 1개월. 연장 못 하면 다시 개방 → 다음 인보이스 낸 사람이 새 1년 |
| 독점 중 커미션은 독점권자만 | `sales_invoices.commission_agent_id` = **인보이스 날짜의 독점권자로 고정** |
| 할인 = Constancia + 주소 증빙 | 둘 다 있을 때만 할인. 없으면 실효 할인 0% |
| 외상 = 경쟁사 서스펜션 구매 인보이스 | 있으면 30일, 없으면 **선입금(0일)** |
| 서류 없이 등록 가능 | 가능. 대신 등록 화면에서 **경고 팝업** → 「서류 없이 등록」/「돌아가기」 |
| 인보이스·견적에 판매 영업사원 | `seller_id` 칸 신설 + 견적서·견적목록 인쇄·인보이스 PDF 에 **Vendedor** 표시 |

**적용 범위 (디렉터 결정)**

- **독점 정책**: 2026-09-28 이전에 매출이 한 번도 없던 고객 + 이후 신규 고객 (`customers.excl_policy`)
- **서류 관문**: 2026-09-28 이후 **등록된** 신규 고객만 (`customers.doc_gate`). 기존 고객의 할인·외상은 그대로
- **기존 거래 고객**: 독점 없음. 커미션은 **발행 시점 고객 담당자로 고정**(이관해도 과거 인보이스는 안 따라감)

### 판매 가능 규칙 (견적 저장 · 매출 등록 · 견적→매출 전환 공통)

| 고객 상태 | 영업(role=sales) 본인 | 영업지원·디렉터가 대신 등록 |
|---|---|---|
| 남의 독점 | **차단** `exclusive_other` (독점권자·만료일 안내) | 가능 — 판매자는 **독점권자로 고정** |
| 내 독점 | 가능 (판매자 = 나, 잠김) | 가능 (판매자 = 독점권자) |
| 개방 | 가능 — 본인 이름으로만(`seller_self_only`) → 이 판매로 1년 독점 | **판매자 선택 필수**(`seller_required`) |
| 기존 거래 고객 | 가능 | 판매자 = 선택값 → 없으면 고객 담당자 |

견적 단계에서는 개방 고객의 판매자를 비워 둘 수 있다(포털 견적 등). **독점권은 전환 시점에 다시 판정**하므로, 둘이 견적했으면 먼저 인보이스 낸 사람이 가져간다.

독점권자가 바뀌면 고객마스터 담당자·팀도 그 사람으로 옮겨진다(화면·팀 가시성이 따라온다). 이미 지급된 커미션은 종전대로 동결.

### 서류 관문 동작 방식 (핵심 설계)

`customers.discount` / `credit_days` 를 읽는 곳이 30곳이 넘는다(견적·매출·CRM·현장조사·오퍼시트…). 하나씩 고치면 반드시 빠진다.
→ **DB 트리거**로 해결: `discount`/`credit_days` 는 **실효값**, 영업이 정한 값은 `discount_agreed`/`credit_days_agreed`(약정값)에 보관.

- 앱이 할인·외상일을 쓰면 → 약정값으로 저장, 실효값은 서류 기준으로 다시 계산
- 서류 업로드·삭제 → 그 고객의 실효값 즉시 재계산 (`trg_customer_docs_sync`)
- 고객 상세·수정 화면은 **약정값**을 보여 주고 고친다(서류 없는 고객 수정이 「할인 변경」으로 잡히지 않게)
- 고객 목록·견적·매출은 실효값을 쓴다

---

## ② 배포 단계

| 파일 | 위치 | 구분 |
|---|---|---|
| `0235_customer_exclusivity.sql` | `refatrix-api/migrations/` | **신규** |
| `exclusivity.js` | `refatrix-api/src/` | **신규** |
| `exclusivityRoutes.js` | `refatrix-api/src/routes/` | **신규** |
| `server.js` | `refatrix-api/src/` | 덮어쓰기 |
| `salesRoutes.js` · `quoteRoutes.js` · `customerRoutes.js` · `commissionRoutes.js` · `commissionBonus.js` · `grossProfitRoutes.js` · `devRequestRoutes.js` | `refatrix-api/src/routes/` | 덮어쓰기 |
| `refatrix-quote.html` · `refatrix-quotelist.html` · `refatrix-sales.html` · `refatrix-customers.html` · `refatrix-funnel.html` · `refatrix-custform.js` | 레포 루트 | 덮어쓰기 |
| `customer_exclusivity.test.mjs` · `customer_exclusivity_e2e.test.mjs` · `customer_exclusivity_front.test.mjs` · `crm_inbound.test.mjs` · `customer_registration.test.mjs` · `inactive_convert_sale.test.mjs` · `quote_devreq_front.test.mjs` · `product_oe_front.test.mjs` | `refatrix-api/test/` | (선택) 검증용 |

1. GitHub Desktop **Fetch/Pull** → zip 을 레포 루트에서 풀기 → **Commit → Push** → Railway **Success**
2. **🔴 Railway APP 콘솔 `npm run migrate`** → `apply 0235_customer_exclusivity.sql` (전자결재 0234 를 아직 안 돌렸으면 `apply 0234_e_approval.sql` 도 함께 나온다)
   - migrate 전에도 500 없음: 판매자·독점 판정은 꺼져 있고(기존 동작), 커미션은 종전대로 고객 담당자
3. 서버 재기동 15초 후 독점 대상 고객 전체를 한 번 재계산한다(이후 6시간마다). 즉시 돌리려면 디렉터로 `POST /api/exclusivity/recompute`
4. 각 화면 **Ctrl+Shift+R** → 탭 제목의 빌드 토큰 확인

```bash
R=https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main; N="?nc=$(date +%s)"
curl -s -o /dev/null -w "%{http_code}\n" "$R/refatrix-api/migrations/0235_customer_exclusivity.sql$N"   # 200
curl -s "$R/refatrix-api/src/server.js$N" | grep -c "approvalRoutes"                                    # 2 (전자결재 유지 확인)
curl -s "$R/refatrix-api/src/server.js$N" | grep -c "exclusivityRoutes"                                 # 2
curl -s "$R/refatrix-api/src/routes/salesRoutes.js$N" | grep -c "resolveSeller"                          # 2
curl -s "$R/refatrix-api/src/routes/commissionRoutes.js$N" | grep -c "commission_agent_id"               # >0
curl -s "$R/refatrix-quote.html$N" | grep -c "qt-0929ex"                                                 # 1
curl -s "$R/refatrix-custform.js$N" | grep -c "v20260929ex"                                              # 1
```

## ③ 테스트 방법 (운영 스모크 10분)

1. **고객 등록** → 서류 없이 저장 → ⚠ 팝업(「할인이 적용되지 않습니다」·「선입금」) → 「돌아가기」면 저장 안 됨 / 「서류 없이 등록」이면 저장
2. 등록 화면에서 ③(경쟁사 인보이스)만 고르면 외상일 30 자동, ①+② 둘 다 골라야 「✔ 할인 적용」
3. 디렉터 승인 → 고객 상세 「🔒 고객 독점 · 거래 조건」 박스: `○○ 독점 · YYYY-MM-DD 까지 (29일 남음)` + 할인/외상 배지
4. **다른 영업사원** 계정으로 그 고객 견적 → `⛔ ○○ 님의 독점 고객입니다`
5. 영업지원(Maria)으로 매출 등록 → 판매 영업사원 칸이 독점권자로 **잠겨** 있음 → 등록 → 고객 상세가 `판매 1년` 으로 바뀜
6. 견적 인쇄 → `Atendió: … Vendedor: …` / 견적 목록 인쇄 → `Vendedor:` / 수주 흐름 인보이스 PDF → `Vendedor:`
7. 서류 없는 신규 고객 매출 → 외상 0일(만기일 = 인보이스일) 확인
8. 커미션 화면 → 그 인보이스가 독점권자에게 잡히는지. 고객 담당을 바꿔도 **그대로 남는지**

## ④ 변경 파일

| 파일 | 내용 |
|---|---|
| `migrations/0235_customer_exclusivity.sql` | `seller_id`(인보이스·견적) · `commission_agent_id` · `excl_policy`/`doc_gate` 판정 · `rfc_excl_from`/`rfc_excl_agent_id` 백필 · 약정값 컬럼 · 트리거 2개 · 기존 인보이스 판매자/귀속 백필 |
| `src/exclusivity.js` | 독점 계산 순수함수 `computeExclusivity` · `resolveSeller`(판매 가능 판정) · `recomputeCustomer` · 기동/주기 스윕 · 삭제·NC·금액조정 후 자동 재계산 훅 |
| `src/routes/exclusivityRoutes.js` | `GET /api/customers/:id/exclusivity` · `GET /api/exclusivity/check` · `GET /api/sellers` · `POST /api/exclusivity/recompute` |
| `salesRoutes.js` | 매출 등록 시 판매자·독점 판정, `seller_id`/`commission_agent_id` 저장, 커밋 후 재계산 |
| `quoteRoutes.js` | 견적 저장·수정·전환에 판매자·독점 판정, 전환 시 판매자 전달, 상세에 `seller_name` |
| `customerRoutes.js` | 상세·수정·승인·변경요청은 **약정값** 기준, 상세에 실효값·관문 여부, 등록 응답에 할인/외상 안내 |
| `commissionRoutes.js` · `commissionBonus.js` · `grossProfitRoutes.js` | 수혜자: 지급 동결 → 팀 수혜자 → **인보이스 귀속** → 고객 담당자 |
| `devRequestRoutes.js` | 인보이스 상세에 `seller_name` (PDF 용) |
| `refatrix-quote.html` | 판매 영업사원 드롭다운 + 독점 배지, 인쇄·엑셀에 Vendedor |
| `refatrix-quotelist.html` | 전환 모달 판매자 선택 + 독점 안내, 인쇄 Vendedor |
| `refatrix-sales.html` | 매출 등록 판매자 드롭다운 + 독점 안내 |
| `refatrix-customers.html` | 상세 「고객 독점 · 거래 조건」 박스(현재 독점·남은 일수·6개월 진척·할인/외상 배지·이력), 서류 종류 라벨 |
| `refatrix-custform.js` | 서류 박스 문구(①②→할인, ③→외상), ③ 선택 시 외상 30 자동, **서류 부족 경고 팝업** |
| `refatrix-funnel.html` | 인보이스 PDF·상세에 판매 영업사원 |

## ⑤ 검증 결과

- `node --check`: 변경 JS 12개 + HTML 인라인 스크립트 5개 화면 ✅
- **pglast**: 0235 (36문) ✅ · 새·변경 SQL 14건 ✅ (정규식 치환이 못 푸는 중첩 템플릿 2건은 아래 실 DB 에서 실행 확인)
- **순수 계산** `customer_exclusivity.test.mjs` **11/11** — 30일·1년 경계, RFC 기간 중 타인 명의 인보이스, 소멸 후 선착순, 6개월 연장/5개월 개방, 같은 달 중복, 전액 반품, 첫 인보이스 취소
- **실 PostgreSQL 16 종단** `customer_exclusivity_e2e.test.mjs` **12/12** (0001→0235 클린 적용)
  - 승인일 기산 · 서류별 할인/외상 전환 · 서류 삭제 시 선입금 복귀 · 영업 차단/지원 대리 등록 · 개방 선착순 + 담당 이동 · 인보이스 삭제 훅 재계산 · 이관 후 커미션 불변 · 기존 고객 무영향 · 수정 화면 약정값 · 변경된 조회 11개 엔드포인트 스모크
- **백필 검증**(0233 DB 에 합성 데이터 → 0235): 9/20 매출 고객 = 기존 / 9/12 승인 무매출 고객 = 독점 대상·관문 없음·기산 9/12 / 9/28 등록 고객 = 관문 적용·실효 0 ✅
- **jsdom** `customer_exclusivity_front.test.mjs` **5/5** — 팝업 돌아가기/진행, ③ 외상 자동, 견적 판매자 잠금·경고·개방, 인쇄 Vendedor
- **전체 스위트 대조**(변경 전 clone ↔ 변경 후, 각각 클린 DB): 새로 깨진 것 **0건**
  - `crm_inbound` 1건: 신규 웹 고객의 할인·외상 기대값 → 약정값 기준으로 테스트 갱신(서류 없으면 실효 0 이 정책상 맞음)
  - `quote_devreq_front` · `product_oe_front`: 빌드 토큰만 `qt-0929ex` 로 갱신
  - `customer_registration` H5·H7: 옛 「3종 완비 → 독점 + 외상 30일」 검사를 새 규칙(①+②→할인, ③→외상, 상세는 서버 판정)으로 갱신. E8(빌드 마커)은 변경 전부터 실패
  - `inactive_convert_sale`: 담당자 없는 신규 고객 = 개방 고객이라 전환 때 판매 영업사원 지정이 필요 → 테스트에 `seller_id` 추가(정책상 맞는 동작)
  - 나머지 기존 실패(TEST_PG_URL·jsdom 관련, 프런트 5종)는 변경 전과 **동일**
  - 재작성(1e2cf2f 베이스) 후 재검증: 0001→0235 클린 적용 · 재실행 멱등 · 독점 순수 11/11 · 종단 12/12 · 화면 5/5 · 커미션 3종(9·15·12) 전부 통과
  - 전자결재 `approval` C-E2E 1건 · `approval_front` F1 1건 실패는 **라이브 main 그대로에서도 똑같이 실패**(이 패키지와 무관, 전자결재 쪽 확인 필요)

## ⑥ 결정사항 (2026-09-29 디렉터)

1. 인보이스에 판매 영업사원 칸, 견적·인보이스 출력에 이름 표시
2. RFC 등록 기준으로 30일
3. 기산일 = 디렉터 승인일
4. 1년 만료 시 연장 조건 미달 → 개방, 다음 인보이스 낸 사람이 새 1년
5. 서류 관문은 신규 고객만, 서류 부족 시 등록 화면 경고 팝업
6. 담당이 바뀌어도 커미션은 인보이스 날짜의 독점권자로 고정 (09-28 「미지급분은 새 담당자」 규칙을 대체)

구현 중 정한 세부 (이의 있으면 알려 주세요)

- 「30일」 = 기산일 포함 30일(10/1 승인 → 10/30 까지). 「1년」 = 10/3 → 다음 해 10/2 까지
- **전액 반품(순매출 0 이하)** 인보이스는 독점을 만들거나 6개월에 세지 않는다. 최소 금액은 없다
- RFC 독점 기간 중 영업지원이 다른 이름을 넣어도 판매자·커미션은 독점권자
- 「신규 고객」(서류 관문) = 2026-09-28 00:00(멕시코) 이후 등록된 고객

## ⑦ 오픈이슈 — 운영 영향 확인 필요

- 🔴 **9/28 이전에 등록·승인됐고 매출이 없는 고객 중, 승인일이 30일 넘게 지난 고객은 migrate 즉시 개방된다**(결정 2·3 의 결과). 담당 영업사원이 보호받는다고 알고 있던 고객일 수 있다. migrate 후 확인:
  ```sql
  SELECT c.code, c.name, u.name AS 담당, c.rfc_excl_from AS 기산일
    FROM customers c LEFT JOIN users u ON u.id=c.owner_id
   WHERE c.excl_policy AND c.deleted_at IS NULL AND c.excl_kind IS NULL
   ORDER BY c.rfc_excl_from;
  ```
- 🔴 **9/28 이후 이미 등록된 신규 고객**은 서류가 없으면 migrate 즉시 **할인 0% · 선입금**이 된다. 진행 중인 견적은 저장된 할인율 그대로지만, 새 견적·직접 매출부터 적용된다
  ```sql
  SELECT c.code, c.name, c.discount_agreed AS 약정할인, c.discount AS 실효할인,
         c.credit_days_agreed AS 약정외상, c.credit_days AS 실효외상
    FROM customers c
   WHERE c.doc_gate AND c.deleted_at IS NULL
     AND (c.discount <> c.discount_agreed OR c.credit_days <> COALESCE(NULLIF(c.credit_days_agreed,0),30));
  ```
- CRM(포털) 고객 동기화도 실효 할인을 보낸다 → 서류 없는 신규 고객은 포털 가격에도 할인이 안 붙는다(정책과 일치, 인지 필요)
- **커미셔너 안내서**(`refatrix-guia-comisionista.html`)는 아직 「서류 3종 → 독점 + 외상 30일」 옛 정책이다 → 스페인어 문구·다이어그램 갱신 필요
- 09-28 커미션 테스트(`commission_customer_owner_e2e` ⑤ 「이관 시 미지급분 새 담당자」)는 귀속값이 비어 있는 옛 인보이스 경로로 여전히 통과하지만, 규칙 자체는 이번 결정으로 대체됐다

## ⑧ 다음 액션

1. 배포 + migrate → ⑦ 의 두 SQL 로 즉시 영향 고객 확인 (필요하면 특정 고객 기산일을 디렉터가 조정)
2. 커미셔너 안내서 스페인어 갱신
3. (선택) 고객 목록에 독점 배지 열(`excl_kind`·`excl_until` 캐시 이미 있음)
