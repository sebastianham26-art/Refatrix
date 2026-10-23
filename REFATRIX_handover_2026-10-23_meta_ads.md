# REFATRIX 인수인계 — Meta 광고 문의: 광고별로 나눠 보기 (광고 ID 등록 · 이름 붙이기 · 광고별 문의 목록) (2026-10-23)

**마이그레이션 0295 (`npm run migrate` 필수)** · 화면 build `mtl-1023ad` · 산출물 `refatrix_meta_ads_1023.zip` (8파일) · 기준 커밋 `040db28`

## ① 설명

디렉터 지시:
- 「광고별 고유번호가 Meta 에 있다. 그 번호를 ERP 화면에 입력하면 번호에 맞는 광고 이름을 내가 붙이게 해 달라」
- 「고유번호별로 고객 정보를 나눠 보고, 광고를 골라 고객 문의 내용을 볼 수 있게 해 달라」

고유번호 = Meta 광고 관리자의 **광고 ID**(숫자 15~18자리)다. 고객이 광고를 눌러 메시지를 보내면 Meta 웹훅이 같은 번호를 보내 준다.

### 1) 문의마다 광고 하나 — 우선순위

1. **사람이 고른 광고** — 문의를 열고 「광고」에서 고른다(전화 문의 · 기록이 빠진 경우).
2. **Meta 광고 기록(웹훅)** — 그 고객이 **가장 먼저 누른 광고**.
   - WhatsApp(ERP API 번호): `messages[].referral.source_id`
   - Messenger / Instagram: `messaging[].referral.ad_id` (message · postback 안에 올 때도 받음)
3. **구분 문구** — 광고를 등록할 때 적은 문구(예: 그 광고의 첫 메시지 · 버튼 문구, 「vi el anuncio A07」)가 고객 메시지에 있으면 그 광고. 대소문자는 무시한다. 웹훅 기록이 생기기 **전의 예전 문의**를 나누는 용도다.

어느 것도 없으면 「광고 외 / 직접」이다.

### 2) 화면 — 제품·마케팅 › Meta 광고 문의 › 「📣 광고별 문의」 탭 (새로 추가)

- **광고 등록**: 광고 ID · 광고 이름 · 구분 문구(선택) · 메모 · 사용 중. 공백과 `-`는 지우고 숫자만 받는다. 같은 ID는 한 번만 등록된다.
- **광고별 문의 표**: 광고 | 문의 | 전화 | 신규 · 연락함 · 연결 · 판매 | 채널(FB · IG · WA) | 근거(기록 · 문구 · 직접) | 마지막 문의 | 수정 · 삭제.
  - **미등록 광고**(웹훅으로 들어왔는데 이름이 없는 ID)는 주황 줄로 보인다. Meta 광고 제목이 이름 칸에 미리 들어가 있고, 「이름 붙이기」를 누르면 등록된다.
  - 맨 아래는 「광고 외 / 직접」이다.
- **행을 누르면** 그 광고의 문의가 아래에 나온다: 최초 일시 · 이름/계정 · 연락처 · 채널 · 문의내용(AI 요약 또는 고객 메시지) · 마지막 대응(우리 쪽 마지막 메시지) · 상태. 한 건을 누르면 대화 전체가 열린다.
- 「이 광고로 목록 · 요약 · 엑셀 보기 →」를 누르면 📋 목록 탭의 **광고 필터**가 그 광고로 맞춰진다. 수요 요약과 엑셀도 그 광고 기준이 된다.
- **📋 목록**: 「광고」 열과 「광고」 필터(전체 / 광고 외 / 광고별)가 추가됐다.
- **한 건 열기**: 「광고」 선택칸이 추가됐다. 비우면 자동값(기록 → 문구)이고, 근거가 함께 표시된다.
- **엑셀**: Contactos에 Anuncio · ID del anuncio · Primer mensaje (hora) 열을 추가했다. 새 시트 **Por anuncio**도 추가했다.
- 「Messenger 페이지 웹훅 연결」 버튼: 페이지를 앱 웹훅에 연결한다(`POST /{page}/subscribed_apps`).

## ② 배포단계

1. zip 풀기 → Commit → Push → Railway **Success**
2. `npm run migrate` → `apply 0295_meta_ads.sql`
3. Meta 광고 문의 화면 Ctrl+Shift+R → 탭 제목이 `mtl-1023ad`인지 확인
4. **Meta 웹훅에 Messenger · Instagram 추가 (한 번만)** — ⑥ 참고
5. 「📣 광고별 문의」에서 광고 ID와 이름을 등록한다.

## ③ 테스트방법

- 광고 관리자 › **광고** 탭 › 열 맞춤 설정 › 「광고 ID」 → ID를 복사한다 → ERP에 이름과 함께 등록한다.
- 다른 휴대폰으로 그 광고를 눌러 메시지를 보낸다 → 「📡 Meta 광고 기록」 건수가 늘어나는지 본다 → 「⟳ 새 문의 가져오기」 → 광고 행의 문의 수가 늘어나는지 본다.
- 예전 문의: 광고의 버튼 문구를 「구분 문구」에 넣는다 → 그 광고 행의 「근거: 문구 n」을 확인한다.

## ④ 변경파일

| repo 경로 | 변경 |
|---|---|
| `refatrix-api/migrations/0295_meta_ads.sql` | **신규** — `meta_ads`(광고 ID · 이름 · 메모 · 구분 문구 · 사용 중), `meta_ad_touches`(웹훅 광고 출처, event_key로 중복 방지), `meta_threads.m_ad_id` |
| `refatrix-api/src/metaAds.js` | **신규** — WhatsApp · Messenger · Instagram referral 해석(에코 제외), 저장, 광고 결정 SQL(사람 > 기록 > 문구), 페이지 웹훅 연결 |
| `refatrix-api/src/waWebhook.js` | 수신 메시지의 referral 기록. 같은 주소로 오는 `object=page` · `instagram` 웹훅 처리 |
| `refatrix-api/src/routes/metaLeadsRoutes.js` | 목록에 ad_id · ad_src · ad_name · first_mx_t · last_reply 추가. `?ad=` 필터. PATCH `ad_id`. `/api/meta-leads/ads` GET · POST · PATCH · DELETE · subscribe |
| `refatrix-metaleads.html` (루트) | 「📣 광고별 문의」 탭, 목록 광고 열 · 필터, 한 건 광고 선택, 엑셀 Por anuncio · build `mtl-1023ad` |
| `refatrix-api/test/meta_ads.test.mjs` | **신규** 7개(A2 · B4 · C3) |
| `refatrix-api/test/meta_leads.test.mjs` | build 토큰만 갱신 |

## ⑤ 검증결과

- `meta_ads` **7/7**(실 PostgreSQL 16 · 새 DB · 0295 재실행 멱등)
  - **A**:
    - WhatsApp referral(521 → 52, post 출처 버림)
    - Messenger 본문 · message · postback referral, 에코 제외, ms 시각, Instagram
  - **B**:
    - 서명 웹훅(재전송 1회만, 잘못된 서명 401)
    - 미등록 → 이름 붙이기 → 광고별 목록
    - 나중에 다른 광고를 눌러도 첫 광고 기준
    - 광고 외 / 직접
    - 구분 문구(대소문자 무시) · 사람 지정 우선 · 빈 값이면 자동
    - 수정 · 삭제 후 미등록으로 남음
    - 권한: 보기 권한은 등록 불가(read_only), 권한 없으면 403
    - 페이지 웹훅 연결 성공 · 실패
  - **C**: 목록 광고 열 · 필터, 광고 탭 등록(공백 · `-` 제거), 미등록 이름 붙이기, 광고 선택 → 문의(최초 일시 · 연락처 · 문의 · 대응), 「목록으로」, 한 건 광고 지정
- 회귀: meta_leads 19/19 · wa_webhook 12/12 · wa_promo 19/19 · wa_promo_front 15/15 통과. integration_nav 3/4 — nav 캐시 마커 1건은 기존 실패로, 이번 변경 전에도 같다.
- 구버전 서버(광고 API 없음)에서도 화면이 깨지지 않는다.
- Chromium으로 데스크톱 · 휴대폰 폭 화면 확인(페이지 오류 0).

## ⑥ 결정사항 · Meta 웹훅 설정 (한 번만)

- **콜백 URL은 WhatsApp과 같다**: `https://refatrix-production.up.railway.app/api/wa/webhook`, 확인 토큰도 같다. 서버가 object(whatsapp / page / instagram)로 구분한다.
- developers.facebook.com › 앱 RefatrixERPmensaje › **웹훅**:
  - **Page**: 같은 콜백 URL · 확인 토큰 → 필드 `messages` · `messaging_referrals` · `messaging_postbacks` 구독
  - **Instagram**: 같은 콜백 URL · 확인 토큰 → 필드 `messages` 구독 (Instagram 광고 출처는 메시지 안 `message.referral`로 온다)
- 그다음 ERP 「Messenger 페이지 웹훅 연결」 버튼을 누른다(페이지 토큰에 `pages_manage_metadata` 필요). 실패하면 오류 사유가 화면에 나온다.
- WhatsApp(ERP API 번호)은 이미 `messages`를 구독하고 있어 추가 설정이 없다.
- 광고 삭제는 **등록만 지운다**. 문의와 웹훅 기록은 남아 「미등록 광고」로 다시 보인다.

## ⑦ 오픈이슈

- **예전 문의에는 광고 ID 기록이 없다.** Graph 대화 목록(`/conversations`)에는 광고 정보가 없고, 웹훅 기록은 오늘 배포 이후부터 쌓인다. 예전 문의는 「구분 문구」나 직접 지정으로 나눈다.
- **WhatsApp 앱 번호(8118250003)로 온 광고 문의는 광고 ID가 오지 않는다.** API로 들어오지 않기 때문이다. 광고의 WhatsApp 번호를 ERP API 번호로 바꾸거나 공존(coexistence)으로 연결하면 들어온다.
- 리드 양식(인스턴트 양식) 리드는 이번 범위가 아니다(`leadgen` 웹훅에 ad_id 있음 — 필요하면 같은 표에 붙일 수 있다).

## ⑧ 다음액션

- 배포 → migrate → 웹훅 Page · Instagram 구독(⑥) → 「Messenger 페이지 웹훅 연결」 → 광고 등록 → 테스트 메시지
- 원하시면 다음 기능을 이어서 만든다: 광고별 주문 · 매출 연결(고객 등록 · 주문 열), 광고 ID를 refatrix.com 주문 할인 코드와 묶기.
