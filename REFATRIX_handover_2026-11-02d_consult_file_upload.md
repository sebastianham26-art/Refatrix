# REFATRIX 인수인계 · 2026-11-02d · 고객상담 「📁 휴대폰 녹음파일 올리기」 + 전사 모델 오류 수정

빌드 토큰: `refatrix-consult.html` = **b20261102up1** · `refatrix-apikeys.html` = **b20261102sk1** · 마이그레이션 **0312**

## ① 설명

1. **휴대폰 녹음 파일로 전사·요약** — 영업 > 고객상담의 녹음 카드에 **[📁 휴대폰 녹음파일 올리기]** 버튼 추가.
   휴대폰 기본 녹음앱(삼성 음성녹음 · 아이폰 음성메모 · 통화녹음)으로 녹음한 파일을 고르면,
   화면 녹음과 똑같이 **전사 → 카테고리 분류 요약 → 펜딩 자동 등록**까지 처리된다.
   - 지원: m4a · mp3 · mp4 · wav · aac · amr · 3gp · ogg · opus · webm · flac · caf · wma · mov 등
   - 업로드는 기존 3MB 조각 전송·세션 만료 재로그인 경로를 그대로 쓴다(최대 200MB).
   - 서버가 **ffmpeg 로 16kHz 모노 Opus(ogg 32kbps) · 20분 구간**으로 변환한 뒤 Whisper 로 보낸다.
     실측: 1시간 128kbps m4a 55.7MB → 4.8MB × 3구간(변환 약 48초). 그래서 긴 파일도 25MB 한도에 안 걸린다.
   - ffmpeg 가 없어도 **m4a · mp3 · wav 24MB 이하**는 원본 그대로 전사된다(그 외는 화면이 올리기 전에 이유를 알려준다).
   - 녹음 카드에 `📁 파일명` 표시, 실패 사유는 한국어로.
2. **오늘 오류(stt: The model `sk-proj-…` does not exist) 원인·수정** — API 키 화면의 **「전사 모델」(VISIT_STT_MODEL, 평문 칸)** 에
   OpenAI 키가 들어가 있었다. 서버가 키를 **모델명으로** 보내 OpenAI 가 거절했고, 그 오류문(키 일부 포함)이 화면에 찍혔다.
   - 모델명 칸 값이 키처럼 생겼거나 모델명이 아니면 **자동으로 whisper-1** 사용(상담·방문 녹음 둘 다).
   - 외부 오류문 속 `sk-…` 는 가려서 저장·표시.
   - API 키 화면: 평문 칸에 키를 **저장 못 하게** 막고, 이미 들어가 있으면 가린 채 「⚠ 키가 잘못 들어감」 경고.

## ② 배포단계 (순서 지킬 것)

1. **Railway Variables** 에 `RAILPACK_DEPLOY_APT_PACKAGES` = `ffmpeg` 추가 (긴 파일·amr/3gp 변환용).
2. GitHub Desktop: **Fetch/Pull** → 백엔드 파일 복사 → Push → Railway **Success** 확인.
3. Railway 콘솔 `npm run migrate` (0312).
4. 프런트 2개 파일 Push → 화면 `Ctrl+Shift+R` → 탭 제목에 `b20261102up1` 확인.
5. **API 키 화면(관리 › 외부 서비스 키) → OpenAI**:
   - 「전사 모델」 칸에 `-` 한 글자 입력 후 저장 → 비워짐(= whisper-1).
   - 키가 평문 칸에 저장·노출돼 있었으므로 **OpenAI 콘솔에서 기존 키 폐기 → 새 키 발급 → 「API 키」 칸에 저장** 권장.
6. 오늘 실패한 녹음은 녹음 카드의 **[↻ 재시도]** 로 다시 처리(실패 건은 오디오가 남아 있다).

## ③ 테스트방법

1. 휴대폰으로 상담 화면 → 상담 선택 → **[📁 휴대폰 녹음파일 올리기]** → 녹음앱 파일 선택.
2. 「✔ 올리기 완료 — 서버가 변환 → 전사 → 요약…」 → 2~10분 뒤 카드가 `✅ 완료 · 📁 파일명` 으로 바뀌고 요약·펜딩이 보이면 정상.
3. 1시간 넘는 m4a 를 올려 완료되면 ffmpeg 설치까지 정상. `ffmpeg 가 없어…` 문구가 나오면 ②-1 변수 확인.

## ④ 변경파일

| 레포 경로 | 구분 | 내용 |
|---|---|---|
| `refatrix-api/src/sttModel.js` | 신규 | 전사 모델명 방어 · 오류문 키 가리기 |
| `refatrix-api/src/audioConvert.js` | 신규 | ffmpeg 찾기 · 휴대폰 형식 → ogg/opus 20분 구간 변환 · 파일 형식 판별 |
| `refatrix-api/src/routes/consultRoutes.js` | 수정 | commit `source:'file'` · 큐에서 변환 후 전사 · `GET /api/consults/recordings/capabilities` · 목록에 source/file_name · 모델 방어 |
| `refatrix-api/src/routes/visitRecRoutes.js` | 수정 | 방문 녹음도 같은 모델 방어 · 키 가리기 |
| `refatrix-api/src/secrets.js` | 수정 | 평문 칸 키 저장 차단 · 기존 오입력 가림 + `misplaced_key` |
| `refatrix-api/migrations/0312_consult_rec_file_upload.sql` | 신규 | `sales_consult_recordings` + `source` · `file_name` · `converted_at` |
| `refatrix-api/test/consult_file_upload.test.mjs` | 신규 | 단위 + 실제 ffmpeg + pg-mem 큐 |
| `refatrix-api/test/consult_file_upload_front.test.mjs` | 신규 | 실제 Chromium 화면 테스트 |
| `refatrix-consult.html` (레포 루트) | 수정 | 📁 버튼 · 사전 점검 · 조각 업로드 · 카드 표시 (b20261102up1) |
| `refatrix-apikeys.html` (레포 루트) | 수정 | 「⚠ 키가 잘못 들어감」 경고 (b20261102sk1) |

npm 의존성 추가 없음(package.json · lock 불변).

## ⑤ 검증결과

- `node --check` 백엔드 5파일 · 상담 화면 스크립트 통과
- pglast: 0312 + 신규/변경 SQL 5건 파싱 통과
- 단위/pg-mem: 신규 17건 + 기존 상담·조각·복구·방문 녹음 테스트 **98건 중 실패 0** (skip 14 = 기존)
- 실제 ffmpeg: m4a·mp3·wav·3gp 50초 → 3구간 ogg(각 구간 단독 재생 확인), 1시간 m4a 55.7MB → 4.8MB×3, 손상 파일 거절, ffmpeg 없음 처리
- 실제 Chromium(390px 휴대폰 폭): 7MB m4a 3조각 → 원본과 바이트 동일 · commit 내용 · 사전 차단 3종 · 마이그레이션 전 안내 · 카드 표시 · 페이지 오류 0 — **7/7**
- 실제 PostgreSQL 16 E2E: 조각 → commit → 큐(실제 ffmpeg 변환) → done · 펜딩 1건 · 오디오 폐기 · 목록 source/file_name, 기존 webm 경로 `rec` 불변 — **2/2**
- 0312 두 번 적용해도 오류 없음(IF NOT EXISTS)
- 참고: 기존 `service_secrets.test.mjs` C3 · `consult_recovery_front.test.mjs`(로그인 게이트 이전 가짜 토큰) 실패는 **main 원본에서도 동일** — 이번 변경과 무관

## ⑥ 결정사항

- 변환은 **서버(ffmpeg)** 에서 한다. 휴대폰 브라우저에서 디코딩하면 긴 파일이 메모리 부족으로 죽는다.
- 원본 파일은 휴대폰에 남으므로 화면(IndexedDB)에 따로 보관하지 않는다.
- 변환은 처리 큐에서 1회만(`converted_at`) — 전사 재시도 때 다시 변환하지 않는다.
- 모드(미팅 전체 / 음성 메모)는 녹음 카드에서 고른 값을 그대로 쓴다.

## ⑦ 오픈이슈

- Railway 에 ffmpeg 가 설치되기 전에는 24MB 넘는 파일·amr/3gp 는 전사 불가(화면이 사전 안내).
- 원본 상한 200MB(`CONSULT_FILE_MAX_MB` 로 조정). 녹음 1건 최대 4시간 규칙은 그대로.
- 방문(영업활동) 화면에는 파일 올리기를 넣지 않았다 — 필요하면 같은 방식으로 확장 가능.

## ⑧ 다음액션

1. ②의 1~6 순서대로 배포 · OpenAI 키 교체.
2. 영업팀(Oscar · Armando 등)에게 "휴대폰 녹음앱으로 녹음 → 상담 화면에서 📁 올리기" 사용법 공유.
