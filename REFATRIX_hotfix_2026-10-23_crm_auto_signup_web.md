# REFATRIX 핫픽스 2026-10-23 — CRM 웹 가입이 여전히 승인 대기로 흐르던 문제

**마이그레이션 없음** · 백엔드 3 + 테스트 2 · 프런트 변경 없음
**산출물**: `refatrix_crm_auto_signup_web_v36.zip`
베이스: `7f429fe` (main, 2026-10-23 fetch — v35b `5632e2d` 반영 확인)

---

## ① 설명 — 원인은 코드가 아니라 **CRM 이 보내는 값**이었다

> 디렉터: "아직도 내가 승인을 해야되는 구조야. 점검해. 고객이 CRM에서 구글계정으로 가입을 희망하면
> 승인없이 바로 가격을 볼 수 있어야해." → 결정: **CUS_Origin 이 오면 전부 자동**

운영 연동 관리 › 수신 이력을 직접 열어 본 결과:

| 리드 | 일시 | 이메일 | **cus_origin** | 결과 |
|---|---|---|---|---|
| LEAD-11 (WEB-87) | 10/23 | gmail | **"WEB"** | 리드 접수 → 팝업 → 사람 등록·승인 대기 |
| LEAD-10 (WEB-86) | 10/22 | gmail | **"WEB"** | 〃 |
| LEAD-9 (WEB-85) | 10/20 | gmail | **"WEB"** | 〃 |

- CRM 은 웹 가입을 **신규고객 등록 창구가 아니라 웹 가입 신청(리드) 창구**로 보낸다
  (신규고객 등록 창구의 마지막 수신은 10/15 P-0013).
- 구글 계정 가입자도 `cus_origin: "WEB"` 이다. 10/22 규칙은 **GOOGLE·FACEBOOK 만** 자동으로 봤으므로
  **한 명도 자동 가입이 되지 않았다.**

## ② 바꾼 것

| # | 내용 |
|---|---|
| 1 | **판정: CUS_Origin 에 값이 있으면(WEB·GOOGLE·FACEBOOK·무엇이든) 자동 가입.** 빈 값·공백·필드 없음은 예전 일반 경로 |
| 2 | 자동 가입 내용은 그대로 — 즉시 활성 · **10% 실효** · 사후승인 없음 · 서류 관문 off · 외상 0 · 07_Pagina · MECANICO |
| 3 | RFC 가 있으면 즉시 CRM 에 `estatus:"aprobado"` + `discountPercent:10` 전송(카달록 가격 공개). 실측 리드 3건은 전부 RFC 가 있다 |
| 4 | 자동 가입에서 **RFC 형식이 깨져 있으면 가입을 버리지 않고** RFC 만 비워 등록(원문은 메모·이력에 남김). 리드 창구는 RFC 를 검사하지 않았으므로, 그대로 두면 자동 가입 전환 후 그런 고객이 400 으로 튕긴다 |
| 5 | **이미 쌓인 리드 전환(디렉터 전용)** — `POST /api/crm-leads/:id/auto-register` · `POST /api/crm-leads/auto-register-open`(열린 리드 중 CUS_Origin 있는 것 전부). 수신 때와 같은 규칙(`registerInbound`)으로 고객을 만들고 리드를 닫는다 |

## ③ 배포단계

1. zip 덮어쓰기 → GitHub Desktop Fetch/Pull → 커밋/푸시
2. Railway **Success** 확인 · `npm run migrate` 불필요
3. **대기 중인 LEAD-9·10·11 전환** — 디렉터 승인을 받아 Claude 가 브라우저에서 `auto-register-open` 을 1회 호출하거나,
   CRM 이 같은 신청을 다시 보내면 자동으로 고객이 된다

## ④ 변경파일

| repo 경로 | 요약 |
|---|---|
| `refatrix-api/src/crmInbound.js` | `isOpenSignup()` = CUS_Origin 값 존재 여부 |
| `refatrix-api/src/routes/crmInboundRoutes.js` | 자동 가입 시 깨진 RFC 는 비우고 가입 · 문구 갱신 |
| `refatrix-api/src/routes/crmLeadRoutes.js` | 리드 → 자동 가입 전환 2개 엔드포인트(디렉터) · 문구 갱신 |
| `refatrix-api/test/crm_auto_signup.test.mjs` | 21건 — **운영 실측 본문(cus_origin WEB) 재현** · 전환 경로(디렉터만·멱등) 포함 |
| `refatrix-api/test/crm_origin_web_signup.test.mjs` | B7·B9·B10 을 새 계약으로 갱신 |

## ⑤ 검증결과

실 PostgreSQL 16(마이그레이션 0001–0291) + 실 라우트.

| 스위트 | 결과 |
|---|---|
| `crm_auto_signup` | **21 / 0** |
| `crm_origin_web_signup` · `crm_inbound` · `crm_web_lead` · `customer_post_approval` · `crm_inbound_key_clear` · `crm_quote_inbound` · `customer_exclusivity` · `customer_exclusivity_e2e` | 16·31·27·15·9·35·15·15 / 0 |
| `crm_sync` 36/2 · `customer_registration` 75/1 · `crm_terms_agreed` 10/1 · `lead_wa_notify` 27/1 · `customer_merge` 16/2 | 기존 실패 — main 과 동일 |

## ⑥ 결정사항

- **CUS_Origin 이 오면 전부 자동 가입(10%)** — 구글/일반 이메일 구분 없음 (2026-10-23)
- 판정은 `isOpenSignup()` 한 곳

## ⑦ 오픈이슈

1. **카달록이 실제로 가격을 여는지는 CRM 쪽 처리에 달려 있다.** ERP 는 응답(`estatus:"aprobado"`·`discountPercent:10`)과
   상거래정보 전송(`customer-commercial`, RFC 기준) 두 길로 알린다. CRM 이 리드 창구 응답을 「접수됨」으로만 처리하고 있다면
   개발자에게 응답의 `erpCustomerCode`·`estatus` 를 반영하도록 요청해야 한다.
2. RFC 없이 가입한 고객은 상거래정보 전송이 `rfc_missing` 으로 건너뛰어진다 → 응답만이 유일한 통보 경로.

## ⑧ 다음액션

- [ ] 배포 → LEAD-9·10·11 전환 → 그 고객들의 카달록 가격 표시 확인
- [ ] 필요 시 CRM 개발자 안내(스페인어)
