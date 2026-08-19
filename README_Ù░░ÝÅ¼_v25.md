# v25 — 원가 정합 프런트 재작성본 (2026-08-19 저녁, 라이브 main 538bb8e 기준)

## 왜 다시 만들었나
어제 v24의 **백엔드는 이미 라이브에 정상 배포**되어 있습니다(수입입고 회계 b60ad41 + 비활성화 재게 30e31fd — 두 작업 공존 확인, 실 PG 테스트 15/15 통과).
사라진 것은 **프런트 2개 파일**뿐입니다:
- refatrix-import.html — 라이브가 아직 imp-0818g (v24의 오더번호 기능이 배포된 적 없음)
- refatrix-products.html — 비활성화 세션의 pj0819act1 로 덮여 v24의 "원가 미반영" 배지가 빠짐

이 zip 은 **현재 라이브 main 을 그대로 베이스로** 다시 만든 것이라, 덮어써도 비활성화 기능·고객상담·영업팀 기능이 지워지지 않습니다.

## 배포 (프런트 2개만, 백엔드/마이그레이션 불필요)
1. 저장소 루트에 덮어쓰기:
   - refatrix-import.html  (build **imp-0819b** — 오더번호(참조) 칸 + (ORDER NO×CTR NO) 인보이스 매칭 + 주황 점선 경고)
   - refatrix-products.html (build **pj0819act2** — 비활성화 기능 그대로 + 원가분석에 "원가 미반영·반려/대기" 배지·오더번호·제외 건수)
2. Commit → Push → 1~2분 후 Ctrl+Shift+R.
3. 확인: 탭 제목에 imp-0819b / pj0819act2. GitHub Desktop diff 에서 **삭제 줄이 비정상적으로 많지 않은지** 한 번 확인(스테일 베이스 사고 방지).

## 배포 후 원가분석 읽는 법
- 회색 배지 "원가 미반영 · 반려됨/승인 대기" 카드 = 화면에는 남지만 평균원가 계산에서 빠진 배치.
- 배지 없이 값이 다 찬 카드만 평균원가에 들어갑니다.
- 카드가 아예 없다면(“수입 입고 이력이 없어…”) 배치가 삭제된 것 → 동봉한 진단 SQL 로 확인.

## 진단 SQL (Railway 콘솔 → psql) — 원가분석에서 내용이 "사라진" SKU 확인용
아래에서 CE0536L 을 해당 코드로 바꿔 실행:
```sql
-- ① 이 SKU 의 모든 수입 라인(삭제 포함): status / deleted_at 이 답을 알려줍니다
SELECT b.id batch, b.batch_no, b.status, b.deleted_at, b.exclude_from_cost,
       il.qty, il.import_price, il.unit_cost_mxn, il.po_ref
  FROM import_lines il JOIN import_batches b ON b.id=il.batch_id
  JOIN products p ON p.id=il.product_id
 WHERE p.code='CE0536L' ORDER BY b.id;

-- ② 그 배치들의 부대비용(설정하신 내용이 남아있는지)
SELECT o.batch_id, b.batch_no, b.status, b.deleted_at, o.label, o.amount, o.currency
  FROM import_overheads o JOIN import_batches b ON b.id=o.batch_id
 WHERE o.batch_id IN (SELECT il.batch_id FROM import_lines il
        JOIN products p ON p.id=il.product_id WHERE p.code='CE0536L');
```
해석:
- deleted_at 이 채워진 배치 → 삭제된 것. 복원하려면 알려주세요(복원 API 가 이미 서버에 있고, 원하시면 복원 버튼 UI 를 만들어 드립니다).
- status='rejected'/'pending' → 데이터는 그대로, 화면에서 회색 배지로 보이고 평균원가에서만 제외(정상 동작).
