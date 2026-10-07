# REFATRIX 인수인계 — WhatsApp 마케팅 (잠재고객 · 동의 · 정기 이미지 · 받은 메시지 · 자동응답) (2026-10-07h)

**마이그레이션 0260 (`npm run migrate` 필수)** · 새 화면 `refatrix-wapromo.html` (build `wap-1007a`) · 메뉴 제품·마케팅 › **WhatsApp 마케팅** (화면 권한 `marketing`) · 산출물 `refatrix_wa_promo_v1.zip` · 기준 커밋 `605d75f`

## ① 설명

설문 응답자 등 잠재고객에게 WhatsApp으로 이미지를 정기 발송하고, 답장을 받아 관리하는 화면이다. 목업(`refatrix-wapromo-mockup.html`)대로 탭 5개로 만들었다.

| 탭 | 기능 |
|---|---|
| 👥 연락처 | 화면 입력 · **엑셀 대량**(미리보기 → 저장, 머리글 자동 인식, 양식 받기) · **설문 응답자 가져오기**(이름·전화·상호 문항 선택) · 동의 상태별 숫자 · 동의 요청(전체/선택) · ✅ 영업 확인 · ⛔ 수신거부 · 삭제 |
| 🗓 발송 일정 | 날짜·시각(멕시코) + 이미지(JPG/PNG 5MB) + 문구 + 대상(동의 전체 / 메모 조건) 예약 · 주간 달력(썸네일·결과) · 상세(휴대폰 미리보기·도착/읽음/실패/답장 수·받는 사람별 원장) · 수정(예약 상태만) · 취소 · 시험 발송 |
| 💬 받은 메시지 | 대화 목록(미처리/전체/처리 완료/미등록 번호 · 담당 · 상담 요청만) · 대화창(정기 발송·동의 요청·자동응답·직접 답장·실제 전달 상태) · 24시간 창 안에서 직접 답장 · 담당 지정·메모·처리 완료 · 미등록 번호를 연락처로 · 🧾 견적 화면 열기(이름·번호 복사) · **엑셀로 받기**(기간) |
| 🤖 자동응답 | 규칙 표(받은 말·버튼 → 답장 + 답장 버튼 + 할 일: 동의로/수신거부로/상담 요청) 수정·추가·삭제 |
| ⚙ 설정 · 원장 | 오늘 발송/상한, 템플릿 이름, 웹훅, Meta 품질 등급(조회되면), Meta에서 할 일, 최근 7일 보낸 메시지 |

**동의 규칙**: 설문지에 동의 칸이 없었으므로 모든 연락처는 ❓ 미확인으로 시작한다.
- 동의 요청은 **사람마다 딱 한 번** 보낸다.
- 「Sí, quiero」를 누르면 ✅ 동의, 「No, gracias」나 BAJA면 ⛔ 거부로 자동으로 바뀐다.
- 정기 이미지는 **✅ 동의자에게만** 간다.
- 본인이 버튼이나 메시지로 수신거부한 사람은 화면에서 되돌릴 수 없다(409). 다시 받으려면 본인이 「Sí, quiero」를 보내야 한다.

**발송 방식**
- 정기 발송은 승인 템플릿 하나(`promo_imagen` = 이미지 헤더 + `{{1}}`)로 **이미지와 문구를 매번 바꿔** 보낸다. 재승인은 필요 없다.
- 24시간 창이 열린 사람(최근 답장)에게는 무료 일반 이미지로 보낸다.
- 이미지는 발송마다 Meta에 **한 번만** 올린다(25일 지나면 다시 올림).
- **하루 상한**: 동의 요청 + 정기 발송 합계가 `PROMO_WA_DAILY_CAP`(기본 150)을 넘지 않는다. 넘친 사람은 다음 날 이어서 보낸다. Meta의 「24시간 250명」 한도를 일일자금·견적 알림과 함께 쓰기 때문이다.
- 실패는 받는 사람별로 2회까지만 다시 시도한다. 동의 요청이 실패하면 사유를 남기고 대기열에서 뺀다.

**받은 메시지**: Cloud API는 지난 대화를 돌려주지 않는다. 그래서 웹훅이 받는 순간 `wa_messages`에 **모든 수신 메시지**를 저장한다(사내 수신자 번호 포함). 자동응답은 **등록된 연락처에게만** 한다.

자동응답 규칙의 맞추는 방식:
- 동의(yes)는 받은 말이 키워드와 똑같을 때만 맞는다. 「no acepto」, 「si pero cuánto」 같은 문장은 안 걸린다.
- 수신거부는 짧은 말(no)은 그 말만 왔을 때, 긴 말(baja · stop · no gracias)은 문장 어디에 있어도 맞는다.
- 그 밖의 규칙은 키워드가 단어로 들어 있으면 맞는다.
- 같은 규칙의 답은 6시간에 한 번만 보낸다.
- 사람이 직접 답장한 뒤 2시간은 「그 밖의 말」 답장을 하지 않는다.
- 동의 버튼 응답은 미처리함에 쌓이지 않는다. 상담 요청과 그 밖의 말은 미처리로 간다.

## ② 배포단계

1. zip을 repo 루트에 풀기 → GitHub Desktop **Fetch/Pull** → Commit → Push → Railway **Success**
2. Railway 콘솔 `npm run migrate` → `apply 0260_wa_promo.sql` (기본 자동응답 5개가 들어감)
3. 화면 `refatrix-wapromo.html`은 같은 push로 올라감. `refatrix-nav.js`도 바뀌었음(메뉴 추가). 캐시 표식(`?v=20260930vr`)은 저장소 규칙(전 화면 동일, `integration_nav` 테스트)대로 그대로 두었다. 그래서 메뉴가 안 보이면 Ctrl+Shift+R 또는 10분쯤 뒤 새로고침. 탭 제목이 `wap-1007a`인지 확인
4. **Meta 템플릿 2개 승인**(아래 ⑦ 가이드). 이름이 다르면 관리 › 외부 서비스 키 › WhatsApp 에 입력
5. 웹훅 필드 `messages` 구독 확인(0253에서 설정함)
6. 순서대로 시험:
   - 본인 번호를 연락처로 추가 → 「동의 요청」 → 휴대폰에서 「Sí, quiero」 → 상태 ✅ 확인
   - 발송 예약(지난 시각이면 1분 안에 바로 나감) → 수신 확인
   - 답장 → 「받은 메시지」에서 확인

## ③ 테스트방법

- 엑셀 업로드: 양식 받기 → 3~4줄(형식 오류·중복 섞어서) → 미리보기 결과 확인 → 저장
- 설문 가져오기: 설문 선택 → 이름/전화 문항 확인 → 미리보기 → 저장(메모에 설문 번호)
- 「BAJA」 답장 → ⛔ 거부로 바뀌고, 다음 정기 발송 대상에서 빠지는지 확인
- 「Quiero cotizar」 → 🙋 상담 요청 + 미처리 + 자동 답장 확인

## ④ 변경파일

| repo 경로 | 변경 |
|---|---|
| `refatrix-api/migrations/0260_wa_promo.sql` | **신규** — wa_contacts · wa_campaigns · wa_campaign_sends · wa_messages · wa_autoreplies(+기본 규칙 5) |
| `refatrix-api/src/waPromo.js` | **신규** — 연락처 정리 · 동의 요청 대기열 · 정기 발송 · 하루 상한 · 받은 메시지 저장 · 규칙 고르기 · 자동응답 · 직접 답장 · 60초 워커 |
| `refatrix-api/src/routes/waPromoRoutes.js` | **신규** — `/api/wa-promo/*` (연락처 · 엑셀 · 설문 가져오기 · 동의 요청 · 발송 일정 · 이미지 · 원장 · 시험 · 대화 · 답장 · 엑셀 원자료 · 자동응답 · 상태) |
| `refatrix-api/src/waSend.js` | 추가 — `sendWaTemplateBare`(변수 없는 템플릿) · `sendWaButtons`(선택 버튼 답장). 기존 함수 무변경 |
| `refatrix-api/src/waWebhook.js` | 받은 메시지마다 `handleInbound` 호출(저장 + 자동응답). 0260 전이면 조용히 건너뜀 |
| `refatrix-api/src/server.js` | 라우트 등록 + `startWaPromoWorker` |
| `refatrix-api/src/secrets.js` | WhatsApp 카드에 `PROMO_CONSENT_TEMPLATE` · `PROMO_IMAGE_TEMPLATE` · `PROMO_WA_DAILY_CAP` |
| `refatrix-wapromo.html` (루트) | **신규** 화면 · build `wap-1007a` · addEventListener만 |
| `refatrix-nav.js` (루트) | 메뉴 `wapromo`(제품·마케팅) · 권한 `marketing` |
| `refatrix-api/test/wa_promo.test.mjs` · `wa_promo_front.test.mjs` | **신규** 테스트 |

## ⑤ 검증결과

- `wa_promo` **9/9** (실 PostgreSQL 16 + buildApp inject, 2회 연속). 확인한 항목:
  - 규칙 고르기: 「no acepto」·「si pero…」 오인 없음, 「BAJA por favor」 거부, 「no tengo…」 오인 없음
  - 연락처: 형식·중복, 엑셀 미리보기는 저장 안 함, 권한 403
  - 동의 요청: 1회만, 상한 3에서 멈추고 상한을 올리면 이어서, 창 열린 사람은 버튼 메시지
  - 웹훅: 버튼 동의, 같은 wamid 재전송 무시, BAJA, 상담 요청 + 미처리, 그 밖의 말 버튼 답장, 6시간 쿨다운, 미등록 번호는 저장만
  - 정기 발송:
    - 동의자만, 업로드 1회
    - 창 닫힘이면 템플릿(변수 한 줄), 창 열림이면 일반 이미지
    - 메모 조건, 실패 2회 상한, 완료 처리
  - 받은 메시지:
    - 미처리함, 대화, 직접 답장, 창 닫힘이면 409
    - 담당·처리, 사람 답장 뒤 2시간 자동응답 멈춤
    - 미등록 번호를 연락처로 등록, 엑셀 원자료
  - 발송 일정과 기타: 수정(멕시코 시각 저장 확인), 시험 발송, 취소 뒤 수정 409, 영업 확인, 본인 수신거부는 되돌림 409, 자동응답 CRUD, 상태
- `wa_promo_front` **6/6** (jsdom, 운영 HTML) — 탭 5개 동작 · 엑셀 미리보기→저장 · 달력/상세/시험 · 대화/답장/처리 · 규칙 저장 · 설정 숫자 · 메뉴 등록 · 인라인 onclick 없음
- 헤드리스 Chromium 캡처(1280 · 390px) — 가로 스크롤 없음
- pglast 새 SQL **64/64** · 마이그레이션 빈 DB 0001~0260 적용 + 재실행 멱등 · node --check 전 파일 · 화면 인라인 JS
- 회귀:
  - 통과: wa_webhook 12 · wa_phone_52 5 · quote_wa_notify 15 · quote_wa_front 5 · treasury_daily 15 · treasury_daily_front 2 · integration_nav 4 · crm_quote_inbound 35
  - 변경 전부터 실패하던 기존 건(원본 main에서도 동일): service_secrets C3 · visit_recordings · offersheet_qty_cap

## ⑥ 결정사항

- 동의 칸이 없던 설문 → 동의 요청 1회 후 ✅만 정기 발송. 영업 확인은 기록(누가·언제).
- 하루 상한 150(내부 알림 몫 100 남김). 정기 발송이 동의 요청보다 먼저 나간다.
- 받은 메시지는 전부 저장하고, 자동응답은 등록 연락처에게만 한다.

## ⑦ Meta 설정 가이드 (클릭 단위)

**템플릿 만들기** — business.facebook.com › WhatsApp Manager › 메시지 템플릿 › **템플릿 만들기**

1. `promo_consentimiento`
   - 카테고리: 마케팅 · 언어: Spanish (MEX) · 헤더: 없음
   - 본문: `Gracias por participar en nuestra encuesta de Refatrix. ¿Desea recibir promociones y novedades de autopartes por WhatsApp?`
   - 버튼 › **빠른 답장(Quick reply)** 2개: `Sí, quiero` · `No, gracias` → 제출
2. `promo_imagen`
   - 카테고리: 마케팅 · 언어: Spanish (MEX) · 헤더: **미디어 › 이미지**(샘플 1장 — 오늘 만든 빨간 이미지 사용 가능)
   - 본문: `Novedades de Refatrix: {{1}}. Responda BAJA si no desea recibir más mensajes.` (변수 유형 **숫자**)
   - `{{1}}` 샘플: `Amortiguadores CTR para Versa 2015-2019 con 15% de descuento esta semana`
   - 버튼 › 빠른 답장 3개: `Quiero cotizar` · `Ver catálogo` · `BAJA` → 제출
3. 상태가 「활성」이 되면 끝. 이름을 바꿨다면 ERP 관리 › 외부 서비스 키 › WhatsApp 에 입력.

**챗봇** — 별도 도구가 필요 없다. 위 버튼을 누르거나 답장하면 웹훅 → ERP 자동응답 규칙이 처리한다. 「🤖 자동응답」 탭에서 문구와 버튼을 고치면 바로 적용된다.

## ⑧ 오픈이슈 · 다음액션

- 「🧾 견적 화면」은 새 탭을 열고 이름·번호를 복사만 한다(견적 화면에 자동 입력 기능 없음). 필요하면 견적 화면에 미리 채우기 추가.
- 받은 사진·음성은 Meta 미디어 id만 저장(내려받기 미구현).
- 상담 요청이 들어올 때 담당자 WhatsApp 알림은 아직 없음(신규견적 알림과 같은 방식으로 추가 가능).
- 다음: 배포 → 템플릿 2개 승인 → 본인 번호로 시험 → 설문 응답자 가져오기 → 동의 요청.
