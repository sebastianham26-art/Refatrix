REFATRIX · 창고 위치변경(Cambio de ubicación) v1 — build rel-0827a / nav v20260827rl

■ 배포 순서 (⚠ 마이그레이션 있음 — 순서를 지키세요)

1) 백엔드 먼저
   refatrix-api/migrations/0187_rack_relocate.sql      ← 신규
   refatrix-api/src/routes/rackMoveRoutes.js           ← 신규
   refatrix-api/src/server.js                          ← 2줄 추가(import + register)
   → Push → Railway 재배포 Success 확인

2) Railway APP 콘솔에서  npm run migrate
   → "apply 0187_rack_relocate.sql" 확인
   (안 돌리면 위치변경 화면의 랙 목록이 500 으로 뜬다. 다른 화면에는 영향 없음)

3) 프런트
   refatrix-relocate.html        ← 신규 화면
   refatrix-nav.js               ← 창고 그룹에 [위치변경] 추가 (v20260827rl)
   nav_token_bumped/*.html       ← 46장, ?v= 토큰만 20260827rl 로 일괄 변경
                                    (이걸 안 올리면 브라우저가 옛 nav 를 캐시해 메뉴가 안 보인다)
   → Push → GitHub Pages 1~2분

4) 브라우저 Ctrl+Shift+R
   콘솔에  [refatrix-nav] v20260827rl  ·  [refatrix-relocate] build rel-0827a

■ 테스트 (동봉, 배포에는 불필요)
   node test/relocate_ui.test.js                                  65건 (jsdom)
   node test/relocate_render.mjs                                   9건 (Chromium 실렌더 + 스크린샷)
   TEST_PG_URL=postgres://... node refatrix-api/test/rack_relocate_sql.test.mjs   61건 (실 PostgreSQL)

■ 스크린샷
   pda_360x640_es.png / pda_320x568_es.png / desktop_1280.png / kinds_1280.png
