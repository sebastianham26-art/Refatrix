# REFATRIX 인수인계 — 신규 견적 WhatsApp 알림에 「당월 요약」 KPI 7칸 추가 (2026-10-07d)

**마이그레이션 0257 (`npm run migrate` 필수)** · 화면 build `ql-1007wa2` · 산출물 `refatrix_quote_wa_summary_v2.zip` (8파일) · 기준 커밋 `b99fdfe`(0256 배포본)

## ① 설명

신규 견적 알림 메시지 **맨 아래**에 이번 달 요약을 붙인다. 견적·매출 추적 화면 상단의 요약 카드 7칸과 **같은 계산 함수**를 쓰므로 숫자가 서로 다를 수 없다.

| 칸 | 내용 |
|---|---|
| ① 총 견적액 | 견적 N건 · 미결 · 전환 · 만료 |
| ② 실매출액 | 견적액 대비 % · 인보이스 건수 |
| ③ 재고부족 매출실기 | 전환 시 미확보 · 만료 시 부족 (+ 미결 견적 현재 부족) |
| ④ 총 견적 수량 | SKU · Pieza · 견적 줄 수 |
| ⑤ 매출 수량 | SKU · Pieza · 견적 대비 % · 부족 SKU/pzs |
| ⑥ 매출총이익 실현 | 이익률 (FOB 추정·원가없음 줄 표시) |
| ⑦ 재고부족 이익 실현불가 | 부족 매출 기준 · 이익률 |

- **당월** = 멕시코 날짜 기준 이번 달, 견적일 기준, 금액은 IVA 제외(화면 카드와 동일). 방금 저장된 견적도 포함한다.
- **팀 범위 수신자**는 그 팀 숫자만 받는다(제목 옆에 팀 이름 표시). 고객 미지정 견적은 작성자 팀으로 센다.
- **수신자별 선택 「당월 요약」**: `7칸 전부`(기본) / `이익 제외`(⑥⑦을 뺀 5칸) / `안 붙임`. ⑥⑦은 원가 정보이므로 영업사원에게는 「이익 제외」를 권장한다.
- 요약 계산이 실패해도 견적 알림 본문은 그대로 나간다.
- 24시간 창 밖에서 템플릿으로 나가는 한 줄 요약(`{{1}}`)에는 당월 요약을 넣지 않는다(템플릿 길이·줄바꿈 제한).

## ② 배포단계

1. zip을 repo 루트에 풀기 → Fetch/Pull → Commit → Push → Railway **Success**
2. `npm run migrate` → `apply 0257_quote_wa_month_summary.sql`
3. 견적·매출 추적 화면 Ctrl+Shift+R → 탭 제목 `ql-1007wa2`
4. 「📲 신규견적 알림」 → 받는 사람마다 「당월 요약」을 정하고 → 미리보기(요약 7칸 / 이익 제외 / 요약 없음) 확인 → 시험 발송

## ③ 테스트방법

- 시험 발송 → 메시지 맨 아래 📊 블록의 ①~⑦이 화면 상단 요약 카드(이번 달만 선택)와 같은지 확인
- 받는 사람을 「이익 제외」로 → ⑥⑦이 없는지 확인
- 팀 범위 수신자 → 그 팀만의 숫자 + 팀 이름

## ④ 변경파일

| repo 경로 | 변경 |
|---|---|
| `refatrix-api/migrations/0257_quote_wa_month_summary.sql` | **신규** — `quote_wa_recipients.month_summary` (full / no_profit / off, 기본 full) |
| `refatrix-api/src/quoteSummary.js` | **신규** — 기간 요약 계산(`computeQuoteSummary`). quoteRoutes.js에서 **계산식 그대로** 옮기고 팀 범위 옵션만 추가 |
| `refatrix-api/src/routes/quoteRoutes.js` | `quoteSummary`가 새 모듈을 부름(화면 동작 동일) |
| `refatrix-api/src/quoteWaNotify.js` | 당월 요약 계산·문구(한/서) · 수신자별 수준 · 같은 범위끼리 1회 계산 |
| `refatrix-api/src/routes/quoteWaRoutes.js` | 수신자 `month_summary` 저장/수정(잘못된 값 400) · 미리보기 `summary=` |
| `refatrix-quotelist.html` | 수신자 표 「당월 요약」 칸 · 추가 양식 · 미리보기 선택 · build `ql-1007wa2` |
| `refatrix-api/test/quote_wa_notify.test.mjs` | A4 · B10 추가 |
| `refatrix-api/test/quote_wa_front.test.mjs` | 요약 선택·미리보기 검증 추가 |

## ⑤ 검증결과

- `quote_wa_notify` **15/15** (실 PostgreSQL 16 + buildApp inject). B10: 실제 견적 저장 → 메시지의 ①~⑦이 **같은 시점의 `/api/quotes/summary` 응답과 일치** · 방금 견적 포함 · 팀 범위 수신자 = 팀 범위 계산값 + 팀 이름 · 이익 제외 수신자에 ⑥⑦ 없음 · 끔 · 미리보기 수준 · 잘못된 값 400
- `quote_wa_front` **5/5** (jsdom) — 기본 7칸 · 수준 변경 PATCH · 추가 시 수준 전송 · 미리보기 summary 파라미터
- **기존 요약 테스트 `quote_summary_search` 21/21 그대로 통과**(빈 DB) — 계산식 이동으로 화면 숫자가 바뀌지 않음을 확인
- 회귀: quote_summary_front 20 · wa_webhook 12 · crm_quote_inbound 35 · customer_exclusivity_e2e 14 · treasury_daily 15 · inactive_demand 4
- 마이그레이션 0257 적용 + 재실행 멱등 · pglast(0257 · 요약 SQL) · node --check 전 파일

## ⑥ 결정사항

- 요약 위치 = 메시지 맨 아래, 기준 = 당월(멕시코 날짜) · 견적일 · IVA 제외
- 기본은 7칸 전부(디렉터 지시). 이익 두 칸은 수신자별로 뺄 수 있음

## ⑦ 오픈이슈

- 템플릿(창 밖) 한 줄에는 당월 요약이 들어가지 않음. 필요하면 「Mes: cotizado $X · venta $Y」 정도의 짧은 꼬리 추가 검토

## ⑧ 다음액션

1. 배포 → 받는 사람별 요약 수준 지정 → 시험 발송으로 화면 카드와 숫자 대조
2. `nueva_cotizacion` 템플릿 승인(창 밖 수신자용)
