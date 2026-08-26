# 배포 안내 — 미팅 저장 오류 수정 + 고객 이름 검색 (v4, 2026-08-26)

**마이그레이션 있음(0185 · 0186)** · 환경변수 추가 없음
이 zip은 **v1~v3을 모두 포함**합니다. 어디까지 올리셨든 이것 하나만 올리면 됩니다.

## ① 「저장 실패: internal server error」 수정 (원인 확정)

미팅 계획 저장이 500 으로 죽던 원인은 **제 SQL 버그**였습니다.
INSERT 문에서 `CASE WHEN $18 THEN $19 ELSE NULL END` 를 썼는데, PostgreSQL 이 이 위치의 `$19` 를
**text 로 추론**해 `confirmed_by`(bigint) 컬럼에 넣지 못했습니다(오류 코드 42804).

- 값을 서버에서 미리 계산해 **평범한 파라미터로** 넘기도록 고쳤습니다 — 추론 여지가 없어집니다.
- **실제 PostgreSQL 16 을 띄워** 마이그레이션을 적용하고 이 INSERT 를 직접 돌려 확인했습니다.
  (기존 pg-mem 테스트는 타입 검사가 느슨해 이 오류를 못 잡았습니다 — 그래서 **진짜 Postgres 회귀 테스트**를 새로 붙였습니다.)
- 덤으로, **마이그레이션을 안 돌린 상태**면 이제 500 대신
  `전시회가 없습니다 / migration_required` 같은 안내가 뜹니다.

> 혹시 `npm run migrate` 를 아직 안 하셨다면 그것도 원인일 수 있습니다 — 아래 3번을 꼭 해주세요.

## ② 고객 이름으로 찾기

드롭다운에서 스크롤로 찾던 것을 **이름 일부를 쳐서** 찾을 수 있게 했습니다.

- 전시회 **새 미팅 등록**과 일반 **고객상담 등록** 두 곳 모두.
- **강세부호를 무시**합니다 — `agui` 로 `Refaccionaria El Águila` 가 찾아집니다.
- 결과가 **하나만 남으면 자동으로 선택**하고 업체명까지 채웁니다.
- 못 찾으면 `찾는 이름이 없습니다 — 「직접 입력」으로 업체명을 적어주세요` 안내가 뜹니다.

## 순서대로 하시면 됩니다

1. `refatrix_전시회_v4.zip` 을 **repo 최상위**에 풀어 덮어쓰기.
2. GitHub Desktop → **Commit → Push** → Railway 재배포 **Success** 확인.
3. Railway **APP Console** 에서 **`npm run migrate`** ← **이번엔 꼭 확인해 주세요** (0185·0186).
   화면에 `apply 0185_...` `apply 0186_...` 또는 `skip` 이 나오고 마지막에 `migrations complete` 가 떠야 합니다.
4. **Ctrl+Shift+R**.

## 배포 확인

```bash
B=https://raw.githubusercontent.com/sebastianham26-art/Refatrix/main
curl -s "$B/refatrix-consult.html?nc=$(date +%s)" | grep -c "b20260826ex4"                       # 1+
curl -s "$B/refatrix-api/src/routes/exhibitionRoutes.js?nc=$(date +%s)" | grep -c "confAt"       # 1+
```

## 테스트

1. 🎪 전시회 → 빈 칸 → 고객 검색칸에 `agu` 입력 → 목록이 줄고, 하나면 자동 선택되는지.
2. **[미팅 계획 저장]** → **오류 없이 저장되고** 시간표에 뜨는지. ← 이번 수정의 핵심
3. 저장한 미팅을 열어 **[✓ 약속 확정]** → `확정 ✓` 로 바뀌는지.
4. 빈 칸 → **[🚶 부스 방문]** → 저장 → 회색 칩 + 담당자 이름으로 뜨는지.
5. 일반 고객상담 → 「기존 고객 선택」 → 검색칸이 있는지.
