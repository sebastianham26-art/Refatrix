# REFATRIX 인수인계 2026-09-18 — 신규 고객 필수 4종 + CRM 전송 신원 동기화 (v2)

**마이그레이션 없음** (`npm run migrate` 불필요) · 백엔드 2 + 프런트 2 + 테스트 1
**산출물 zip**: `refatrix_customer_required_fields_v2.zip`
라우트 rev **`20260918tier`** · custform **`v20260918tier`** · 고객화면 build **`tx-0918tier`**
베이스: 2026-09-18 라이브 HEAD (편집 직전 cache-busted raw URL 로 재수신 · v2 작업 시 `crmSync.js` 재대조)

> **v2 에서 추가된 것**: 상거래정보 창구(`upsert`) 전송 본문에도 신원 4종을 함께 싣는다.
> v1 은 `create`(CRM 에 없는 고객을 새로 만드는 폴백) 본문에만 실렸다. **v2 하나만 배포하면 된다.**

---

## ① 설명 — 무엇을, 왜

### 디렉터 지시 (2026-09-18)
> "ERP에서 고객등록할 때 이메일 주소를 반드시 입력하도록 해줘"
> "Para un RFC nuevo son requeridos razonSocial, contactEmail, contactPhone y businessTypeId — 이것들이 신규고객입력에 반드시 들어가도록 해줘"
> "회사종류 4가지가 이렇게 연결되도록 해줘" (TIER A~D 드롭다운 캡처)
> "(upsert 전송에도 신원을 실을지) 응. 그래야지"

### 지금까지의 문제

**(가) 입력이 비어도 아무도 안 막았다.**
CRM(웹 카달록)은 **새 RFC 를 받을 때 네 가지를 요구**하는데 ERP 고객 등록 폼은 이메일·전화·회사 종류가
전부 선택 입력이었다. 그래서: 영업사원이 이메일 없이 등록 → 디렉터 승인 → CRM 전송 → **CRM 이 거절** →
그 사실은 **연동 관리 아웃박스를 들여다봐야만** 알 수 있다. 고객은 카달록에서 가격도 재고도 못 보고,
우리는 며칠 뒤에 안다. 이메일이 비면 **팩투라(청구서)와 오퍼시트도 보낼 곳이 없다.**

**(나) 이미 CRM 에 있는 고객은 연락처가 바뀌어도 CRM 이 몰랐다.**
승인·수정이 확정되면 ERP 는 상거래정보 창구(`customer_commercial`)로 `upsert` 를 쏘는데, 그 본문은
**`rfc`·`discountPercent`·`paymentDays`·`estatus`·`transactionUser` 다섯 개뿐**이었다.
ERP 에서 이메일을 고쳐도 CRM 쪽은 옛 주소 그대로였다.

### 이번에 바꾼 것

| | 전 | 후 |
|---|---|---|
| 이메일 주소 | 선택 (형식만 검사) | **신규·수정 모두 필수** · 프런트 + 서버 이중 강제 |
| 전화 (인보이스 수신) | 선택 | **신규 등록 필수** (수정은 막지 않음) |
| 회사 종류 | 자유 목록 5개 (refraccionaria·Mayoreo·Flotia·taller·publico) | **TIER A~D 4가지** · 신규 등록 필수 |
| 미등록 기존 고객 | 표시 없음 | 목록에 **`✉ 이메일 미등록`** 배지 · 상세에 ⚠ 경고 |
| CRM 전송 — `create` | `nombre`·`correo`·`telefono` | **+ `razonSocial`·`contactEmail`·`contactPhone`·`businessType`·`businessTypeId`** |
| CRM 전송 — `upsert` | 다섯 개뿐 (신원 없음) | **+ 위 신원 8개 전부** (빈 값은 키 자체 생략) · 되돌림 스위치 있음 |

### 회사 종류 = TIER (보내 주신 드롭다운 그대로)

| 값 | 화면 표기 | CRM `businessTypeId` (기본값) |
|---|---|---|
| `A` | A · Distribuidor mayorista / cliente estratégico | 1 |
| `B` | B · Distribuidor medio / refaccionaria grande | 2 |
| `C` | C · Refaccionaria / taller establecido | 3 |
| `D` | D · Cliente nuevo / pequeño volumen | 4 |
| (빈값) | Sin seleccionar | 안 보냄 |

### ★ `upsert` 에 신원을 실으면서 반드시 지킨 규칙 — 빈 값은 키를 뺀다

전체 동기화(`scope=all`)를 누르면 **이메일이 비어 있는 레거시 고객이 통째로 섞여 나간다.**
그때 `contactEmail: ""` 를 보내면 **CRM 에 제대로 들어 있던 연락처를 우리가 지워 버린다.**
그래서 값이 없는 항목은 **키 자체를 본문에서 뺀다** — 상대는 "안 보냈으니 그대로 둔다" 로 읽는다.
(`create` 가 원래 쓰던 규칙을 그대로 가져왔고, 테스트로 고정했다.)

### ★ 상대가 거절하면 — 재배포 없이 되돌린다

상거래정보 창구가 모르는 필드를 **엄격하게 거절**하면 승인·수정 전송이 줄줄이 실패할 수 있다.
그 경우 Railway 변수 한 줄로 **즉시** 예전 다섯 항목으로 돌아간다 (저장하면 자동 재시작, 코드 수정 불필요):

```
CRM_UPSERT_IDENTITY=0        (off / false / no 도 됨)
```

끈 상태에서도 **`create` 본문은 신원을 그대로 보낸다** — 등록 창구는 신원이 없으면 고객을 못 만든다.

### ★ 확인 없이 정한 가정 2가지

1. **`businessTypeId` 숫자는 A=1·B=2·C=3·D=4 로 가정했다.** 상대 카탈로그의 실제 아이디를 아직 못 받았다.
   다르면 **코드를 고치지 말고** Railway 변수 하나만 넣으면 된다:
   `CRM_BUSINESS_TYPE_IDS="A=10,B=11,C=12,D=13"`
2. **예전 회사 종류 값(refraccionaria 등)은 지우지 않았다.** 일괄 변환하면 분류가 통째로 날아간다.
   기존 고객을 열면 그 값이 「(기존 값 — TIER 미지정)」 항목으로 그대로 보이고 옆에 ⚠ 가 붙는다.

### 손대지 않은 경로 (의도적)

- **엑셀 일괄등록** — 디렉터 전용이고 대량 이관 경로다. 여기까지 막으면 작업이 멈춘다.
  (정적 가드 테스트로 이 블록이 라이브와 **바이트 단위로 동일**함을 고정해 뒀다)
- **CRM 수신 창구**(`/api/integrations/crm/customer-registration`) — 이미 `correo` 포함 5개가 필수다
- **`delete` · `reject` 전송 본문** — 무변경 (회귀 테스트로 고정)
- **배송지 즉시저장** 등 일부 항목만 보내는 PATCH — 본문에 `contact` 가 실린 경우에만 검사한다

---

## ② 배포 단계 — ⚠ 백엔드 먼저 (마이그레이션 없음)

1. **백엔드 2파일** 덮어쓰기 → GitHub Desktop **Commit / Push**
   - `refatrix-api/src/routes/customerRoutes.js`
   - `refatrix-api/src/crmSync.js`
2. Railway 재배포 **Success** 확인 → 로그에 `[customerRoutes] loaded rev 20260918tier`
   - **`npm run migrate` 불필요** (새 테이블·컬럼 없음)
3. **프런트 2파일** 덮어쓰기 → Push → Pages 1~2분
   - `refatrix-custform.js` · `refatrix-customers.html`
4. 고객등록 화면에서 **`Ctrl+Shift+R`** → 콘솔 `[refatrix-custform] v20260918tier loaded`
5. (선택) `test/custform_required.test.js` 도 함께 push
6. **★ 배포 직후 30분은 연동 관리 › 아웃박스를 한 번 확인하세요.** 상거래정보 창구가 새 필드를
   거절하면 `failed` 가 쌓입니다 → 그때 Railway 변수 `CRM_UPSERT_IDENTITY=0` (⑦-1)
7. (선택) CRM 개발자에게서 businessTypeId 목록을 받으면 `CRM_BUSINESS_TYPE_IDS` 추가

> **반쪽 배포 주의**: 프런트만 먼저 올리면 무해하지만(서버가 그냥 통과시킴), **백엔드만 올리고
> 프런트가 캐시된 구버전이면** 영업사원이 이메일 없이 저장했을 때 서버가 400 을 돌려준다.
> 데이터는 안전하지만 왜 막히는지 모른다. 그래서 순서는 백엔드 → 프런트.
> `refatrix-nav.js` 무변경 → **캐시버스터 일괄 bump 불필요**.

### 배포 검증
```
B=https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main
curl -s "$B/refatrix-api/src/routes/customerRoutes.js?nc=$(date +%s)" | grep -c "20260918tier"            # 6
curl -s "$B/refatrix-api/src/routes/customerRoutes.js?nc=$(date +%s)" | grep -c "business_type_required"  # 1
curl -s "$B/refatrix-api/src/crmSync.js?nc=$(date +%s)" | grep -c "identityFields"                        # 3
curl -s "$B/refatrix-api/src/crmSync.js?nc=$(date +%s)" | grep -c "CRM_UPSERT_IDENTITY"                   # 3
curl -s "$B/refatrix-custform.js?nc=$(date +%s)" | grep -c "v20260918tier"                                # 1
curl -s "$B/refatrix-customers.html?nc=$(date +%s)" | grep -c "20260918tier"                              # 1
```

---

## ③ 테스트 방법 (현장 스모크)

**신규 등록**
1. 영업 › 고객등록 › `+ 고객 등록` → 라벨에 **`이메일 주소 *` · `전화 (인보이스 수신) *` · `회사 종류 · TIER *`**.
2. **회사 종류** 드롭다운이 `Sin seleccionar / A / B / C / D` **다섯 줄**인지 (스페인어 설명 포함).
3. 고객명 + 팀만 넣고 저장 → **`⛔ 이메일 주소를 입력해야 저장됩니다`** · 커서가 이메일 칸으로.
4. 이메일 `abc` → **형식 오류**. `a@b.com` → 통과.
5. 전화 비우고 저장 → **`⛔ 전화번호를 입력해야 등록이 진행됩니다`**.
6. TIER 를 `Sin seleccionar` 로 두고 저장 → **`⛔ 회사 종류(TIER A~D)를 선택해야…`**.
7. 넷 다 채우면 **기존 흐름(RFC 확인 → 기준단가 → 등록 요청)** 으로 그대로 넘어가는지.

**기존 고객 수정**
8. 이메일이 있는 고객을 열어 **이메일만 지우고** 저장 → **막히는지**.
9. 같은 고객의 **전화번호만** 바꿔 저장 → **아무 경고 없이 저장되는지** (TIER 가 예전 값이어도).
10. 회사 종류가 `refraccionaria` 인 고객을 열면 **`refraccionaria (기존 값 — TIER 미지정)`** 이 그대로
    선택돼 있고 라벨 옆에 **⚠ 미지정**. TIER 로 바꿔 저장 → 경고가 사라지는지.

**목록·상세**
11. 이메일이 없는 고객 이름 옆에 **`✉ 이메일 미등록`** 빨간 배지.
12. 회사 종류 칸: `A`~`D` 는 굵게, 예전 값은 `refraccionaria ⚠`, 빈값은 `⚠`.
13. 고객 상세 → **회사 종류 · TIER** 행에 스페인어 전체 설명, **이메일 주소** 행에 미등록 시 빨간 경고.

**★ CRM 전송 (v2 핵심)**
14. **이미 CRM 에 있는 고객**의 이메일을 ERP 에서 바꾸고 저장·승인 → 연동 관리 › 아웃박스에서
    그 전송 건의 **「원문」** 을 열어 **`contactEmail`·`razonSocial`·`contactPhone`·`businessTypeId`** 가
    실렸는지 확인. → **이게 v2 가 제대로 붙었다는 증거**다.
15. **이메일이 비어 있는 레거시 고객**을 하나 골라 할인율만 바꿔 승인 → 같은 화면에서 원문을 열어
    **`contactEmail` 키가 아예 없는지** 확인 (있으면 CRM 의 값을 지운다 — 즉시 알려 주세요).
16. 전송 결과가 `sent` 인지 `failed` 인지 확인. `failed` 이고 사유가 "알 수 없는 필드" 계열이면 ⑦-1.
17. TIER 를 넣은 **신규** 고객 승인 → CRM 에 없으면 폴백으로 `create` 가 나가는지 (본문에 `erpCustomerCode` 포함).

**회귀**
18. **엑셀 일괄등록** — 이메일이 빈 행이 섞인 파일을 올려도 **종전대로 등록되는지**.
19. 고객 삭제 → `delete` 전송 본문이 `rfc` + `transactionUser` **두 개뿐**인지.
20. 등록 반려 → `estatus: rechazado` + `motivoRechazo` 가 **종전대로** 나가는지.
21. 타팀 고객 수정 요청 → 디렉터 승인 diff, 배송지 즉시저장, 증빙서류, 할인/외상일 승인 흐름.

---

## ④ 변경 파일

| 파일 | repo 경로 | 종류 | 변경 요약 |
|---|---|---|---|
| `customerRoutes.js` | `refatrix-api/src/routes/customerRoutes.js` | 수정 | POST 필수 4종 검사(`contact_required`·`contact_invalid`·`phone_required`·`business_type_required`) · PATCH 이메일 필수 · `isEmailAddr`/`BUSINESS_TIERS` export · rev `20260918tier` (**+45 / −1 줄**) |
| `crmSync.js` | `refatrix-api/src/crmSync.js` | 수정 | `CUSTOMER_COLS` 에 `customer_type` · `businessTypeId()` 신설 · `identityFields()` 공용화 · **`upsert` 본문에 신원 8개 추가** · `upsertIdentityOn()` 킬스위치 · 빈 값 키 제거 (**+70 / −5 줄**) |
| `refatrix-custform.js` | `refatrix-custform.js` (repo 최상위) | 수정 | TIER A~D 드롭다운 · 필수 라벨 `*` · 저장 검증 · 예전 값 보존(`ensureTypeOption`) · `v20260918tier` (**+36 / −7 줄**) |
| `refatrix-customers.html` | `refatrix-customers.html` (repo 최상위) | 수정 | 목록 `✉ 이메일 미등록` 배지 · TIER 칸 · 상세 `tierCell`/`mailCell` · custform `?v=20260918tier` · build `tx-0918tier` (**+19 / −6 줄**) |
| `custform_required.test.js` | `test/custform_required.test.js` | **신규** | jsdom 12건 — 운영 custform 을 그대로 실행 |

- **마이그레이션 없음** · `refatrix-nav.js` 무변경 · `server.js` 무변경.
- **4파일 모두 순증**(삭제 우세 0건) — repo-guard B(급격한 축소)에 안 걸린다. `[guard-skip]` 불필요.

### 새 환경변수 (둘 다 선택 · 없어도 동작)

| 변수 | 기본 동작 | 언제 넣나 |
|---|---|---|
| `CRM_UPSERT_IDENTITY` | 켜짐 (신원 함께 전송) | 상대가 새 필드를 거절할 때 `0` 으로 끈다 (⑦-1) |
| `CRM_BUSINESS_TYPE_IDS` | A=1·B=2·C=3·D=4 | 상대 카탈로그 아이디가 다를 때 `"A=10,B=11,…"` (⑦-2) |

### 새 오류 코드 (프런트가 이미 `note` 를 그대로 띄운다)

| HTTP | error | 언제 |
|---|---|---|
| 400 | `contact_required` | 이메일 빈값 (POST · PATCH) |
| 400 | `contact_invalid` | 이메일 형식 오류 (POST · PATCH) |
| 400 | `phone_required` | 전화 빈값 (POST 만) |
| 400 | `business_type_required` | 회사 종류 빈값 (POST 만) |

---

## ⑤ 검증 결과 (이번 세션 — **49 / 49 ✅**)

**정적**
- `node --input-type=module --check` — `customerRoutes.js` · `crmSync.js` ✅
- `node --check` — `refatrix-custform.js` ✅ · `refatrix-customers.html` 인라인 `<script>` **2블록 전부** ✅
- 라이브 HEAD 대비 diff — 4파일 **전부 순증**(+170 / −19), 삭제 우세 파일 0건 ✅
- 편집 직전 cache-busted raw URL 로 재수신 · **v2 작업 전 `crmSync.js` 를 라이브와 재대조**(동일 확인) ✅

**`test/custform_required.test.js` — jsdom 12/12 ✅** (운영 custform 을 그대로 실행)
- TIER 드롭다운이 `['', A, B, C, D]` 로 고정 · 라벨 `*` 3개
- 신규: 이메일 빈값 / 형식오류 / 전화 빈값 / TIER 빈값 → **저장 요청 자체가 안 나감**(fetch 0건)
- 신규: 넷 다 채우면 다음 단계로 넘어감
- 수정: 이메일 지우면 차단 · **전화만 바꾸면 PATCH 1건 정상 전송**
- 수정: 예전 값 `refraccionaria` 가 드롭다운에서 **사라지지 않고** ⚠ 표시 · 연달아 열어도 안 쌓임

**백엔드 28/28 ✅** (운영 `customerRoutes.js`·`crmSync.js` 를 그대로 올리고 `db.js` 만 스텁 → 실제 핸들러 호출)
- `isEmailAddr` 경계 13종 · `BUSINESS_TIERS` 가 A~D 네 개
- `businessTypeId`: 기본 A=1·B=2·C=3·D=4 · 예전 값·빈값은 **undefined**(모르는 값을 지어내지 않음) ·
  `CRM_BUSINESS_TYPE_IDS` 로 덮어쓰기
- **`upsert` 본문**: 신원 8개 + 기존 5개 동시 존재 ·
  **★ 빈 값이면 6개 키가 전부 빠짐**(CRM 연락처 보호) · 예전 TIER 값은 `businessTypeId` 만 빠짐 ·
  **★ 킬스위치 `0`/`off`/`false`/`no` → 정확히 예전 5개만** · `1`/`on`/`true`/빈값 → 켜짐 ·
  킬스위치가 `create` 에는 영향 없음 · 승인대기 고객은 여전히 `pendiente`(전체 동기화 보호)
- **`create`**: 새 이름 + 옛 이름 둘 다 · 연락처가 비면 키 생략
- **`delete`·`reject` 본문 무변경** (회귀)
- POST: 4종 각각 400 + 정확한 error 코드, **DB 에 닿지 않음**(스텁이 INSERT 에서 터지도록 해 확인) ·
  넷 다 채우면 **검증을 지나 DB 까지 도달** · 앞뒤 공백 trim
- PATCH: 빈 이메일 400 · 형식오류 400 · **본문에 `contact` 가 없으면 요구하지 않음** ·
  전화/TIER 는 수정에서 막지 않음

**정적 가드 9/9 ✅**
- **엑셀 일괄등록(preview/commit) 블록이 라이브와 바이트 단위로 동일** ·
  필수 검사가 `INSERT INTO customers` **앞** · 프런트 검증이 `fetch` **앞** ·
  예전 고정 목록(`<option>refraccionaria</option>`) 제거 확인 · 4파일 순증 · build 마커 4종

> **실 PostgreSQL 종단 테스트는 돌리지 않았다** — 이번 변경에 **SQL 이 한 줄도 없다**
> (`crmSync` 의 `SELECT` 에 기존 컬럼 `customer_type` 하나를 더한 것이 전부).
> 추가된 코드는 전부 순수 함수이고, 위 테스트가 실제 핸들러·실제 본문 생성으로 그 경계를 고정한다.
> 배포 후 ③-14·15·16(아웃박스 원문 확인)이 종단 확인을 대신한다.

---

## ⑥ 결정 사항

| 항목 | 결정 | 근거 |
|---|---|---|
| 이메일 필수 범위 | **신규 등록 + 기존 고객 수정** | 디렉터 지시 |
| 전화·TIER 필수 범위 | **신규 등록만** | 수정까지 막으면 전화 한 줄 고치려는 사람이 멈춘다 |
| 기존 이메일 미등록 고객 | **표시만** (목록 배지 + 상세 경고), 저장은 안 막음 | 디렉터 선택 |
| 회사 종류 값 체계 | 자유 목록 5개 → **TIER A~D** | 디렉터 지시 (CRM 드롭다운과 일치) |
| 예전 회사 종류 값 | **일괄 변환하지 않고 보존** + ⚠ 표시 | 자동 변환은 분류를 통째로 날린다 |
| `businessTypeId` 숫자 | **A=1·B=2·C=3·D=4 가정**, 환경변수로 덮어쓰기 | 상대 카탈로그 미수령 (⑦-2) |
| CRM 전송 필드명 | **새 이름 + 옛 이름 둘 다** | 디렉터 선택. 이름을 갈아치웠다가 지금 되는 것까지 깨뜨릴 위험을 없앤다 |
| **`upsert` 에도 신원 전송** | **한다** (v2) | 디렉터 지시. CRM 에 이미 있는 고객의 연락처·TIER 가 ERP 와 계속 어긋나던 문제 |
| `upsert` 빈 값 처리 | **키 자체를 뺀다** | 전체 동기화에 레거시 고객이 섞여 CRM 의 멀쩡한 값을 지우는 사고를 막는다 |
| 되돌림 수단 | **환경변수 킬스위치** (재배포 불필요) | 상대 창구가 거절하면 승인·수정 전송이 줄줄이 실패한다 |
| 엑셀 일괄등록 | **대상 아님** | 디렉터 전용 · 대량 이관 경로 |
| 마이그레이션 | **없음** | `customer_type` 은 자유 텍스트 컬럼(엑셀 임포트가 임의 문자열을 넣고 있다) |

---

## ⑦ 오픈 이슈 / 확인 필요

1. **★ 상거래정보 창구가 새 필드를 받아 주는지 — 배포 후 30분 안에 확인.**
   상대가 «알 수 없는 필드» 를 거절하면 승인·수정 전송이 줄줄이 `failed` 가 된다.
   그때는 Railway 변수 **`CRM_UPSERT_IDENTITY=0`** → 저장 → 자동 재시작(약 1분)이면 예전 동작으로 돌아간다.
   **CRM 개발자에게 미리 물어보면 가장 깔끔하다**:
   "¿El endpoint de información comercial ignora campos adicionales (`razonSocial`, `contactEmail`,
   `contactPhone`, `businessTypeId`) o los rechaza?"
2. **★ `businessTypeId` 실제 숫자 — CRM 개발자에게 받아야 한다.**
   지금은 A=1·B=2·C=3·D=4 로 나간다. 상대가 다른 아이디를 쓰면 **전송은 성공하고 분류만 조용히 틀어진다**
   (오류로 안 잡힌다). 받는 즉시 `CRM_BUSINESS_TYPE_IDS="A=?,B=?,C=?,D=?"` 만 넣으면 된다.
   **물어볼 것**: "¿Cuáles son los `businessTypeId` exactos de los cuatro TIER (A/B/C/D)?"
3. **전체 동기화(`scope=all`) 를 누르기 전에 ③-15 를 먼저 해 보세요.**
   레거시 고객이 대량으로 나가는 경로라, 빈 값 처리가 의도대로인지 **한 건으로 먼저 확인**하는 편이 안전하다.
4. **예전 회사 종류 고객 정리** — `refraccionaria`·`Mayoreo`·`Flotia`·`taller`·`publico` 고객은 TIER 가 없어
   `businessTypeId` 가 안 실린다. 목록의 ⚠ 로 찾아 정리하는 게 좋다. 건수가 많으면 일괄 매핑
   (예: `Mayoreo`→A, `refraccionaria`→C, `taller`→C, `publico`→D)을 별건으로 만들 수 있다 —
   **이번엔 임의로 변환하지 않았다.**
5. **이메일 미등록 기존 고객 수** — 배지로 눈에는 띄지만 카운트가 없다.
   필요하면 「⚠ 이메일 미등록만 보기」 필터를 붙이겠다.
6. **repo-guard 파수꾼** — `tools/repo_guard.config.json` 이 아직 저장소에 없다(v5 zip 미배포로 보임).
   배포되면 아래를 넣어 주시거나 말씀 주시면 제가 넣겠다:
   ```json
   "refatrix-custform.js": [
     { "text": "TIER_KEYS", "why": "회사 종류 TIER A~D (2026-09-18)" }
   ],
   "refatrix-api/src/crmSync.js": [
     { "text": "identityFields", "why": "CRM 전송 신원 4종 (2026-09-18)" },
     { "text": "CRM_UPSERT_IDENTITY", "why": "upsert 신원 전송 킬스위치 (2026-09-18)" }
   ]
   ```
7. **견적·현장조사 등 다른 모듈의 고객 자동생성 경로**는 `POST /api/customers` 를 타지 않으므로
   이번 검증을 받지 않는다. 그쪽으로 만들어진 고객은 이메일이 빌 수 있다(목록 배지로는 잡힌다).

---

## ⑧ 다음 액션

1. ② 순서대로 배포(백엔드 → Railway Success → 프런트 → Ctrl+Shift+R) → ③ 스모크.
2. ★ 배포 후 **아웃박스 확인** (③-14·15·16). 새 필드가 실리고 `sent` 면 끝, `failed` 면 ⑦-1.
3. ★ CRM 개발자에게 두 가지 질문 (⑦-1 필드 수용 여부 · ⑦-2 businessTypeId 숫자).
4. 고객 목록에서 `✉ 이메일 미등록` · `⚠` 를 훑어 기존 고객 정리 (⑦-4, ⑦-5).
5. (선택) 「이메일 미등록만 보기」 필터 · 예전 회사 종류 일괄 매핑 — 지시 주시면 별건으로.

### 이월 (직전 유지)
- 재고 요약 카드에 PRO 포함할지 — 디렉터 판단 대기
- 구 `promo_items` 항목 재등록 (9/18 promo 인수인계 ⑧-2)
- repo-guard v5(`refatrix_wbr_restore_and_guard_v5.zip`) 배포 — 아직 저장소에 `tools/` 가 없다
- 기존 백로그: 구매제안 엔진, CFDI de egreso 2단계, WhatsApp Business API, 랙 위치 엑셀 매핑, 전 SKU COGS 재계산, pgAdmin 로컬 백업

---
*이 문서는 인수인계용 스냅샷입니다. 큰 변경이 생기면 갱신해서 다시 올려주세요.*
