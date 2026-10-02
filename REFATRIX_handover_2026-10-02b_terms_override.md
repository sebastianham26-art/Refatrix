# REFATRIX 인수인계 — 서류 관문 디렉터 PIN 승인 예외 + CRM 할인·외상 전송

- 작업일: 2026-10-02
- 마이그레이션: **0247**(`0247_customer_terms_override.sql`) — `npm run migrate` 필수
  - ⚠ 번호 변경: 전자결재가 **0246**(`0246_e_approval_custom_line.sql`)을 먼저 썼다 → 이 패키지는 **0247**. 서로 겹치는 테이블 없음
- 베이스: GitHub `main` 라이브 clone (HEAD `e01dcc5` 「결재문서 결제선 수정기능」, 재작성 2026-10-02 16:30)
- 산출물: `refatrix_terms_override_1002.zip` (레포 구조 그대로) + 개별 파일
- 빌드 토큰: customers `tx-1002ov` (nav.js·custform.js 변경 없음 → 다른 화면 토큰 그대로)

---

## ① 설명

**증상**: 서류(0235 관문)가 모자란 신규 고객은 실효 할인·외상일이 0 이라 **CRM 에도 0 이 전송**됐다.
CRM 본문은 `customers.discount` / `credit_days`(실효값)을 그대로 보내기 때문이다.

**디렉터 지시**: 조건이 안 돼도 **디렉터 PIN 승인**으로 조건을 충족시킨 것으로 보고, 할인율·외상일이 전송되게 한다.

| 구현 | 내용 |
|---|---|
| 승인 플래그 | `customers.discount_override` · `credit_override` (+ 승인자·일시·사유) |
| 실효값 계산(트리거) | 할인 = (Constancia + 주소 증빙) **또는 할인 승인** → 약정 할인 / 외상 = 경쟁사 인보이스 **또는 외상 승인** → 약정 외상일(약정 0 이면 30일) |
| 승인 API | `POST /api/customers/:id/terms-override` `{discount?, credit?, pin, reason}` — 디렉터 전용, PIN 검증, 켤 때 사유 필수 |
| CRM 전송 | 승인·해제로 실효값이 바뀌면 즉시 `upsert` 대기열 (승인 대기 고객은 승인 시점에 나감 — 기존 규칙) |
| **추가 수정** | 고객 상세에서 **서류를 나중에 올리거나 지울 때도** 실효값이 바뀌면 CRM 재전송. 전에는 서류를 올려도 CRM 은 등록 당시의 0 그대로였다 |
| 화면 | 고객 상세 「🔒 고객 독점 · 거래 조건」 박스에 디렉터 전용 **🔑 디렉터 PIN 승인** 패널(할인/외상 체크 · 사유 · PIN). 승인 중이면 배지에 `· 디렉터 승인` + 승인자·일시·사유 |

- 할인과 외상은 **따로** 승인할 수 있다. 서류가 이미 있는 항목은 체크박스가 나오지 않는다.
- 체크를 풀고 PIN 저장하면 해제 → 즉시 서류 기준으로 복귀(CRM 에도 다시 전송). 약정값은 보존된다.
- 승인 중 약정 할인을 바꾸면 새 약정값이 그대로 적용·전송된다(기존 디렉터 수정 경로가 CRM 전송).
- 서류 관문 대상이 아닌 기존 고객에는 쓸 수 없다(`not_gated` — 이미 등록 조건 그대로 적용 중).
- 이력: `customer_registration_events(action='terms_override')` 에 전후 값과 사유 기록.

## ② 배포 단계

| 파일 | 위치 | 구분 |
|---|---|---|
| `0247_customer_terms_override.sql` | `refatrix-api/migrations/` | **신규** |
| `exclusivity.js` | `refatrix-api/src/` | 덮어쓰기 |
| `exclusivityRoutes.js` · `customerRoutes.js` | `refatrix-api/src/routes/` | 덮어쓰기 |
| `refatrix-customers.html` | 레포 루트 | 덮어쓰기 |
| `customer_exclusivity_e2e.test.mjs` · `customer_exclusivity_front.test.mjs` | `refatrix-api/test/` | (선택) 검증용 |

1. GitHub Desktop **Fetch/Pull** → zip 을 레포 루트에서 풀기 → **Commit → Push** → Railway **Success**
2. **🔴 Railway APP 콘솔 `npm run migrate`** → `apply 0247_customer_terms_override.sql`
   - migrate 전 배포해도 500 없음: 화면은 승인 패널이 「migrate(0247) 필요」로 잠기고 나머지는 종전대로
3. 고객등록 화면 **Ctrl+Shift+R** → 탭 제목 `tx-1002ov`

```bash
R=https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main; N="?nc=$(date +%s)"
curl -s -o /dev/null -w "%{http_code}\n" "$R/refatrix-api/migrations/0247_customer_terms_override.sql$N"  # 200
curl -s "$R/refatrix-api/src/routes/exclusivityRoutes.js$N" | grep -c "terms-override"                  # >0
curl -s "$R/refatrix-api/src/routes/customerRoutes.js$N" | grep -c "resyncIfTermsChanged"                # 3
curl -s "$R/refatrix-customers.html$N" | grep -c "tx-1002ov"                                             # 1
```

## ③ 테스트 방법 (운영 스모크 5분)

1. 서류 없는 신규 고객 상세 → `할인 미적용` · `선입금` 배지 + **🔑 디렉터 PIN 승인** 패널(디렉터만 보임)
2. 할인·외상 체크 → 사유 → PIN → 저장 → 배지가 `할인 적용 N% · 디렉터 승인` / `외상 N일 · 디렉터 승인`
3. 관리 → CRM 연동(전송 이력) → 그 고객의 최신 전송 본문 `discountPercent` · `paymentDays` 가 약정값인지
4. 영업 계정으로 같은 고객 상세 → 패널이 **없는지**
5. 서류 관문 고객에 경쟁사 인보이스를 업로드 → 외상 배지 변경 + CRM 전송 이력에 `docs_terms_change` 1건

## ④ 변경 파일

| 파일 | 내용 |
|---|---|
| `migrations/0247_customer_terms_override.sql` | override 컬럼 5개 · `refx_customer_terms_gate()` 교체(예외 플래그 반영, 나머지는 0235 그대로) |
| `src/exclusivity.js` | `statusFor().gate` 에 `discount_override`·`credit_override`·`*_docs_ok`·승인자/일시/사유. `discount_ok`/`credit_ok` 는 승인 포함 |
| `src/routes/exclusivityRoutes.js` | `POST /api/customers/:id/terms-override` (디렉터·PIN·사유·이력·CRM 전송) |
| `src/routes/customerRoutes.js` | 서류 업로드·삭제 후 실효값이 바뀌면 CRM 재전송(`resyncIfTermsChanged`) |
| `refatrix-customers.html` | 승인 패널 · `saveOverride()` · 배지 표시 |

## ⑤ 검증 결과

- `node --check` 3파일 + 화면 인라인 스크립트 ✅ · **pglast** 0247(8문) + 신규 SQL 7건 ✅
- 실 PostgreSQL 16 클린 DB(0001→0247) 적용 + 재실행 멱등 ✅
- 종단 `customer_exclusivity_e2e` **14/14** (신규 E11·E12)
  - 디렉터 전용(영업 403) · 틀린 PIN 403 · 사유 없음 거절(값 불변) · 할인만 승인 → CRM `discountPercent` 38 · `paymentDays` 0 · 외상 추가 승인 → 45 · 화면 상태 · 승인 중 약정 변경 반영 · 해제 → 0 복귀 + CRM 0 재전송 · 약정값 보존 · 이력 3건 · 기존 고객 409
  - 서류 업로드로 외상 생김 → CRM 재전송 1건 / 실효값 안 바뀌는 업로드는 전송 안 함
- jsdom `customer_exclusivity_front` **6/6** (신규 F6: 영업에겐 패널 없음 · PIN/사유 검증 · 저장 본문 · 결과 배지)
- 관련 스위트 라이브 main 대비 **동일**: crm_sync 36/2 · crm_inbound 31/0 · crm_inbound_key_clear 9/0 · crm_web_lead 27/0 · customer_registration 74/1 · commission 3종 · inactive_convert_sale · customers_page_edit (기존 실패 수 그대로)
- 테스트 정리: E10 의 「독점 대상 ≥3」 은 재사용 DB 에서만 맞던 가정 → 클린 DB 기준 ≥2. F4·F5 는 다른 작업으로 계속 바뀌는 빌드 토큰 대신 기능 존재를 검사

## ⑥ 결정사항

- 디렉터 PIN 승인으로 서류 조건을 임의 충족 → 약정 할인율·외상일 적용 + CRM 전송 (2026-10-02)
- (구현) 할인·외상 **개별 승인**, 켤 때 사유 필수, 해제도 PIN 필요, 해제 시 서류 기준 즉시 복귀

## ⑦ 오픈이슈

- 지금 서류 없이 0 으로 CRM 에 나가 있는 고객은 **승인을 걸어야** 다시 나간다(자동 일괄 승인 없음). 대상 확인:
  ```sql
  SELECT code, name, discount_agreed, discount, credit_days_agreed, credit_days
    FROM customers
   WHERE doc_gate AND deleted_at IS NULL
     AND (discount < discount_agreed OR credit_days < COALESCE(NULLIF(credit_days_agreed,0),30));
  ```
- 등록 화면의 서류 부족 팝업 문구에는 「디렉터 승인 가능」 안내가 아직 없다(custform 변경 시 함께)
- 기존 코드의 `approve_registration` 감사 로그가 `audit_log_action_check` 에 걸려 기록되지 않는다(이번 변경과 무관, 기존부터)

## ⑧ 다음 액션

1. 배포 + migrate → ⑦ SQL 로 대상 고객 확인 → 필요한 고객에 PIN 승인
2. (선택) 등록 승인 화면에서 바로 PIN 승인하는 버튼
