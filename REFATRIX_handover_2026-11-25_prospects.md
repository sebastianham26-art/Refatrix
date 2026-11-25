# REFATRIX 인수인계 — 2026-11-25 · 영업 › 고객개발 (0334)

DENUE 후보를 ERP에 넣고, 지역별 담당 배정 → 오늘 루트 → 체크인·녹음 → AI가 Alta de clientes 양식 초안 작성 → 담당자 확인·저장 → 기존 고객 연결 → 현황판까지 이어지는 모듈입니다.
녹음·전사·요약은 **기존 「영업 › 고객상담」 원클릭 녹음을 그대로** 씁니다(같은 OpenAI·Anthropic 키, 같은 큐). 이 모듈은 거기에 후보 연결과 양식 초안만 붙였습니다.

## 배포 순서
1. 백엔드 파일 올리기(refatrix-api) → Railway 재배포
2. `npm run migrate` — **0334_prospects.sql** 적용(컬럼 추가만, 기존 행·동작 그대로 · 재실행 안전)
3. 화면 파일 올리기: `refatrix-prospects.html`, `refatrix-nav.js`, `refatrix-consult.html`
4. 메뉴: 영업 › **고객개발**. 권한은 고객상담과 같은 `pipeline`(영업활동) 키. 가져오기·지역·목표·연결 승인은 디렉터만.
5. 고객개발 › **DENUE 가져오기**에서 `prospects_import_NL.csv` 업로드(9,492곳, 판 2026-11) → **지역·담당**에서 지역 만들기 → 저장하면 미배정 후보가 자동 배정됩니다.

마이그레이션 전에 화면을 열면 「0334 적용 필요」 안내가 뜨고, 고객상담은 예전처럼 동작합니다.

## 파일
| 구분 | 파일 | 내용 |
|---|---|---|
| DB | `refatrix-api/migrations/0334_prospects.sql` | prospects · prospect_territories · *_stage_history · *_assign_history · prospect_targets · prospect_routes/_stops · prospect_crm_values/_log · prospect_customer_links + sales_consults(prospect_id, checkin_dist_m, review_status…) · sales_consult_recordings(alta_draft, alta_status, alta_error) |
| 신규 | `src/altaClientesForm.js` | FORMATO_ALTA_CLIENTES_FINAL.xlsx Hoja1 → 6개 섹션 53칸(경쟁사 3세트 펼침). 항목마다 fill(denue/ia/manual), required, erp_field |
| 신규 | `src/prospectCore.js` | 순수 함수: 단계 규칙, DENUE 정규화·우선순위, 지역 판정, 거리·방문순서, 고객 매칭, AI 프롬프트/파서, 검토 병합, KPI |
| 신규 | `src/prospectAlta.js` | 체크인 상담 ↔ 후보 연결, 요약 후 Alta 초안 생성, 고객 승인+첫 인보이스 → 신규고객 |
| 신규 | `src/routes/prospectRoutes.js` | /api/prospects/*, /api/prospect-territories, /api/prospect-targets, /api/prospect-routes, /api/prospect-links |
| 수정 | `src/server.js` | prospectRoutes 등록 2줄 |
| 수정 | `src/routes/consultRoutes.js` | ① POST /api/consults 가 `prospect_id` 를 받으면 후보 연결 ② processOne 요약 끝에 Alta 초안 1회 추가 호출 — 실패해도 요약은 done |
| 신규 | `refatrix-prospects.html` | 고객개발 화면(IKEA 톤 + CTR 레드 #E2231A, 로고는 /api/company 등록 이미지) |
| 수정 | `refatrix-consult.html` | `#quick=1&prospect=ID&pname=상호` 로 들어오면 첫 녹음 1건을 그 후보에 연결(상호 미리 채움) |
| 수정 | `refatrix-nav.js` | 영업 그룹에 고객개발(prospects) · 스페인어 메뉴명 · 모바일 탭 아이콘 |
| 테스트 | `test/prospects.test.mjs` | 순수 함수 13개 |

## 흐름 요약
- **체크인**: 오늘 루트/후보 상세의 「체크인 · 녹음」 → 고객상담 원클릭 녹음 화면이 열림(업체 정보 없어도 바로 시작). 서버가 상담을 후보에 연결하고, 체크인 위치와 후보 좌표의 거리(150m 넘으면 노란색)를 기록합니다. 단계는 → 컨택, 오늘 루트 정류장에 방문 표시.
- **AI 초안**: 기존 요약이 끝나면 같은 전사문으로 `buildAltaPrompt` 1회 호출(max_tokens 3000) → `alta_draft`. 말하지 않은 항목은 null, 근거 문장·확신도(alta/media/baja)를 함께 받음. CRM 값은 이 단계에서 바뀌지 않습니다.
- **검토**: 「검토 대기」 탭/루트에서 열면 AI → 저장값 → DENUE 순으로 병합. 칸마다 출처 배지(IA/DENUE/저장됨/없음). 「확정 후 저장」은 필수(청구 섹션 제외)가 비면 막힘. 저장 때 AI 값과 최종 값을 `prospect_crm_log` 에 함께 남김 → AI 정확도 추적 가능.
- **고객 연결**: 후보 상세에 RFC·전화·상호·위치 점수로 기존 고객 추천. 담당자는 「연결 요청」 → 디렉터 「연결 승인」 탭에서 승인(디렉터는 바로 연결). 승인되면 그 후보의 상담에 customer_id가 채워져 고객 이력에 보이고, 단계 → 고객등록 중. 고객이 승인 + 첫 게시 인보이스가 나가면 자동 → 신규고객.
- **신규고객 집계**: 이번 달 첫 인보이스가 나간 연결 고객만(원래 거래하던 고객은 연결돼도 신규로 안 셈). 신규매출 = 첫 인보이스 후 90일 이내 인보이스(IVA 제외).
- **지역 확대**: 다른 주 CSV를 같은 화면에서 올리면 cve_ent로 주를 인식. 지역은 주 + municipio(또는 CP 목록). 새 판을 다 올린 뒤 「이번 판에 없는 곳 표시」로 폐업 가능 표시(삭제 안 함).

## 검증(2026-11-25, 로컬 PostgreSQL 17)
- 전체 마이그레이션 0001~0334 새 DB에 적용 성공
- 통합 시나리오 34개 통과: 9,492행 가져오기(2초) · 재가져오기는 갱신만 · 지역 저장 시 Guadalupe 1,345곳 자동 배정 · 담당자는 본인 후보만 · 체크인 → 컨택·거리 33m·루트 연결 · AI 초안(모의 응답) → 검토 병합 → 필수 누락 시 확정 거부 → 확정 저장 · 고객 추천(90점) → 요청 → 승인 → 고객등록 중 → 첫 인보이스 → 신규고객 · 현황판 수치 일치 · 뒤로 되돌리기 거부
- 기존 테스트 회귀 없음: consult 31 · consult_upload_parts 15 · consult_quick 11 · consult_quick_visit 11 · consult_recovery 14 (실 DB)
- `node --test test/prospects.test.mjs` 13/13

## 남은 일 / 확인 필요
- **AI 초안 실제 품질**: 테스트는 모의 응답입니다. 첫 실제 방문 몇 건의 초안을 보고 `buildAltaPrompt` 문구를 다듬으세요.
- **고객 등록 화면 미리 채움**: 지금은 후보 상세의 「고객 등록용 값 복사」(erp_field 매핑) → 고객 등록 화면에 붙여넣기. refatrix-customers.html이 해시로 값을 받게 하면 버튼 한 번으로 열 수 있습니다(다음 단계).
- 30일 방치 기준·체크인 경고 거리(150m)는 코드 상수(`CHECKIN_WARN_M`, SQL `30 days`) — 바꾸려면 알려주세요.
- 녹음 고지(고객에게 녹음 안내)는 기존 고객상담 화면 정책을 따릅니다.
