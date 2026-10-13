# REFATRIX 인수인계 — Meta 광고 문의: AI 대화 분석(고객 유형 · 지역 · 차종+연식 · 부품) + WhatsApp 출처 + 지역·수요 요약 개편 (2026-10-13c)

**마이그레이션 0271 (`npm run migrate` 필수)** · 화면 build `mtl-1013ai` · 산출물 `refatrix_meta_leads_ai_1013.zip` (10파일) · 기준 커밋 `90bcff2`

## ① 설명

디렉터 지시:
- 「지역수요요약을 더 잘해 줘. 대화 내용에 차종과 연식, 요청 부품, particular인지 flotilla인지, 지역 정보가 있다 — 감지해서 보여 줘야 한다」
- 「채널에 WhatsApp 출처가 없는데 WhatsApp으로 온 내용이 중요하니 받을 수 있게 해 줘. WhatsApp에는 연락처 정보가 있다」

### 1) AI 대화 분석 (새로 추가)

- 규칙 추출은 철자 · 문맥을 놓쳤다. 예: 「berza 17」, 직원이 「¿Confirmas que es para un Nissan Sentra 2015?」라고 묻고 고객이 「sí」.
- 이제 **Claude(Haiku 4.5)가 대화 전체(고객 + 우리 직원)를 읽고** 아래 값을 뽑는다:
  - **고객 유형**: Particular · Taller mecánico · Refaccionaria · Mayorista · Flotilla · Taxi / app. 근거를 함께 남긴다: 본인이 말함 / 광고 버튼만 누름 / 문맥 추정.
  - **지역**: 32개 주 + 도시. 도시에서 주를 추론한다(Monclova → Coahuila).
  - **차종 · 연식 · 부품 짝**: 「Versa 2018 → 호시 · 쇼바, March 2015 → 로툴라」처럼 차종과 부품을 짝지어 둔다. 오타도 교정한다.
  - **전화** · **관심**(가격 · 카탈로그 · 배송 …) · **한 줄 요약**(스페인어).
- 값의 우선순위: **사람이 고친 값 > AI > 규칙**.
- 언제 돈다:
  - 가져오기가 끝나면 바뀐 대화만 자동으로 분석한다. 대화 내용 지문이 같으면 다시 보내지 않는다.
  - 「🤖 AI 전체 다시 분석」을 누르면 전부 다시 분석한다.
  - 고객이 버튼만 누르고 아무 말도 안 쓴 대화는 AI에 보내지 않는다(비용 절약).
- Anthropic 키(관리 › 외부 서비스 키)를 쓴다. 모델은 「Meta 페이지」 카드의 「문의 분석 AI 모델」에서 바꿀 수 있다.

### 2) WhatsApp 출처

- **ERP WhatsApp Cloud API 번호로 받은 대화**(WhatsApp 마케팅 › 받은 메시지에 쌓이는 것)를 같은 목록에 「WA」 채널로 합친다.
  - **WhatsApp 번호가 곧 연락처**라 전화 칸이 항상 채워진다.
  - 이름은 연락처 이름, 없으면 **WhatsApp 프로필 이름**을 쓴다. 이번에 웹훅이 프로필 이름을 저장하도록 바꿨다.
  - 사내 번호는 뺀다: 사용자 WhatsApp 번호, 신규견적 알림 수신자, 일일요약 번호.
  - Meta 토큰이 없어도 WhatsApp은 가져온다.

### 3) 지역 · 수요 요약 개편

- KPI: 문의 · 차종·부품 확인 · 고객 유형 확인 · 지역 확인 · 전화 · AI 요약 (각 %)
- 막대: **고객 유형** · 주 · 부품
- **차종 · 연식 × 부품 표**: 차종 | 부품 | 문의 수 | 연식 분포 | 어느 주 | 어떤 고객 유형 | 전화 있는 수
- **주별 판매기회 표**: 주 | 문의 | 수요 확인 | 전화 | 고객 유형 분포(P 개인 · T 정비소 · R 부품점 · F 플리트 · Taxi) | 많이 찾는 차종·연식 | 많이 찾는 부품
- 목록: 채널 FB/IG/**WA**, 고객 유형에 「(버튼)」「(추정)」 표시, 메시지 칸에 🤖 AI 요약. 한 건 열면 AI 요약과 관심 표시.
- 엑셀 7개 시트: Contactos(유형 근거 · AI 요약 열 추가) · Oportunidades por estado · **Demanda vehículo-pieza** · **Por tipo** · Por estado · Por vehículo · Por pieza

## ② 배포단계

1. zip 풀기 → Commit → Push → Railway **Success**
2. `npm run migrate` → `apply 0271_meta_leads_ai.sql`
3. Meta 광고 문의 화면 Ctrl+Shift+R → 탭 제목이 `mtl-1013ai`인지 확인
4. 「⟳ 새 문의 가져오기」 → WhatsApp 대화가 합쳐지고, 끝나면 AI 분석이 자동으로 이어진다(「🤖 AI 분석 중… n / N」)
5. 이미 가져온 대화도 분석하려면 「🤖 AI 전체 다시 분석」 한 번(500건 ≈ 몇 분)

## ③ 테스트방법

- 상단 줄 「🤖 AI 분석 N건 완료」 확인
- 지역·수요 요약 탭 → 「차종 · 연식 × 부품」 표 → 엑셀 「Demanda vehículo-pieza」
- 채널 필터 WhatsApp → 전화 칸이 채워져 있는지 확인

## ④ 변경파일

| repo 경로 | 변경 |
|---|---|
| `refatrix-api/migrations/0271_meta_leads_ai.sql` | **신규** — `meta_threads.ai_*` 14열 · platform에 `whatsapp` · `wa_inbound.profile_name` |
| `refatrix-api/src/metaLeadsAi.js` | **신규** — 대화 정리(봇 안내 제외) · 프롬프트 · JSON 해석 · 값 정리(주 이름 · 우리 번호 제거) · 8건씩 분석 · 지문 비교 |
| `refatrix-api/src/metaLeads.js` | `syncWhatsAppThreads`(사내 번호 제외 · 10자리 연락처) · 가져오기 순서 WA → Graph · 끝나면 AI 자동 |
| `refatrix-api/src/routes/metaLeadsRoutes.js` | 우선순위 m > ai > a · `demand` · `summary` · `/api/meta-leads/ai` · 상태에 AI · WA 건수 · 토큰 없어도 가져오기 |
| `refatrix-api/src/waWebhook.js` | 보낸 사람 프로필 이름 저장 |
| `refatrix-api/src/secrets.js` | 「문의 분석 AI 모델」 칸 |
| `refatrix-metaleads.html` (루트) | 요약 탭 개편 · AI 버튼 · WA 채널 · 엑셀 7시트 · build `mtl-1013ai` |
| `refatrix-api/test/meta_leads.test.mjs` | A3 · B7 · B8 추가 · B1 · C 갱신 |

## ⑤ 검증결과

- `meta_leads` **17/17**(실 PostgreSQL 16 · 새 DB · 0271 재실행 멱등)
  - **A3**: 봇 안내 제외, 직원 확인 질문은 남김, 주 이름 대소문자·악센트 무시, 32개 주 밖은 버림, 우리 번호 제거
  - **B7**: WA 대화 합치기, 사내 번호 제외, 프로필 이름, 번호 = 연락처, (imagen) 표시
  - **B8**:
    - 키 없으면 400
    - 고객 말이 있는 대화만 보내고, 봇 안내는 안 보냄
    - 사람이 고친 값 > AI > 규칙
    - 같은 대화는 재호출하지 않음
    - 사람이 차종을 고치면 AI 짝은 숨김
    - 깨진 응답은 오류로 남기고 대기
  - **C**: WA 행 · AI 요약 · 엑셀 7시트(차종-부품 짝 · 연식 분포 · 유형 근거) · AI 버튼
- 회귀: wa_webhook 12 · wa_promo 10 · wa_promo_front 7 · integration_nav 4 · quote_wa_notify 21 · lead_wa_notify 28 통과. service_secrets 23/24(C3 기존 실패).
- 웹훅 실제 모양 페이로드로 profile_name 저장 확인. Chromium 화면 확인(오류 0).

## ⑥ 결정사항

- 문의 분류는 AI가 1차로 한다. 사람이 고친 값이 항상 이긴다.
- WhatsApp 문의는 ERP Cloud API 번호로 받은 것을 합친다.

## ⑦ 오픈이슈 — ★ WhatsApp 번호

- **ERP가 읽을 수 있는 WhatsApp은 Cloud API 번호로 들어온 대화뿐이다.** 광고와 봇 안내에 적힌 **8118250003**이 휴대폰 WhatsApp Business **앱**에서 쓰는 번호라면, 그 대화는 Meta가 API로 주지 않는다. Business Suite 받은편지함에도 「WhatsApp Business 앱에서만 볼 수 있음」으로 나왔다.
  - 방법 1: 광고 · 봇 안내의 WhatsApp 번호를 **ERP Cloud API 번호**로 바꾼다 → 모든 문의가 ERP로 들어온다(자동응답 · 연락처 포함).
  - 방법 2: 8118250003을 **앱 + API 공존(coexistence)**으로 Cloud API에 연결한다 → 휴대폰 앱을 그대로 쓰면서 대화가 ERP로 들어온다. 최근 6개월 대화도 동기화된다. Meta 「Embedded Signup」 절차라 별도로 진행한다.
- AI 비용: Haiku 기준 대화 500건 전체 분석이 대략 1~2달러 수준이다(대화 길이에 따라 다름).

## ⑧ 다음액션

- 배포 → migrate → 가져오기 → AI 전체 분석 1회 → 요약 확인
- WhatsApp 번호 결정(⑦ 방법 1 또는 2)
