# REFATRIX 인수인계 — 고객 상세 「고객정보」 아래 메모 기록 (2026-10-27)

**마이그레이션 0304 (`npm run migrate` 필수)** · 화면 build `tx-1027cn` · 기준 커밋 `0bfcfde`(라이브 main, 14:56 「개선」)
산출물: `refatrix_1027cn_github_railway.zip`(레포 8파일) — Netlify 변경 없음

## ① 설명
디렉터 요청: 「고객정보 아래에 메모를 입력할 수 있게」.
레포 이력(6월~오늘 전체)을 확인한 결과 고객 상세에 메모 **입력란**이 있었던 커밋은 없었다 — 메모는 「수정」 폼의 한 줄(`customers.memo`)뿐이었고, 영업 계정이 그걸 고치면 디렉터 승인 대기로 들어가 바로 보이지 않았다. 그래서 고객정보 표 바로 아래에 **바로 저장되는 메모 기록**을 새로 붙였다.

- 고객관리 › 고객 상세 › 고객정보 표 아래 **「📝 메모」**: 입력칸 + 「메모 저장」(Ctrl+Enter 도 저장)
- 저장 즉시 반영(승인 없음) · 한 건씩 쌓인다 — **일시(멕시코시간) · 작성자 · 내용**, 최신순, 줄바꿈 유지, 2,000자
- 삭제 ✕ = **본인 메모 또는 디렉터**. 실제로 지우지 않고 `deleted_at` 기록(감사로그에도 남음)
- 보기 = 그 고객을 볼 수 있는 사람 · 쓰기 = 고객관리 편집권 + 그 팀 편집권(열람 전용 · 타팀은 보기만/막힘)
- 기존 「메모」(수정 폼의 한 줄)는 그대로 — 표 안에 그대로 보인다
- 고객 **병합** 시 메모도 남길 고객으로 따라간다(지운 메모 포함, 안내 건수는 살아 있는 것만)

## ② 배포단계
1. GitHub Desktop **Fetch/Pull** → zip 풀어 ④ 경로대로 덮어쓰기 → Commit → Push → Railway **Success**
2. Railway 콘솔 `npm run migrate` → `apply 0304_customer_notes.sql`
3. 고객관리 `Ctrl+Shift+R` → 탭 제목 **build tx-1027cn**

⚠ 순서: migrate 전에 화면을 열면 「메모를 불러오지 못했습니다」가 보인다(테이블 없음). migrate 후 새로고침하면 정상.

## ③ 테스트방법
1. 고객 하나 열기 → 고객정보 표 바로 아래 「📝 메모」
2. 메모 입력 → 「메모 저장」 → 맨 위에 일시 · 내 이름과 함께 표시, 입력칸 비워짐
3. 두 줄 메모(Enter 줄바꿈) → 줄바꿈 그대로
4. 영업 계정으로 같은 고객 → 메모 보임, 디렉터 메모에는 ✕ 없음, 본인 메모는 ✕
5. 다른 팀 영업 → 그 고객 자체가 안 열림(기존 규칙)
6. ✕ → 확인 → 목록에서 사라짐

## ④ 변경파일
| 구분 | repo 경로 | 변경 |
|---|---|---|
| Railway | `refatrix-api/migrations/0304_customer_notes.sql` | **신규** — `customer_notes` 테이블 · 인덱스 |
| Railway | `refatrix-api/src/routes/customerRoutes.js` | `GET/POST /api/customers/:id/notes` · `DELETE /api/customers/:id/notes/:noteId` · 병합 건수에 메모 |
| Railway | `refatrix-api/src/customerMerge.js` | 병합 이관 대상에 `customer_notes` |
| GitHub Pages | `refatrix-customers.html` (루트) | 고객정보 아래 「📝 메모」 · build `tx-1027cn` |
| 레포(테스트) | `refatrix-api/test/customer_notes.test.mjs` | **신규** 실 PG 종단 |
| 레포(테스트) | `refatrix-api/test/customer_notes_front.test.mjs` | **신규** jsdom 8건 |
| 레포(테스트) | `refatrix-api/test/customer_merge.test.mjs` | 이관 대상 목록 기대값 |
| 레포(테스트) | `refatrix-api/test/customer_exclusivity_front.test.mjs` | 빌드 토큰 기대값 `tx-1027cn` |

## ⑤ 검증결과
- `node --check` 백엔드 2파일 · 고객관리 인라인 스크립트 3블록 ✅
- pglast — 0304 + 라우트 SQL 6/6 ✅
- **실 PostgreSQL 16**: 0001→0304 전체 신규 적용 · 재실행 skip · 0304 단독 재실행 멱등 ✅
- 실 PG 종단 `customer_notes` 통과 — 저장(공백·CRLF 정리) · 작성자/일시 · 최신순 · 빈 메모 400 · 2,001자 400 · 같은 팀 타인 삭제 403 · 타팀 보기/쓰기 403 · 열람 전용(쓰기·삭제 불가) · 본인/디렉터 삭제 · 삭제 후 DB 보존 · 다른 고객 경로로 삭제 404 · 고객 상세 회귀 200 · 병합 미리보기 건수(살아 있는 1건) · 병합 후 3건 이관 · 감사로그 create/delete 기록
- jsdom `customer_notes_front` 8/8 — 위치(고객정보 바로 아래) · 이스케이프 · 줄바꿈 · ✕ 표시 조건 · 저장/Ctrl+Enter/빈칸 차단 · 실패 문구 · 삭제 · 늦은 응답 무시
- 헤드리스 Chromium 렌더(PC 1200 · 폰 390) 확인
- 회귀: customer_merge_front 16/16 · customer_visits_front 19/19 · customer_monthly_front 17/17 · customer_exclusivity_front 7/7 · customer_post_approval 15/15 · customer_exclusivity_e2e 15/15 · customer_visits_sql 1/1
  기존 실패(cross_team_request_front · customer_ar_eps_front · customers_page_edit · customer_registration 1 · customer_monthly_summary · customer_merge 실PG 2)는 **수정 전 라이브 코드에서도 똑같이 실패** — 이번 변경과 무관

## ⑥ 결정사항
- 승인 없이 즉시 저장(운영 메모 — 배송지 즉시저장과 같은 취급)
- 덮어쓰기가 아니라 기록으로 쌓음, 삭제는 본인 · 디렉터만, 소프트 삭제
- 기존 `customers.memo`는 건드리지 않음

## ⑦ 오픈이슈
- 기존 한 줄 메모(`customers.memo`)를 새 기록으로 옮기지는 않았다 — 원하면 일괄 이관 가능
- 메모 수정 기능은 없음(지우고 다시 쓰기)
- CRM 으로 보내지 않음(내부 메모)

## ⑧ 다음액션
- ② 배포 → ③ 확인
