# REFATRIX 인수인계 — Meta 광고 문의: WhatsApp 문의 실시간 접수 (2026-10-23b)

**마이그레이션 없음**(0295는 앞 배포분) · 화면 build `mtl-1023wa` · 산출물 `refatrix_wa_live_1023.zip` · 기준 `5e2d5dc`(광고별 문의 0295)

## ① 설명

디렉터 지시: 「WhatsApp 번호로 오는 문의 내용도 자동으로 접수되게 해 달라」

이전에는 ERP WhatsApp(Cloud API 번호)로 온 메시지가 문의 목록에 들어가기까지 두 경로뿐이었다:
- 「⟳ 새 문의 가져오기」를 누를 때
- 30분 자동 가져오기(첫 가져오기를 사람이 한 번 성공시킨 뒤에만 돈다)

이제는 아래처럼 **바로** 들어간다:
- **고객 메시지(웹훅 도착)** → 2초 안에 Meta 광고 문의 목록에 행이 생기거나 갱신된다.
  - 같은 번호로 연달아 오는 메시지는 2초 동안 모아서 한 번에 반영한다.
- **우리 답장(ERP에서 보낸 WhatsApp)** → 그 문의의 대화 · 「마지막 대응」에 바로 반영된다.
  - 고객이 먼저 보낸 적이 없는 번호(정기 발송만 받은 번호)는 문의로 만들지 않는다.
- 광고를 눌러 온 메시지면 **광고 ID도 같이 붙는다**(0295). 「📣 광고별 문의」에 바로 보인다.
- 반영된 뒤에는 AI 분석(고객 유형 · 지역 · 차종 · 부품 · 요약)이 자동으로 이어진다.
- 사내 번호(사용자 WhatsApp · 견적 알림 수신자 · 일일요약)는 그대로 뺀다.
- 화면 상단 「⚡ 실시간 접수 켜짐 (마지막 …)」 줄로 동작을 확인한다.
- 끄려면 환경변수 `META_LEADS_WA_LIVE=0`.

같은 시각에 온 메시지의 순서가 뒤바뀌던 문제도 고쳤다(정렬에 id를 추가).

## ② 배포단계

1. zip 풀기 → Commit → Push → Railway **Success** (migrate 불필요 — 단, 0295를 아직 안 돌렸으면 먼저)
2. Meta 광고 문의 화면 Ctrl+Shift+R → 탭 제목 `mtl-1023wa`

## ③ 테스트방법

- 다른 휴대폰으로 **ERP API 번호**에 「hola, horquillas versa 2017」을 보낸다 → 몇 초 뒤 새로 고침 → 목록 맨 위에 WA 행이 보이는지 확인한다.
- ERP에서 그 번호로 답장한다 → 문의를 열어 대화에 답장이 있는지 확인한다.

## ④ 변경파일

| repo 경로 | 변경 |
|---|---|
| `refatrix-api/src/metaLeads.js` | `upsertWaThread`(번호 하나 → 문의 행, 가져오기와 공용) · `kickWaThread`(2초 모아 반영 · 사내 번호 제외 · AI 깨움) · `waLive` 상태 · 메시지 정렬 id 보조 |
| `refatrix-api/src/waWebhook.js` | 받은 메시지 저장 뒤 `kickWaThread`(재전송 중복이면 안 함) |
| `refatrix-api/src/waPromo.js` | 보낸 메시지 기록 뒤 `kickWaThread` |
| `refatrix-api/src/routes/metaLeadsRoutes.js` | status.wa에 live · live_at · live_count · live_error |
| `refatrix-metaleads.html` | 「⚡ 실시간 접수」 표시 · build `mtl-1023wa` |
| `refatrix-api/test/meta_ads.test.mjs` | **B5** 추가 — 가져오기 없이 목록에, 광고 연결, 두 메시지 한 문의, 우리 답장 = 마지막 대응, 사내 번호 제외 |

(앞 배포분 0295 파일도 zip에 같이 들어 있다 — 이미 올렸으면 덮어써도 같다.)

## ⑤ 검증결과

- meta_ads 8/8 · meta_leads 19/19 · wa_webhook 12/12 · wa_promo 19/19 · wa_promo_front 15/15 · quote_wa_notify 21/21 통과(실 PostgreSQL 16).
- lead_wa_notify 27/28 · integration_nav 3/4 — 남은 실패는 화면 캐시 마커 검사이고, 이번 변경 전에도 같다.

## ⑦ 오픈이슈 — ★ 휴대폰 앱 번호 8118250003

- **실시간 접수는 ERP Cloud API 번호로 온 메시지만 된다.** 8118250003은 휴대폰 WhatsApp Business **앱** 번호라 Meta가 API로 주지 않는다.
- 광고 · 봇 안내에 8118250003이 적혀 있으면 그 문의는 여전히 들어오지 않는다. 방법은 둘이다:
  1. 광고 · 봇 안내의 WhatsApp 번호를 **ERP API 번호로 바꾼다** — 오늘부터 바로 전부 들어온다.
  2. 8118250003을 **공존(coexistence)**으로 Cloud API에 연결한다 — 휴대폰 앱을 그대로 쓰면서 ERP로도 들어오고, 최근 6개월 대화도 가져온다. Meta Embedded Signup 절차가 필요해 별도로 진행한다.

## ⑥ Railway 마이그레이션(콘솔에 npm · node가 안 잡힐 때)

- 콘솔 PATH에 node가 없을 수 있다. node 위치를 찾아 실행한다(채팅에 보낸 한 줄 명령).
- 근본 해결: Railway › API 서비스 › Settings › Deploy › **Pre-deploy Command**에 `node scripts/migrate.js`를 넣는다. 배포마다 자동으로 마이그레이션이 돈다.
