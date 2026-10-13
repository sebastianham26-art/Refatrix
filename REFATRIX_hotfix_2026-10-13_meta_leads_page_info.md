# REFATRIX 핫픽스 — Meta 광고 문의: 페이지 정보 권한(#100) 없어도 대화 가져오기 (2026-10-13)

**마이그레이션 없음** · 화면 build `mtl-1013b` · 산출물 `refatrix_meta_leads_hotfix_1013.zip` (5파일) · 기준 커밋 `c175502`

## ① 설명

증상: 「연결 시험」은 「페이지 대화를 읽을 수 있습니다」(HTTP 200)였다. 그런데 「⟳ 새 문의 가져오기」를 누르면 **#100 … requires the 'pages_read_engagement' permission**으로 실패하고 대화가 0건이었다.

원인:
- 디렉터는 토큰을 Messenger API 설정의 「토큰 생성」에서 받았다. 이 페이지 토큰은 대화 읽기(`pages_messaging`)는 되지만, 페이지 정보 `/{page}?fields=name,instagram_business_account`는 `pages_read_engagement`가 없어 거절된다.
- ERP는 가져오기 전에 페이지 정보부터 확인하다가 여기서 멈췄다.

수정:
- 페이지 정보 조회가 실패해도 **대화를 읽을 수 있으면 그대로 진행**한다. 화면에는 빨간 오류가 아니라 주황 안내를 띄운다.
- Instagram 계정 id를 페이지 정보에서 못 받으면, **대화 참여자로 추정**한다. 모든 대화에 공통으로 있는 참여자를 우리 계정으로 본다. 대화가 1건뿐이면 추정하지 않고 다음 가져오기에서 다시 시도한다.
- Instagram 쪽이 권한 문제로 실패해도 Messenger 결과는 성공으로 저장한다.

## ② 배포단계

1. zip 풀기 → Commit → Push → Railway **Success** (migrate 불필요)
2. Meta 광고 문의 화면 Ctrl+Shift+R → 탭 제목이 `mtl-1013b`인지 확인
3. 「⟳ 새 문의 가져오기」 (처음 실행은 「전체 다시 가져오기」와 같다)

## ③ 테스트방법

- 상단 「연결 · 가져오기」 카드에 빨간 오류 대신 주황 안내 「ⓘ 대화는 정상으로 가져옵니다…」가 보인다.
- 마지막 가져오기가 「성공 · 대화 N건」이고, 목록이 채워진다.

## ④ 변경파일

| repo 경로 | 변경 |
|---|---|
| `refatrix-api/src/metaLeads.js` | `resolvePage` 3단계 시도 → 실패해도 대화 시험 통과면 진행(경고) · `inferBusinessId` · Instagram 계정 추정 |
| `refatrix-api/src/routes/metaLeadsRoutes.js` | 상태에 `page_warning` |
| `refatrix-metaleads.html` (루트) | 경고 표시 · build `mtl-1013b` |
| `refatrix-api/test/meta_leads.test.mjs` | **B6** 추가(#100 페이지 정보 → 대화 정상 · IG 추정 · 1건이면 추정 안 함) · 토큰 갱신 |

## ⑤ 검증결과

- `meta_leads` **14/14**(실 PostgreSQL 16 · 새 DB migrate). B6: 페이지 정보가 #100이어도 받은 토큰 그대로 Messenger·Instagram을 저장하고, IG 우리 메시지를 구분한다.
- 회귀: integration_nav 4/4 · service_secrets 23/24(C3 기존 실패, 변경 전과 동일)

## ⑥ 결정사항

- 페이지 정보 권한은 필수가 아니다. 대화 읽기 권한만 있으면 가져온다.

## ⑦ 오픈이슈

- 이 토큰으로는 화면에 페이지 이름 · Instagram @계정이 표시되지 않는다(기능에는 영향 없음). 표시하려면 Graph API 탐색기에서 `pages_read_engagement`까지 넣은 페이지 토큰으로 바꾸면 된다.
- Instagram 대화를 읽으려면 페이지 토큰에 `instagram_manage_messages`가 있고, Instagram 계정이 CTR 페이지에 연결돼 있어야 한다. 실패하면 마지막 가져오기 줄에 `instagram: …` 사유가 남는다.

## ⑧ 다음액션

- 배포 → 가져오기 → 숫자(전체 · 차종·부품 · 지역 · 전화)를 확인한 뒤 추출 규칙을 보강한다.
