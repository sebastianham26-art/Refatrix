# REFATRIX 핫픽스 · 2026-11-02e · 전사 길이 상한 → whisper-1 자동 폴백

## ① 설명
오류: `stt: audio duration 2559.08 seconds is longer than 1400 seconds which is the maximum for this model`
- 「전사 모델」이 **gpt-4o-transcribe / gpt-4o-mini-transcribe** 로 설정돼 있으면 구간 하나가 **1400초(≈23분)** 를 넘을 때 OpenAI 가 거절한다.
  (whisper-1 은 길이 상한이 없고 25MB 한도만 있다.)
- 42분짜리 구간이 그대로 간 경우: ffmpeg 설치 전 원본 그대로 보낸 휴대폰 파일(m4a 24MB 이하), 또는 아이폰 사파리 녹음(mp4, 서버가 못 자름).
- 수정: 길이 상한 오류가 오면 **같은 구간을 whisper-1 로 한 번 더 보내** 이어서 처리한다. 상담 녹음·방문 녹음 공통.
  다른 오류는 폴백하지 않고, 이미 whisper-1 이면 재시도하지 않는다.

## ② 배포단계
1. Fetch/Pull → 아래 3개 파일 Push → Railway Success. (마이그레이션 없음 · 화면 변경 없음)
2. 실패한 녹음 카드에서 **[↻ 재시도]**.
3. 권장: API 키 화면 「전사 모델」은 비워 두기(= whisper-1). 스페인어 상담 녹음은 whisper-1 로 충분하다.
4. Railway `RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg` 가 아직이면 추가 — 변환되면 구간이 20분으로 잘려 이 상한에 애초에 걸리지 않는다.

## ③ 테스트방법
실패했던 녹음에서 [↻ 재시도] → `✅ 완료` 로 바뀌면 정상.

## ④ 변경파일
| 레포 경로 | 구분 |
|---|---|
| `refatrix-api/src/sttModel.js` | 수정 (`isDurationLimitError`) |
| `refatrix-api/src/routes/consultRoutes.js` | 수정 (`sttOnce` 분리 + 폴백) |
| `refatrix-api/src/routes/visitRecRoutes.js` | 수정 (동일) |
| `refatrix-api/test/consult_file_upload.test.mjs` | 수정 (폴백 테스트 3건) |

## ⑤ 검증결과
- `node --check` 통과 · 상담/조각/복구/방문 녹음 + 신규 테스트 101건 중 실패 0 (skip 14 = 기존)
- 폴백: gpt-4o-transcribe 거절 → whisper-1 성공 / 다른 오류는 폴백 없음 / whisper-1 설정 시 1회만 / 방문 녹음 동일

## ⑥ 결정사항
- 길이 상한 오류에만 whisper-1 로 1회 폴백(비용 이중 결제 없음 — 상한 오류는 과금 전 거절).

## ⑦ 오픈이슈
- 없음

## ⑧ 다음액션
- 배포 후 실패 건 재시도.
