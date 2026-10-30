# REFATRIX 핫픽스 · 2026-10-30 — 패킹리스트·박스 라벨: KIT 차종 · 구성품 제품명 · PRO 품목 설명

## ① 설명
디렉터 지시(2026-10-30): 패킹리스트에 KIT 번호만 나오고 KIT 제목(차종)이 없다 → 차종과 구성품 제품명을 보여 줄 것. 박스 라벨에도 차종 인쇄. PRO 로 시작하는 제품코드는 SYD 코드 대신 description 인쇄.
(키트 묶음·정렬은 지금처럼 **키트 번호 기준** — 차종은 제목으로만 붙는다.)

- **Lista de empaque**
  - 「Kits incluidos」 표: KIT · **Vehículo**(예: Nissan Versa 2012-2019) · Juegos · 구성품(**CTR + 제품명**, 수량 2 이상은 ×2)
  - 박스 안 KIT 머리줄: `KIT K0009 · Nissan Versa 2012-2019 · 1 juego · 5 pzas`
  - 박스 표 열: No. · CTR · **Código competidor / Descripción** · **Producto** · Cant.
    CTR 부품 = SYD + 제품명, **PRO 품목 = SYD 대신 설명**(Producto 칸은 비워 중복 방지)
- **박스 라벨(Etiquetas, jsPDF 실제 출력 경로 + HTML 폴백 둘 다)**
  - 헤더에 **`Vehículo: Nissan Versa 2012-2019 / …`**(그 박스에 든 키트 차종, 최대 2줄)
  - 표에 KIT 머리줄(`KIT K0009 · Nissan Versa 2012-2019`) → 구성품 → `Piezas sueltas` → 단품
  - **PRO 품목 = SYD 대신 설명** — 한 줄에 안 들어가면 같은 칸 두 줄로(뒷부분까지 출력)
  - 차종 줄이 늘어난 만큼 라벨 한 장의 줄 수를 자동으로 줄임(라벨 밖으로 넘침 없음). 키트가 다음 장으로 넘어가면 `(cont.)` 머리줄을 다시 붙이고, 머리줄이 장 끝에 홀로 남지 않게 함
- 같은 제목 표기를 **창고 포장지시 화면 머리줄**과 **Orden de surtido 「Kits en este pedido」**에도 맞춤(Vehículo 열)

## ② 배포단계
마이그레이션 없음.
1. 백엔드 — `refatrix-api/src/vioPromos.js`, `refatrix-api/src/routes/warehouseRoutes.js` 덮어쓰기 → Fetch/Pull → Commit/Push → Railway **Success**
2. 화면 — `refatrix-warehouse.html`, `refatrix-quotelist.html` (repo 최상위) → Commit/Push → 1~2분 → **Ctrl+Shift+R**
3. 탭 제목 확인: 창고 포장 `build 1030kitv` · 견적 목록 `ql-1030kitv`

## ③ 테스트방법
1. 창고 › 출고 대기 › Q-2026-0339 › **패킹리스트** → Kits incluidos 에 차종·구성품 제품명, PRO 줄에 설명(SYD 없음)
2. 같은 오더 **라벨 출력** → 키트 박스 헤더에 `Vehículo: …`, 표에 KIT 머리줄, PRO 줄에 설명
3. 창고 › 포장지시 Q-2026-0339 → 머리줄 `🧰 KIT K0009 Nissan Versa 2012-2019 · 1세트 · …`

## ④ 변경파일
| 저장소 경로 | 내용 |
|---|---|
| `refatrix-api/src/vioPromos.js` | 키트 구성품에 제품명(`name`) |
| `refatrix-api/src/routes/warehouseRoutes.js` | 출고 출력 API 박스 줄에 `product_name` |
| `refatrix-warehouse.html` | Lista de empaque · 라벨(PDF/HTML) · 포장지시 머리줄 차종 · build 1030kitv |
| `refatrix-quotelist.html` | Orden de surtido 키트 표 Vehículo 열 · ql-1030kitv |
| `refatrix-api/test/kit_packing_e2e.test.mjs` | 출고 API 제품명·차종·구성품 이름 검사 추가 |
| `refatrix-api/test/kit_packing_front.test.mjs` | 라벨(PDF·HTML)·PRO 설명·차종 표기 검사 |
| `refatrix-api/test/warehouse_pickmap_front.test.mjs` | 빌드 토큰 |
| `refatrix-api/test/quote_wa_front.test.mjs` | 빌드 토큰 |

## ⑤ 검증결과
- ESM `node --check` · 인라인 스크립트 문법 · pglast(변경 쿼리 2개) 통과
- 실 PostgreSQL 16: `kit_packing_e2e` 11/11 (출고 API 제품명·차종·구성품 이름 포함)
- jsdom: `kit_packing_front` 9/9 — 라벨 PDF 경로를 기록용 jsPDF 로 직접 그려 차종 줄·KIT 머리줄·PRO 설명·라벨 밖 넘침 없음·(cont.) 머리줄·머리줄 고아 방지까지 확인
- 실제 jsPDF 2.5.1 로 Q-2026-0339 형태 라벨 2장 생성·이미지 확인, Lista de empaque 는 Chromium A4 인쇄로 확인
- 관련 기존 시험 17묶음 재실행 통과

## ⑥ 결정사항
- 키트 묶음·정렬은 키트 번호 기준 유지, 차종은 제목으로 표시
- PRO 품목: 패킹리스트·라벨 모두 SYD 대신 제품 설명

## ⑦ 오픈이슈
- K0014 · K0016(같은 구성 Sportage 키트) 중복 정리 여부 — 미결

## ⑧ 다음액션
- 배포 후 실제 라벨 프린터로 Q-2026-0339 라벨 1장 시험 출력(두 줄 설명 글자 크기 확인)
