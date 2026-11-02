# REFATRIX 핫픽스 · 2026-11-02h · ffmpeg 를 레포 설정(railpack.json)으로 설치 + 변환기 상태 표시

빌드 토큰: `refatrix-consult.html` = **b20261102up3** (마이그레이션 없음)

## ① 설명
- 증상: `WhatsApp Audio 2026-11-02 at 2.39.49 PM.mp4 · 42:39` → "전사 서버가 이 오디오 형식을 읽지 못했습니다"
- 원인: **Railway 서버에 ffmpeg 가 없다.** 휴대폰 파일은 변환이 기본인데, 변환기가 없어서 24MB 이하 mp4 를 원본 그대로 보냈고 whisper-1 이 거절했다.
  (변환기가 있었다면 ogg 로 바뀌어 이 오류가 날 수 없다. 실제 ffmpeg 로 WhatsApp 식 mp4(aac·opus·조각 MP4) 변환 확인.)
- 수정:
  1. `refatrix-api/railpack.json` — Railpack 공식 설정으로 **배포 이미지에 ffmpeg 설치**. Railway 화면 설정이 필요 없다.
     `"..."` 는 Railpack 기본 패키지를 유지하라는 뜻(빼면 기본 패키지가 사라진다).
  2. 화면: 📁 버튼 아래에 **「🔧 서버 오디오 변환기: ✅ 사용 가능 / ❌ 없음」** 상시 표시.
  3. 변환기 없을 때 mp4·mov 파일은 올리기 전에 막고 이유를 보여준다(헛 업로드 방지).

## ② 배포단계
1. Railway Variables 에 `RAILPACK_DEPLOY_APT_PACKAGES` 를 넣었다면 **삭제**(값이 `ffmpeg` 만이면 Railpack 기본 패키지를 덮어쓴다 — railpack.json 이 대신한다).
2. Fetch/Pull → `refatrix-api/railpack.json` Push → Railway **빌드 로그에 ffmpeg 설치 줄** · Success 확인.
3. `refatrix-consult.html` Push → Ctrl+Shift+R → 탭 제목 `b20261102up3`.
4. 상담 녹음 카드의 변환기 상태가 **✅** 인지 확인 → 실패한 WhatsApp 녹음 **[↻ 재시도]**.

## ③ 테스트방법
✅ 확인 후 재시도 → 42분 파일이 ogg 20분 × 3구간으로 변환·전사 → `✅ 완료`.
❌ 그대로면 Railway 서비스 Settings › Build 의 빌더가 Railpack 인지 확인(Nixpacks 면 변수 `NIXPACKS_APT_PKGS=ffmpeg`).

## ④ 변경파일
| 레포 경로 | 구분 |
|---|---|
| `refatrix-api/railpack.json` | 신규 |
| `refatrix-consult.html` (루트) | 수정 (변환기 상태 · mp4 사전 차단 · b20261102up3) |
| `refatrix-api/test/consult_file_upload_front.test.mjs` | 수정 |

## ⑤ 검증결과
- railpack.json JSON 유효 · Railpack 문서 형식(`deploy.aptPackages` + `"..."`)과 일치
- 실제 ffmpeg: opus-in-mp4 · aac 조각 MP4 30초 → ogg 변환 성공
- 실제 Chromium 7/7 (변환기 ✅/❌ 표시, WhatsApp mp4 사전 차단 포함) · 화면 스크립트 문법 통과

## ⑥ 결정사항
- ffmpeg 설치는 Railway 화면 변수 대신 **레포의 railpack.json** 으로 관리(배포 기록에 남고 실수로 지워지지 않음).

## ⑦ 오픈이슈
- 없음

## ⑧ 다음액션
- 배포 → ✅ 확인 → 재시도.
