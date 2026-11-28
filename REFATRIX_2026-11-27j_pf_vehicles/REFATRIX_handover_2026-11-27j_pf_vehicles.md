# REFATRIX handover 2026-11-27j · 플랫폼 신규 차종 수신 API + 제품찾기 반영 (0346) · 제품 `ps-1127vu` · 견적 `qt-1127vq`

> **`27h_pf_vehicles` 패키지를 대체합니다(그 폴더는 `_OLD_DO_NOT_USE` 로 이름을 바꿔 두었습니다 — 쓰지 마세요).**
> 라이브 `ed592fb`(11-27h 적용차종 분해 규칙 · 11-27i 메이커 → 모델[연식 범위] → 연식) 위에 다시 만들었습니다.

기준 코드: 로컬 레포 HEAD `ed592fb` (2026-11-27 16:35 「찾기」) — 작업 트리 변경 없음 확인 후 작업.
GitHub tarball 은 이 세션에서 받을 수 없어 로컬 레포 기준입니다. **푸시 전 Fetch/Pull 로 그 사이 바뀐 것이 없는지 확인하세요.**

## ① 설명

### 왜 Geely Emgrand 가 안 나왔나 (원인)
- 제품찾기(차종)의 메이커 · 모델 · 연식 목록과 결과는 **`product_applications` 한 표**에서만 만듭니다(제품 마스터 `products.app` 를 `parseApplications()` 로 나눈 것).
- 제품검색 → 수정(PATCH `/api/products/:id`)과 플랫폼 확인완료(pf-catalog confirm) **둘 다 저장 즉시 이 표를 다시 씁니다.** 캐시 · 색인 · 확인완료 대기는 없습니다.
- 원인은 분해 규칙이었습니다: 예전엔 **맨 앞의 대문자 낱말만 메이커** → `Geely Emgrand 2025` 는 메이커가 비어 메이커 목록에서 빠졌습니다. → **11-27h(라이브 반영됨)가 메이커 이름표로 고쳤습니다.** 기존 데이터는 「분해 데이터 전체 재동기화」 1회가 필요합니다.
- 그리고 ERP 에는 차종 마스터 표가 없어서, 제품이 연결되지 않은 차종은 목록에 나올 길이 없었습니다 → 이번 패키지.

### 이번 패키지(11-27j)
1. **신규 차종 표 `pf_vehicles`(0346)** + `POST/GET /api/pf-catalog/vehicles`.
2. **제품찾기 목록이 `pf_vehicles` 도 함께 읽음** — 메이커 · 모델(연식 범위 표시 포함) · 연식 드롭다운, 제품 화면 · 견적 화면 모두. 제품이 아직 없으면 옵션 끝에 🆕. 이름 키가 같으면 한 줄(제품이 생기면 🆕 사라짐).
3. **차량 도면** — 신규 차종인데 연결 제품이 없으면 「연결된 제품 없음 — 🆕 플랫폼 신규 차종 · 출처 · 연식 · 참고 OE」 + 「제품 마스터 적용차종에 `GEELY Emgrand 2025-2026` 처럼 넣으면 여기 나옵니다」.
4. **저장할 때 알림** — 제품 수정 · 확인완료 응답에 `app_warnings`(메이커 · 연식 못 읽은 적용차종). 제품 수정 모달에 「⚠ 차종 찾기에 안 나오는 적용차종 N건」. 저장은 막지 않음.
5. **제품 저장 뒤 메이커 목록 바로 새로고침**(고른 메이커 유지).
6. 분해 규칙(11-27h)은 **건드리지 않음** — `appWarnings()` 함수만 추가.

## ② 배포단계
1. GitHub Desktop **Fetch/Pull**.
2. `REFATRIX_2026-11-27j_pf_vehicles_BACKEND.zip` → 레포 루트에 덮어쓰기 → 푸시 → Railway **Success**.
3. Railway 콘솔 `npm run migrate` → `apply 0346_pf_vehicles.sql`.
   (0346 전에는 `/api/pf-catalog/vehicles` 만 **501** → 플랫폼 「ERP 대기」 · 30분마다 재전송. 나머지 그대로.)
4. `..._FRONTEND.zip` 3개 파일 → 푸시 → `Ctrl+Shift+R` → 탭 제목 제품 **`ps-1127vu`** · 견적 **`qt-1127vq`**.
5. **11-27h/i 배포 뒤 「분해 데이터 전체 재동기화」를 아직 안 눌렀다면 1회**(제품 › 제품 마스터 업로드 탭 · 디렉터).
6. 플랫폼 📈 시장 데이터 → [🚗 신규 차종 → ERP].

## ③ 테스트방법
- 진단 SQL(Railway DB):
  ```sql
  SELECT p.code, a.app_text, a.maker, a.model, a.year_from, a.year_to
    FROM product_applications a JOIN products p ON p.id = a.product_id AND p.deleted_at IS NULL
   WHERE a.app_text ILIKE '%emgrand%';
  SELECT id, brand, model, year_from, year_to, source, ref, created_by FROM pf_vehicles ORDER BY id DESC LIMIT 20;
  ```
- 화면: 제품 › 제품 찾기 › 🚗 차종으로 제품찾기 → 메이커 `Geely 🆕` → 모델 `Emgrand  2025~2027 🆕` → 연식 → 「연결된 제품 없음」.
  CTR 제품 수정 → 적용차종 `Geely Emgrand 2025-2026` 저장 → 같은 화면에서 바로 그 제품(🆕 사라짐).
- curl 은 ⑨ 회신의 test 항목.

## ④ 변경파일

| 레포 경로 | 구분 | 내용 |
|---|---|---|
| `refatrix-api/migrations/0346_pf_vehicles.sql` | 신규 | pf_vehicles 표 · 이름 키 unique · ref unique(부분) |
| `refatrix-api/src/pfVehicles.js` | 신규 | 본문 검사 · 받기(existed) · 목록(연결 제품 수 · ERP 연식) · OE 후보 · 제품찾기 보충(모델 연식 범위 포함) |
| `refatrix-api/src/routes/pfCatalogRoutes.js` | 수정 | `POST/GET /api/pf-catalog/vehicles` · confirm 응답 `app_warnings` |
| `refatrix-api/src/routes/productRoutes.js` | 수정 | app-makers · app-models · app-years 에 pf_vehicles 합침(`pf_only`) · PATCH 응답 `app_warnings` |
| `refatrix-api/src/routes/vehicleMapRoutes.js` | 수정 | 응답 `pf_vehicle` |
| `refatrix-api/src/productImport.js` | 수정 | `appWarnings()` 추가만(분해 규칙 그대로) |
| `refatrix-api/test/pf_vehicles.test.mjs` | 신규 | 순수 · 화면(jsdom) · 실 PostgreSQL + 서버 |
| `refatrix-api/test/` 화면 시험 7개 · `product_positions_ctr.test.mjs` | 수정 | 빌드 토큰 qt-1127vq · ps-1127vu 만 |
| `refatrix-vehiclemap.js` (루트) | 수정 | 🆕 · 연결된 제품 없음 안내 · loadMakers 선택 유지 · version 20261127j |
| `refatrix-products.html` (루트) | 수정 | 저장 뒤 메이커 목록 새로 · 적용차종 경고 · `?v=20261127j` · ps-1127vu |
| `refatrix-quote.html` (루트) | 수정 | `?v=20261127j` · qt-1127vq |

## ⑤ 검증결과
- `node --check` 전 파일 통과 · 실 PostgreSQL 16 에 0001~0346 마이그레이션 적용 성공.
- `pf_vehicles.test.mjs` 3/3 — 401(토큰 없음 · ERP 토큰) · 501 · 422 · 201 · 200 existed(대소문자 · 하이픈 · ref) · 동시 2건 → 1건 · OE 후보 · created_by · 메이커/모델/연식 목록 🆕 · 연식 범위(2024 제외 · 끝 연식 없으면 올해+1) · 도면 pf_vehicle · 저장 즉시 도면 반영 + 메이커 없음 알림 · GET products/app_year · confirm 반영 + 연식 없음 알림 · 가격/재고 불변 · 플랫폼 신규 차종 6종(Geely Emgrand · EX5 EM-i · Nissan Magnite · RAM 1200 · Kia K4 · VW Tera) 분해 확인.
- 회귀: 관련 테스트 30개 파일을 기준 코드(ed592fb)와 이번 코드에서 똑같이 돌림 — **새로 실패한 것 없음.**
  양쪽 모두 실패하던 것(이번 변경과 무관 · 이 환경/기존 문제): product_sort_all 3 · product_ref_new_front 2 · rack_stock_front 4 · xref_master_front 3 · price_master_schema.
  pf_catalog_front 는 기준 코드에서 1건 실패 · 이번 코드에서 통과(흔들리는 시험).
- vehicle_map_e2e · pf_catalog · pf_catalog_create · quote_vehicle_pick_front · product_positions_ctr · productImport 통과.

## ⑥ 결정사항(제가 정한 것 — 바꾸려면 말씀하세요)
- 표 이름 `pf_vehicles`, id 는 `BIGINT IDENTITY`. 같은 차종 키는 `brand_key|model_key`.
- 이미 있으면 **아무것도 바꾸지 않음**(연식 · OE 도).
- year_to 가 null 이면 「현재 판매 중」 — 연식 목록은 올해+1 까지(11-27h 인정 범위 1950 ~ 올해+2 안). year_from 이 없는 차종은 연식을 안 고를 때만.
- 응답에 `matches`(OE 같은 ERP 제품 코드) 항상 포함(없으면 `[]`).
- 제품 연결은 기존 적용차종(products.app) 그대로.

## ⑦ 오픈이슈
- 메이커 줄임말(VW ↔ VOLKSWAGEN)은 합치지 않음 — 플랫폼이 `VW` 로 보내고 제품에 `VOLKSWAGEN` 이면 두 줄.
- ERP 에서 신규 차종 기록을 직접 고치는 화면은 없음 — 제품 적용차종을 고치면 GET 의 `products · app_year_from/app_year_to` 로 플랫폼이 읽어 감.
- `27g_hr_admin_role_patch`(0344)는 아직 레포에 없음 — 이번 파일과 겹치지 않고 번호 순서도 문제없음.

## ⑧ 다음액션
1. 배포 → migrate → (필요하면) 재동기화 → 플랫폼 [🚗 신규 차종 → ERP].
2. ERP 제품찾기 Geely → Emgrand 확인 → CTR 제품 적용차종 연결.

---

## ⑨ 회신 (플랫폼 프로젝트에 붙여넣기)

```
[REFATRIX-VEH-ANSWER]
finder_source: 표 product_applications(product_id, app_text, maker, model, year_from, year_to) — products.app(적용차종 원문, ' // ' 구분)을 refatrix-api/src/productImport.js parseApplications()/parseAppEntry() 로 나눠 저장. 목록: refatrix-api/src/routes/productRoutes.js GET /api/products/app-makers · app-models(?maker · groups[].y_from/y_to) · app-years(?maker&model) (nameGroups · 이름 키 NK_SQL/MAKER_COND_SQL = src/vehicleMap.js). 결과: refatrix-api/src/routes/vehicleMapRoutes.js GET /api/products/vehicle-map(?maker&model&year) — product_applications 를 이름 키로 걸러 products 와 조인(별도 application 표 사용 · 화면에서 글자 파싱 안 함). 0346 부터 pf_vehicles 도 목록에 합침(제품 없으면 🆕 pf_only).
why_not_reflected: 다른 표 · 캐시 · 확인완료 대기 아님 — 제품 수정(PATCH /api/products/:id)과 pf-catalog confirm 둘 다 저장 즉시 product_applications 를 다시 씀. 원인은 분해 규칙 「메이커 = 맨 앞 대문자 낱말」: 'Geely Emgrand 2025' 는 maker=NULL 로 저장돼 메이커 목록에 안 나옴(연식 없으면 연식 목록에서도 빠짐). 11-27h(라이브 반영)가 메이커 이름표로 고쳤고, 기존 데이터는 「분해 데이터 전체 재동기화」 1회. 제품이 없는 차종은 ERP 에 차종 표가 없어 나올 수 없었음 → pf_vehicles 추가. 저장 응답에 app_warnings(메이커 · 연식 못 읽은 줄) 추가.
router_file: refatrix-api/src/routes/pfCatalogRoutes.js — 인증 = 같은 파일 안 guard(req, reply)(req.jwtVerify + typ 'pf_cat' + uk 확인 · pfCatalogReady 아니면 503). 토큰 발급 POST /api/pf-catalog/login(플랫폼 세션 → platformApi.log 확인 → 1시간 JWT). 신규 차종 로직 refatrix-api/src/pfVehicles.js.
vehicle_table: 신규 pf_vehicles(id BIGINT IDENTITY, brand, model, brand_key, model_key, norm_key UNIQUE, year_from, year_to, segment, origin, kind, source, ref UNIQUE(부분), sales_ytd, oe_ref JSONB, created_by, created_at, updated_at). 기존 차종 마스터 표는 없었음(ctr_vio_rank 는 VIO 순위 전용).
patch: 패키지 REFATRIX_2026-11-27j_pf_vehicles — BACKEND.zip(migrations/0346_pf_vehicles.sql 신규 · src/pfVehicles.js 신규 · src/routes/pfCatalogRoutes.js · src/routes/productRoutes.js · src/routes/vehicleMapRoutes.js · src/productImport.js(appWarnings 만) · test/pf_vehicles.test.mjs + 빌드토큰 시험 8개) + FRONTEND.zip(refatrix-vehiclemap.js · refatrix-products.html · refatrix-quote.html) + existing-files.diff. 응답: 201 {vehicle:{id,brand,model,year_from,year_to,segment,origin,kind,source,ref,sales_ytd,created_by,created_at,oe_ref}, existed:false, matches:[{code,oe}]} · 200 {vehicle, existed:true, matches} · 422 {"error":"brand/model 필수"} · 0346 전 501 {"error":"migration_required"}. GET → {items:[{id,brand,model,year_from,year_to,source,ref,…,products,app_year_from,app_year_to}]}.
migration: 0346_pf_vehicles.sql 1개(IF NOT EXISTS · 재실행 안전). 순서: 백엔드 푸시 → Railway Success → npm run migrate → 프론트 푸시 → Ctrl+Shift+R → (11-27h 이후 아직이면) 「분해 데이터 전체 재동기화」 1회.
deploy_note: Fetch/Pull 먼저(기준 ed592fb). migrate 전에는 /api/pf-catalog/vehicles 만 501(플랫폼 「ERP 대기」 → 30분마다 재전송) · 나머지 그대로. 새 npm 패키지 · 환경변수 없음. 빌드 토큰 제품 ps-1127vu · 견적 qt-1127vq · vehiclemap ?v=20261127j. 가격 · 재고 · 제품 데이터 변경 없음.
test: |
  API=https://refatrix-production.up.railway.app
  PFTOK=$(curl -s -X POST $API/api/pf-catalog/login -H 'Content-Type: application/json' -d '{"token":"<플랫폼 세션 UUID>","name":"Sebastian","user_key":"1"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')
  # 201 (새로)
  curl -s -w '\n%{http_code}\n' -X POST $API/api/pf-catalog/vehicles -H "Authorization: Bearer $PFTOK" -H 'Content-Type: application/json' -d '{"brand":"Geely","model":"Emgrand","year_from":2025,"year_to":null,"segment":"A SEDAN","origin":"China","kind":"passenger","source":"refatrix-market","ref":"NEW|GEELY|Emgrand","sales_ytd":16406,"oe":[{"cat":"BALL JOINT","pos":"Front Lower","oe":"4017020200","price":1816.76,"src":"견적서 · Geely · EMGRAND · 24/11/2026"}]}'
  # 200 existed (같은 이름 키 · 대소문자/하이픈 달라도)
  curl -s -w '\n%{http_code}\n' -X POST $API/api/pf-catalog/vehicles -H "Authorization: Bearer $PFTOK" -H 'Content-Type: application/json' -d '{"brand":"GEELY","model":"EM-GRAND"}'
  # 422
  curl -s -w '\n%{http_code}\n' -X POST $API/api/pf-catalog/vehicles -H "Authorization: Bearer $PFTOK" -H 'Content-Type: application/json' -d '{"model":"Emgrand"}'
  # 조회
  curl -s "$API/api/pf-catalog/vehicles?q=emgrand" -H "Authorization: Bearer $PFTOK"
[/REFATRIX-VEH-ANSWER]
```
