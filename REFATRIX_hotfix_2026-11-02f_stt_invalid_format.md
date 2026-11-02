# REFATRIX 핫픽스 · 2026-11-02f · "Invalid file format" — 아이폰 mp4 녹음·원본 전송분 자동 변환

빌드 토큰: `refatrix-consult.html` = **b20261102up2** (마이그레이션 없음)

## ① 설명
오류: `stt: Invalid file format. Supported formats: ['flac','m4a','mp3','mp4','mpeg','mpga','oga','ogg','wav','webm']`
- 확장자는 지원 목록에 있어도 **속 구조**를 whisper-1 이 못 읽은 경우다. 대표 사례: **아이폰 사파리 화면 녹음(조각 MP4)**,
  ffmpeg 설치 전 **원본 그대로 보낸 휴대폰 파일**. 직전 오류(1400초 상한)에서 whisper-1 로 폴백하자 이 오류가 드러났다.
- 수정(전사 전 변환 대상 확대):
  · 휴대폰 파일 — 항상 변환(기존)
  · 화면 녹음 **webm**(크롬·안드로이드) — 변환 안 함(기존과 동일)
  · 화면 녹음 **그 밖(mp4 등)** — 이제 ffmpeg 로 ogg/opus 20분 구간 변환 후 전사. 구간이 여러 개면 순서대로 각각 변환
  · ffmpeg 없을 때 원본 그대로 보낸 건은 `converted_at` 을 남기지 않는다 → **ffmpeg 설치 후 [↻ 재시도]하면 그때 변환**
  · 예전 배포본이 원본 전송에 `converted_at` 을 찍어 둔 행도 다시 변환
- 화면: 이 오류·길이 상한 오류를 한국어 안내로 표시.

## ② 배포단계
1. **Railway Variables `RAILPACK_DEPLOY_APT_PACKAGES` = `ffmpeg` 필수** — 이 오류는 변환으로만 해결된다.
2. Fetch/Pull → `refatrix-api/src/routes/consultRoutes.js` Push → Railway Success.
3. `refatrix-consult.html` Push → Ctrl+Shift+R → 탭 제목 `b20261102up2`.
4. 실패한 녹음 카드 **[↻ 재시도]**.

## ③ 테스트방법
실패 건 재시도 → `✅ 완료`. 여전히 "Invalid file format" 이면 ffmpeg 미설치 — Railway 빌드 로그에서 apt `ffmpeg` 설치 줄 확인.

## ④ 변경파일
| 레포 경로 | 구분 |
|---|---|
| `refatrix-api/src/routes/consultRoutes.js` | 수정 (`needsConvert` · `prepareRecordingAudio`) |
| `refatrix-consult.html` (루트) | 수정 (오류 안내 · b20261102up2) |
| `refatrix-api/test/consult_file_upload.test.mjs` | 수정 (테스트 6건 추가) |

## ⑤ 검증결과
- 백엔드 107건 중 실패 0 (skip 14 = 기존) · 실제 Chromium 7/7 · 실제 PostgreSQL 16 E2E 2/2
- 실제 ffmpeg: 사파리식 조각 MP4(frag_keyframe+empty_moov) 45초 → ogg 3구간 변환 확인
- mp4 2구간 녹음 → 구간별 변환·시간 순서 유지 / ffmpeg 없음 → 원본 전송·converted_at 비움 → 설치 후 재시도로 성공 / 예전 converted_at 행 재변환

## ⑥ 결정사항
- webm 화면 녹음은 지금처럼 변환하지 않는다(정상 동작 중, 서버 부하 불필요).

## ⑦ 오픈이슈
- 방문 녹음(영업활동 화면)의 아이폰 mp4 는 아직 변환 경로 없음 — 같은 오류가 나면 동일 방식으로 확장.

## ⑧ 다음액션
- ffmpeg 변수 추가 → 배포 → 재시도.
