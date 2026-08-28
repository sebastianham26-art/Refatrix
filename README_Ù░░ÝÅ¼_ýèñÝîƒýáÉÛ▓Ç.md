# REFATRIX 배포 — SKU 스팟점검 (build `sc0827spot` / rev `20260827spot`)

**⚠ 마이그레이션 `0188` 신규 — `npm run migrate` 필수**
백엔드 1 + 마이그레이션 1 + 프런트 1 (+ 테스트 3). **nav.js 무변경.**

---

## 배포 순서 (엄수)

### 1. 백엔드 먼저

| 파일 | 놓을 곳 |
|---|---|
| `0188_stock_count_spot.sql` | `refatrix-api/migrations/` |
| `stockCountRoutes.js` | `refatrix-api/src/routes/` |

→ GitHub Desktop **Commit / Push** → Railway **Success** 확인

### 2. 마이그레이션 실행

Railway APP 콘솔에서:

```
npm run migrate
```

→ `apply 0188_stock_count_spot.sql` 확인.
**안 돌리면 재고실사 화면의 세션 목록이 500** 이 납니다(`stock_counts.mode` 컬럼 없음).

### 3. 프런트

| 파일 | 놓을 곳 |
|---|---|
| `refatrix-stockcount.html` | 저장소 **최상위** |

→ Push → Pages 1~2분 → 재고실사 화면에서 **Ctrl+Shift+R**
→ 콘솔에 `[refatrix-stockcount] build sc0827spot` 확인

---

## ⚠ 덮어쓰기 주의 — `nav_token_bumped/` 폴더

저장소 루트의 `nav_token_bumped/` 폴더에는 **스팟점검이 없는 옛 `refatrix-stockcount.html`** 이
들어 있습니다(위치변경 배포 때 nav 토큰만 갈아 끼운 46장). 그 폴더를 루트에 통째로 복사하면
**이번 기능이 지워집니다.**

- 이번에 드리는 `refatrix-stockcount.html` 은 nav 토큰이 이미 `20260827rl` 로 맞춰져 있습니다.
- `nav_token_bumped/` 를 적용하실 거면 **`refatrix-stockcount.html` 만 빼고** 복사하세요.

(참고: 현재 main 은 `refatrix-relocate.html` 만 `20260827rl`, 나머지 45장은 `20260824ph` 입니다.
그래서 **「위치변경」 메뉴가 아직 안 보이는 사용자가 있을 수 있습니다** — 별건이지만 같이 확인해 주세요.)

---

## 배포 확인 (raw)

```
curl -s ".../main/refatrix-api/migrations/0188_stock_count_spot.sql?nc=$(date +%s)" | grep -c stock_count_spot_checks   # 5+
curl -s ".../main/refatrix-api/src/routes/stockCountRoutes.js?nc=$(date +%s)" | grep -c "20260827spot"                 # 2
curl -s ".../main/refatrix-stockcount.html?nc=$(date +%s)" | grep -c "sc0827spot"                                       # 3
curl -s ".../main/refatrix-stockcount.html?nc=$(date +%s)" | grep -c "spot-checks"                                      # 4+
```

---

## 롤백

프런트만 되돌리면 스팟점검 화면이 사라집니다(기존 전체 재고실사는 그대로 동작).
백엔드·마이그레이션은 **되돌릴 필요 없습니다** — `mode` 는 기본값 `'full'` 이고
신규 테이블은 아무도 안 쓰면 그냥 비어 있습니다.

---

## 테스트 실행(개발자용)

```
npm i jsdom playwright-core                      # 저장소 최상위
node test/spot_ui.test.js                        # jsdom 83건
node test/spot_render.mjs                        # 실제 Chromium 렌더 15건 (없으면 자동 skip)
TEST_PG_URL=postgres://... node refatrix-api/test/stock_spot_sql.test.mjs   # 실 PG 89건
```
