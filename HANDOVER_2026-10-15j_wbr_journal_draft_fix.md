# REFATRIX 핸드오버 2026-10-15j — WBR 「나의 기록으로 초안 만들기」 ai_empty 오류 수정 (build wbr-1015j)

## ① 설명
증상: 「기록에서 이슈로 정리할 내용을 찾지 못했습니다」(ai_empty).
이 메시지는 "기록이 부족하다"는 뜻이 아니라 **AI 응답을 JSON으로 읽지 못한 모든 경우**에 나오고 있었음.
- 원인 1: `max_tokens 3000` — 한국어 불릿 수십 개(조직 5 × 최대 14개)를 쓰다 출력이 잘려 JSON이 깨짐 → `parseDraft` null → ai_empty. 기록이 많은 주일수록 잘 남.
- 원인 2: 자유 텍스트 JSON — 문장 안 따옴표(`15"`, `"Autozone"`)가 이스케이프 안 되면 파싱 실패.

수정:
- Anthropic **도구 호출(tool_use) + 스키마 강제**(`submit_wbr_draft`) — 응답이 항상 유효한 객체로 옴(따옴표 문제 제거).
- `max_tokens` 3000 → 8000, 타임아웃 120s → 180s, 프롬프트에 전체 불릿 45개 상한.
- 오류 구분: `ai_truncated`(출력 한도 잘림) / `ai_parse`(형식 못 읽음) / `ai_empty`(정상 응답인데 항목 0개). 화면 문구도 각각 표시.
- 텍스트 JSON 응답도 계속 받음(하위호환).

## ② 배포단계
1. GitHub Desktop Fetch/Pull → 아래 파일 교체 → 백엔드 push
2. Railway Success 확인 (마이그레이션 없음)
3. `refatrix-wbr.html` push → Ctrl+Shift+R → 탭 제목 `build wbr-1015j` 확인

## ③ 테스트방법
WBR → 「📝 나의 기록으로 초안 만들기」 → 검토 패널이 열리는지. 실패 시 이제 원인별 문구가 나옴.

## ④ 변경파일
| 파일 | 경로 |
|---|---|
| wbrRoutes.js | `refatrix-api/src/routes/wbrRoutes.js` |
| wbrJournalDraft.js | `refatrix-api/src/wbrJournalDraft.js` |
| refatrix-wbr.html | `refatrix-wbr.html` (repo root) |
| 테스트 3개 | `refatrix-api/test/wbr_journal_draft.test.mjs`, `..._api.test.mjs`, `..._front.test.mjs` |

## ⑤ 검증결과
node --check 통과 · 실 PostgreSQL 16 (마이그레이션 0277까지) + app.inject + jsdom: WBR 관련 5개 테스트 파일 67/67 통과.
신규: 도구 응답(따옴표 포함) 성공 · 요청에 tool_choice/max_tokens≥8000 확인 · 잘림→ai_truncated · 잘렸어도 도구 입력 완성 시 성공 · 형식불가→ai_parse · 빈 결과→ai_empty.
SQL 변경 없음.

## ⑥ 결정사항
없음 (버그 수정).

## ⑦ 오픈이슈
- 실제 원인이 1·2 중 무엇이었는지는 배포 후 오류 문구로 확인 가능. 모델 `claude-sonnet-4-5-20250929`(env `WBR_DRAFT_MODEL`로 교체 가능).

## ⑧ 다음액션
배포 후 이번 주 기록으로 1회 실행.
