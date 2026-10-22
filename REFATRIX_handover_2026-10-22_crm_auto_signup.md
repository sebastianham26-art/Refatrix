# REFATRIX 인수인계 2026-10-22 — CRM 웹 가입: 구글·페이스북은 완전 자동

**마이그레이션 없음** · 백엔드 3 + 테스트 2(신규 1) · 프런트 변경 없음
**산출물**: `refatrix_crm_auto_signup_v35b.zip` (**v35 대체** — v35 는 올리지 말 것)
베이스: `0b4ce51` (main, 2026-10-22 13:30 fetch)

---

## ① 설명

> 디렉터 지시: "CRM에서 구글이나 페이스북 이메일로 가입을 요청하면 ERP로 넘어올 때 ERP에서
> 자동으로 10% 할인을 승인해주도록. **사후승인도 필요없고**, constancia 및 외상 정보 올리는 것도
> 필요없이 그냥 회원가입이 자동으로 되도록"
> → (v35b) "**CUS_Origin 으로 보내는 게 있으면 이게 10% 자동할인 고객**으로 보는 거야"

10/16(v34)에 이미 된 것: GOOGLE·FACEBOOK 유입은 필수항목 면제 · 팀 07_Pagina · MECANICO ·
10% · 서류 관문 off. **이번에 바뀐 것은 다섯 가지다.**

| # | 무엇 | 전 | 후 |
|---|---|---|---|
| 1 | 판정 | `CUS_Origin` (GOOGLE·FACEBOOK) | **그대로 `CUS_Origin` 하나만** — v35 에서 넣었던 가입 계정(provider) 판정은 v35b 에서 뺐다 |
| 2 | 사후승인 | 사후승인 목록에 쌓임 | **등록과 동시에 확인 완료**(`ratified_at=now()`, note 기록) |
| 3 | 외상 | CRM 이 `paymentDays` 를 보내면 서류 없이 그대로 외상이 됨(관문 off 라서) | **항상 0(현금)** |
| 4 | CRM 에 10% 알림 | 사후승인 버튼이 보냈음 → 이제 버튼이 없음 | 등록 즉시 전송 적재 + **응답에 `discountPercent:10` · `paymentDays:0` · `registroAutomatico:true`** |
| 5 | 웹 가입 신청 창구(`customer-lead`) | 구글 가입도 리드(팝업) → 회사·RFC 없으면 400 | 구글·페이스북이면 **같은 등록 규칙으로 바로 고객**, 리드 목록엔 「자동 가입」(닫힘)으로 한 줄 |

### 판정 — `CUS_Origin` 하나
`GOOGLE` · `google` · `Google Ads` · `FACEBOOK` · `Facebook Ads` · `FB` · `Meta` → 10% 자동 가입.
그 밖의 값(INSTAGRAM 등)·빈 값·필드 없음 → 일반 경로. 로그인 방식 필드(`provider` 등)는 보지 않는다.

### ★ gmail 주소로는 판정하지 않는다
서류를 내고 일반 경로로 가입하는 고객 다수가 @gmail.com 을 쓴다. 도메인으로 보면 그 고객들까지
승인 없이 10% 가 된다. **CRM 이 구글·페이스북 가입 때 `CUS_Origin` 을 채워 보내야 한다**(⑦-1).

## ② 배포단계

1. zip 해제 → 덮어쓰기 → GitHub Desktop Fetch/Pull → 커밋/푸시
2. Railway 배포 **Success** 확인
3. `npm run migrate` **불필요**(새 마이그레이션 없음)
4. 프런트 변경 없음 — Ctrl+Shift+R 불필요

## ③ 테스트방법 (3분)

연동 관리 › CRM 신규고객 등록(수신) › 시험 발송, 또는 CRM 개발자에게 한 건:

```json
{ "CUS_Origin": "GOOGLE", "nombre": "Taller de prueba", "correo": "prueba@gmail.com" }
```

→ 응답 `codigoError:"0"` · `estatus:"aprobado"` · `discountPercent:10` · `paymentDays:0` · `registroAutomatico:true`
→ 고객 상세: 팀 07_Pagina · MECANICO · **할인 10%(실효)** · 외상 0
→ 고객등록 › **등록 사후승인 탭에 안 올라온다**
→ 같은 내용을 `/api/integrations/crm/customer-lead` 로 보내도 `P-####` 고객이 생기고, 「웹 가입 신청」 탭엔 자동 가입(완료)로 남는다

## ④ 변경파일

| repo 경로 | 종류 | 요약 |
|---|---|---|
| `refatrix-api/src/crmInbound.js` | 수정 | `isOpenSignup()` (판정 한 곳 = CUS_Origin) · `empresa`·`whatsapp` 동의어 |
| `refatrix-api/src/routes/crmInboundRoutes.js` | 수정 | 등록 본문을 `registerInbound()` 로 분리(동작 동일) · 자동 확인 · 외상 0 · CRM 전송 적재 · 응답에 조건 |
| `refatrix-api/src/routes/crmLeadRoutes.js` | 수정 | 구글·페이스북이면 `registerInbound()` 호출 → 리드 닫힘 기록 |
| `refatrix-api/test/crm_auto_signup.test.mjs` | **신규** | 18건 (A 순수 5 · B 등록 창구 7 · C 리드 창구 5 + 부모) — provider 만 구글이면 일반 경로(C3b) |
| `refatrix-api/test/crm_origin_web_signup.test.mjs` | 수정 | B8 옛 계약(사후승인 대기) → 새 계약 · B10 에 일반 경로 사후승인 유지 확인 추가 |

규칙 스위치(`crmInboundRoutes.js` 상단):
```js
const WEB_DISCOUNT = 10;
const WEB_AUTO_RATIFY = true;   // false 로 바꾸면 다시 사후승인 대기
```

## ⑤ 검증결과

`node --check` 5파일 OK · 실 PostgreSQL 16 에 마이그레이션 0001–0291 전부 적용 후 실 라우트로 시험.

| 스위트 | 결과 | 비교(손대지 않은 main) |
|---|---|---|
| `crm_auto_signup` (**신규**) | **18 / 0** | — |
| `crm_origin_web_signup` | **16 / 0** | 16/0 (B8 계약 갱신) |
| `crm_inbound` · `crm_web_lead` · `customer_post_approval` · `crm_inbound_key_clear` · `crm_quote_inbound` · `customer_exclusivity` · `customer_exclusivity_e2e` | 31·27·15·9·35·15·15 / 0 | 동일 |
| `crm_sync` 36/2 · `customer_registration` 75/1 · `crm_terms_agreed` 10/1 · `lead_wa_notify` 27/1 · `customer_merge` 16/2 | 기존 실패 | **main 과 완전히 동일** — 이번 변경과 무관 |

## ⑥ 결정사항

- 구글·페이스북 가입 = 10% 실효 · 사후승인 없음 · Constancia/주소증빙/외상서류 불필요 · **외상 0(현금)**
- 판정은 **`CUS_Origin` 하나**(GOOGLE·FACEBOOK). 로그인 방식 필드·이메일 도메인은 근거가 아니다
- 두 수신 창구(등록·웹 가입 신청) 모두 같은 결과
- 이미 ERP 에 있는 고객(RFC·CRM 코드·이메일 일치)은 **건드리지 않는다** — 비어 있는 연락처만 채운다(기존 규칙)
- 일반 경로는 전부 그대로(필수 5개 · 서류 관문 · 사후승인 대기)

## ⑦ 오픈이슈

1. **CRM 이 구글·페이스북 가입 때 `CUS_Origin` 을 실제로 채우는지 확인 필요.** 비어 오면
   일반 경로(필수 5개)로 가서 400 이 난다.
   (연동 관리 › 수신 이력 › 「원문」 에서 실제 본문을 볼 수 있다)
2. **RFC 없는 자동 가입 고객은 CRM 동기화가 나가지 않는다**(RFC 가 CRM 조회 키라 `skipped · rfc_missing`).
   그래서 응답에 `discountPercent` 를 실었다 — **CRM 개발자가 이 응답 값을 저장하도록** 알려야 한다.
3. RFC 없는 고객은 팩투라 확정이 막힌다(기존 규칙). 견적까지는 된다.
4. 외상을 주려면 고객 상세에서 디렉터가 외상일을 넣는다(서류 관문이 꺼져 있어 바로 실효가 된다).

## ⑧ 다음액션

- [ ] 배포 후 ③ 의 시험 1건
- [ ] CRM 개발자(스페인어)에게: ① 구글·페이스북 가입 시 `CUS_Origin` 에 GOOGLE/FACEBOOK 을 넣을 것 ② 응답의
      `discountPercent`·`paymentDays`·`registroAutomatico` 를 카달록에 반영할 것
- [ ] 영업팀 공지: 웹 구글·페이스북 가입 고객은 서류 없이 10% · 현금 조건으로 자동 활성
