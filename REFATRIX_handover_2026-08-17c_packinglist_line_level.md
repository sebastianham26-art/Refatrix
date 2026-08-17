# REFATRIX 인수인계 — 패킹리스트 라인별 저장(합산 제거) + 검수·적치 라인 단위 스캔 2026-08-17

**⚠ 마이그레이션 0173 (신규 — `npm run migrate` 필수, 0172 와 함께)** · **백엔드 1 + 마이그레이션 1 + 프런트 1**
**산출물 zip**: `refatrix_inbound_line_v3.zip` (**오늘 존 지정 작업(0172)까지 누적** — zone v1 대체)
**빌드**: `refatrix-inbound.html` **20260817c → 20260817e**

> 같은 날 앞선 작업: ① 카톤 라벨 파싱(`..._2026-08-17_inbound_carton_label_scan.md`)
> ② 존 지정(`..._2026-08-17b_warehouse_zone_sorting.md`). **이 zip 은 둘 다 포함**한다.

---

## ① 왜 — 라인이 곧 카톤 묶음이다

디렉터 지시: *"패킹리스트 엑셀의 라인별 내용을 그대로 기록해야 한다. 같은 SKU 라고 수량을 합치면 안 된다.
카톤박스에 포장된 수량은 그 라인에 있는 수량이므로."*

기존 서버 `aggregate()` 는 같은 팔렛 안의 같은 SKU 라인을 **합산**해서 저장했다:

```
파일:  CE0796  #1–20   20카톤 × 16EA = 320     ← 소입수 16
       CE0796  #21–23   3카톤 × 12EA =  36     ← 소입수 12
저장(구): CE0796  23카톤 356EA               ← 소입수 정보 소실 (356÷23 ≈ 15.5)
```

이러면 ① 카톤당 수량(소입수) 대사가 어긋나고 ② `CTR-CE0796-12` 라벨이 "불일치" 로 오판되고
③ 어떤 카톤 묶음을 검수했는지 추적할 수 없다.

## ② 무엇을 했나

### 서버 (`inboundRoutes.js` + 마이그레이션 0173)
- **`aggregate()` 라인 보존** — 팔렛(ORDER NO+PL NO)으로 묶기만 하고, 그 안의 라인은 **파일 등장 순서 그대로 1줄 = 1행**.
  같은 SKU 3라인이면 3행. 카톤 0 행(낱개·혼적)도 별도 라인으로 남는다.
- **0173**: `inbound_pallet_items.box_from / box_to INT` — 파일의 **카톤 번호 범위** 보존(같은 SKU 라인 구분 표식).
  기존 행은 NULL(과거 합산 저장분 — 동작 무영향).
- INSERT 에 box 범위 포함, `GET /api/inbound/:id` 응답 item 에 `box_from/box_to` 추가 + **`ORDER BY pi.id`**(= 파일 라인 순서).
- **하위 흐름 무영향 확인**: 마감 `SUM(qty)` · 입고예정 뷰 `v_incoming_stock` · 구매 incoming 집계 모두 SUM 기반이라 라인 분리와 무관하게 동일.

### 프런트 (`refatrix-inbound.html` build `20260817e`)
- 업로드 파서가 라인마다 `box_from/box_to` 를 함께 전송(원래 FROM/TO 읽고 있었음).
- **검수 카운트를 라인(item id) 기준으로 전환** — 이전엔 SKU 코드 키라서, 라인이 분리되면 같은 코드 라인마다
  카운트가 중복 전송될 뻔했다(치명적 이중 계상). 이제 라인별 독립.
- **라벨 소입수량으로 라인 자동 선택** (`pickLine`):
  ① 여유 있는 라인 중 **소입수(qty÷cartons)가 라벨 수량과 같은 라인** 우선
  ② 없으면 여유 있는 첫 라인(파일 순서) — 이때 소입수가 다르면 `⚠ 소입수 불일치` 경고
  ③ 전 라인이 차면 초과 스캔 차단
  → `CTR-CE0796-12` 를 스캔하면 자동으로 **×12 라인(#21–23)** 에 붙는다.
- 화면 표기: 스캔 결과에 라인 표식 `#21–23`, SKU 목록은 **라인별 행**(`CE0796 #1–20 ×16` / `CE0796 #21–23 ×12`)으로
  각자 진행 표시. 진행줄 문구 `SKU n/m` → `라인 n/m`.
- **검수 완료 전송이 라인별 증분** — `{item_id: 201, scanned_delta: 2}, {item_id: 202, scanned_delta: 3}` 처럼 따로 나간다.
- 팔렛 자동 확정(candidatePallets)은 **같은 SKU 라인들의 카톤 합**으로 판정(동작 동일).
- **적치도 라인 단위** — 남은 카톤이 있는 라인 중 라벨 소입수와 같은 라인 우선. `putAdd` 는 원래 id 키라 그대로.
- 수량 대사는 정직하게: 라벨 합계 ≠ 패킹리스트 합계면 검수완료 전 확인창(기존 게이트 유지).

## ③ 배포 ⚠ 마이그레이션 있음 — 순서 준수

이 zip 은 **오늘 존 지정 작업까지 누적**이므로 이것 하나만 배포하면 된다.

1. **백엔드 먼저**: zip 의 `refatrix-api/` 전부(0172·0173 신규, zoneRoutes.js 신규, inboundRoutes.js, server.js) → Push → Railway **Success**.
2. Railway APP 콘솔 **`npm run migrate`** → `apply 0172_...` + `apply 0173_inbound_line_boxes.sql` 확인.
   (0173 없이 새 백엔드가 돌면 선적 생성 INSERT 가 box_from 컬럼 부재로 **500** — 반드시 실행.)
3. **프런트**: `refatrix-zones.html`(신규) · `refatrix-nav.js` · `refatrix-inbound.html` + nav 토큰 갱신 HTML 43장 → Push → Pages 1~2분.
4. **Ctrl+Shift+R** → 콘솔 `[refatrix-nav] v20260817z` · `[refatrix-inbound] build 20260817e` · `[refatrix-zones] build zone-0817a`.

배포 확인:
```
curl -s ".../main/refatrix-api/migrations/0173_inbound_line_boxes.sql?nc=$(date +%s)" | grep -c "box_from"   # 1+
curl -s ".../main/refatrix-api/src/routes/inboundRoutes.js?nc=$(date +%s)" | grep -c "라인을 합산하지 않는다"  # 1
curl -s ".../main/refatrix-inbound.html?nc=$(date +%s)" | grep -c "20260817e"                                # 2
curl -s ".../main/refatrix-api/src/routes/inboundRoutes.js?nc=$(date +%s)" | grep -c "applyRelines"          # 3
curl -s ".../main/refatrix-inbound.html?nc=$(date +%s)" | grep -c "pickLine"                                 # 3+
```

**✅ 기존 선적은 취소 없이 해결** — 선적 상세 헤더의 **[🔀 라인 재분할]** 버튼(아래 ③-1)으로
원본 파일을 다시 읽어 라인별로 교체한다. 하차 상태·ETA·파일 그대로 보존.


## ③-1 기존 선적 해결 — [🔀 라인 재분할] (디렉터 지시: "지금 등재되어 있는 것부터")

현재 등재된 선적(예: D26-81319563, 하차 36/36·검수 0)은 합산 저장 상태다. **취소·재업로드 없이** 고친다.

**사용법 (배포 후 1분)**
1. 창고 › 수입입고 → 해당 선적 열기 → 헤더 파일 줄에 **[🔀 라인 재분할]** 링크가 보인다.
   (노출 조건: 마감 전 + 라인별 저장 이전 등재(box 범위 없음) + **검수·적치 스캔 0** — 조건이 안 맞으면 아예 안 보인다)
2. 클릭 → 확인창 → **첨부된 원본 패킹리스트(.xlsx)를 자동으로 다시 읽어** 라인별로 교체.
   원본이 미보관(8MB 초과 등)이면 파일 선택창이 열린다 — 같은 엑셀을 고르면 된다.
3. `✔ 라인 재분할 완료 — 26 → 31라인` 토스트 후 화면 갱신. 검수 SKU 목록에 `#카톤범위 ×소입수` 라인들이 보이면 성공.

**안전 가드 (서버 강제 — `POST /api/inbound/:id/relines`)**
- 검수/적치가 1카톤이라도 진행된 선적은 `already_scanned` 거부(스캔 기록을 임의 라인에 귀속시킬 수 없으므로).
- **같은 파일인지 검증**: 팔렛 집합(ORDER NO+PL NO)과 팔렛별 카톤·수량 합계가 기존 등재와 정확히 일치해야 한다.
  다른 파일이면 `file_mismatch` 거부 — 무엇이 다른지 detail 로 알려준다.
- 팔렛 행(id·하차 상태·예상 카톤)은 건드리지 않는다. 감사로그 `update` + `target inbound:<id>` (before/after 라인 수).

## ④ 테스트 (운영 스모크)

1. 같은 SKU 가 여러 라인인 패킹리스트 업로드 → 미리보기 수량 대사 ✅ → 선적 생성.
2. 수입입고 상세 → 검수 → SKU 목록에 같은 SKU 가 **라인별로**(`#1–20 ×16` / `#21–23 ×12`) 나오는지.
3. `CTR-<코드>-12` 라벨 스캔 → **×12 라인에 카운트**되고 소입수 불일치 경고가 없는지.
4. ×16 라인 카톤을 다 채운 뒤 또 16EA 라벨 스캔 → 여유 라인으로 넘어가며 ⚠ 소입수 불일치 경고.
5. 검수 완료 → 새로고침 → 라인별 `scanned_cartons` 가 각각 저장돼 있는지.
6. 적치에서 같은 SKU 스캔 → 남은 라인부터 소진되는지. 마감 후 발주 입고 수량이 파일 합계와 같은지.
7. 존 지정·자판 보정 등 오늘 앞선 기능 회귀 없음.

## ⑤ 검증 (이 세션 — 누적 182/182 ✅)

- **`refatrix-api/test/inbound_lines.test.js` 25/25 (신규)** — ④ 라인 재분할 8건 포함(운영 `applyRelines` 를 직접 import 해 실 Postgres 로 실행): 합산 1행 → 2라인 교체 · 팔렛 id/상태 보존 · 다른 파일 거부(합계·팔렛) · 검수 진행 시 거부. — **운영 소스에서 `aggregate()`·INSERT·GET SQL 을 추출해 실행**:
  같은 SKU 3라인 비합산·순서·box 범위·카톤0 낱개 라인 / 실 Postgres 에 같은 SKU 2행 저장(유니크 제약 없음 실증) /
  GET 쿼리 0173 컬럼·id 순 / `SUM(qty)` 마감 연동 동일 / 라인별 검수 증분 독립.
- **`scan_label.test.js` 61/61** — ⑨ 라인 재분할 링크 노출 조건 3종 + POST 전송 포함. — 기존 43건 회귀(카운트 키를 라인 id 로 갱신) + **⑧ 멀티라인 12건**:
  12EA 라벨 → ×12 라인 배정 · 16EA → ×16 라인 · 라인 차면 여유 라인 이월 + 불일치 경고 · 전 라인 초과 차단 ·
  라인 표식(#f–t)·소입수(×n) 표기 · **검수완료 라인별 증분 전송** · 수량 차이 정직 경고(72≠68).
- 회귀: `scan_hyphen` **23/23** · `zone_ui` **46/46** · `zones` **27/27** (0173 포함 전체 마이그레이션 173개 적용 후).
- 0173 pglast VALID · `node --input-type=module --check` · 인라인 JS 파싱 · **Chromium 렌더 스크린샷**(멀티라인 배정) 육안 확인.

## ⑥ 변경 파일 (이번 회차)

| 파일 | 변경 |
|---|---|
| `refatrix-api/migrations/0173_inbound_line_boxes.sql` | **신규** — box_from/box_to |
| `refatrix-api/src/routes/inboundRoutes.js` | aggregate 라인 보존 · INSERT/GET box 범위 · ORDER BY pi.id · **`applyRelines` + POST /relines** |
| `refatrix-inbound.html` | 라인 단위 카운트·pickLine·라인 표식·검수완료 라인별 증분 · **[🔀 라인 재분할] UI** · build `20260817e` |
| `refatrix-api/test/inbound_lines.test.js` | **신규** 25건 |

## ⑦ 메모 / 남은 것

- **검수 화면의 라인 자동 선택은 라벨 소입수량에 의존**한다. 라벨에 수량이 없는 구형 라벨이면 파일 순서대로
  첫 여유 라인에 붙는다(카톤 수는 정확, 라인 귀속만 근사).
- 과거 합산 저장된 선적은 [🔀 라인 재분할]로 복원한다. 단 **검수를 이미 시작한 선적은 재분할 불가** — 그대로 합산 단위로 검수를 마치면 된다(수량 정합엔 문제 없음).
- **라벨 소입수량 DB 기록**(scanned_qty) 과제는 여전히 미결 — 라인별 저장으로 기반은 마련됨
  (라인 소입수가 이제 정확하므로 컬럼 하나 + check API 필드 하나면 된다). 디렉터 결정 대기.

---
*이 문서는 인수인계용 스냅샷입니다.*
