# refatrix_relocate_v2 — 랙 유형 목록의 콤마 분리 (2026-08-27)

**백엔드 1 + 프런트 1** · 마이그레이션 없음 · `refatrix-relocate.html` **rel-0827a → rel-0827b**
현재 배포본(`c4a532e 창고 적치변경`) 위에 얹는 패치입니다.

## 무엇이 문제였나

위치변경 › 🏷 **랙 유형** 탭에서 `AA` 그룹 안에 `AA3-2, B2-2` 같은 줄이 있었습니다.

`products.rack_location` 한 칸에 **콤마로 여러 랙**이 적힌 제품이 있는데,
`GET /api/warehouse/racks` 가 그 문자열을 **랙 1개**로 묶고 있었습니다.
그룹은 맨 앞 글자로만 판정하니 `"AA3-2, B2-2"` 전체가 **AA 그룹 한 줄**로 들어간 것입니다.
(존 지정 화면은 2026-08-27 에 이미 고쳤는데, 이 라우트가 그 전 코드를 복사해 간 상태였습니다.)

## 무엇을 고쳤나

**`rackMoveRoutes.js`**
- 랙 목록 집계를 `regexp_split_to_table(rack_location, '[,\n\r]+')` 로 쪼갭니다 —
  **`zoneRoutes.splitRacks` 와 같은 구분자**. 제품 수는 `COUNT(DISTINCT p.id)`.
- **`replaceRackToken()` 신설** — 이동/되돌리기의 마스터 갱신에 적용.
  > ⚠ 기존에는 `rack_location` 을 도착 랙으로 **통째로 덮어써서**, `"AA3-2, B2-2"` 제품을
  > `AA3-2` 에서 옮기면 **`B2-2` 가 조용히 사라졌습니다.** 이제 옮긴 랙 자리만 갈아끼우고,
  > 출발 랙이 목록에 없으면 **마스터를 건드리지 않습니다**(추측 금지).
- `/scan` 응답에 `racks[]` 추가, 랙 유형은 **첫 랙** 기준(통짜 문자열로는 매칭이 안 됐습니다).

**`refatrix-relocate.html`** — `findRack()` 이 통짜 문자열이면 첫 랙으로 매칭(마스터 위치 유형 칩 복구).

## 배포 (마이그레이션 없음)

1. `refatrix-api/src/routes/rackMoveRoutes.js` → repo 같은 경로에 덮어쓰기
2. `refatrix-relocate.html` → repo **루트**
3. Commit / Push → Railway Success → Pages 1~2분 → **Ctrl+Shift+R**
   → 콘솔 `[refatrix-relocate] build rel-0827b`
   `npm run migrate` **불필요**

확인:
```
curl -s ".../main/refatrix-api/src/routes/rackMoveRoutes.js?nc=$(date +%s)" | grep -c regexp_split_to_table  # 1
curl -s ".../main/refatrix-api/src/routes/rackMoveRoutes.js?nc=$(date +%s)" | grep -c replaceRackToken       # 4
curl -s ".../main/refatrix-relocate.html?nc=$(date +%s)" | grep -c "rel-0827b"                               # 2
```

## 스모크

1. 위치변경 › 랙 유형 → `AA` 그룹에 `B2-2`·`C1-2`·`D2-3` 이 **없고**, 각각 `B`·`C`·`D` 그룹에 있는지.
2. 한 줄에 랙이 **하나씩만** 나오는지(콤마 있는 줄이 없어야 함).
3. `AA2-1` 제품 수가 3+1=4, `AA3-2` 가 4로 합산되는지.
4. 콤마로 여러 랙을 쓰는 제품을 스캔 → 유형 칩이 뜨는지.
5. **그 제품을 이동 → 제품 마스터 위치에 나머지 랙이 남아 있는지**(예: `AA3-2, B2-2` 에서
   `AA3-2` → `F1-1` 이동 후 `F1-1, B2-2`). 되돌리기하면 원래대로 돌아오는지.

## 테스트
```
cd test
node rack_kind_split.test.mjs   # 33/33 (npm i pg 필요)
bash rack_kind_sql.sh           # 실 PostgreSQL 16 — 스크린샷 값 그대로
```

## 참고 — 마이그레이션 번호 중복

`0187_inbound_warehouse_finish.sql` 과 `0187_rack_relocate.sql` 이 **둘 다 0187** 입니다.
`scripts/migrate.js` 가 **파일명 기준**으로 정렬·기록하므로 둘 다 정상 적용됩니다
(`inbound…` → `rack…` 순). 지금 문제는 없지만, 다음 마이그레이션은 0188 부터 쓰세요.
