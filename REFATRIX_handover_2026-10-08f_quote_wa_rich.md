# REFATRIX 인수인계 — 신규 견적 알림: 헤더 이미지 + 상세 내용 한 통 (2026-10-08f)

**마이그레이션 0265 (`npm run migrate` 필수)** · 화면 build `ql-1008rc` · 산출물 `refatrix_quote_wa_rich.zip` (9파일) · 기준 커밋 `d22b55b`(0264 배포본)

## ① 설명

디렉터 요청: 지금은 두 가지 형태가 따로 온다. **헤더 이미지(CTR)는 위에, 텍스트로 온 상세 요약은 그 이미지 아래에 오는 한 통**으로 받고 싶다.

**새 발송 형식 「헤더 이미지 + 상세 내용 (한 통)」 — 새 기본값**

| 상황 | 나가는 메시지 | 비용 |
|---|---|---|
| 24시간 창 **안** (최근에 회사 번호와 대화함) | **이미지 메시지 1통**: 위는 헤더 이미지, 아래 설명(캡션)은 견적 상세·수주현황·당월 요약 7칸. 1024자를 넘으면 요약의 「 — 」 뒤 세부를 줄인다. | 무료 |
| 창 **밖** | **상세 템플릿 `cotizacion_detalle`**: 헤더 이미지와 여러 줄 본문. 같은 항목을 변수 16개로 채운다. | 유틸리티 1건 |
| 창 밖인데 상세 템플릿이 **아직 승인 전** | 지금처럼 `nueva_cotizacion`(헤더 이미지 + 한 줄)으로 대신 보낸다. 원장에 ⚠ 사유가 표시된다. | 유틸리티 1건 |

- 한국어 수신자에게는 `cotizacion_detalle`의 **한국어(ko)** 번역을 먼저 보낸다. 한국어 번역이 없으면(#132001) **Spanish (MEX)**로 보낸다.
- 모든 팀을 고른 수신자의 당월 요약 머리에 팀 이름이 줄줄이 붙던 것을 없앴다. 이제 팀 이름은 붙지 않고, 팀이 4개 이상이면 「N개 팀」으로 표시한다.
- 예전 형식(항상 템플릿 / 창 열리면 텍스트)도 그대로 고를 수 있다.

## ② 배포단계

1. zip 풀기 → Fetch/Pull → Commit → Push → Railway **Success**
2. `npm run migrate` → `apply 0265_quote_wa_rich.sql`. 기존 설정이 「헤더 이미지 + 상세」로 바뀐다.
3. 견적·매출 추적 Ctrl+Shift+R → 탭 제목이 `ql-1008rc`인지 확인
4. 「📲 신규견적 알림」을 연다.
   - **「헤더 이미지 + 상세 내용 (한 통)」**이 선택돼 있는지 확인한다.
   - 헤더 이미지가 올라가 있는지 확인한다(0264 때 올렸으면 그대로다).
   - 미리보기에 휴대폰에서 보일 모양(이미지 + 설명)이 나오는지 본다.
5. **Meta에 상세 템플릿 `cotizacion_detalle` 만들기** — 아래 ⑥의 「템플릿 만들기」 순서대로.
6. 휴대폰에서 회사 WhatsApp 번호로 아무 메시지나 보내 창을 연다 → 받는 사람 행의 **시험 발송** → 이미지 한 통에 상세가 붙어 오는지 확인한다.

## ③ 테스트방법

- 원장 상태 라벨:
  - 「접수(이미지+상세)」: 창 안에서 한 통으로 보냄
  - 「접수(상세 템플릿)」: 창 밖, cotizacion_detalle로 보냄
  - 「접수(템플릿) ⚠ 상세 템플릿 … #132001」: 아직 승인 전이라 한 줄 템플릿으로 보냄. 승인되면 사라진다.
- 미리보기 아래 「창 밖에서 나가는 상세 템플릿 변수 16개 보기」를 열면 Meta에 넣을 샘플값이 그대로 보인다.

## ④ 변경파일

| repo 경로 | 변경 |
|---|---|
| `refatrix-api/migrations/0265_quote_wa_rich.sql` | **신규** — send_mode에 `rich` 추가 · 기본값 rich · 기존 행을 한 번만 rich로 바꿈(재실행 안전) |
| `refatrix-api/src/waSend.js` | `sendWaTemplateParams`(헤더 이미지 + 변수 N개) · `waParam`(줄바꿈 제거 · 빈 값 「—」) |
| `refatrix-api/src/quoteWaNotify.js` | `deliverQuote` rich 규칙 · `buildQuoteCaption`(≤1024) · `buildDetailParams`(16개) · ko→es_MX 재시도 · 상태 `sent_image`/`sent_detail` · 전체 팀 이름 생략 |
| `refatrix-api/src/routes/quoteWaRoutes.js` | 미리보기에 `caption` · `detail_params`, 상태에 `detail_template` |
| `refatrix-api/src/secrets.js` | 외부 서비스 키 › WhatsApp에 `QUOTE_WA_DETAIL_TEMPLATE` 칸(비우면 cotizacion_detalle · 「-」 = 안 씀) |
| `refatrix-quotelist.html` (루트) | 발송 형식에 「헤더 이미지 + 상세」 · 휴대폰 모양 미리보기(이미지 + 캡션) · 변수 16개 목록 · 원장 라벨 · build `ql-1008rc` |
| `refatrix-api/test/quote_wa_notify.test.mjs` | A6 · B13 추가, A5 · B11 · B12 갱신 |
| `refatrix-api/test/quote_wa_front.test.mjs` | ②-2 갱신 · 빌드 토큰 |

## ⑤ 검증결과

- `quote_wa_notify` **20/20**(실 PostgreSQL 16, 새 DB에 migrate). B13은 Meta 호출을 가로채 실제 본문을 확인했다:
  - 창 열림 → `type: image`, `image.id` = 업로드한 헤더, 캡션 ≤1024에 견적번호 · 수주현황 · 견적액 포함, 원장 `sent_image`
  - 창 닫힘 → `template cotizacion_detalle (ko)`, header image + body 변수 **16개**, 줄바꿈 없음, 원장 `sent_detail`
  - 승인 전(#132001) → `cotizacion_detalle:ko` → `cotizacion_detalle:es_MX` → `nueva_cotizacion:es_MX`(헤더 이미지), 원장에 사유
  - 미리보기 caption/detail_params, 상태 detail_template
- A6(규칙 8가지): 캡션 길이 제한, 팀 개수 표시, 변수 16개, 이익 제외 · 요약 끔 「—」, ko→es 재시도는 #132001일 때만, 상세 템플릿 끔
- `quote_wa_front` **6/6**(jsdom): 기본 rich 선택, 미리보기 캡션 · 이미지 · 변수 16개, 원장 라벨 · ⚠ 사유, 형식 전환 PUT
- 회귀: wa_webhook 12 · wa_promo 10 · wa_promo_front 7 · integration_nav 4 · quote_summary_front 20 · treasury_daily 17 통과. service_secrets C3 1건은 기존 실패로, 이번 변경 전에도 같다.
- 0265 새 DB 적용 + 재실행 멱등: 사용자가 바꾼 설정은 덮어쓰지 않는다. node --check, 화면 인라인 JS 확인.

## ⑥ 결정사항 · Meta 템플릿 만들기

견적 알림 기본값 = 「헤더 이미지 + 상세 내용 한 통」. 창 밖에서도 상세를 받으려면 아래 템플릿을 Meta에서 승인받는다.

**WhatsApp Manager › 메시지 템플릿 › 템플릿 만들기**

1. 카테고리 **유틸리티** · 이름 **`cotizacion_detalle`** · 언어 **Spanish (MEX)**. 같은 템플릿에 **언어 추가 › Korean**도 넣으면 한국어 수신자는 한국어로 받는다(선택).
2. **변수 유형: 숫자(Number)**
3. **헤더: 이미지** → 샘플로 `ctr_header_web_1600x836.jpg`(ERP 패널에 올린 것과 같은 이미지)
4. **본문** — 아래 글을 그대로 붙여 넣는다. 줄바꿈은 그대로 둔다. *별표*는 굵은 글씨다.
5. **바닥글**: `Refatrix · Aviso interno` · **버튼**(선택): 웹사이트 방문 `www.refatrix.com`
6. 변수 샘플 16개를 아래 표대로 넣고 → 제출

**본문 — Spanish (MEX)**
```
🧾 *Nueva cotización* {{1}}
Cliente: *{{2}}*
Elaboró: {{3}}

SKU *{{4}}* · Piezas *{{5}}*

*Estatus de pedido* (sin IVA)
🟢 Disponible: {{6}}
🟡 Falta stock: {{7}}
🟣 Por desarrollar: {{8}}

💰 *Monto:* {{9}}

📊 *Resumen del mes* (sin IVA)
① Cotizado: {{10}}
② Venta real: {{11}}
③ Venta perdida por stock: {{12}}
④ Cantidad cotizada: {{13}}
⑤ Cantidad vendida: {{14}}
⑥ Utilidad bruta: {{15}}
⑦ Utilidad no realizada: {{16}}

Consulte el detalle en el ERP › Cotizaciones y ventas.
```

**본문 — Korean (선택)**
```
🧾 *신규 견적* {{1}}
고객: *{{2}}*
작성: {{3}}

SKU *{{4}}* · 총수량 *{{5}}*개

*수주현황* (IVA 제외)
🟢 즉시매출가능: {{6}}
🟡 재고부족: {{7}}
🟣 개발필요: {{8}}

💰 *견적액:* {{9}}

📊 *이번 달 요약* (IVA 제외)
① 총 견적액: {{10}}
② 실매출액: {{11}}
③ 재고부족 매출실기: {{12}}
④ 총 견적 수량: {{13}}
⑤ 매출 수량: {{14}}
⑥ 매출총이익: {{15}}
⑦ 이익 실현불가: {{16}}

상세는 ERP 견적·매출 추적에서 확인하세요.
```

**변수 샘플**

| 변수 | 한국어 샘플 | Spanish (MEX) 샘플 |
|---|---|---|
| {{1}} | Q-2026-0512 | Q-2026-0512 |
| {{2}} | REFACCIONARIA DEL SURESTE (02_Merida) | REFACCIONARIA DEL SURESTE (02_Merida) |
| {{3}} | Oscar · 2026-10-08 | Oscar · 2026-10-08 |
| {{4}} | 12 | 12 |
| {{5}} | 186 | 186 |
| {{6}} | 9 SKU · 150 개 · $39,100.00 | 9 SKU · 150 pzas · $39,100.00 |
| {{7}} | 2 SKU · 30 개 · $8,150.00 | 2 SKU · 30 pzas · $8,150.00 |
| {{8}} | 1 SKU · 6 개 | 1 SKU · 6 pzas |
| {{9}} | $48,250.00 (IVA 제외) · $55,970.00 (IVA 포함) | $48,250.00 (sin IVA) · $55,970.00 (con IVA) |
| {{10}} | $812,400.00 · 견적 41건 | $812,400.00 · 41 cotizaciones |
| {{11}} | $455,300.00 · 견적 대비 56% | $455,300.00 · de lo cotizado 56% |
| {{12}} | $96,500.00 | $96,500.00 |
| {{13}} | SKU 388 · 5,320 개 | SKU 388 · 5,320 pzas |
| {{14}} | SKU 210 · 2,980 개 | SKU 210 · 2,980 pzas |
| {{15}} | $172,100.00 · 이익률 37.8% | $172,100.00 · margen 37.8% |
| {{16}} | $35,100.00 | $35,100.00 |

- 템플릿 이름을 다르게 지었으면 관리 › 외부 서비스 키 › WhatsApp › 「신규견적 상세 템플릿명」에 그 이름을 넣는다.
- 본문의 고정 글자나 변수 순서를 바꾸면 ERP가 보내는 16개 값과 어긋난다. 위 글 그대로 쓴다.

## ⑦ 오픈이슈

- 당월 요약을 「안 붙임」·「이익 제외」로 한 수신자도, 창 밖 상세 템플릿에는 요약 줄의 고정 글자가 남고 값만 「—」로 나간다(템플릿 본문은 고정이라서).
- 창 안 이미지 메시지는 Meta 규칙상 캡션이 1024자까지다. 상세가 길면 요약 세부를 줄인다(핵심 숫자는 유지).
- Meta는 변수가 많은 템플릿을 반려하기도 한다. 반려되면 사유를 알려 주면 줄 수를 조정한다. 그동안 알림은 nueva_cotizacion으로 계속 나간다.

## ⑧ 다음액션

- 배포 → migrate → Meta에 `cotizacion_detalle` 제출 → 창을 연 상태로 시험 발송(이미지 + 상세 한 통 확인) → 승인 후 창 밖 수신자 확인
