# REFATRIX 인수인계 — 견적·매출 추적: 신규 견적 WhatsApp 알림 (2026-10-07c)

**마이그레이션 0256 (`npm run migrate` 필수)** · 새 설정값 1개(선택: `QUOTE_WA_TEMPLATE`) · 화면 build `ql-1007wa1` · 산출물 `refatrix_quote_wa_notify_v1.zip` (11파일) · 기준 커밋 `36e141f`

## ① 설명

견적이 새로 저장되면, 디렉터가 지정한 사람에게 WhatsApp으로 바로 알린다.

| 요구 | 구현 |
|---|---|
| 1) 받는 대상 지정 | 견적·매출 추적 화면 › **📲 신규견적 알림**(디렉터 전용). 이름 · 번호 · 언어(한국어/Español) · **팀 범위** · 사용 on/off |
| 2) 견적번호 | 첫 줄 `🧾 신규 견적 · Q-2026-xxxx` (포털 견적요청이면 `🌐 포털 견적요청` 한 줄 추가) |
| 3) 고객이름 | `고객: 이름 (팀)` + 고객 PO가 있으면 한 줄 · 작성자 · 견적일 |
| 4) SKU · 총수량 | `SKU 5 · 총수량 40개` (미등록 코드 줄 포함) |
| 5) 수주현황 · 견적액 | 목록 화면과 같은 3분류(예약 확보 기준): 🟢 즉시매출가능 / 🟡 재고부족 / 🟣 개발필요 — 각 SKU · 수량 · 금액. 견적액은 **IVA 제외 + IVA 포함** 병기. 수주현황 금액은 IVA 제외(견적액과 같은 기준) |

메시지 예(한국어):
```
🧾 *신규 견적* · Q-2026-0123
고객: *REFACCIONARIA SUR* (02_Merida)
작성: Oscar · 2026-10-07

SKU *5* · 총수량 *40* 개

*수주현황* (IVA 제외)
🟢 즉시매출가능 3 SKU · 30 개 · $10,000.00
🟡 재고부족 1 SKU · 8 개 · $2,000.00
🟣 개발필요 1 SKU · 2 개

💰 *견적액* $12,000.00 (IVA 제외) · $13,920.00 (IVA 포함)
```

**보내는 규칙**
- 대상 경로: 화면 견적 저장 · 견적 복제 · 포털(CRM) 견적요청. **가용재고 견적(pricelist)·취소·삭제 견적은 보내지 않음.**
- 저장 응답을 돌려준 **뒤** 바로 발송(저장은 기다리지 않음). 놓친 건은 60초마다 최근 24시간 안에서 다시 줍는다. 실패는 3회까지 재시도.
- **수신자를 등록한 뒤에 만들어진 견적부터** 간다(등록 순간 옛 견적이 몰려가지 않음).
- 팀 범위: 아무 팀도 안 고르면 전체. 고르면 그 팀 고객의 견적만(고객 미지정 견적은 작성자 팀).
- 한 사람에게 한 견적은 **한 번만**(즉시 발송과 줍기가 겹쳐도 원장 잠금으로 1회).
- 24시간 창: 웹훅이 창이 닫힌 걸 알면 처음부터 템플릿(`QUOTE_WA_TEMPLATE` → 없으면 `WHATSAPP_TEMPLATE`)으로 한 줄 요약. 창 밖 실패(131047)는 웹훅이 원장을 다시 열어 템플릿으로 재시도(일일자금과 같은 규칙).
- 끄기: `QUOTE_WA_ENABLED=0`.

**패널**: 상태 칩(알림 켜짐 · WhatsApp 키 · 창 밖 템플릿 · 웹훅) · 받는 사람 표(언어/팀/사용 바로 저장, 24시간 창 열림/닫힘, **시험 발송** = 가장 최근 견적을 그 사람에게) · 보낼 내용 미리보기(한/서) · 최근 발송 원장(접수 → ✓✓ 도착 / 👁 읽음 / ✗ 전달 실패 + 사유).

## ② 배포단계

1. zip을 repo 루트에 풀기 → GitHub Desktop **Fetch/Pull** → Commit → Push → Railway **Success**
2. Railway 콘솔 `npm run migrate` → `apply 0256_quote_wa_notify.sql`
3. 견적·매출 추적 화면 **Ctrl+Shift+R** → 탭 제목 `ql-1007wa1` 확인
4. 「📲 신규견적 알림」 → 받는 사람 추가 → **시험 발송** → 휴대폰 수신 + 원장 「✓✓ 도착」 확인
5. (권장) 24시간 창 밖에서도 받게: WhatsApp Manager에 유틸리티 템플릿 승인 — 이름 예 `nueva_cotizacion` · Spanish (MEX) · 본문 `{{1}}` 하나 → 관리 › 외부 서비스 키 › WhatsApp › **신규견적 알림 템플릿명**에 입력. 없으면 기본 템플릿(`WHATSAPP_TEMPLATE`)을 쓰고, 그것도 없으면 창 밖 수신자는 못 받음 → 받는 사람이 회사 번호로 하루 한 번 메시지를 보내 두면 창이 열림.

## ③ 테스트방법

- 새 견적 1건 저장 → 1~2초 안에 휴대폰 도착 · 패널 원장에 견적번호 행
- 팀 범위를 Monterrey만 → Merida 고객 견적은 안 감
- 받는 사람 「사용」 해제 → 안 감
- 가용재고 견적 저장 → 안 감

## ④ 변경파일

| repo 경로 | 변경 |
|---|---|
| `refatrix-api/migrations/0256_quote_wa_notify.sql` | **신규** — `quote_wa_recipients`(이름·번호·언어·team_ids·사용) · `quote_wa_sends`(견적×수신자 1행 · 1회 가드 · 재시도 · 잠금) |
| `refatrix-api/src/quoteWaNotify.js` | **신규** — 견적 적재(수주현황 3분류) · 문구(한/서) · 템플릿 한 줄 · 팀 범위 · 발송·원장 · 즉시 kick · 60초 줍기 워커 |
| `refatrix-api/src/routes/quoteWaRoutes.js` | **신규** — `/api/quote-wa/recipients`(GET/POST/PATCH/DELETE) · `/status` · `/preview` · `/send` (디렉터 전용) |
| `refatrix-api/src/routes/quoteRoutes.js` | 견적 저장·복제 뒤 `kickQuoteNotify` (+3줄) |
| `refatrix-api/src/routes/crmQuoteRoutes.js` | 포털 견적요청 접수 뒤 `kickQuoteNotify` (+2줄) |
| `refatrix-api/src/server.js` | 라우트 등록 + 워커 시작 (+4줄) |
| `refatrix-api/src/waWebhook.js` | 창 밖 실패(131047/470) 시 견적 알림 원장도 재오픈 (+7줄) |
| `refatrix-api/src/secrets.js` | WhatsApp 카드에 `QUOTE_WA_TEMPLATE` 칸 + 용도 줄 |
| `refatrix-quotelist.html` | 「📲 신규견적 알림」 버튼(디렉터) + 설정 패널 · build `ql-1007wa1` (addEventListener만) |
| `refatrix-api/test/quote_wa_notify.test.mjs` | **신규** — 실 PostgreSQL E2E 13개 |
| `refatrix-api/test/quote_wa_front.test.mjs` | **신규** — jsdom 화면 5개 |

## ⑤ 검증결과

- `node --check` 변경 파일 전부 · HTML 인라인 스크립트 통과
- pglast: 새 SQL 15/15 + 마이그레이션 파싱 OK (PATCH의 동적 SET 1건은 치환 모양만 다름 — E2E로 실행 확인)
- 마이그레이션 0001~0256 전체를 빈 PostgreSQL 16에 적용 + **재실행(멱등) OK**
- `quote_wa_notify` **13/13** (실 PostgreSQL 16 + buildApp inject, 2회 연속): 문구(한/서) · 한 줄 헤드라인 · 팀 범위 · 수신자 CRUD/521→52/중복 · **실제 견적 저장 → 발송 내용이 DB의 줄 금액·3분류와 일치** · 등록 이전 견적 제외 · 팀 변경 · 실패 3회 상한 + 수동 재발송 · 동시 발송 1회 · 창 닫힘 → 템플릿 신호 · 웹훅 131047 재오픈 → 창 열림 후 텍스트 재시도 · 복제 · pricelist/삭제 제외 · 미리보기 · 꺼짐 스위치 · 권한(영업 403)
- `quote_wa_front` **5/5** (jsdom): 디렉터만 버튼 · 상태/수신자/원장/미리보기 표시 · 추가(팀) · 팀 PATCH · 시험 발송 · 영업 역할은 API 호출 없음 · 인라인 onclick 없음
- 회귀: wa_webhook 12 · wa_phone_52 5 · treasury_daily 15 · treasury_daily_front 2 · crm_quote_inbound 35 · crm_order_status 18 · customer_exclusivity_e2e 14 · inactive_demand 4 · quote_summary_front 20 — 전부 통과
- 변경 전부터 실패하던 기존 건(이번 변경과 무관, 원본 main에서도 동일): service_secrets C3(메뉴 등록) · offersheet_disable

## ⑥ 결정사항

- 수주현황·견적액 금액 기준 = **IVA 제외**(목표·이익과 같은 기준), 견적액만 IVA 포함 병기
- 등록 이전 견적은 소급 발송하지 않음 · 줍기 범위 최근 24시간 · 재시도 3회
- 수신자 관리는 디렉터 전용, 위치는 견적·매출 추적 화면

## ⑦ 오픈이슈

- 창 밖 수신자를 위한 전용 템플릿 승인 필요(②-5). 승인 전에는 기본 템플릿 또는 24시간 창에 의존
- 받는 사람 = 번호 직접 입력(ERP 사용자 계정과 연결하지 않음). 「본인이 만든 견적은 빼기」 같은 규칙이 필요하면 사용자 연결 추가

## ⑧ 다음액션

1. 배포 → 받는 사람 등록 → 시험 발송으로 도착 확인
2. `nueva_cotizacion` 템플릿 승인 후 키 화면에 입력
3. 필요 시: 견적이 「확정」/「매출전환」될 때도 알림, 금액 기준 이상 견적만 알림
