refatrix_20260902_ar_paid_eps.zip  (2026-09-02)

■ 푸는 위치
  레포 최상위 폴더(refatrix-api 와 refatrix-settlement.html 이 함께 있는 폴더)에서
  "여기에 압축 풀기" → 경로 그대로 덮어쓰기 됩니다.

■ 들어있는 것 (16개)
  백엔드 11 · 프런트 3 · 신규 테스트 1 · 인수인계 문서 1
  ※ 마이그레이션 파일 없음 → npm run migrate 불필요

■ 배포 순서
  1) 압축 해제(덮어쓰기)
  2) GitHub Desktop → Commit → Push
  3) Railway 자동 재배포 → Deployments 가 Success 인지 확인
  4) GitHub Pages 1~2분 대기 → 수금/정산·영업실적·고객 화면에서 Ctrl+Shift+R
     (nav 마커가 v20260902eps 로 바뀌면 반영된 것)

■ 배포 후 꼭 할 일 — RECAR folio 31 재반제 (코드로는 복구되지 않습니다)
  수금/정산 → 미배분 입금 인박스
   → 2026-08-26 · BBVA · 24,005 · ryo_recar 행 [이 입금으로 반제]
   → 아래 목록에서 folio 31 [반제] → 카트에 담기
   → [저장 · 통지 닫기]
  결과: folio 31 완납 · 통지가 인박스에서 사라짐 · 잔여 0.47 은 선수금으로 확정

■ 확인 포인트
  - LUEMI folio 25 가 「완납」으로 바뀌고 미수 목록에서 빠지는지 (LUEMI 건수 4 -> 3)
  - folio 29(연체 6일) · 30(연체 5일) · 34(D-23) 은 그대로인지 (회귀 확인)
  - 선수금(과입금) 카드에 0.5 미만 센타보 건이 더 이상 뜨지 않는지

자세한 내용은 같이 들어있는 REFATRIX_handover_2026-09-02_ar_paid_eps_recar.md 참고.
