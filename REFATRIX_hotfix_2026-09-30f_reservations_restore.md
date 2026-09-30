# REFATRIX 핫픽스 · 2026-09-30f · 재고 예약 현황 복구 (apar2 스테일 푸시)

## ① 설명
`apar2` 커밋(317ee16, 일일 자금 2차)이 **예약 반영 전의 로컬 사본**으로 푸시되면서 `예약` 커밋(313b46b)의 일부가 되돌려졌다.

- **빠진 것**
  - `server.js` 라우트 등록 → `/api/reservations` 가 404
  - `refatrix-nav.js` 메뉴 항목 → 메뉴에서 사라짐
  - 견적 목록 `?q=` 바로가기
  - nav 캐시 토큰 → `20260930td` 로 되돌아감
- **살아 있던 것**: 화면 파일, 라우트·로직 파일, 예약 자동충당(quoteBuild/quoteRoutes), 0241 마이그레이션, 테스트
- 복구는 live main `317ee16` 위에 빠진 부분만 다시 얹었다. apar2 의 일일 자금 변경(`treasuryRoutes`, `treasuryDaily`, `cashdaily.html`, `0241_treasury_account_scope`)은 **그대로 둔다**.

## ② 배포단계
1. GitHub Desktop **Fetch/Pull**
2. 백엔드 `refatrix-api/src/server.js` 푸시 → Railway **Success**
3. migrate 불필요(새 마이그레이션 없음)
4. 프런트 푸시: `refatrix-nav.js`, `refatrix-quotelist.html`, HTML 55개(nav 토큰 `20260930vr`)
5. `Ctrl+Shift+R`

## ③ 테스트방법
- 영업·영업지원 메뉴에 「재고 예약 현황」이 다시 보이는지
- 화면이 데이터를 불러오는지(404 아님)
- 견적번호를 누르면 견적 목록이 그 번호 검색 상태로 열리는지(탭 제목 `ql-0930rsv2`)
- 재무 › 일일 자금 화면이 그대로인지

## ④ 변경파일
| 저장소 경로 | 내용 |
|---|---|
| `refatrix-api/src/server.js` | reservationRoutes import·register 복구 |
| `refatrix-nav.js` (루트) | 메뉴 `reservations` 복구 · v20260930vr (일일 자금 항목 유지) |
| `refatrix-quotelist.html` (루트) | `?q=` 바로가기 복구 · `ql-0930rsv2` |
| `refatrix-reservations.html` 외 HTML 55개 (루트) | nav 토큰 `20260930vr` |
| `refatrix-api/test/approval_front.test.mjs` | nav 토큰 기대값 |
| `refatrix-api/test/treasury_daily_front.test.mjs` | nav 토큰 기대값 |

## ⑤ 검증결과
실 PostgreSQL 16(0001~0241 두 파일 모두 적용)에서 통과:

| 시험 | 결과 |
|---|---|
| reservations | 9/9 |
| reservations_e2e | 9/9 |
| reservation_topup_e2e | 7/7 |
| quote_revalidate_sql | 12/12 |
| quote_revalidate_front | 6/6 |
| treasury_daily | 13/13 |
| treasury_daily_front | 2/2 |
| crm_quote_inbound | 35/35 |
| quote_customer_po_front | 31/31 |

approval_front F1 실패는 이번 변경 전 main 에서도 동일하게 실패하던 기존 건이다.

## ⑥ 결정사항
- `0241_quote_stock_flag_restate` 와 `0241_treasury_account_scope` 는 번호가 겹친다. 러너가 파일명으로 추적하므로 **둘 다 실행된다**(이름순). 이미 적용된 파일이라 이름은 바꾸지 않는다.

## ⑦ 오픈이슈
- 스테일 푸시 재발 방지: 푸시 전 GitHub Desktop 「Fetch origin」 → 「Pull」 후 변경 파일 목록에 **내가 고치지 않은 파일**(특히 `refatrix-nav.js`, `server.js`)이 있으면 멈추기.

## ⑧ 다음액션
- 배포 후 메뉴·화면 확인.
