# REFATRIX 인수인계 — 창고 존(zone) 지정 + 검수 스캔에 목적지 존 안내 2026-08-17

**⚠ 마이그레이션 0172 (신규 — `npm run migrate` 필수)** · **백엔드 3(신규1) + 마이그레이션 1 + 프런트 신규1 + nav 토큰 일괄**
**산출물 zip**: `refatrix_zone_v1.zip` · **빌드**: `refatrix-inbound.html` **20260817b → 20260817c** · `refatrix-zones.html` **zone-0817a** · nav **v20260817z**

> 같은 날 앞선 작업(카톤 라벨 `CTR-제품번호-소입수량` 파싱 + 수량 대사)은
> `claude/REFATRIX_handover_2026-08-17_inbound_carton_label_scan.md` 참고. **이 zip 은 그 내용까지 누적**이다.

---

## ① 왜 — 수입 팔렛에서 존 이동용 팔렛으로 "분리"가 필요하다

디렉터 지시: *"검수한 카톤을 해당 존으로 옮기기 전에, 존을 명시해둔 임시 팔렛에 분리해야 한다.
존 구분은 내가 지정해줄 테니 현재 랙 번호를 알파벳순으로 나열해줘. 4개로 드롭다운. 저장되면
검수 스캔할 때마다 어느 존으로 갈지 보여주면 된다."*

현장 흐름:

```
수입 팔렛 (팔렛 12, 37카톤 26SKU)
   └ 검수 스캔 1회 → 제품번호·소입수량 + ★목적지 존★ 표시
        └ 작업자가 그 존의 「이동용 임시 팔렛」에 박스를 올린다   ← 이번에 가능해진 부분
             └ 존 팔렛이 차면 그 존으로 이동 → 적치(랙 스캔)
```

기존에는 존을 랙 번호 앞글자(`A-01-03` → `A`)로만 추정했다. 그런데 **현장 존은 랙 앞글자와 다르고**,
지금 들어온 팔렛은 26 SKU 전부 `🆕 랙 미지정`이라 추정할 근거조차 없었다.
그래서 **랙 → 존 매핑을 디렉터가 직접 지정하는 화면**을 만들었다.

## ② 새 화면 — 창고 › **존 지정** (`refatrix-zones.html`)

- **존 4개 고정**(1~4). **이름만 편집** 가능 — 현장 임시 팔렛에 붙일 이름(예: `A동 앞`, `2층 좌측`).
- **현재 제품마스터에 실제로 쓰이는 랙만** 자동으로 나열한다(운영 DB 조회 권한이 없어 화면이 실시간으로 가져온다).
  - **자연 정렬**: `A-2-9` → `A-2-10` (단순 문자정렬이면 10이 먼저 와서 현장 감각과 어긋남)
  - 랙 앞머리(`A`/`B`/`C`)로 **그룹 구분줄** + 랙별 **제품 수** 표시
  - **대소문자 표기 통합**: `B-01-01` 과 `b-01-01` 은 한 줄로 합쳐 보여준다(중복 지정 방지)
  - 삭제된 제품의 랙·빈 값은 제외
- 랙마다 **드롭다운 5개 옵션**(미지정 + 존 1~4). **앞글자 일괄지정**(`A 그룹 → 존 3`) 버튼으로 수십 개를 한 번에.
- **랙 검색** · **미지정만 보기** 필터 · 미지정 행은 왼쪽에 빨간 줄 · 변경된 행은 노란 배경 + `변경 n건` 배지.
- **🆕 랙이 없는 신규 SKU 기본 존** — 별도 드롭다운. 비워두면 검수 화면에 **"존 미지정"** 으로 뜬다(임의 배치 방지).
- 제품마스터에서 사라졌는데 배정만 남은 랙은 하단에 참고 표시(무해).
- **권한**: 보기 = 창고 권한(검수가 존을 써야 하므로), **저장 = 디렉터 전용**. 비디렉터는 드롭다운·저장 버튼 비활성 + 안내문.

## ③ 검수 스캔 화면 — 목적지 존을 크게 (`refatrix-inbound.html` build `20260817c`)

스캔 1회에 이제 이렇게 나온다:

```
CE0796  × 16 EA
TERMINAL EXTERIOR
┌────────────────────────────────┐
│  2   이 박스를 옮길 곳            │
│      존 2 · A동 뒤               │
│      존 이동용 임시 팔렛          │
└────────────────────────────────┘
B존  B-01-01              카톤 1/1 · 16/16 EA ✓
라벨 CTR-CE0796-16 · 제품번호 CE0796 · 소입수량 16 EA
```

- 존별 **색**(1 파랑 · 2 초록 · 3 주황 · 4 보라)으로 멀리서도 구분된다.
- **신규 SKU**는 `🆕 신규 SKU 기본 존` 이라고 밝혀준다(랙에서 온 존이 아님을 명시).
- **존 미지정**이면 빨간 배너 `? / 존 미지정 / 디렉터에게 존 지정을 요청하세요 (창고 › 존 지정)`.
  **그래도 카톤·수량은 정상 집계** — 작업이 멈추지 않는다.
- 검수 **SKU 목록**의 각 줄에도 작은 존 칩(`2`)을 붙여, 팔렛 전체가 몇 개 존으로 흩어지는지 한눈에 보인다.
- 안내문 갱신: "…제품번호·수량을 읽고 **이 박스를 옮길 존**을 알려줍니다. 스캔한 박스는 그 존의 **이동용 임시 팔렛**에 올리세요."

## ④ 데이터 · API

### 마이그레이션 0172 (`0172_warehouse_rack_zones.sql`)
```sql
warehouse_zones(zone SMALLINT PK CHECK 1~4, name, note, updated_by BIGINT→users, updated_at)  -- 4행 시드
rack_zones(rack TEXT PK, zone SMALLINT NOT NULL→warehouse_zones, updated_by, updated_at)
  + idx_rack_zones_zone, idx_rack_zones_rack_upper(UPPER(rack))
```
- **존 슬롯은 FK + CHECK 로 4개로 강제** — 존 5 삽입은 DB 가 거부한다.
- **특수키 `'__NEW__'`** = 랙 미지정 신규 SKU 의 기본 존(별도 테이블을 만들지 않음).
- 시드는 `ON CONFLICT DO NOTHING` — **재실행 멱등**.

### `zoneRoutes.js` (신규)
| 엔드포인트 | 권한 | 내용 |
|---|---|---|
| `GET /api/warehouse/zones` | `requirePage('warehouse')` | 존 4개 + 랙 목록(자연정렬·제품수·그룹·현재 존) + `new_zone` + `orphans` + `no_rack_products` + `totals` |
| `PUT /api/warehouse/zones` | `requireDirector` | `{zones:[{zone,name,note}], map:[{rack,zone}], new_zone}` — **변경분만** 받는다. `zone:null` 이면 그 랙 매핑만 삭제(전체 삭제 아님). 1~4 외 값은 400 `bad_zone`, 20,000행 초과는 400 `too_many_racks` |

- 감사로그는 표준 액션 `update` + `target:'warehouse_zones'` (0057 CHECK 에 커스텀 액션이 없어 조용히 실패하므로).
- `rackSortKey / sortRacks / rackGroup / NEW_KEY` 를 export — 테스트가 운영 함수를 그대로 쓴다.

### `inboundRoutes.js` (수정)
`GET /api/inbound/:id` 의 items 에 **`zone` · `zone_name` · `zone_is_default`** 추가.
```sql
LEFT JOIN rack_zones rz
       ON UPPER(rz.rack) = UPPER(TRIM(COALESCE(NULLIF(TRIM(pi.rack_saved),''), p.rack_location)))
LEFT JOIN warehouse_zones wz ON wz.zone = rz.zone
```
- 우선순위: **적치 때 저장한 랙(`rack_saved`) → 제품마스터 랙(`rack_location`) → 신규 기본 존(`__NEW__`)** → 없으면 `null`.
- **대소문자 무시 매칭** — `b-01-01` 을 스캔해도 `B-01-01` 의 존이 나온다.
- 매핑은 **랙 기준**이라 제품의 랙을 바꾸면 존도 자동으로 따라간다.

## ⑤ 배포 ⚠ 마이그레이션 있음 — 순서 준수

1. **백엔드 먼저**: `refatrix-api/` 의 4파일(0172 신규 · zoneRoutes.js 신규 · inboundRoutes.js · server.js) → Push → Railway **Success**.
2. Railway APP 콘솔 **`npm run migrate`** → `apply 0172_warehouse_rack_zones.sql` 확인.
   (안 돌리면 `/api/warehouse/zones` 500 + **수입입고 상세도 500** — items 쿼리가 `rack_zones` 를 조인한다. 반드시 실행.)
3. **프런트**: `refatrix-zones.html`(신규) · `refatrix-nav.js` · `refatrix-inbound.html` + **nav 토큰 갱신된 HTML 43장** → Push → Pages 1~2분.
4. **Ctrl+Shift+R** → 콘솔 `[refatrix-nav] v20260817z` · `[refatrix-zones] build zone-0817a` · `[refatrix-inbound] build 20260817c`.

> nav.js 가 바뀌었으므로 **전 HTML 의 `?v=` 토큰을 `20260817z` 로 일괄 통일**했다(43장). 이걸 안 올리면 브라우저가 옛 nav 를 캐시해 「존 지정」 메뉴가 안 보인다.

배포 확인:
```
curl -s ".../main/refatrix-api/migrations/0172_warehouse_rack_zones.sql?nc=$(date +%s)" | grep -c "rack_zones"     # 3+
curl -s ".../main/refatrix-api/src/server.js?nc=$(date +%s)" | grep -c "zoneRoutes"                                # 2
curl -s ".../main/refatrix-api/src/routes/inboundRoutes.js?nc=$(date +%s)" | grep -c "rack_zone"                    # 4+
curl -s ".../main/refatrix-nav.js?nc=$(date +%s)" | grep -c "refatrix-zones.html"                                   # 1
curl -s ".../main/refatrix-inbound.html?nc=$(date +%s)" | grep -c "zoneBigHtml"                                     # 2
```
(`...` = `https://raw.githubusercontent.com/sebastianham26-art/Refatrix`)

## ⑥ 디렉터가 할 일 (한 번만, 5분)

1. 창고 › **존 지정** 열기 → 랙 목록이 알파벳·번호순으로 나온다.
2. 존 4개의 **이름**을 현장 임시 팔렛 이름으로 바꾼다.
3. **앞글자 일괄지정**으로 A/B/C 그룹을 존에 배정 → 예외 랙만 개별 드롭다운으로 수정.
4. **🆕 랙 없는 신규 SKU 기본 존**을 정한다(지금 26개 SKU가 여기 해당 — 안 정하면 검수에서 "존 미지정").
5. **저장** → 검수 화면에 즉시 반영(별도 배포 없음).

## ⑦ 테스트 (운영 스모크)

1. 존 지정 화면: 랙 목록·제품수·그룹 구분 확인 → 일괄지정 → `변경 n건` → 저장 → 새로고침 후 유지되는지.
2. 비디렉터(창고 계정)로 열기 → 드롭다운 비활성 + "디렉터만 저장" 안내.
3. 검수에서 카톤 라벨 스캔 → **존 배너**가 지정한 존·이름으로 뜨는지. 존별 색이 다른지.
4. 랙 없는 SKU 스캔 → `🆕 신규 SKU 기본 존` 으로 안내되는지.
5. 기본 존을 비운 뒤 스캔 → 빨간 `존 미지정` + 그래도 카톤·수량이 집계되는지.
6. 제품 화면에서 어떤 SKU 의 랙을 다른 존의 랙으로 바꾼 뒤 검수 재스캔 → 존이 따라 바뀌는지.
7. 하차·적치·마감·다수 작업자 동시 작업(25초 폴링) 회귀 없음.

## ⑧ 검증 (이 세션 — 139/139 ✅)

- **`refatrix-api/test/zones.test.js` 27/27** — **실 PostgreSQL 16 + 전체 마이그레이션 172개 적용** 위에서,
  **운영 소스에서 SQL 문자열을 정규식으로 추출해 실행**(복붙 아님 → 코드가 바뀌면 테스트도 같이 바뀜):
  존 4개 시드·CHECK/FK 거부·시드 멱등 / 랙 목록 자연정렬·대소문자 통합·삭제·빈값 제외 / upsert·해제·부분 저장·`updated_by` /
  존 해석 4경로(랙 지정·`rack_saved` 우선·신규 기본·미등록 SKU) / 대소문자 무시 매칭 / 기본 존 미설정 시 `null` / 랙 변경 추종
- **`test/zone_ui.test.js` 46/46** (jsdom, 운영 HTML 인라인 스크립트 그대로 실행) —
  검수 존 배너(번호·이름·색·문구) · 신규 기본 존 표기 · 존 미지정 빨간 경고 + 집계 계속 · SKU 존 칩 /
  존 지정 화면 렌더·정렬·그룹줄·드롭다운 옵션·기존값 선택·KPI·미지정 강조 /
  변경 감지·원복 시 변경 0·일괄지정·저장 payload(변경분만·`new_zone`·존 이름)·해제는 `zone:null`·검색·미지정만·비디렉터 읽기전용·랙 0건
- **회귀**: `scan_label.test.js` **43/43** · `scan_hyphen.test.js` **23/23** (오늘 앞선 라벨 파서 작업)
- `0172` **pglast VALID**(7문) · `node --input-type=module --check` 백엔드 3파일 · 인라인 JS 파싱 2파일 · `node --check` nav.js
- **Chromium 실제 렌더 스크린샷** — 존 지정 화면 / 검수 존 배너(일반·신규) 육안 확인

## ⑨ 변경 파일

| 파일 | 변경 |
|---|---|
| `refatrix-api/migrations/0172_warehouse_rack_zones.sql` | **신규** — warehouse_zones + rack_zones |
| `refatrix-api/src/routes/zoneRoutes.js` | **신규** — GET/PUT + rackSortKey·rackGroup·NEW_KEY |
| `refatrix-api/src/routes/inboundRoutes.js` | items 에 zone/zone_name/zone_is_default 추가(조인 2개 + `__NEW__` 조회) |
| `refatrix-api/src/server.js` | zoneRoutes import + register (2줄) |
| `refatrix-zones.html` | **신규** 화면 build `zone-0817a` |
| `refatrix-inbound.html` | 존 배너·존 칩·CSS·안내문 · build `20260817c` |
| `refatrix-nav.js` | SCREENS/PAGEKEY/GROUPS 에 `zones` 추가 · v20260817z |
| HTML 43장 | nav 캐시버스터 `?v=20260817z` 일괄 |
| `refatrix-api/test/zones.test.js`, `test/zone_ui.test.js` | **신규** 테스트(zip 동봉) |

## ⑩ 메모 / 남은 것

- **분류 실적은 기록하지 않는다.** 지금은 검수 스캔이 "어느 존으로 가라"를 **안내만** 한다(디렉터 지시).
  존 팔렛에 몇 박스가 올라갔는지 시스템에 남기려면 별도 테이블 + 스캔 단계가 필요하다 — 필요해지면 별건.
- **존은 4개 고정.** 5개 이상이 필요해지면 0172 의 CHECK 와 프런트 `[1,2,3,4]` 배열을 함께 늘려야 한다.
- 랙 매핑은 **랙 문자열 기준**이다. 제품마스터에서 랙 표기를 바꾸면(예: `A-01-03` → `A0103`)
  그 랙은 **미지정으로 돌아간다**(존 지정 화면에 새 랙으로 나타남). 랙 표기 규칙을 고정하는 게 좋다.
- 앞머리 규칙(`A`/`B`/`12`)은 **일괄지정 편의용**일 뿐, 저장은 항상 개별 랙 행이다 — 나중에 랙이 추가되면
  그 랙만 미지정으로 뜨므로 존 지정 화면의 `미지정` KPI 를 주기적으로 보면 된다.
- 오늘 앞선 작업의 남은 과제(**라벨 소입수량을 DB 에 기록**)는 그대로 미결 — 재고 정확성과 직결되므로 디렉터 결정 대기.

---
*이 문서는 인수인계용 스냅샷입니다.*
