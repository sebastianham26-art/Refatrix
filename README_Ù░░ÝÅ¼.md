# refatrix_inbound_v16 — 수입입고 누적 산출물 (2026-08-27)

`refatrix-inbound.html` build **20260827whlock**
v15(2026-08-18) 이후 이 세션의 3건을 **누적**한 배포본입니다. v15 를 대체합니다.

| # | 내용 | 문서 |
|---|---|---|
| 1 | ERP 등재 내역 창 — 🌐 한국어/스페인어 토글 + ⤓ 엑셀 다운로드 | `REFATRIX_handover_2026-08-27_registered_view_lang_excel.md` |
| 2 | 엑셀 다운로드가 안 되던 문제 수정(팝업 제스처 차단) — `<a download href="blob:">` 방식 + CSV 대체 | 위 문서 |
| 3 | **창고 종료(잠금)** — 적치 완료 후 창고 수정 차단. 창고 신청 → 디렉터 PIN 승인 | `REFATRIX_handover_2026-08-27b_inbound_warehouse_finish_lock.md` |

---

## ⚠ 배포 순서 — 마이그레이션이 있습니다

1. `refatrix-api/migrations/0187_inbound_warehouse_finish.sql` → repo 같은 경로에 복사
2. `refatrix-api/src/routes/inboundRoutes.js` → repo 같은 경로에 덮어쓰기
3. GitHub Desktop **Commit / Push** → **Railway Success 확인**
4. Railway APP 콘솔 **`npm run migrate`**
   → `apply 0187_inbound_warehouse_finish.sql` 확인
   **안 돌리면 선적 상세 조회가 `wh_locked_at` 컬럼 없음으로 500 입니다.**
5. `refatrix-inbound.html` → repo **루트**에 덮어쓰기 → Commit / Push
6. Pages/Cloudflare 1~2분 → 수입입고 화면 **Ctrl+Shift+R**
   → 콘솔에 `[refatrix-inbound] build 20260827whlock`

> 3~4번(백엔드+migrate)을 5번(프런트)보다 **먼저** 끝내세요.
> 프런트가 `wh_check`·`wh_locked_at` 을 기대합니다.

### 배포 확인 (`...` = `https://raw.githubusercontent.com/sebastianham26-art/Refatrix`)

```
curl -s ".../main/refatrix-api/migrations/0187_inbound_warehouse_finish.sql?nc=$(date +%s)" | grep -c wh_locked_at   # 3+
curl -s ".../main/refatrix-api/src/routes/inboundRoutes.js?nc=$(date +%s)" | grep -c "WH_LOCKED"                     # 12+
curl -s ".../main/refatrix-inbound.html?nc=$(date +%s)" | grep -c "20260827whlock"                                   # 2
curl -s ".../main/refatrix-inbound.html?nc=$(date +%s)" | grep -c "wh-finish"                                        # 1+
curl -s ".../main/refatrix-inbound.html?nc=$(date +%s)" | grep -c "createObjectURL"                                  # 1
```

---

## 운영 스모크

**등재 내역 (첨부 줄 `📋 ERP 등재 내역`)**
1. 창 상단에 버튼 3개(인쇄 · 엑셀 · 🌐).
2. `🌐 Español` → 제목·머리글·상태가 스페인어. **본문 화면은 그대로 한국어**인지.
3. `⤓ 엑셀 다운로드` → **실제로 파일이 떨어지는지**. 카톤·수량이 숫자 셀인지, 합계 행이 화면과 같은지.
   (라벨이 `⤓ CSV 다운로드` 로 보이면 그 PC 에서 cdnjs 가 막힌 것 — CSV 로 정상 저장됩니다.)

**창고 종료 ([마감] 탭 맨 아래)**
4. 적치 미완료 선적 → `⚠ 적치 미완료 n팔렛`, 신청 버튼 없음.
5. 적치는 끝났는데 입고 미반영 → `⚠ 입고 미반영 n팔렛 — 먼저 마감하세요`.
6. 전부 끝난 선적 → 창고 계정으로 `[🏁 창고 종료 신청]` → ⏳ 대기.
7. 디렉터 계정 → PIN → `[✔ 승인하고 잠금]` → 상단 🔒 배너, 목록에 🔒 태그.
8. **잠긴 상태에서** 하차·검수·적치 탭의 버튼/스캔칸이 전부 비활성인지, 팔렛 줄이 안 눌리는지,
   스캐너로 바코드를 쏴도 반응이 없는지.
9. 디렉터 `[🔓 잠금 해제]` → 다시 수정 가능 + 신청 상태도 초기화되는지.
10. 회귀: 잠기지 않은 다른 선적의 하차·검수·적치·마감이 그대로인지.

---

## 테스트 (재현 방법)

```
cd test
npm i jsdom xlsx@0.18.5
node inbound_wh_finish.test.mjs          # 40/40 — 창고 종료 UI·권한·applyLock
node inbound_registered_view.test.mjs    # 45/45 — 등재 내역 언어·엑셀
bash inbound_wh_finish_sql.sh            # 실 PostgreSQL 16 — 0187·판정 SQL
```
테스트는 **운영 파일에서 해당 블록을 그대로 추출해** 실행합니다(복붙 아님).
경로가 `/home/claude/repo/...` 로 박혀 있으니 각자 repo 경로로 바꿔서 쓰세요.

---

## 되돌리기

- 프런트만 되돌리려면 `refatrix-inbound.html` 을 이전 빌드로 교체하면 됩니다.
- 백엔드를 되돌려도 0187 컬럼은 남아 있어도 무해합니다(아무도 안 읽음).
  이미 잠근 선적이 있다면 되돌리기 전에 디렉터가 `[🔓 잠금 해제]` 로 풀어 두세요.
