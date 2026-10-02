# REFATRIX 인수인계 · 2026-10-02 · 전자결재 — 문서 삭제 시 PIN 확인 — build b20261002fc

## ① 설명
디렉터 「🗑 문서 삭제」 창에 **내 PIN(로그인 PIN)** 입력칸을 추가했다. 사유와 PIN을 모두 넣어야 삭제된다.
- PIN이 틀리면 창은 그대로 남고, 「PIN이 올바르지 않습니다」를 띄운 뒤 PIN 칸을 비운다. 문서는 그대로다.
- 서버도 PIN을 검증한다(재고실사·입고에서 쓰는 PIN 확인과 같은 방식). 화면을 우회해도 PIN 없이는 삭제할 수 없다.
- 복구와 임시저장 삭제(기안자)는 PIN 없이 지금처럼 동작한다.
- 마이그레이션 없음.

## ② 배포단계
※ 0249(문서 삭제)를 아직 배포하지 않았다면, 0249 패키지 대신 이 패키지를 쓰고 0249 마이그레이션 파일만 함께 넣는다(이 패키지에 그 변경이 포함돼 있음).
1. 백엔드 푸시 — ④ 표의 `refatrix-api/` 3개
2. Railway **Success** (마이그레이션 없음. 0249를 함께 넣는 경우만 `npm run migrate`)
3. 프런트 푸시 — `refatrix-approval.html`
4. `Ctrl+Shift+R` → 탭 제목 **`전자결재 · b20261002fc`**

## ③ 테스트방법
1. 디렉터 → 문서 → 「🗑 문서 삭제」 → 사유만 넣고 삭제 → 「PIN을 입력하세요」
2. 틀린 PIN → 「PIN이 올바르지 않습니다」, 창이 유지되고 문서도 그대로인지
3. 맞는 PIN → 삭제 → 「삭제된 문서」에 나타나는지

## ④ 변경파일
| 구분 | 레포 경로 | 상태 |
|---|---|---|
| 백엔드 | `refatrix-api/src/routes/approvalRoutes.js` | 수정 — POST `/:id/delete`에 `pin` 필수·검증 |
| 테스트 | `refatrix-api/test/approval.test.mjs` · `approval_front.test.mjs` | 수정 |
| 프런트 | `refatrix-approval.html` (루트) | 수정 — 삭제 창 PIN 칸, 오류 처리 |

API: POST `/api/approvals/:id/delete` `{reason, pin}`. PIN이 없으면 400 `pin_required`, 틀리면 403 `bad_pin`.

## ⑤ 검증결과
| 단계 | 결과 |
|---|---|
| node --check | 변경 JS 3개 + HTML 인라인 스크립트 통과 |
| pglast | 추가 SQL 통과 |
| jsdom | PIN 칸(password) · PIN 없으면 막힘 · 틀린 PIN이면 창 유지·칸 비움·문서 유지 · 맞는 PIN이면 삭제 → 삭제된 문서 → 복구 · JS 오류 0 |
| 실제 PostgreSQL E2E | 디렉터만 · 사유 필수 · PIN 필수 · 틀린 PIN 403·삭제 안 됨 · 맞는 PIN 삭제·리포트 제외·복구 |
| 반복성 | 새 DB 2개 × approval 24/24 · 새 DB 2개 × front 2/2 |

## ⑥ 결정사항
- 디렉터 문서 삭제는 사유와 본인 PIN을 함께 입력해야 한다.
- (구현 판단) 복구와 임시저장 삭제는 PIN 없이 한다.

## ⑦ 오픈이슈
- PIN을 여러 번 틀려도 잠그지 않는다(다른 화면의 PIN 확인과 같은 수준). 필요하면 5회 실패 시 잠금을 추가한다.
- 이전 오픈이슈는 그대로다.
