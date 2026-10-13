# REFATRIX 인수인계 — 제품·마케팅 화면 권한: WhatsApp 마케팅 = 디렉터·소시오 전용 / Meta 광고 문의 = 제품·마케팅 사용자 모두 (2026-10-13b)

**마이그레이션 없음** · `refatrix-wapromo.html` build `wap-1013ds` · 산출물 `refatrix_pm_access_1013.zip` (9파일) · 기준 커밋 `098628b`

## ① 설명

디렉터 지시: 「제품 마케팅에서 WhatsApp 마케팅 화면은 디렉터와 소시오 전용으로 해 주고, Meta 광고 문의는 제품·마케팅 페이지에 접속 가능한 사람들은 모두 볼 수 있게 해 줘」

| 화면 | 전 | 후 |
|---|---|---|
| **WhatsApp 마케팅** | 마케팅 화면 권한이 있는 사람 | **디렉터 · 소시오만.** 화면 권한과 상관없이 역할로 판단한다. 다른 역할은 메뉴에 안 보이고, 주소로 직접 열어도 서버가 403(`director_or_socio_only`)을 돌려준다 |
| **Meta 광고 문의** | 마케팅 화면 권한이 있는 사람 | **제품·마케팅 메뉴에 들어가는 사람 모두.** 권한키 `products · marketing · pricemaster · devrequest · quote · sales` 중 하나라도 있으면 볼 수 있다. 그중 하나라도 「편집」이면 상태 · 메모 수정과 가져오기도 된다 |

- `devrequest`(개발 요청)는 견적 · 영업 권한으로도 열리는 화면이다. 그래서 영업 · 견적 권한자도 제품·마케팅 메뉴에 들어간다. 이들도 Meta 문의를 보고, refaccionaria 연결 상태를 적을 수 있다.
- 메뉴(`refatrix-nav.js`)와 서버(`PM_KEYS`)는 같은 목록을 쓴다. 메뉴에는 보이는데 서버가 막는 일이 없다.

## ② 배포단계

1. zip 풀기 → Commit → Push → Railway **Success** (migrate 불필요)
2. 각 화면 Ctrl+Shift+R. WhatsApp 마케팅 탭 제목이 `wap-1013ds`인지 확인

## ③ 테스트방법

- 소시오 계정: 제품·마케팅에 「WhatsApp 마케팅」과 「Meta 광고 문의」가 둘 다 보인다.
- 마케팅 · 영업 계정: 「WhatsApp 마케팅」은 메뉴에 없다. 주소로 직접 열면 「WhatsApp 마케팅은 디렉터 · 소시오 전용입니다.」가 뜬다. 「Meta 광고 문의」는 보인다.

## ④ 변경파일

| repo 경로 | 변경 |
|---|---|
| `refatrix-api/src/middleware/authGuard.js` | `requireRoles(roles)` · `DIR_SOCIO` 추가 |
| `refatrix-api/src/routes/waPromoRoutes.js` | 모든 `/api/wa-promo/*` → 디렉터 · 소시오 전용 |
| `refatrix-api/src/routes/metaLeadsRoutes.js` | `PM_KEYS` · `requirePageAny` / `requirePageEditAny` |
| `refatrix-nav.js` (루트) | `__dirsocio__` 권한키(소시오 · 디렉터) · `wapromo` · `metaleads` 권한 목록 |
| `refatrix-wapromo.html` (루트) | 전용 안내 문구 · build `wap-1013ds` |
| `refatrix-metaleads.html` (루트) | 변경 없음(배포본과 동일, 함께 넣음) |
| `refatrix-api/test/wa_promo.test.mjs` | 마케팅 edit 권한자 403 · 소시오 200 |
| `refatrix-api/test/wa_promo_front.test.mjs` | 메뉴 권한키 · 빌드 토큰 |
| `refatrix-api/test/meta_leads.test.mjs` | 제품(보기) 권한자 열람 200 · 가져오기 read_only · 영업 권한자 열람 200 · 메뉴 목록 |

## ⑤ 검증결과

- meta_leads 14/14 · wa_promo 10/10 · wa_promo_front 7/7 · integration_nav 4/4 (실 PostgreSQL 16, 새 DB migrate)

## ⑥ 결정사항

- WhatsApp 마케팅은 역할로만 연다(디렉터 · 소시오). 관리 › 사용자 · 권한의 「마케팅」 권한으로는 더 이상 열리지 않는다.
- Meta 광고 문의는 제품·마케팅 메뉴에 들어가는 사람 모두 열람한다.

## ⑦ 오픈이슈

- 마케팅 담당자가 WhatsApp 정기 발송을 맡게 되면 역할을 추가해야 한다(`DIR_SOCIO`에 한 줄).

## ⑧ 다음액션

- 배포 후 소시오 계정으로 두 화면이 보이는지 확인한다.
