# REFATRIX 인수인계 · 2026-09-29 · 전자결재(비용집행 품의) — build b20260929ea

## ① 설명

공통 › **전자결재** 모듈 신규. 모든 계정이 비용집행을 품의하고, 결재선을 거쳐 대표이사 사후승인으로 완결된다.

```
기안 → [카테고리 템플릿: 중간결재·합의·경유] → 디렉터 결재
     → [기준액 이상] 대표이사 사전승인 → 승인완료(집행대기, 공람 공개)
     → 재무 집행(예정→실적, Factura·송금증 필수) → 대표이사 사후승인 → 완결
```

- **상태 3축 분리**: 결재(`status`) · 집행(`exec_status`) · 사후승인(`post_status`). 게시판은 단일 단계 키(임시저장/결재중/사전승인 대기/집행대기/사후승인 대기/이의제기/완결/반려)로 필터.
- **결재선 스냅샷**: 상신 시점에 `approval_lines` 로 고정. 설정·템플릿을 바꿔도 진행 중 문서는 그대로.
- **디렉터 기안**: 템플릿 대신 「재무담당 합의 포함」 토글. 본인 결재 칸 자동 완료. 합의·사전승인이 없으면 상신 즉시 승인완료.
- **대표이사 기안**: 사전승인 생략, 사후승인은 디렉터(자기 문서 자기 확인 방지).
- **증빙**: pdf·doc(x)·ppt(x)·xls(x)·csv·txt·jpg/png/gif/webp/heic·CFDI xml·zip·eml/msg, 파일당 **20MB**. 상신 시 선택, **집행완료 시 Factura(XML/PDF) 또는 송금증 필수**. 업로드 단계(기안/결재중/집행/사후) 자동 기록. CFDI XML 은 UUID·RFC·총액 자동 판독(실적과 불일치 경고). **중복 증빙 감지**(파일 SHA-256 · CFDI UUID, 재기안 원문서·사본 제외).
- **증빙 보관**: `approval_files.file_data` BYTEA(비공개). 공개 URL 없음 — API 가 열람 권한 확인 후 원본 전달. 승인 후 삭제 불가(무효 처리 + 사유).
- **댓글**: 게시판식 댓글 + 파일 첨부. **수정·삭제는 디렉터만**, 수정 원문은 이력 보존, 삭제는 흔적 남김(원문은 디렉터·대표이사만).
- **타임라인**: 상신·승인·반려·집행·이의·회수·파일 등 모든 행위 일시 기록(`approval_events`, 수정·삭제 API 없음). 화면은 멕시코 시간, 마우스 오버 시 한국 시간.
- **반려**: 사유 필수 → 상신자에게 알림(사유 포함) → 「수정 후 재기안」(v+1, 증빙·참조 복사, 원문서 연결, 새 문서번호).
- **대표이사 결재함(Jang)**: 사전승인 대기 · 사후승인 대기(체크 → **일괄 확인**) · 이의제기 진행중(소명은 댓글).
- **예정·실적 리포트**: 카테고리별 예정/실적/차이/미집행/사후 미확인 + 완결성 점검 6항목. **재무상태·cashflow 미반영**(모듈 내부 집계).
- **설정(디렉터)**: 사전승인 기준액·판단 금액(IVA 포함 합계/소계)·실적 초과 경고 %·대표이사/디렉터/재무 계정·카테고리·결재선 템플릿. 모든 변경은 이력.
- 문서번호 `EXP-YYYY-NNNN`(멕시코 기준 연도별).

## ② 배포단계

> GitHub Desktop 에서 **Fetch/Pull 먼저**. 이 패키지는 라이브 `main` 3727ed9(2026-09-29 06:45 CTR 색상) 기준.
> 그 뒤 다른 푸시가 있었다면 `refatrix-nav.js` · HTML 토큰이 겹칠 수 있으니 덮어쓰기 전에 확인.

1. **백엔드 푸시** — `refatrix-api/` 아래 6개 파일(아래 ④ 표 · 백엔드)
2. Railway 배포 **Success** 확인
3. Railway 콘솔 `npm run migrate` → `apply 0234_e_approval.sql`
4. 설정 시드 확인(대표이사=Jang, 디렉터=Sebastian, 재무=첫 treasury):
   ```sql
   SELECT s.ceo_pre_threshold, c.name AS ceo, d.name AS director, f.name AS finance
     FROM approval_settings s
     LEFT JOIN users c ON c.id=s.ceo_user_id
     LEFT JOIN users d ON d.id=s.director_user_id
     LEFT JOIN users f ON f.id=s.finance_user_id;
   ```
   비어 있으면 화면 **전자결재 › 설정 › 결재 담당 계정**에서 지정(지정 전에는 상신이 막히고 이유가 표시된다).
5. **프런트 푸시** — `refatrix-approval.html` · `refatrix-nav.js` · 토큰 올린 루트 HTML 54개
6. `Ctrl+Shift+R` → 탭 제목 **`Refatrix ERP · 전자결재 · b20260929ea`** 확인
7. 라이브 확인:
   ```
   curl -s "https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main/refatrix-approval.html?nc=$(date +%s)" | grep -o "b20260929ea"
   curl -s "https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main/refatrix-nav.js?nc=$(date +%s)" | grep -c "approval"
   ```

## ③ 테스트방법

**화면(역할별)**
1. 직원(예: Oscar) — 작성 탭 → 카테고리·제목·소계 입력 → 결재선 미리보기(기준액 이상이면 「대표이사 사전승인 포함」) → 파일 첨부 → 상신
2. Sebastian — 게시판 「처리할 문서」 → 상세 → 승인(의견 선택) / 반려(사유 필수)
3. Jang — 대표이사 결재함 → 사전승인 → (집행 후) 사후승인 체크 → 일괄 확인 / 이의제기
4. Christopher — 「결재·집행할 문서」 → 집행 처리: 증빙 없으면 막힘 → 송금증/Factura 첨부 → 실적 입력 → 집행완료
5. 반려 받은 기안자 — 🔔 알림 → 상세(사유 표시) → 「수정 후 재기안」
6. Sebastian 기안 — 「재무담당 합의 포함」 ON/OFF 에 따라 결재선이 바뀌는지
7. 설정 — 기준액 변경 → 변경 이력 · 작성 화면 미리보기에 즉시 반영
8. 모바일 — 하단 탭바 위로 액션 버튼이 떠 있는지, 모달이 하단 시트로 뜨는지

**자동 테스트**
```
cd refatrix-api
node --test test/approval.test.mjs                                   # 규칙·배선(DB 없이)
TEST_PG_URL=postgres://... node --test test/approval.test.mjs        # + 실제 PostgreSQL E2E
TEST_PG_URL=postgres://... node --test test/approval_front.test.mjs  # 화면(jsdom) × 실제 API
```
TEST_PG_URL DB 조건: 0234 까지 migrate, login_id 가 sebastian/christopher/jang/maria/oscar/jose/luis 인 사용자. 운영 DB 에서 돌리지 말 것(테스트 문서가 쌓임).

## ④ 변경파일

| 구분 | 레포 경로 | 상태 |
|---|---|---|
| 백엔드 | `refatrix-api/migrations/0234_e_approval.sql` | 신규 |
| 백엔드 | `refatrix-api/src/approval.js` | 신규 — 순수 규칙(결재선·다음 단계·열람·파일 검증·CFDI·리포트) |
| 백엔드 | `refatrix-api/src/routes/approvalRoutes.js` | 신규 — API 전체 |
| 백엔드 | `refatrix-api/src/server.js` | 수정 — import + `app.register(approvalRoutes)` 2줄 |
| 테스트 | `refatrix-api/test/approval.test.mjs` | 신규 |
| 테스트 | `refatrix-api/test/approval_front.test.mjs` | 신규 |
| 테스트 | `refatrix-api/test/rack_relocate_sql.test.mjs` | 수정 — 창고 그룹 정확 목록 → 포함 여부 검사(1줄) |
| 프런트 | `refatrix-approval.html` (루트) | 신규 |
| 프런트 | `refatrix-nav.js` (루트) | 수정 — 화면 등록 · 공통/재무/창고 그룹 · 모바일 아이콘 · 마케팅 권한키 복구 |
| 프런트 | 루트 HTML 54개 (`refatrix-*.html` 등) | 수정 — `refatrix-nav.js?v=20260929hd` → `20260929ea` 한 줄씩 |

`nav_token_bumped/` 폴더(8월 보관본 46개)는 건드리지 않았다.

**API** (`authGuard` 만 — 문서 열람은 결재선·참조·공람·역할로 판단)

| 메서드 · 경로 | 용도 |
|---|---|
| GET `/api/approvals/bootstrap` | 나 · 설정 · 카테고리/템플릿 · 사용자 · 미확인 알림 수 |
| GET `/api/approvals` | 게시판 목록(권한 필터 · 단계 · 할 일 · 증빙/댓글 수 · 경고 플래그) |
| GET `/api/approvals/:id` | 상세(결재선 · 증빙 메타 · 댓글 · 이벤트 · 연결문서 · 가능한 버튼) |
| POST / PUT / DELETE `/api/approvals[/:id]` | 임시저장 생성·수정·삭제(번호 없는 임시저장만) |
| POST `/api/approvals/:id/submit` | 상신(결재선 스냅샷 · 번호 부여) |
| POST `/api/approvals/:id/act` | `approve` / `reject`(사유 필수) — 중간·합의·경유·디렉터·사전·사후 |
| POST `/api/approvals/post-bulk` | 사후승인 일괄 확인 |
| POST `/api/approvals/:id/flag` · `/close-flag` | 이의제기 · 이의 종결 |
| POST `/api/approvals/:id/execute` | 집행(실적 · 지급일 · 방법 · 메모) — 실적 증빙 필수 |
| POST `/api/approvals/:id/withdraw` · `/resubmit` | 회수 · 재기안 |
| POST `/api/approvals/:id/files` | 증빙 업로드(data URL, 라우트 전용 bodyLimit 29MB) |
| GET / DELETE `/api/approvals/files/:fid` · POST `/files/:fid/void` | 원본 열람 · 삭제(승인 전) · 무효(승인 후) |
| POST `/api/approvals/:id/links` | 결재문서 연결 |
| POST `/api/approvals/:id/comments` · PUT/DELETE `/comments/:cid` | 댓글 · 디렉터 수정/삭제 |
| GET `/api/approvals/notifications` · POST `/notifications/read` | 알림 |
| PUT `/api/approvals/settings` · 카테고리/단계 CRUD | 설정(디렉터) |
| GET `/api/approvals/report?month=YYYY-MM` | 예정·실적 리포트 + 완결성 점검(재무·디렉터·대표이사) |

## ⑤ 검증결과

| 단계 | 결과 |
|---|---|
| 1. `node --check` | 변경 JS 7개 + HTML 인라인 스크립트 전부 통과 |
| 2. pglast | 라우트 SQL 95/95 파싱(열 이름 보간 1건은 실제 열 `sha256`·`cfdi_uuid` 로 별도 확인) · 마이그레이션 27문 |
| 3. pg-mem | 마이그레이션 26/27 · 핵심 쿼리(ON CONFLICT DO UPDATE RETURNING 번호 채번, DO NOTHING, GROUP BY, DISTINCT) 통과. 설정 시드 1문은 pg-mem 한계(INSERT…SELECT 안 스칼라 서브쿼리) — 실제 PG 에서 확인 |
| 4. jsdom | `approval_front.test.mjs` — 실제 API 에 붙여 작성·상신(사전승인 미리보기) → 디렉터 승인 → 대표이사 사전승인 → 재무 집행(증빙 없으면 막힘) → 사후 일괄 확인 → 댓글 → 설정 저장 → 리포트, JS 오류 0 |
| 5. 실제 PostgreSQL 16 | 전 마이그레이션(0001~0234) 적용 후 `approval.test.mjs` 15개 통과 — **동시 클릭(같은 결재 2회 → 200/409)**, 20MB 정확히 통과 · 초과 거부, 확장자 차단, 열람 권한(참조/공람/재무/무관자), 원본 바이트 일치, 승인 후 삭제 불가·무효, 반려→재기안, 디렉터 토글, 일괄 확인(권한 없는 건 제외), 회수 규칙, 댓글 이력, 리포트 권한 |
| 반복성 | 새 DB 2개 × 2회씩 = 8회 연속 전부 통과 |
| 회귀 | 기존 테스트 151개 파일 전체 실행 — **새로 깨진 것 0**. `main` 에서 이미 실패하던 45개 파일(service_secrets C3 포함)은 동일 결과 |
| 시드 | 실제 DB 에서 대표이사=Jang · 디렉터=Sebastian(시드 '관리자' 계정 회피) · 재무=Christopher 확인. 재실행 멱등 확인 |

## ⑥ 결정사항

- 사전승인 기준액은 설정에서 입력·수정(기본 100,000 MXN · IVA 포함 합계). 진행 중 문서는 상신 시점 기준 유지.
- 대표이사 계정 = Jang, 화면 한국어, 모바일 우선.
- 모든 문서는 **집행완료 후** 대표이사 사후승인. 사후는 반려가 아니라 확인/이의제기.
- 디렉터 기안은 재무 합의를 필요에 따라 넣거나 뺌(토글).
- 상신 시 증빙 선택(부족하면 반려로 보완 요청). 반려 시 사유 메모 필수 + 상신자 알림.
- 댓글 수정·삭제는 디렉터만.
- 파일당 20MB.
- **예정/실적 금액은 재무상태·cashflow 에 반영하지 않음** — 완결성 확인 후 결정.
- (구현 판단) 실적이 예정을 넘으면 **경고만**, 재승인 없음(설정의 경고 %).
- (구현 판단) 증빙 원본은 **DB(BYTEA) 비공개 저장** — 기존 거래 영수증(0230)과 같은 방식, 새 키·SDK 없이 바로 동작. base64 가 아니라 원본 크기 그대로 저장.
- (구현 판단) 대표이사 본인 기안 → 사전승인 생략, 사후는 디렉터.
- (구현 판단) 재무 부재 시 디렉터도 집행 처리 가능.
- (구현 판단) 리포트는 재무·디렉터·대표이사만, 각자 볼 수 있는 문서 범위로 집계.

## ⑦ 오픈이슈

1. **마케팅 화면 권한키 복구(동작 변경)** — `refatrix-nav.js` 196행에서 09-24 편집 때 `marketing/mktspend/survey` 권한키가 주석 안으로 들어가 **권한과 무관하게 전원에게 보이던 상태**였다. 원래대로 `marketing` 권한이 있는 사용자에게만 보이게 복구했다. 배포 후 마케팅 담당(예: Alondra)에게 `marketing` 권한이 있는지 관리 › 사용자·권한에서 확인 필요.
2. **카테고리 결재선 템플릿이 비어 있음** — 10개 카테고리만 시드, 중간결재·합의·경유 단계는 없음(모든 직원 문서가 기안 → 디렉터). 설정 화면에서 카테고리별로 지정 필요.
3. 알림은 화면 안 🔔 만 — 이메일·WhatsApp·nav 배지 미구현.
4. 「인쇄 · PDF」는 브라우저 인쇄(인쇄용 CSS). jsPDF 결재문서 생성은 미구현.
5. Word·PowerPoint 는 미리보기 없이 새 탭/다운로드.
6. 화면 한국어 전용 — 스페인어 사용 직원이 기안하므로 스페인어 병기 여부 결정 필요.
7. 증빙 DB 저장량 모니터링 — 증가 추세가 크면 R2 비공개 버킷 이전 검토.
8. (기존) `main` 에서 이미 실패하던 테스트 45개 파일 — 이번 작업과 무관, 별도 정리 필요.
9. (기존) `refatrix-api/src/routes/refatrix-nav.js` 에 nav 사본이 있음 — 건드리지 않음, 정리 대상인지 확인 필요.

## ⑧ 다음액션

1. ② 순서대로 배포 → 설정 시드(대표이사·디렉터·재무) 확인
2. 설정에서 카테고리별 결재선 템플릿(중간결재·합의·경유) 입력
3. 마케팅 권한(⑦-1) 확인
4. 2~3건 시범 운영: 직원 기안 → 승인 → 집행 → Jang 사후 일괄 확인까지 한 바퀴
5. 한 달 운영 후 예정·실적 리포트의 완결성 점검 결과로 재무상태 반영 여부 결정
