# REFATRIX 인수인계 · 2026-10-23 · 전자결재 증빙 — 동영상(mp4) 업로드 · 마케팅 자료 — build b20261023va

## ① 설명
**증상**: 전자결재 증빙에 mp4가 올라가지 않음.
**원인**: 서버 허용 확장자에 동영상이 없었다(bad_type). 화면의 파일 선택 창도 문서·이미지만 보여 줬고, 한도는 모든 파일이 20MB였다.
**변경**
- 동영상 **mp4 · mov(아이폰) · m4v · webm** 허용. 파일당 **50MB**까지. 다른 형식은 지금처럼 20MB.
- 증빙 종류에 **「마케팅 자료」** 추가. 동영상을 고르면 자동으로 「마케팅 자료」로 잡힌다(바꿀 수 있음).
- 증빙·댓글·추가 작성·집행 업로드 모두 같은 규칙. 「열기」를 누르면 브라우저에서 바로 재생된다.
- 동영상 아이콘(보라)과 한도 문구(「파일당 20MB · 동영상 50MB」)를 표시. 한도를 넘으면 「한도를 넘어 제외」라고 알려 준다.
- 마이그레이션 없음.

## ② 배포단계
1. 백엔드 푸시 — `refatrix-api/src/approval.js`, `src/routes/approvalRoutes.js`, 테스트 4개
2. Railway **Success** (migrate 불필요)
3. 프런트 푸시 — `refatrix-approval.html`
4. `Ctrl+Shift+R` → 탭 제목 **`전자결재 · b20261023va`**

## ③ 테스트방법
1. 문서 상세 → 「증빙 추가」 → mp4(20MB 이상도) 선택 → 종류가 「마케팅 자료」인지 → 등록
2. 「열기」 → 새 탭에서 재생되는지
3. 50MB를 넘는 영상 → 「한도를 넘어 제외」 안내
4. 휴대폰(아이폰 mov)에서도 올라가는지

## ④ 변경파일
| 구분 | 레포 경로 | 상태 |
|---|---|---|
| 백엔드 | `refatrix-api/src/approval.js` | 수정 — 동영상 확장자·50MB·「마케팅 자료」·업로드 bodyLimit(약 69MB) |
| 백엔드 | `refatrix-api/src/routes/approvalRoutes.js` | 수정 — 오류 응답 max_bytes를 형식별로 |
| 테스트 | `refatrix-api/test/approval.test.mjs` | 수정 — 동영상 규칙 + 실제 30MB mp4 업로드·내려받기 |
| 테스트 | `approval_front` · `approval_finance_front` · `commission_approval_front` | 수정(빌드 토큰 · nav 토큰 형식 검사) |
| 프런트 | `refatrix-approval.html` (루트) | 수정 — 파일 선택에 동영상, 50MB 한도, 아이콘·문구 |

## ⑤ 검증결과
| 단계 | 결과 |
|---|---|
| node --check | 변경 JS + HTML 인라인 스크립트 통과 |
| 규칙 | mp4·mov·webm·m4v MIME · 21MB mp4 허용 · 정확히 50MB 허용 · 50MB+1 거부 · PDF 21MB 거부(20MB 유지) · 「마케팅 자료」 추정 |
| 실제 PostgreSQL E2E | 30MB mp4 업로드 200 → kind·MIME·크기 저장 → 내려받기 `video/mp4`, 원본 크기 같음 · 50MB 초과 거부 |
| 회귀 | approval 24/24 · approval_front 2/2 · approval_finance 3/3 · approval_finance_front 2/2 · commission_approval_front 2/2 · 새 DB 2개 반복 |
| 참고 | `approval_front` F0의 nav 토큰 고정(20261016wp)이 이미 깨져 있었음(nav가 20261021lg) → 날짜+문자 형식 검사로 바꿈 |

## ⑥ 결정사항
- 전자결재에 동영상(mp4)을 마케팅 증빙으로 올릴 수 있다(디렉터 2026-10-23).
- (구현 판단) 동영상은 파일당 50MB, 형식은 mp4·mov·m4v·webm. 다른 파일은 20MB 유지.

## ⑦ 오픈이슈
- 50MB 넘는 긴 영상(휴대폰 1080p 1분 ≈ 100MB)은 압축하거나 링크(YouTube·Drive 등)를 댓글로 남긴다. 더 큰 영상이 자주 필요하면 별도 저장소(R2 등)로 옮기는 방식을 검토한다.
