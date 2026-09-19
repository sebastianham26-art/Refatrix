# 카탈로그 조회 API — 엑셀 다운로드 (검증용) · 2026-09-19

고객에게 **실제로 나가는 그 카탈로그**를 디렉터가 직접 엑셀로 받아 검증하는 기능입니다.
미리보기(50건)가 아니라 **전 건**을, 고객이 받는 것과 **똑같은 값**으로 내려받습니다.

---

## 1. 무엇이 들어 있나

| 파일 | 성격 | 설명 |
|---|---|---|
| `refatrix-api/src/routes/catalogApiRoutes.js` | 교체 | `GET /clients/:id/export` 추가 |
| `refatrix-api/src/catalogPull.js` | 교체 | 대응품번 출처(`ref_source`)·제외 접두어·재고 구간 |
| `refatrix-api/test/catalog_pull.test.mjs` | 교체 | 시험 41건 (내보내기 2건 포함) |
| `refatrix-catalog-api.html` | 교체 | 「엑셀 다운로드」 단추 + 3개 시트 생성 |
| `migrations/0222_catalog_stock_range.sql` | 신규 | 재고를 구간으로 |
| `migrations/0223_catalog_exclude_prefixes.sql` | 신규 | PRO 제외 |
| `migrations/0224_catalog_ref_source.sql` | 신규 | 대응품번 출처 = 화면과 같은 `scode` |

`server.js` · `refatrix-nav.js` 는 **건드리지 않습니다**. 이미 `apply_catalog_api.mjs` 로 연결해 두셨습니다.

---

## 2. 배포 순서

```bash
# ① 백엔드 파일 교체 (위 4개 + migrations 3개를 같은 경로에 덮어쓰기)
git add -A && git commit -m "feat(catalog): 카탈로그 엑셀 내보내기 + 대응품번 출처 설정"
git push          # ← 푸시는 디렉터님이

# ② Railway 배포 뒤 마이그레이션
#    (서버가 기동하며 자동 적용됩니다. 수동 확인용:)
psql "$DATABASE_URL" -f refatrix-api/migrations/0222_catalog_stock_range.sql
psql "$DATABASE_URL" -f refatrix-api/migrations/0223_catalog_exclude_prefixes.sql
psql "$DATABASE_URL" -f refatrix-api/migrations/0224_catalog_ref_source.sql

# ③ 프런트 (GitHub Pages) — refatrix-catalog-api.html 교체
```

백엔드 → 마이그레이션 → 프런트 순서를 지켜 주십시오.

---

## 3. 쓰는 법

1. **연동관리 → 카탈로그 조회 API** 로 들어간다
2. 고객사(예: 멀티브랜드 비교 고객)를 고른다
3. **「엑셀 다운로드 — 고객이 받을 전체」** 를 누른다
4. `catalogo_<고객사>_2026-09-19.xlsx` 가 내려온다

---

## 4. 엑셀 시트 3개

**① 설정·요약** — 이 파일이 *어떤 설정으로* 뽑힌 것인지 함께 남깁니다.

- 생성 시각(멕시코) · 고객사 · 연결 고객 + 적용 할인율 · 제품 수
- 대응품번 출처 / 재고 표기 / 제외 접두어 / 단종품 정책 / 사진 주소 규칙
- 검증용 집계: 대응품번 없는 제품 수, 사진 없는 제품 수, 재질 미입력 수, 적용차종 없는 제품 수

**② 제품** — 1행 = 1제품
`codigo(CTR) · descripcion · activo · referencias(대응품번) · marcas · 대응품번 수 ·
aplicacionesTexto · 적용차종 수 · precioLista · precioCompra · moneda · ivaPorcentaje ·
existencia(재고구간) · material · posicionMontaje · imagenUrl · actualizado`

**③ 적용차종** — 1행 = 1차종 (분해가 제대로 됐는지 보는 시트)
`codigo(CTR) · marca · modelo · anioDesde · anioHasta · nota`

---

## 5. 안전장치 — 확인해 두실 점

- **디렉터 전용**입니다. 다른 권한으로는 403.
- 이 내려받기는 고객의 **접속창(토요일 05–09시)·주 1회 회차·호출 이력을 전혀 건드리지 않습니다.**
  즉, 평일 아무 때나 몇 번을 받아도 고객의 토요일 동기화에 영향이 없습니다.
- 감사 기록(`audit_log`)에는 `export` 로 남습니다 — 누가 언제 몇 건을 받았는지.
- 고객 키는 이 화면 어디에도 나오지 않습니다.
- 안전 상한 20만 건(1,000건 × 200쪽).

---

## 6. 무엇을 봐 주시면 되나

| 시트 | 보실 곳 |
|---|---|
| 설정·요약 | 「대응품번 출처」가 **제품찾기 화면과 같음 (SYD)** 인지 |
| 설정·요약 | 「제외 접두어」가 **PRO** 인지 → 제품 시트에 PRO 로 시작하는 코드가 한 건도 없어야 함 |
| 제품 | `marcas` 칸에 **BAW · MOOG · GROB 가 없어야** 함 (SYD 계열만) |
| 제품 | `precioCompra` = `precioLista × (1 − 할인율)` — 설정·요약의 할인율로 검산 |
| 제품 | `existencia` 가 `0 / 1-5 / 6-10 / 11-20 / 21-50 / 51-100 / 101+` 중 하나인지 |
| 제품 | `activo = NO (단종)` 인 것이 섞여 있는지 (계약대로 포함이 맞습니다) |
| 제품 | `imagenUrl` 을 하나 눌러 사진이 실제로 열리는지 |

---

## 7. 검증 결과

```
node --test test/catalog_pull.test.mjs   →  41 통과 / 0 실패
  38  ★ 엑셀용 전체 내보내기 — 고객이 받을 것과 같고, 접속창·회차를 건드리지 않는다
  39  전체 내보내기는 디렉터만
```
실제 PostgreSQL 16 으로 돌린 결과입니다.

---

## 8. 아직 남은 일 (디렉터님 결정 대기)

- `check_referencias.sql` 을 운영 DB 에서 한 번 돌려 두 출처의 규모 차이를 확인
- **웹카달록(CRM 제품 전송)** 에는 아직 PRO 제외가 걸려 있지 않습니다. 걸까요?
