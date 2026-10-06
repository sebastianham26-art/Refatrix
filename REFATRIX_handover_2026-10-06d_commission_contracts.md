# REFATRIX 인수인계 — 커미션 대상자별 계약서 업로드 (본인 + 디렉터만 열람)

- 작업일: 2026-10-06
- 마이그레이션: **0255** (신규 · `0255_commission_contracts.sql`)
- 빌드: `b1006ctr` (합의 페이지 · 커미션 화면 토큰) · **nav.js 변경 없음**
- 검증: 합의·계약서 e2e **14건**(신규 1 · 2회 연속) + 기존 커미션 90 = 104건 통과 · `npm test` 24 · pglast 23 · 0255 미적용 DB 에서 조회 200 / 올리기 503 안내 · jsdom(디렉터 올리기·열기 / 본인 보기 / 다른 사람 빈 목록 / 재무 숨김) JS 오류 0

## ① 무엇을 만들었나

**디렉터 — 합의 현황판(`refatrix-acuerdo-comision.html`)에 「계약서」 열**
- 사람마다 `없음 · 올리기` / `N건 · 관리` → 창에서 **파일 선택 + 제목(선택) + 계약(서명)일(선택) → 올리기**.
- 같은 창에서 올린 파일 **열기 · 삭제**. 파일당 15MB, PDF · 이미지(JPG·PNG·WEBP) · Word(DOCX). 같은 파일 중복 업로드는 막는다.
- 재무·소시오도 현황판은 보지만 **계약서 열은 숨김**(건수도 서버가 내려주지 않음).

**본인 — 같은 페이지 「Mi contrato」 카드 (스페인어)**
- 자기 계약서 목록(제목·서명일·올린 일시)과 **[Ver]**. "Solo tú y la Dirección pueden ver estos archivos."
- 커미션 화면 배너·안내서 바로가기로 들어오는 그 페이지다.

**열람 권한 (서버에서 강제)**
| | 목록 | 파일 열기 | 올리기 · 삭제 |
|---|---|---|---|
| 본인 | 자기 것만(다른 사람 id 를 넣어도 자기 것) | 자기 것만 | ✕ |
| 디렉터 | 누구나 | 누구나 | ○ |
| 재무·소시오·다른 영업사원 | ✕ | ✕ (403) | ✕ |

- 파일은 DB(BYTEA)에 비공개 저장, 주소 공유로 열 수 없고 로그인 토큰으로만 받는다(`Cache-Control: no-store`).
- 올리기·열기·삭제 모두 감사로그(열기 = `export`).
- 삭제는 **소프트 삭제** — 본인 화면에서 사라지고 원본·기록은 남는다.

## ② 배포

| 파일 | 레포 경로 | 구분 |
|---|---|---|
| `0255_commission_contracts.sql` | `refatrix-api/migrations/0255_commission_contracts.sql` | **신규** |
| `commissionAgreementRoutes.js` | `refatrix-api/src/routes/commissionAgreementRoutes.js` | 덮어쓰기 |
| `refatrix-acuerdo-comision.html` | `refatrix-acuerdo-comision.html` (루트) | 덮어쓰기 |
| `refatrix-commission.html` | `refatrix-commission.html` (루트) | 덮어쓰기 (빌드 토큰만) |
| `commission_agreement_e2e.test.mjs` | `refatrix-api/test/` | (선택) |

백엔드 push → Railway Success → **`npm run migrate`(0255)** → 프런트 push → Ctrl+Shift+R → 탭 제목 `build b1006ctr`.

## ③ 테스트 (3분)
1. 커미션 화면 [조건 합의 현황] → oscar 행 「계약서 · 올리기」 → PDF 선택·제목·서명일 → 올리기 → 「1건 · 관리」.
2. [열기]로 파일 확인.
3. Oscar 로 로그인 → 합의 페이지 「Mi contrato」에 보이고 [Ver] 로 열림.
4. 다른 영업사원 로그인 → 「Aún no hay contrato cargado.」(Oscar 것 안 보임).

## ④ 기술
- 0255 `commission_contracts`(user_id · title · file_name · mime_type · file_size · sha256 · file_data BYTEA · signed_date · uploaded_by/at · deleted_at/by). 목록 쿼리는 file_data 를 읽지 않는다.
- API: `GET /api/commission/contracts?user_id=`(본인은 user_id 무시) · `POST /api/commission/contracts/:uid`(디렉터 · 라우트 bodyLimit 22MB) · `GET /api/commission/contracts/file/:id`(본인·디렉터) · `DELETE /api/commission/contracts/:id`(디렉터 · 소프트).
- `decodeContractFile`: 확장자 허용목록 + **내용 서명 확인**(PDF `%PDF`, JPG `FFD8`, PNG, WEBP, DOCX `PK`) → 확장자만 바꾼 파일은 거부.
- `/agreement/me` 에 `contracts`, `/agreement/board` 에 디렉터에게만 `contracts` 건수.

## ⑤ 함께 고친 버그 (기존 합의 기능)
- 감사로그 테이블(`audit_log_action_check`)이 정해진 action 이름만 받는데, 합의 기능이 `agree`·`agree_fail` 을 써서 **감사로그가 조용히 누락**되고 있었다(합의 기록 자체는 `commission_agreements` 에 정상 저장 — 손실 없음).
  → 허용값으로 변경: 합의 = `create`, PIN 실패 = `create` + result `denied`. 테스트로 실제 기록되는지 확인.

## ⑥ 오픈 이슈 — 시스템 전체 감사로그 누락
같은 원인으로 다른 화면의 감사로그도 기록되지 않고 있다(오류는 안 남, 조용히 버려짐). 약 24종:
커미션 월 확정 `confirm`·인사전달 `hand_off`, 입고 `inbound_create/update/file`, WBR·MBR `wbr_*`(13종), 방문 `visit_checkin/delete/link_customer`, 그 외 `apply`·`approve`·`read`·`upload`·`void`.
→ 제안: 마이그레이션 1개로 action CHECK 제약을 없애거나 목록을 넓히면 한 번에 해결. 원하시면 바로 만든다.
