# REFATRIX 인계 · 2026-10-26 · 오더상태 (전송) 끝 상태 추가 — eliminado · expirado

build `20261026os` · 마이그레이션 `0296` · 기준 커밋 `ea1417c`(2026-10-23 main)

## ① 설명

연동관리 › 오더상태 (전송)에 구간 2개를 추가했습니다. 웹(COT-…) 견적만 대상입니다.

| secuencia | estatus | 언제 |
|:--:|---|---|
| 8 | `expirado` | 24시간 룰로 견적이 `expired` 가 되는 순간 (60초 만료 스위퍼) |
| 9 | `eliminado` | 디렉터가 **삭제 승인**을 누르는 순간 (`POST /api/quotes/:id/delete-approve`) |

- 번호를 8·9 로 둔 이유: CRM 은 이미 「secuencia 가 작거나 같으면 무시」 규칙으로 동작합니다. 끝 상태가 가장 큰 번호여야 늦게 도착한 재시도(예: Surtiendo)가 Eliminado 를 덮지 못합니다. 만료 후 삭제도 가능하므로 9 > 8.
- 삭제 **요청**만으로는 보내지 않습니다(반려될 수 있음). 반려되면 아무것도 나가지 않습니다.
- eliminado 의 `transactionUser` = 승인한 디렉터, expirado 는 `erp`.
- 즉시 훅 + 90초 감시(안전망) 두 겹 — 훅이 못 나가도 감시가 줍습니다. (견적, 단계) 기본키로 중복 없음.
- 연동이 꺼져 있으면 아무것도 쌓지 않습니다(기존 원칙 그대로).

## ② 배포단계

1. GitHub Desktop **Fetch/Pull** 먼저.
2. 백엔드 push: `orderStatusSync.js`, `quoteRoutes.js`, `integrationRoutes.js`, `0296_…sql` (+ 테스트 파일)
3. Railway **Success** 확인 → 콘솔에서 `npm run migrate` (0296 적용 확인)
4. 프론트 push: `refatrix-integrations.html` → `Ctrl+Shift+R`, 탭 제목 `build 20261026os` 확인
5. 연동관리 › 오더상태 표에 8 Expirado · 9 Eliminado 행이 보이면 완료.

> ⚠ CRM 쪽이 `expirado`·`eliminado` 를 받도록 고치기 전에는 400(ERR_VALIDATION)으로 실패→재시도→실패가 쌓입니다. 계약서 v1.1 을 CRM 개발자에게 먼저 전달하세요(오더상태 연동이 지금 켜져 있다면 특히).

## ③ 테스트방법

1. 웹 견적(COT) 하나를 만들고 24시간 경과(또는 테스트 서버에서 `reserve_expires_at` 을 과거로) → 1분 내 연동관리 › 최근 보낸 단계에 `8 · Expirado`, 계기 「오더상태 · 24시간 만료」.
2. 다른 COT 견적 삭제 요청 → 디렉터 승인 → `9 · Eliminado`, 계기 「오더상태 · 삭제 승인」, 전송 이력 본문 `transactionUser` = 승인자.
3. 「견적 1건 확인」에 삭제된 COT 번호 입력 → `CRM 9 eliminado` 로 표시.

## ④ 변경파일

| 파일 | 저장소 경로 | 내용 |
|---|---|---|
| orderStatusSync.js | `refatrix-api/src/orderStatusSync.js` | 끝 상태 정의·`finalStepOf`·`syncOrderFinal`·`kickOrderFinal`, 공통 적재 `enqueueSteps`, 감시에 끝 상태 안전망, 미리보기·연결테스트 반영 |
| quoteRoutes.js | `refatrix-api/src/routes/quoteRoutes.js` | 만료 스위퍼·삭제 승인에 훅 |
| integrationRoutes.js | `refatrix-api/src/routes/integrationRoutes.js` | 현황 8·9 집계, 삭제된 견적도 1건 확인 |
| 0296_crm_order_status_final.sql | `refatrix-api/migrations/0296_crm_order_status_final.sql` | seq CHECK 1~4 → 1,2,3,4,8,9 · 계약서 설명 갱신 |
| refatrix-integrations.html | `refatrix-integrations.html` (저장소 루트) | 8·9 단계 설명, 계기 라벨, 안내문, build `20261026os` |
| crm_order_status_final.test.mjs | `refatrix-api/test/crm_order_status_final.test.mjs` | 신규 시험 |
| 빌드토큰 시험 5개 | `refatrix-api/test/{crm_retry_failed,integration_method_translate,product_sync,product_sync_delta,promo_banner_front}.test.mjs` | `20261026os` 허용 추가 |
| 계약서 | `Contrato_API_Estatus_Pedido_v1.1.md` (CRM 개발자 전달용, 저장소 X) | 스페인어 v1.1 |

## ⑤ 검증결과

- `node --check` 전 파일 통과
- pglast: 0296 및 orderStatusSync.js 의 SQL 전부 파싱 통과
- 실 PostgreSQL 16(전 마이그레이션 0001~0296 적용) + 모의 CRM:
  - 신규 `crm_order_status_final` 16/16 — 꺼짐 시 미적재 · 켜면 따라잡기 · **실제 만료 스위퍼 경로** → 1·8 · 만료 후 삭제 승인 → 8·9 · Surtiendo 중 삭제 → 1·2·9 후 진행 단계 재전송 없음 · 반려 시 미전송 · 훅 누락 시 감시가 회수 · ERP 견적 미전송 · 현황/1건 확인
  - 기존 `crm_order_status` 18/18 등 연관 회귀 시험 통과(아래 ⑦ 참고)
- 0296 두 번 실행 → 멱등 확인

## ⑥ 결정사항

- 끝 상태 코드: `expirado`(8) · `eliminado`(9), 같은 엔드포인트·POST·같은 키.
- 끝 상태 앞에 진행 단계를 지어내 채우지 않음 — CRM 은 COT 를 원래 알고 있음.
- 연동을 켜거나 배포 직후, **최근 120일 웹 견적 중 이미 만료/삭제 승인된 건**도 감시가 한 번 따라잡아 보냄(CRM 화면에 「Solicitud nueva」로 남아 있던 것을 바로잡음). 기존 「켜면 120일 따라잡기」 원칙과 동일.
- 취소(cancelled)는 이번에도 보내지 않음.

## ⑦ 오픈이슈

- CRM 개발자가 v1.1(8·9 수용)을 반영해야 함 — 반영 전엔 400 실패 누적.
- 기존 동작(이번 변경 무관): 만료된 견적의 삭제를 **반려**하면 `draft` 로 돌아가고, 다음 만료 틱에서 다시 `expired` 가 됨. expirado 는 이미 보냈으므로 중복 전송은 없음.

## ⑧ 다음액션

1. 계약서 v1.1 을 CRM 개발자에게 전달 → 테스트 서버에서 8·9 수용 확인.
2. 백엔드 → migrate → 프론트 순서로 배포.
3. 배포 후 연동관리 › 오더상태 「지금 따라잡기」 1회 → 8·9 건수 확인.
