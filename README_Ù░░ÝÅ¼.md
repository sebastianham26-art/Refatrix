# refatrix_inbound_v17 — 수입입고 누적 산출물 (2026-08-27)

`refatrix-inbound.html` **20260827rack** · `refatrix-zones.html` **zone-0827a**
v15(2026-08-18) 이후 4건 누적. **v16 을 대체**합니다.

| # | 내용 |
|---|---|
| 1 | ERP 등재 내역 창 — 🌐 한국어/스페인어 토글 + ⤓ 엑셀 다운로드 |
| 2 | 엑셀 다운로드 차단 문제 수정 — `<a download href="blob:">` + CSV 대체 |
| 3 | **창고 종료(잠금)** — 적치 완료 후 창고 수정 차단 (신청 → 디렉터 PIN 승인) |
| 4 | **랙 콤마 분리** — `products.rack_location` 한 칸의 여러 랙을 낱개로 |

---

## ④ 랙 콤마 분리 (이번 추가분)

**증상**: 존 지정 화면에서 `A` 그룹에 `aa3-1` 이 들어가 있고, `aa3-2` 와 `b2-2` 가 한 줄에 같이 나온다.

**원인**: `products.rack_location` 한 칸에 `"A3-1, AA3-1"` 처럼 **콤마로 여러 랙**이 들어 있는데
시스템이 그 문자열 전체를 **랙 1개**로 취급했다. 그룹은 맨 앞 글자로만 판정하므로
`"A3-1, AA3-1"` → `A` 그룹, `"AA3-2, B2-2"` → `AA` 그룹으로 들어갔다.
부작용으로 `rack_zones` 는 정확 일치라 그런 제품은 **검수·적치에서 존이 아예 안 잡혔다**.

**수정**
- `zoneRoutes.js` — 목록 집계를 `regexp_split_to_table(rack_location,'[,\n\r]+')` 로 쪼개
  낱개 랙 단위로 센다(제품 수는 `COUNT(DISTINCT p.id)`). 대소문자 통합·자연 정렬은 그대로.
  JS 쪽 헬퍼 `splitRacks()`/`RACK_SPLIT_RE` 를 export — **SQL 과 같은 구분자**를 쓴다.
- `inboundRoutes.js` — 존 조회도 같은 규칙으로 쪼개고, **각 랙의 존을 모두** 모은다.
  응답에 `zones:[{zone,name}]` 추가(`zone`/`zone_name` 은 대표 존으로 하위호환 유지).
  LATERAL 안에서 집계하므로 **라인이 중복 복제되지 않는다**(카톤·수량 부풀림 회귀 없음).
- `refatrix-inbound.html` — 존이 여러 개면 색 배너를 **전부** 쌓아 보여주고
  `⚠ 이 제품의 랙이 n개 존에 걸쳐 있습니다` 안내를 붙인다. SKU 줄의 존 칩도 개수만큼.
  (디렉터 결정: 여러 존이면 전부 표시)

> **참고**: 예전에 콤마 통짜 문자열(`"A3-1, AA3-1"`)로 저장해 둔 존 매핑이 있으면
> 존 지정 화면 하단 **"제품마스터에서 사라진 랙"** 목록에 나타납니다. 무해하지만,
> 이제 낱개 랙에 다시 지정해 주시면 됩니다.

---

## ⚠ 배포 순서 — 마이그레이션이 있습니다(창고 종료 0187)

1. `refatrix-api/migrations/0187_inbound_warehouse_finish.sql`
2. `refatrix-api/src/routes/inboundRoutes.js` · `zoneRoutes.js`
3. Commit / Push → **Railway Success 확인** → 콘솔 **`npm run migrate`**
   → `apply 0187_inbound_warehouse_finish.sql` (안 돌리면 선적 상세가 **500**)
4. `refatrix-inbound.html` · `refatrix-zones.html` → repo **루트**
5. Pages 1~2분 → **Ctrl+Shift+R** → 콘솔
   `[refatrix-inbound] build 20260827rack` / `[refatrix-zones] build zone-0827a`

### 배포 확인 (`...` = `https://raw.githubusercontent.com/sebastianham26-art/Refatrix`)
```
curl -s ".../main/refatrix-api/src/routes/zoneRoutes.js?nc=$(date +%s)"  | grep -c regexp_split_to_table   # 1
curl -s ".../main/refatrix-api/src/routes/inboundRoutes.js?nc=$(date +%s)" | grep -c regexp_split_to_table # 1
curl -s ".../main/refatrix-api/src/routes/inboundRoutes.js?nc=$(date +%s)" | grep -c "WH_LOCKED"           # 12+
curl -s ".../main/refatrix-inbound.html?nc=$(date +%s)" | grep -c "20260827rack"                           # 2
curl -s ".../main/refatrix-zones.html?nc=$(date +%s)"   | grep -c "zone-0827a"                             # 2
```

---

## 운영 스모크

**랙 콤마 분리**
1. 창고 › 존 지정 → `A` 그룹에 `aa…` 랙이 없는지, 한 줄에 랙이 하나씩만 있는지.
2. `AA3-1`·`AA3-2`·`AA10-1` 이 각각 별도 줄로 나오는지. 제품 수가 맞는지.
3. 콤마로 여러 랙을 쓰는 제품을 검수 스캔 → 존 배너가 **여러 개** 뜨고 `⚠ n개 존` 안내가 보이는지.
4. 하단 "사라진 랙" 목록에 예전 콤마 통짜 매핑이 있으면 낱개 랙으로 다시 지정.

**창고 종료**
5. 적치 미완료 → `⚠ 적치 미완료 n팔렛` / 입고 미반영 → `⚠ 먼저 마감하세요`.
6. 전부 끝난 선적 → 창고 계정 `[🏁 창고 종료 신청]` → 디렉터 PIN `[✔ 승인하고 잠금]`.
7. 잠긴 뒤 하차·검수·적치 탭이 전부 읽기 전용인지. 디렉터 `[🔓 잠금 해제]` 로 복구되는지.

**등재 내역**
8. `📋 ERP 등재 내역` → 🌐 토글 · ⤓ 엑셀 다운로드가 실제로 떨어지는지.

---

## 테스트

```
cd test
npm i jsdom xlsx@0.18.5
node inbound_zone_multi.test.mjs         # 23/23 — 존 여러 개 표시
node inbound_wh_finish.test.mjs          # 40/40 — 창고 종료
node inbound_registered_view.test.mjs    # 45/45 — 등재 내역
bash rack_split_sql.sh                   # 실 PostgreSQL 16 — 콤마 분리 SQL
bash inbound_wh_finish_sql.sh            # 실 PostgreSQL 16 — 0187·종료 판정
```
전부 **운영 파일에서 해당 블록·SQL 을 추출해** 실행합니다(복붙 아님).
경로가 `/home/claude/repo/...` 로 박혀 있으니 각자 repo 경로로 바꿔 쓰세요.
