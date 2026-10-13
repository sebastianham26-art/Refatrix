# REFATRIX 인수인계 — Meta 광고 문의 가져오기 (Messenger · Instagram → 지역 · 연락처 · 차종 · 부품) (2026-10-12k)

**마이그레이션 0270 (`npm run migrate` 필수)** · 새 화면 `refatrix-metaleads.html` (build `mtl-1012a`) · 산출물 `refatrix_meta_leads.zip` (9파일) · 기준 커밋 `1d64e32`

## ① 설명

디렉터 지시: Meta 광고 문의가 500건이 넘는다. 이를 **지역 · 이름 · 연락처 · 수요품목**으로 엑셀 목록화해서 우리 고객(refaccionaria)의 판매기회로 만들고 싶다.

받은편지함 화면을 하나씩 읽는 방식은 목록을 20건씩 손으로 내려야 하고, Chrome 창이 숨겨지면 멈췄다. 그래서 **Meta Graph API로 페이지 대화를 직접 가져오는 ERP 기능**으로 만들었다.

- **제품·마케팅 › 📨 Meta 광고 문의** (새 메뉴, 마케팅 권한)
  - 「⟳ 새 문의 가져오기」를 누르면 Messenger · Instagram 대화를 한 번에 받는다. 처음에는 최근 180일, 이후에는 30분마다 새로 바뀐 대화만 받는다.
  - 고객이 쓴 말에서 아래 값을 **자동 추출**한다. 우리 봇·직원 메시지는 빼고 고객 말만 본다.
    - 업종: Refaccionaria · Mayorista · Taller · Flotilla · Taxi/app · Particular
    - 지역: 32개 주와 주요 도시
    - 전화 · 이메일
    - 차종+연식: Nissan Versa 2018 등 80여 종
    - 부품: Horquilla · Rótula · Terminal ext/int · Bieleta · Amortiguador · Base · Buje · Soporte de motor · Maza · Cremallera …
    - 문의 의도: 가격 · 카탈로그 · 배송 · 구매처 · 상담원
  - 광고 버튼 문구 「Soy Particular **de MTY**…」는 지역으로 쓰지 않는다. 버튼에 박힌 글자이기 때문이다. 업종은 「(버튼)」으로 따로 표시한다.
  - 봇 안내문의 우리 번호 8118250003은 고객 전화로 잡지 않는다.
- **한 건을 열면** 대화 전체가 보이고 지역·차종·부품·전화를 사람이 고칠 수 있다. 상태(신규 / 연락함 / refaccionaria 연결 / 판매 / 제외), 연결한 refaccionaria, 메모도 적을 수 있다. 고친 값은 다시 가져와도 지워지지 않는다.
- **📊 지역 · 수요 요약**: 주별 문의, 차종, 부품 막대그래프와 「지역 × 수요 — refaccionaria에 넘길 판매기회」 표.
- **📥 엑셀**(스페인어 시트 5개): Contactos · Oportunidades por estado · Por estado · Por vehículo · Por pieza.

## ② 배포단계

1. zip 풀기 → Fetch/Pull → Commit → Push → Railway **Success**
2. `npm run migrate` → `apply 0270_meta_leads.sql`
3. **Meta 토큰을 한 번만 설정한다.** 아래 ⑥ 순서대로 한다.
4. 제품·마케팅 › **Meta 광고 문의**를 연다(Ctrl+Shift+R). 탭 제목이 `mtl-1012a`인지 확인한다.
5. 「⟳ 새 문의 가져오기」를 누른다. 몇 분 걸리고, 진행 건수가 화면에 보인다. 끝나면 목록과 「📥 엑셀」을 확인한다.

## ③ 테스트방법

- 상단 줄에 페이지 이름과 Instagram @계정이 보이면 연결된 것이다. 빨간 「Meta 연결 오류 #…」가 보이면 ⑥의 권한을 확인한다.
- 「차종·부품 있는 것만」을 켜고 주를 고른다 → 엑셀을 받는다 → 그 지역 refaccionaria에 전달한다 → 상태를 「refaccionaria 연결」로 바꾼다.

## ④ 변경파일

| repo 경로 | 변경 |
|---|---|
| `refatrix-api/migrations/0270_meta_leads.sql` | **신규** — `meta_threads`(대화 1건 = 1행, 자동값 a_* / 사람 값 m_* / 상태 · 메모), `meta_sync_runs` |
| `refatrix-api/src/metaLeadExtract.js` | **신규** — 업종 · 지역 · 전화 · 차종 · 부품 · 의도 추출 규칙(순수 함수) |
| `refatrix-api/src/metaLeads.js` | **신규** — 페이지 토큰 확인(시스템 사용자 토큰 → 페이지 토큰), 대화 가져오기(페이지 넘김 · 증분), 저장, 다시 추출, 30분 워커 |
| `refatrix-api/src/routes/metaLeadsRoutes.js` | **신규** — `/api/meta-leads/{status, sync, list, :id, reextract}` |
| `refatrix-api/src/server.js` | 라우트 · 워커 등록 |
| `refatrix-api/src/secrets.js` | 외부 서비스 키에 **「Meta 페이지」** 카드(`META_PAGE_TOKEN` · `META_PAGE_ID` · `META_LEADS_DAYS`) + 연결 시험 |
| `refatrix-metaleads.html` (루트) | **신규 화면** |
| `refatrix-nav.js` (루트) | 메뉴 `metaleads`(제품·마케팅, 권한 marketing) |
| `refatrix-api/test/meta_leads.test.mjs` | **신규** 13개 |

## ⑤ 검증결과

- `meta_leads` **13/13**(실 PostgreSQL 16, 새 DB에 migrate)
  - **A 추출 규칙(실제 문의 문장):**
    - Jiutepec, Morelos / 택시 / Versa 2024 / 부품 5종
    - 「¿solo mayoreo?」 질문은 업종으로 치지 않음
    - Monclova → Coahuila
    - 연식이 붙은 「kics2024」, 다음 줄에 쓴 연식
    - 다음 차의 연식을 끌어오지 않음
    - 버튼의 MTY는 지역 아님
    - 우리 번호, 연식 나열은 전화 아님
  - **B 서버 + DB + Graph 가짜 응답:**
    - 시스템 사용자 토큰 → 페이지 토큰으로 바꿔 읽음
    - Messenger 2페이지 + Instagram
    - 고객 말과 우리 말 구분
    - 필터 7종
    - 사람이 고친 값 · 상태 · 메모가 전체 다시 가져오기 후에도 유지
    - 빈 값 = 자동값으로 복귀
    - 증분 가져오기는 마지막 성공 이후까지만 읽음
    - 토큰 오류(#190) 기록
    - 다시 추출
    - 권한: 마케팅 권한 없으면 403
  - **C 화면(jsdom):**
    - 상태 · 목록 · 버튼 업종 표시
    - 한 건 열기 · PATCH 본문
    - 가져오기
    - 엑셀 5개 시트 내용(연식을 뗀 모델로 묶음)
    - onclick 없음 · 메뉴
- 회귀: integration_nav 4 · wa_promo 10 · wa_promo_front 7 · quote_wa_notify 21 · lead_wa_notify 28 통과. service_secrets 23/24 — C3 1건은 기존 실패로, 이번 변경 전에도 같다.
- 0270 새 DB 적용 + 재실행 멱등. Chromium으로 화면 확인(페이지 오류 0).

## ⑥ 결정사항 · Meta 토큰 만들기 (한 번만)

WhatsApp에 쓰는 **시스템 사용자**에 페이지를 붙이면 된다. 같은 Meta 앱 `RefatrixERPmensaje`를 쓴다.

1. business.facebook.com › **설정 › 사용자 › 시스템 사용자** → WhatsApp 토큰을 만든 그 시스템 사용자를 고른다.
2. **「자산 추가」 › 페이지** → CTR Suspensión y Dirección México → **「메시지」(또는 전체 관리)** 를 켠다. Instagram 문의도 받으려면 **Instagram 계정**(ctrmexico_)도 같은 방식으로 추가한다.
3. **「새 토큰 생성」** → 앱 RefatrixERPmensaje → 만료 **없음** → 다음 권한을 체크한다:
   - 필수: `pages_show_list` · `pages_read_engagement` · `pages_manage_metadata` · `pages_messaging`
   - Instagram용: `instagram_basic` · `instagram_manage_messages`
   - 기존 WhatsApp 권한(`whatsapp_business_messaging` 등)도 함께 체크하면, 이 토큰 하나로 WhatsApp까지 쓸 수 있다.
4. ERP **관리 › 외부 서비스 키 › 「Meta 페이지」 › 페이지 · 시스템 사용자 토큰**에 붙여 넣고 「연결 시험」을 누른다. 「페이지 대화를 읽을 수 있습니다」가 나오면 된다.
5. 페이지 ID는 비워 두면 1338649012669713(Business Suite 주소의 asset_id)을 쓴다.

> 이 칸을 비워 두면 WhatsApp 영구 토큰으로 시도한다. 3번에서 같은 토큰에 페이지 권한을 넣었다면 따로 넣지 않아도 된다.

## ⑦ 오픈이슈

- **Facebook 프로필의 거주지는 API로 오지 않는다.** 받은편지함 오른쪽에 보이던 「멕시코시티에 거주」 같은 값이다. 그래서 지역은 고객이 대화에서 말한 것만 잡힌다. 지역이 비어 있는 문의는 「지역 모름」 필터로 모아, 직원이 「¿De qué ciudad nos escribe?」 한 줄을 물어보는 운영을 권한다.
- **봇 첫 질문이 지역을 더 잘 받게 할 수 있다.** 지금 첫 질문은 「…y de qué municipio nos contactas」인데 대부분 버튼만 누른다. 광고 버튼 문구에서 「de MTY」를 빼고 「¿En qué ciudad estás?」 버튼형 질문을 넣으면 지역 확인률이 크게 오른다(Meta 광고 관리자에서 수정).
- **WhatsApp 문의**는 이미 ERP WhatsApp 마케팅 › 받은 메시지에 쌓이고 있어 이번 범위에서 뺐다. Business 앱으로만 받은 WhatsApp은 API로 읽을 수 없다.
- Meta API는 대화당 최근 80개 메시지까지 받는다. 그보다 긴 대화는 앞부분이 빠진다.

## ⑧ 다음액션

- 배포 → migrate → 토큰 설정(⑥) → 「⟳ 새 문의 가져오기」 → 엑셀
- 원하시면 다음 기능을 이어서 만든다: 주별 refaccionaria 고객 자동 추천(ERP 고객의 주 · 팀과 매칭), 담당 refaccionaria에 WhatsApp으로 문의 전달.
