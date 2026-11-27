# REFATRIX handover 2026-11-27h · 플랫폼 신규 차종 수신 API + 제품찾기 반영 (0346)

기준 코드: 로컬 레포 HEAD `35d8fec` (2026-11-27 16:05 「new shop」 · 27g 연식우선 포함) — 작업 트리 변경 없음 확인 후 작업.
GitHub tarball(codeload)은 이 세션에서 받을 수 없어 로컬 레포를 기준으로 했습니다. **푸시 전 GitHub Desktop 에서 Fetch/Pull 로 그 사이 바뀐 것이 없는지 확인하세요.**

## ① 설명

### 왜 Geely Emgrand 가 안 나왔나 (원인)
- 제품찾기(차종)의 메이커 · 모델 · 연식 목록과 결과는 **`product_applications` 한 표**에서만 만듭니다. 이 표는 제품 마스터 `products.app`(적용차종 원문)을 `parseApplications()` 로 나눠 넣은 것입니다.
- 제품검색 → 수정(PATCH `/api/products/:id`)과 플랫폼 확인완료(pf-catalog confirm) **둘 다 저장 즉시 이 표를 다시 씁니다.** 캐시 · 색인 · 확인완료 대기는 없습니다.
- 문제는 파서 규칙: **메이커 = 맨 앞의 「대문자」 낱말**. `Geely Emgrand 2025` 처럼 대소문자를 섞어 쓰면 메이커가 비고(`maker = NULL`) 모델이 `Geely Emgrand` 로 들어갑니다. 메이커 목록은 `maker` 가 빈 줄을 빼므로 **Geely 가 목록에 안 나왔습니다.**
- 연식(끝의 4자리)이 없으면 연식 목록 · 연식 조건 검색에서도 빠집니다.
- ERP 에는 차종 마스터 표가 없었습니다 — 제품이 연결되지 않은 차종은 목록에 나올 길이 없었습니다.

### 이번에 바꾼 것
1. **적용차종 읽기 보강** — 대문자가 아니어도 알려진 메이커 이름(GEELY · KIA · VW · GREAT WALL · MERCEDES-BENZ 등 76개)이면 메이커로 읽고 대문자로 저장. 기존 대문자 규칙 · 'DODGE, CHRYSLER' 쉼표 메이커는 그대로. 모르는 낱말(`Versa 2012-2019`)은 추측하지 않음.
2. **저장할 때 알림** — 제품 수정 · 확인완료 응답에 `app_warnings`(메이커 · 연식 못 읽은 적용차종). 제품 수정 모달에 「⚠ 차종 찾기에 안 나오는 적용차종 N건」 표시. 저장은 막지 않음.
3. **신규 차종 표 `pf_vehicles`(0346)** + `POST/GET /api/pf-catalog/vehicles`.
4. **제품찾기 목록이 `pf_vehicles` 도 함께 읽음** — 메이커 · 모델 · 연식 드롭다운(제품 화면 · 견적 화면 모두). 제품이 아직 없으면 옵션 끝에 🆕. 같은 이름 키면 한 줄로 묶임(제품이 생기면 🆕 사라짐).
5. **차량 도면** — 신규 차종인데 연결 제품이 없으면 「연결된 제품 없음 — 🆕 플랫폼 신규 차종 · 출처 · 연식 · 참고 OE」 + 「제품 마스터 적용차종에 `GEELY Emgrand 2025-2026` 처럼 넣으면 여기 나옵니다」.
6. **제품 저장 뒤 메이커 목록 바로 새로고침**(고른 메이커 유지) — 새로고침 없이 차종 찾기에 반영.

## ② 배포단계
1. GitHub Desktop **Fetch/Pull**.
2. 백엔드 zip(`REFATRIX_2026-11-27h_pf_vehicles_BACKEND.zip`) 풀어 레포 루트에 덮어쓰기 → 커밋 · 푸시 → Railway **Success** 확인.
3. Railway 콘솔 `npm run migrate` → `apply 0346_pf_vehicles.sql`.
   (0346 전에는 `/api/pf-catalog/vehicles` 가 **501** → 플랫폼은 「ERP 대기」로 두고 30분마다 다시 보냄. 다른 기능은 그대로.)
4. 프론트 zip(`..._FRONTEND.zip`) 3개 파일 레포 루트에 덮어쓰기 → 푸시 → `Ctrl+Shift+R`.
   탭 제목 빌드 토큰: 제품 `ps-1127vs` · 견적 `qt-1127vo`.
5. **제품 화면 › 「분해 데이터 전체 재동기화」 1회(디렉터)** — 이미 저장돼 있는 대소문자 섞인 적용차종(예: `Geely Emgrand …`)을 새 규칙으로 다시 읽습니다. 원문(products.app)은 안 바뀝니다.
6. 플랫폼 📈 시장 데이터 → [🚗 신규 차종 → ERP].

## ③ 테스트방법
- 진단(배포 전 지금 상태 확인 · Railway DB):
  ```sql
  SELECT p.code, a.app_text, a.maker, a.model, a.year_from, a.year_to
    FROM product_applications a JOIN products p ON p.id = a.product_id AND p.deleted_at IS NULL
   WHERE a.app_text ILIKE '%emgrand%';
  ```
  `maker` 가 비어 있으면 위 원인입니다.
- 화면: 제품 › 제품 찾기 › 🚗 차종으로 제품찾기 → 메이커 `GEELY 🆕` → 연식 → 모델 `Emgrand` → 「연결된 제품 없음」.
  CTR 제품 수정 → 적용차종 `GEELY Emgrand 2025-2026`(또는 `Geely Emgrand 2025-2026`) 저장 → 같은 화면에서 바로 그 제품.
- curl 은 ⑨ 회신의 test 항목.

## ④ 변경파일

| 레포 경로 | 구분 | 내용 |
|---|---|---|
| `refatrix-api/migrations/0346_pf_vehicles.sql` | 신규 | pf_vehicles 표 · 이름 키 unique · ref unique(부분) |
| `refatrix-api/src/pfVehicles.js` | 신규 | 본문 검사 · 받기(existed) · 목록(연결 제품 수) · OE 후보 · 제품찾기 보충 |
| `refatrix-api/src/routes/pfCatalogRoutes.js` | 수정 | `POST/GET /api/pf-catalog/vehicles` · confirm 응답 `app_warnings` |
| `refatrix-api/src/routes/productRoutes.js` | 수정 | app-makers · app-models · app-years 에 pf_vehicles 합침 · PATCH 응답 `app_warnings` |
| `refatrix-api/src/routes/vehicleMapRoutes.js` | 수정 | 응답 `pf_vehicle` |
| `refatrix-api/src/productImport.js` | 수정 | 대문자 아닌 알려진 메이커 읽기(`KNOWN_MAKERS` · `knownMakerPrefix`) · `appWarnings` |
| `refatrix-api/test/pf_vehicles.test.mjs` | 신규 | 순수 · 화면(jsdom) · 실 PostgreSQL + 서버 |
| `refatrix-api/test/{quote_*_front,product_dims_front,xref_cols_front}.test.mjs` 7개 · `test/product_positions_ctr.test.mjs` | 수정 | 빌드 토큰 qt-1127vo · ps-1127vs 만 |
| `refatrix-vehiclemap.js` (루트) | 수정 | 🆕 · 연결된 제품 없음 안내 · loadMakers 선택 유지 |
| `refatrix-products.html` (루트) | 수정 | 저장 뒤 메이커 목록 새로 · 적용차종 경고 · `?v=20261127h` · ps-1127vs |
| `refatrix-quote.html` (루트) | 수정 | `?v=20261127h` · qt-1127vo |

## ⑤ 검증결과
- `node --check` 전 파일 통과.
- 실 PostgreSQL 16 에 마이그레이션 0001~0346 전부 적용 성공.
- `pf_vehicles.test.mjs` 3/3 통과 — 401(토큰 없음 · ERP 토큰) · 501 · 422 · 201 · 200 existed(대소문자 · 하이픈 · ref) · 동시 2건 → 1건 · OE 후보 · created_by · 메이커/연식/모델 목록 🆕 · 연식 범위(2024 제외 · 끝 연식 없으면 올해+1) · 도면 pf_vehicle · 대문자 아닌 메이커 저장 즉시 도면 반영 · GET products/app_year · confirm 반영 + 연식 경고 · 가격/재고 불변.
- 회귀: 관련 테스트 30개 파일 — 변경 전 코드와 결과 **완전히 같음**(diff 0). 남은 실패(pf_catalog_front 1 · product_sort_all 3 · product_ref_new_front 2 · rack_stock_front 4 · xref_master_front 3)는 변경 전에도 똑같이 실패하던 것(이 환경 · 기존 문제).
- vehicle_map_e2e 10/10 · pf_catalog 6/6 · pf_catalog_create 2/2 · quote_vehicle_pick_front 5/5 · product_positions_ctr.

## ⑥ 결정사항(제가 정한 것 — 바꾸려면 말씀하세요)
- 표 이름 `pf_vehicles`, id 는 ERP 규칙대로 `BIGINT IDENTITY`. 같은 차종 키는 `brand_key|model_key`(구분자 넣어 'AB'+'C' ≠ 'A'+'BC').
- 이미 있으면 **아무것도 바꾸지 않음**(연식 · OE 도) — 요청서 그대로.
- year_to 가 null 이면 「현재 판매 중」 — 연식 목록은 올해+1 까지. year_from 이 없는 차종은 연식을 안 고를 때만 모델 목록에.
- 응답에 `matches`(OE 같은 ERP 제품 코드)를 항상 넣음(없으면 `[]`).
- 제품 연결은 새 표가 아니라 기존 적용차종(products.app) 그대로 — 화면 · 견적 · 가격마스터 등 다른 곳도 같은 기준을 쓰기 때문.

## ⑦ 오픈이슈
- 메이커 줄임말(VW ↔ VOLKSWAGEN)은 합치지 않음(기존 11-27b 규칙). 플랫폼이 `VW` 로 보내고 제품에 `VOLKSWAGEN` 이면 두 줄로 보임.
- ERP 화면에서 신규 차종 기록(연식 · 이름)을 직접 고치는 화면은 없음 — 지금은 제품 적용차종을 고치면 GET 의 `app_year_from/app_year_to · products` 로 플랫폼이 읽어 감.
- 적용차종을 ' // ' 대신 쉼표 · 줄바꿈으로 여러 차종 적으면 한 항목으로 읽힘(기존 규칙 그대로 · 이번엔 바꾸지 않음).
- 오늘 패키지 `27g_hr_admin_role_patch`(0344)가 아직 레포에 없음 — 이번 파일과 겹치지 않고 번호 순서도 문제없음.

## ⑧ 다음액션
1. 배포 → migrate → 재동기화 1회 → 플랫폼 [🚗 신규 차종 → ERP].
2. ERP 제품찾기 Geely → Emgrand 확인 → CTR 제품 적용차종 연결.
3. 필요하면 신규 차종 관리 화면(ERP 디렉터) · 메이커 줄임말 합치기.

---

## ⑨ 회신 (플랫폼 프로젝트에 붙여넣기)

```
[REFATRIX-VEH-ANSWER]
finder_source: 표 product_applications(product_id, app_text, maker, model, year_from, year_to) — products.app(적용차종 원문, ' // ' 구분)을 src/productImport.js parseApplications()/parseAppEntry() 로 나눠 저장. 목록: src/routes/productRoutes.js GET /api/products/app-makers · app-models(?maker&year) · app-years(?maker&model) (nameGroups · 이름 키 NK_SQL/MAKER_COND_SQL = src/vehicleMap.js). 결과: src/routes/vehicleMapRoutes.js GET /api/products/vehicle-map(?maker&model&year) — product_applications 를 이름 키로 걸러 products 와 조인(적용차종 글자를 화면에서 파싱하지 않음, 별도 application 표 사용). 0346 부터 pf_vehicles 도 목록에 합침.
why_not_reflected: 다른 표 · 캐시 · 확인완료 대기 아님 — 제품 수정(PATCH /api/products/:id)과 pf-catalog confirm 둘 다 저장 즉시 product_applications 를 다시 씀. 원인은 파서 규칙 「메이커 = 맨 앞 대문자 낱말」: 'Geely Emgrand 2025' 는 maker=NULL · model='Geely Emgrand' 로 저장돼 메이커 목록(maker 빈 줄 제외)에 안 나옴. 연식(끝 4자리)이 없으면 연식 목록 · 연식 검색에서도 빠짐. 수정: 알려진 메이커는 대소문자 무관하게 읽음 + 저장 응답 app_warnings + 기존 데이터는 「분해 데이터 전체 재동기화」 1회.
router_file: refatrix-api/src/routes/pfCatalogRoutes.js — 인증 = 같은 파일 안 guard(req, reply)(req.jwtVerify + typ 'pf_cat' + uk 확인, pfCatalogReady 아니면 503), 토큰 발급 POST /api/pf-catalog/login(플랫폼 세션 → platformApi.log 확인 → 1시간 JWT). 신규 차종 로직 refatrix-api/src/pfVehicles.js.
vehicle_table: 신규 pf_vehicles(id BIGINT IDENTITY, brand, model, brand_key, model_key, norm_key UNIQUE, year_from, year_to, segment, origin, kind, source, ref UNIQUE(부분), sales_ytd, oe_ref JSONB, created_by, created_at, updated_at). 기존 차종 마스터 표는 없었음(ctr_vio_rank 는 VIO 순위 전용).
patch: 패키지 REFATRIX_2026-11-27h_pf_vehicles — BACKEND.zip(migrations/0346_pf_vehicles.sql 신규 · src/pfVehicles.js 신규 · src/routes/pfCatalogRoutes.js · src/routes/productRoutes.js · src/routes/vehicleMapRoutes.js · src/productImport.js · test/pf_vehicles.test.mjs 외 빌드토큰 테스트 8개) + FRONTEND.zip(refatrix-vehiclemap.js · refatrix-products.html · refatrix-quote.html) + existing-files.diff. 응답: 201 {vehicle:{id,brand,model,year_from,year_to,segment,origin,kind,source,ref,sales_ytd,created_by,created_at,oe_ref}, existed:false, matches:[{code,oe}]} · 200 {vehicle, existed:true, matches} · 422 {"error":"brand/model 필수"} · 0346 전 501 {"error":"migration_required"}. GET → {items:[{id,brand,model,year_from,year_to,source,ref,…,products,app_year_from,app_year_to}]}.
migration: 0346_pf_vehicles.sql 1개(IF NOT EXISTS · 재실행 안전). 순서: 백엔드 푸시 → Railway Success → npm run migrate → 프론트 푸시 → Ctrl+Shift+R → 제품 화면 「분해 데이터 전체 재동기화」 1회(디렉터).
deploy_note: Fetch/Pull 먼저. migrate 전에는 /api/pf-catalog/vehicles 만 501(플랫폼 「ERP 대기」 → 30분마다 재전송) · 나머지 그대로. 새 npm 패키지 없음 · 환경변수 없음. 빌드 토큰 제품 ps-1127vs · 견적 qt-1127vo · vehiclemap ?v=20261127h. 가격 · 재고 · 제품 데이터 변경 없음(재동기화는 원문에서 분해표만 다시 만듦).
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
