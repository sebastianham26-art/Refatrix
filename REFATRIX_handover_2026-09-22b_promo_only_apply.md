# REFATRIX 인수인계 2026-09-22b — 재고실사 **프로모션(PRO) 품목만 실물 반영**

**마이그레이션 없음** (`npm run migrate` 불필요) · **백엔드 1 + 프런트 1 + 테스트 5**
**산출물 zip**: `refatrix_promo_only_apply_v1.zip`
라우트 rev `20260918promo` → **`20260922proapply`** · 프런트 build `sc0922promo2` → **`sc0922proapply`**
베이스: 2026-09-22 라이브 HEAD (패키징 직전 raw URL md5 로 재확인 — 두 파일 모두 라이브와 동일한 판본 위에 편집)

---

## ① 설명 — 무엇을, 왜

### 디렉터 지시 (2026-09-22)
> "프로모션 제품만 실물완료 반영이 되도록 해줘"
> 확인한 결정: **① 프로모션 화면 버튼 + ② 창고 담당자도 PRO 반영 가능 (둘 다)** · 확인 절차는 **본인 PIN**

### 바꾼 것
| | 전 | 후 |
|---|---|---|
| PRO 실사 수량 반영 | 디렉터만 · 세션 전체 검토(🔒 실물 반영 검토) | **창고 담당자도 가능** · PRO 품목만 골라서 반영 |
| 확인 | 디렉터 PIN | **반영하는 사람 본인 PIN** — 이동내역·검토이력에 그 사람 이름이 남음 |
| 부품 | 디렉터 전용 | **그대로 디렉터 전용** (이 경로로는 절대 못 바꿈) |
| 부품이 섞인 실사 | 전부 한 번에 | PRO 만 먼저 반영 → 실사는 「제출됨」 유지 → 디렉터가 남은 부품 반영 |
| PRO 만 있는 실사 | 디렉터가 마감 | PRO 반영 후 남은 항목이 0 이면 **자동으로 반영완료** |

### 화면
- **프로모션 품목 화면** 상단 안내 바에 실사별 **[✔ 프로모션만 반영]** 버튼, 각 품목 「실사 반영 대기」 칸에 **[반영 ▸]**.
- **대조 화면**(창고·디렉터 공통)에도 **[🎁 프로모션 품목만 반영 (N건)]** 버튼. 디렉터에게는 기존 🔒 실물 반영 검토 버튼도 그대로 있다.
- 모달: 품목별 **반영 / 조정수량(강제조정) / 랙저장 / 코멘트** + **본인 PIN**. 기본값은 차이 있으면 반영 체크, 랙이 바뀌었으면 랙저장 체크.
  **체크 안 한 품목은 보내지 않는다 → 손대지 않고 대기로 남는다**(예: 가방 PRO_019 보류).

### 서버 (`stockCountRoutes.js`)
| 메서드 | 경로 | 권한 | 내용 |
|---|---|---|---|
| GET | `/api/stock-counts/:id/promo-apply` | 창고 읽기 | 이 실사의 PRO 반영 대상 + 나머지 대기 건수(`other_pending`) |
| POST | `/api/stock-counts/:id/promo-apply` | 창고 편집 + **본인 PIN** | `{pin, items:[{product_id, apply, final_qty?, save_rack, comment}]}` |

- **대상** = 디렉터 검토목록(`buildReviewList`)과 **같은 계산**에서 `kind='part'` 이고 코드가 `PRO` 로 시작하는 것만. 구 `promo_items` 는 대상 아님(디렉터 경로).
- 요청에 PRO 대기목록에 없는 id(부품 등)가 **하나라도** 있으면 `400 not_promo_item` — 트랜잭션 전체 거부.
- 반영 = 디렉터 반영과 **같은 기록 방식**: `stock_qty` 갱신 + `stock_movements`(adjust, `source='count'`, `ref=count:<id>`, 비고 `재고실사 SC-… 실물조정 (프로모션)`) + `stock_count_adjustments` 1행.
- **이중 반영 방지**: 검토목록·조정계획 계산에서 **이미 `stock_count_adjustments` 에 기록된 품목은 제외**하도록 두 쿼리에 한 줄씩 추가.
  → PRO 를 먼저 반영한 뒤 디렉터가 검토하면 **부품만** 보인다. (기존 흐름은 반영과 동시에 세션이 닫히므로 이 한 줄이 영향을 주는 경우가 없다.)
- 남은 검토 항목이 0 이면 `status='reconciled'` 로 닫는다. 빈 요청(`items:[]`)은 **남은 게 없을 때만** 마감 역할.
- 세션 행을 `FOR UPDATE` 로 잡으므로 두 사람이 동시에 눌러도 1번만 반영된다(테스트 G).

---

## ② 배포 단계 — ⚠ 순서 준수 (마이그레이션 없음)

1. `refatrix-api/src/routes/stockCountRoutes.js` 덮어쓰기 → GitHub Desktop **Fetch/Pull → Commit / Push**
2. Railway 재배포 **Success** → 로그 `[stockCountRoutes] loaded rev 20260922proapply`
3. `refatrix-stockcount.html` 덮어쓰기 → Push → Pages 1~2분 → **`Ctrl+Shift+R`** → 탭 제목 `build sc0922proapply`
4. (선택) 테스트 5개 파일 push

> **반쪽 배포 주의**: 프런트를 먼저 올리면 [✔ 프로모션만 반영]이 「반영 목록 조회 실패」만 띄운다(다른 화면은 정상). 백엔드 먼저.

```
B=https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main
curl -s "$B/refatrix-api/src/routes/stockCountRoutes.js?nc=$(date +%s)" | grep -c "20260922proapply"   # 2
curl -s "$B/refatrix-api/src/routes/stockCountRoutes.js?nc=$(date +%s)" | grep -c "promo-apply"        # 2
curl -s "$B/refatrix-stockcount.html?nc=$(date +%s)" | grep -c "sc0922proapply"                        # 8
```

---

## ③ 테스트 방법 (현장 5분 · 9/22 실데이터 기준)

1. **창고 담당자(Luis) 계정**으로 재고실사 › 🎁 프로모션 품목 관리 → 상단에 실사별 **[✔ 프로모션만 반영]** 버튼.
2. **SC-2026-0011** → PRO015 16→18(+2) 반영 체크 · 랙 E3-2 저장 체크 → **Luis 본인 PIN** → 반영.
   - PRO015 재고 18 · 재고 › 이동내역에 `재고실사 SC-2026-0011 실물조정 (프로모션)` +2 (작성자 Luis) · 실사 목록에서 SC-0011 **반영완료**.
3. **SC-2026-0012** → 4품목 모두 수량 일치 · 랙만 E3-1 로 바뀜 → 랙저장만 체크 → PIN → 실사 **반영완료**(재고 불변).
4. **SC-2026-0010 (가방)** → PRO_019 **체크 해제** 상태로 두고 닫기(⑦-1 정리 후 처리).
5. 틀린 PIN → 「PIN이 올바르지 않습니다」 · 재고 불변.
6. 회귀: 디렉터 계정 대조 화면에 🔒 실물 반영 검토 그대로 · 부품 섞인 실사는 PRO 반영 후에도 「제출됨」이고 디렉터 검토목록에 부품만.

---

## ④ 변경 파일

| 파일 | repo 경로 | 종류 | 변경 요약 |
|---|---|---|---|
| `stockCountRoutes.js` | `refatrix-api/src/routes/stockCountRoutes.js` | 수정 | `GET/POST /api/stock-counts/:id/promo-apply` 신규 · 검토목록/조정계획에 「이미 검토된 품목 제외」 1줄씩 · rev `20260922proapply` |
| `refatrix-stockcount.html` | `refatrix-stockcount.html` (repo 최상위) | 수정 | 프로모션만 반영 모달 · 안내 바 세션별 버튼 · 행 [반영 ▸] · 대조 화면 버튼 · build `sc0922proapply` |
| `promo_pending_ui.test.js` | `test/promo_pending_ui.test.js` | 수정 | ⑤ 프로모션만 반영 UI 21건 추가 (총 49) |
| `promo_ui.test.js` | `test/promo_ui.test.js` | 수정 | build 마커 |
| `spot_ui.test.js` | `test/spot_ui.test.js` | 수정 | build 마커 |
| `promo_products_sql.test.mjs` | `refatrix-api/test/promo_products_sql.test.mjs` | 수정 | rev 마커 · 재고변경 지점 3→4(원장 1:1 유지) · PRO만 반영 정적 가드 5건 |
| `stock_spot_sql.test.mjs` | `refatrix-api/test/stock_spot_sql.test.mjs` | 수정 | rev/build 마커 · stock_qty UPDATE 3→4 · rack_location UPDATE 2→3 |

---

## ⑤ 검증 결과

- **ESM 문법** 백엔드 `node --input-type=module --check` ✅ · HTML 인라인 스크립트 2블록 `node --check` ✅
- **실 PostgreSQL 16 종단 테스트 41/41** — **운영 라우트 모듈을 그대로 import** 해 Fastify 위에서 실행
  (스키마: 0122 `stock_count_adjustments` 원문 DDL + `applied_qty`, CHECK 포함)
  - A PRO 만 있는 실사: 창고 PIN 반영 → 재고·원장 18 · 이동 1건(작성자=창고) · 검토이력 · 랙 저장 · **자동 반영완료** · 재반영 409 · 창고의 디렉터 `/apply` 는 여전히 403
  - B 부품 섞임: 부품 id 끼워 넣기 400 · PRO+부품 섞어 보내면 **통째 롤백** · PRO 만 반영 후 세션 제출됨 유지 · 디렉터 검토목록엔 부품만 · 디렉터 반영 후 **PRO 이중 반영 없음**(재고·원장 40) · 이력 중복 없음
  - C PIN 없음 400 · 남의 PIN 403 · 영업 역할 403 · 디렉터도 사용 가능 · 강제조정 비고 · 음수 400
  - D 체크 해제 품목은 손대지 않음 · 랙만 저장(이동 없음)
  - E 작성중 409 · 스팟 409(PIN 검사 전) · 없는 세션 404
  - F 차이 없는 실사 빈 요청 마감 · 부품 차이 남은 실사는 안 닫힘
  - G **동시 2회 클릭 → 1회만 반영**(재고·원장 25 · 이력 1건)
- `promo_products_sql.test.mjs` **45/45** · `stock_spot_sql.test.mjs` **23/23**(DB 파트는 `TEST_PG_URL` 없어 skip — 위 PG 종단 테스트가 대신함)
- jsdom — `promo_pending_ui.test.js` **49/49** · `promo_ui.test.js` **60/60** · `spot_ui.test.js` **103/103**
- **실제 Chromium 렌더** 1510×812 · 360×640 — 모달의 반영 체크박스가 첫 열, PIN·반영 버튼 화면 안, 페이지 가로 스크롤 0

---

## ⑥ 결정 사항 (디렉터 2026-09-22)
| 항목 | 결정 |
|---|---|
| 범위 | 프로모션 화면 버튼 + 창고 담당자 권한 **둘 다** |
| 확인 | **본인 PIN** (반영자가 이력에 남음) |
| 대상 | 제품마스터 `PRO` 코드만. 부품·구 promo_items 는 디렉터 경로 유지 |
| 체크 해제 | 「보류 기록」이 아니라 **손대지 않고 대기** — 나중에 다시 반영하거나 디렉터가 처리 |

## ⑦ 오픈 이슈
1. **★ 가방 이중 등록** (직전 문서와 동일) — `PRO_019`(0) · `PRO019`(77). SC-2026-0010 은 PRO_019 로 88개. PRO_019 는 체크 해제 → PRO019 [수량조정] 88 → PRO_019 비활성 → 그다음 SC-0010 은 디렉터 검토에서 보류로 마감.
2. `PRO` 판정은 접두사 `PRO`(대소문자 무시) — `PRO_019` 같은 형식도 PRO 로 본다. 형식 가드(`PRO`+숫자만)는 지시 시 별건.
3. 구 프로모 `PRO200 테스트` 999 — 삭제 권장.
4. 이 경로의 감사로그 step = `promo_apply` (디렉터 반영은 `apply`).

## ⑧ 다음 액션
1. ② 배포 → ③ 1~5.
2. SC-0011·SC-0012 를 창고에서 반영해 보고 이동내역 작성자 확인.
3. ⑦-1 가방 정리.

---
*이 문서는 인수인계용 스냅샷입니다. 큰 변경이 생기면 갱신해서 다시 올려주세요.*
