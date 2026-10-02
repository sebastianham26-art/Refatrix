# REFATRIX 인수인계 — 2026-10-02c 선수금 「인보이스에 배분」 영업지원(Maria) 허용

## ① 설명
수금/정산 › **선수금(과입금) 관리** 카드의 **[인보이스에 배분]** 이 디렉터 전용이었음 → **디렉터 + 영업지원(sales_support, Maria)** 으로 확대.
- 백엔드 `POST /api/ar/advances/:id/apply`: `requireDirector` → `requirePage('settlement')` + `_bdCanNotify` (통지 반제와 동일 권한: director·sales_support)
- 프런트: 영업지원에게 [인보이스에 배분] 버튼 표시. **[입금 취소]는 디렉터 전용 유지** (입금 거래 자체를 지우는 되돌릴 수 없는 작업).
- 재무(treasury)는 기존처럼 배분 불가(조회만).
- DB 변경·마이그레이션 없음.

## ② 배포단계
1. GitHub Desktop **Fetch/Pull** 먼저
2. 백엔드 push: `refatrix-api/src/routes/financeRoutes.js` (+ 테스트 파일) → Railway **Success** 확인
3. `npm run migrate` **불필요** (스키마 변경 없음)
4. 프런트 push: `refatrix-settlement.html` → `Ctrl+Shift+R`
5. 탭 제목 빌드 토큰 **`build 20261002adv`** 확인

## ③ 테스트방법
- Maria 계정으로 수금/정산 → 선수금 관리: **[인보이스에 배분]** 버튼이 보이고, 배분 저장 시 「선수금 배분 완료」 메시지. [입금 취소] 버튼은 안 보여야 함.
- 디렉터 계정: 두 버튼 모두 보임(기존과 동일).
- 재무 계정: 버튼 없이 「디렉터·영업지원만 배분 가능」 안내.

## ④ 변경파일
| 파일 | 저장소 경로 |
|---|---|
| financeRoutes.js | `refatrix-api/src/routes/financeRoutes.js` |
| ar_advance_manage.test.mjs | `refatrix-api/test/ar_advance_manage.test.mjs` |
| refatrix-settlement.html | `refatrix-settlement.html` (저장소 루트) |

## ⑤ 검증결과
- `node --check` — financeRoutes.js / 테스트 / settlement.html 인라인 스크립트: 통과
- 실 PostgreSQL 16 (마이그레이션 0001~0245 전체 적용) + 실 라우트 `ar_advance_manage.test.mjs`: **9/9 통과**
  - ⑤ 권한: 재무 403 · 영업지원 200(배분 반영, 잔여 6,500 / 미수 18,100) · 영업지원 입금취소 403
  - ⑥ 입금 취소 시 영업지원 배분분까지 함께 복구(23,200) 확인
- jsdom 역할별 렌더: director(배분✔ 취소✔) / sales_support(배분✔ 취소✘) / treasury(배분✘ 취소✘)
- 참고: 테스트 ⑦은 **변경 전 코드에서도 실패**하던 상태였음 — 09-02 추가된 중복 통지 가드(같은 계좌·일자·금액 → 409)에 테스트 픽스처 금액(11,600)이 걸린 것. 픽스처 금액을 12,180으로 바꿔 해결(운영 코드 무관).

## ⑥ 결정사항
- 선수금 인보이스 배분 = 디렉터 + 영업지원(Maria) (Sebastian, 2026-10-02)
- 입금 취소는 디렉터 전용 유지

## ⑦ 오픈이슈
- 수금내역의 개별 반제 **수정/삭제**(startEditAlloc 등)는 여전히 디렉터 전용 — 필요 시 별도 요청.

## ⑧ 다음액션
- 배포 후 Maria 계정으로 실제 선수금 1건 배분 확인.
