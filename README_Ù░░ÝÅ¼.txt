Refatrix — 견적 엑셀 수량열 4종 분리 (빌드 qt0901veh2)
=====================================================
이 zip 을 repo 루트에 그대로 풀어 덮어쓰면 됩니다.

포함 파일
  refatrix-quote.html                              ← 프런트 (루트)
  refatrix-api/src/routes/quoteRoutes.js           ← 백엔드
  REFATRIX_handover_2026-09-01b_quote_qty_columns.md  ← 인수인계서

배포 순서 (백엔드 먼저 — 반쪽배포 금지)
  1) quoteRoutes.js push  → Railway 자동 재배포 완료 확인 (마이그레이션 없음)
  2) refatrix-quote.html push → GitHub Pages 배포 (1~2분)
  3) 견적 화면 Ctrl+Shift+R → 탭 제목 끝이 qt0901veh2 인지 확인

바뀐 것
  En tránsito 가 v_backorder(발주 미입고 전체)를 쓰고 있어 실제보다 컸음 → 둘로 분리
  G Existencia(현재고) · H Disponible(현재고−타견적 예약) · I En tránsito(선적됨) · J En producción(발주 미선적)
  이후 K Cantidad · L Precio Lista · M c/Desc · N Importe · O(숨김) Principal
  En tránsito + En producción = 예전 값과 동일 (합은 보존, 정의만 분리)

인수인계서 전문은 Claude 프로젝트 문서 claude/REFATRIX_handover_2026-09-01b_quote_qty_columns.md 참조.
