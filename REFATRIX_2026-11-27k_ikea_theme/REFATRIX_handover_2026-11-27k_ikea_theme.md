# REFATRIX 인수인계 2026-11-27k · ERP 전 화면 공통 디자인 (IKEA 톤 · 「차종으로 제품찾기」 기준)

## ① 설명
- 「차종으로 제품찾기」(refatrix-vehiclemap.js) 디자인을 기준으로 ERP 전 화면을 하나의 디자인으로 통일했습니다.
  - 흰 바탕 · 회색 면(#F5F5F5) · 얇은 회색 선(#DFDFDF) · 검정 글자(#111) / 보조 글자(#484848)
  - 주 색 = 파랑 #0058A3 (기본 버튼 · 선택된 탭 · 제목줄) · 강조 = 노랑 #FFDB00 (gold 버튼 · 포커스 · 선택 행)
  - 알약 버튼(둥근 64px) · 카드/입력칸 4px 각진 모서리 · 그림자 없음 · 글꼴 Noto Sans KR
  - 표: 회색 머리글 + 검정 굵은 밑줄 · 입력칸: 회색 테두리 + 파랑 포커스
- 방식: 새 공통 파일 `refatrix-theme.css` 하나를 각 화면 `</head>` 바로 앞(화면 자체 스타일 뒤)에 연결.
  화면들이 쓰는 같은 색 이름(--brand, --paper, --line, --gold, --radius …)을 덮어써서 화면 코드를 고치지 않고 색·모양만 바뀝니다.
  각 화면 `<style>` 안의 옛 진녹색(#143D34)·베이지 색 값도 새 색으로 바꿨습니다(색 값만 바뀜 — 구조·JS 변경 없음, 검증 ⑤).
- **스페인어 자동번역 안전장치**(테마에 포함 — i18n.css 가 없던 25개 화면에도 적용):
  - 버튼·탭·제목·라벨·안내문은 길어지면 줄바꿈(가로로 넘치지 않음), 탭 줄은 다음 줄로 넘김
  - 표 머리글은 세로로 줄바꿈, 데이터 셀은 단어 단위 줄바꿈(숫자·코드·날짜는 공백이 없어 안 끊김)
  - 긴 선택지(option)가 생긴 select·입력칸 묶음이 부모 칸 밖으로 밀지 않음
- 바꾸지 않은 것: 상단 메뉴(CTR 레드 헤더) · 견적서/수령증 등 인쇄·PDF 문서 색 · 프로모션 이미지(캔버스) · 엑셀 색 · 커미셔너 안내서(guia — 자체 문서 디자인 유지).
- `refatrix-nav.js`: 화면에 테마 링크가 없으면 자동으로 붙임(앞으로 새로 만드는 화면도 같은 디자인). 버전 20261127th.

## ② 배포 단계 (프론트엔드만 · 백엔드/마이그레이션 없음)
1. GitHub Desktop → Fetch/Pull (최신 받기)
2. `REFATRIX_2026-11-27k_ikea_theme_FRONTEND.zip` 압축을 풀어 **레포 루트**에 덮어쓰기 (68개 파일, 아래 ④ 표)
3. Commit → Push (GitHub Pages)
4. 1~2분 후 ERP 에서 `Ctrl+Shift+R`
5. 브라우저 탭 제목 대신 콘솔(F12)에 `[refatrix-nav] v20261127th loaded (1127k 공통 디자인…` 가 보이면 배포 완료

되돌리기: 이 폴더의 `ROLLBACK_before_theme.tgz`(변경 전 원본 전체)를 풀어 덮어쓰면 원래대로 돌아갑니다.

## ③ 테스트 방법
1. 포털 → 아무 화면 몇 개(견적 작성, 견적·매출 추적, 고객, 가격마스터, WBR, 창고) — 흰 바탕 · 파랑 알약 버튼 · 회색 머리글 표인지 확인
2. 크롬 주소창 오른쪽 번역 아이콘 → 「스페인어」 번역 → 같은 화면에서 버튼·탭·표 머리글이 칸 밖으로 넘치거나 겹치지 않는지 확인
3. 휴대폰(또는 크롬 F12 → 기기 모드 390px)에서 같은 확인
4. 「제품 찾기 → 🚗 차종으로 제품찾기」 화면은 기준 디자인 그대로인지 확인
5. 견적서 인쇄/PDF, 커미션 수령증 인쇄가 예전과 같은 색인지 확인(바꾸지 않음)

## ④ 변경 파일 (모두 레포 루트)
| 레포 경로 | 변경 |
|---|---|
| `refatrix-theme.css` | **신규** — 공통 디자인 (build th20261127k) |
| `refatrix-nav.js` | 테마 링크 자동 보충 `loadTheme()` · 버전 20261127th |
| `refatrix-acuerdo-comision.html` `refatrix-apikeys.html` `refatrix-approval.html` `refatrix-board.html` `refatrix-budget.html` `refatrix-cashdaily.html` `refatrix-catalog-api.html` `refatrix-commission.html` `refatrix-company.html` `refatrix-consult.html` `refatrix-crmsync.html` `refatrix-customers.html` `refatrix-daily.html` `refatrix-dashboard.html` `refatrix-devrequest.html` `refatrix-fieldsurvey.html` `refatrix-finance.html` `refatrix-finder.html` `refatrix-fsanalysis.html` `refatrix-funnel.html` `refatrix-grossprofit.html` `refatrix-import.html` `refatrix-importcost.html` `refatrix-inbound.html` `refatrix-integrations.html` `refatrix-leadassign.html` `refatrix-login.html` `refatrix-marketing.html` `refatrix-metaleads.html` `refatrix-mktspend.html` `refatrix-orderfunnel.html` `refatrix-pipeline.html` `refatrix-portal.html` `refatrix-pricemaster.html` `refatrix-process-kpi.html` `refatrix-products.html` `refatrix-prospects.html` `refatrix-purchase.html` `refatrix-purchasereview.html` `refatrix-quote.html` `refatrix-quotelist.html` `refatrix-rackstock.html` `refatrix-recost.html` `refatrix-relocate.html` `refatrix-reservations.html` `refatrix-rnr-roles.html` `refatrix-rnr.html` `refatrix-sales.html` `refatrix-salesperf.html` `refatrix-salestrend.html` `refatrix-settlement.html` `refatrix-shortage.html` `refatrix-stock.html` `refatrix-stockcount.html` `refatrix-survey.html` `refatrix-targets.html` `refatrix-users.html` `refatrix-viofinder.html` `refatrix-wapromo.html` `refatrix-warehouse.html` `refatrix-wasched.html` `refatrix-wbr.html` `refatrix-whmap.html` `refatrix-zones.html` | 64개 화면: `</head>` 앞 테마 링크(+ Noto Sans KR 글꼴), `<style>` 안 옛 녹색·베이지 색 값 교체, nav 버전 |
| `refatrix-guia-comisionista.html` `refatrix-stock-test.html` | nav 버전 문자열만 (디자인 변경 없음) |

## ⑤ 검증 결과
- 구조 무변경 확인: 64개 화면 각각 「추가한 head 블록 제거 + 색 값(#RRGGBB) 정규화」 후 원본과 **완전히 같음** → 바뀐 것은 색 값과 링크뿐
- 인라인 스크립트 `node --check`: 변경 전 0건 오류 → 변경 후 0건 오류 (전 화면) · `refatrix-nav.js` `node --check` 통과
- Playwright(크로미움) 65개 화면 × 변경 전/후 실제 로드 — 디렉터 세션 + API 모의응답:
  - 한글을 스페인어 길이(음절당 2.7자 / 강하게 4.2자)로 바꾼 뒤 「칸 밖으로 넘친 글자」「잘린 글자」「가로 스크롤」 측정
  - PC 1366px: 변경 전/후 모두 0 (늘어난 곳 없음)
  - 휴대폰 390px: **변경 후가 같거나 더 적음** — fsanalysis 가로넘침 74→0px, settlement 60→0px, marketing 36→23px, pricemaster·wapromo 넘침 글자 1~2→0
- nav 테마 보충: 링크 없는 화면(stock-test)에 자동 적용 · guia 는 적용 안 됨 · 이미 링크 있는 화면은 중복 안 됨(1개)
- 한계: 모의응답이라 데이터 행이 비어 있는 상태로 검사함 → 실제 데이터가 찬 표는 ③-2 로 한 번 확인 필요

## ⑥ 결정사항
- 기준 디자인 = 「차종으로 제품찾기」(파랑 #0058A3 · 노랑 #FFDB00 · 흰 바탕 · 알약 버튼 · 4px 카드)
- 상단 메뉴는 CTR 레드 그대로 둠(기준 화면도 이 메뉴 아래에 있음)
- 고객에게 나가는 인쇄물·PDF·프로모션 이미지·엑셀 색은 바꾸지 않음
- 커미셔너 안내서(guia-comisionista)는 자체 문서 디자인 유지
- 빨강 삭제 버튼 등 화면이 따로 정한 색 버튼은 그 색 유지(모양만 알약)

## ⑦ 오픈 이슈
- JS 로 그리는 일부 그래프 선·배지에 옛 녹색(#143D34)이 남아 있음(현금흐름·수주추이·마진 그래프 등) — 인쇄물과 같은 코드에 섞여 있어 이번엔 손대지 않음
- 화면마다 고정 폭(px)을 직접 준 일부 칸은 스페인어로 아주 길어지면 줄바꿈으로 높이가 늘어날 수 있음(넘치지는 않음)

## ⑧ 다음 액션
- 배포 후 실제 데이터 화면(견적·매출 추적, 가격마스터, WBR, 커미션)을 스페인어 번역으로 훑어보고 어색한 화면 알려주시면 해당 화면만 다듬기
- 원하시면 상단 메뉴도 같은 톤(평면 · 그라데이션 제거)으로 맞추기, 그래프 녹색 → 파랑 정리
