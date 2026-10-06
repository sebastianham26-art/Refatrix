# Refatrix ERP · WhatsApp 연동 패키지

## 들어 있는 파일

| 파일 | 역할 |
|---|---|
| `whatsapp-webhook.js` | Meta 콜백 URL `/webhooks/whatsapp` 수신 (검증, 서명 확인, 고객 메시지·발송 상태 저장). 시작 시 `wa_events` 테이블 자동 생성 |
| `whatsapp-daily-report.js` | 일일 자금 요약 표를 이미지로 캡처해 매일 06:05에 WhatsApp 템플릿으로 전송 |
| `wa_events.sql` | 참고용 (테이블은 코드가 자동으로 만들므로 실행하지 않아도 됨) |
| `.env.example` | Railway에 넣을 환경변수 목록 |

---

## 1단계 · 웹훅 (지금 바로)

1. 이 ZIP의 `whatsapp-webhook.js`를 ERP 저장소의 서버 시작 파일(`server.js` 또는 `index.js`)과 **같은 폴더**에 올립니다.
   GitHub: **Add file → Upload files → 파일 끌어다 놓기 → Commit changes**
2. 서버 시작 파일을 열고(**연필 아이콘**) 2줄을 추가한 뒤 **Commit changes**:

```js
// 맨 위 import 들 아래
import whatsappWebhook from './whatsapp-webhook.js';

// fastify.listen(...) 보다 위
fastify.register(whatsappWebhook, { db: pool });   // pool = new Pool(...) 로 만든 DB 변수 이름
```

3. Railway → ERP 서비스 → **Variables → + New Variable** 로 2개 추가 → **Deploy**
   - `WA_VERIFY_TOKEN` = Meta "인증 토큰"에 넣은 값과 동일
   - `WA_APP_SECRET` = Meta 앱 → 앱 설정 → 기본 → 앱 시크릿 코드
4. Deployments가 **Active**가 되면 Meta → Webhooks 구성 → **확인 및 저장** → 웹훅 필드 **messages 구독**

---

## 2단계 · 일일 자금 요약 자동 전송 (템플릿 승인 후)

1. `whatsapp-daily-report.js`를 같은 폴더에 올립니다.
2. `package.json`의 dependencies에 추가:
   ```json
   "playwright": "^1.47.0",
   "node-cron": "^3.0.3"
   ```
3. Railway 빌드 시 Chromium 설치가 필요합니다. `package.json`의 scripts에 추가:
   ```json
   "postinstall": "npx playwright install --with-deps chromium"
   ```
4. 서버 시작 파일에 추가:
   ```js
   import { registerDailyCashReport } from './whatsapp-daily-report.js';
   registerDailyCashReport(fastify);
   ```
5. ERP에 표만 보여주는 내부 페이지 `/internal/reports/daily-cash` 를 만들고,
   표 전체를 `<div id="daily-cash-summary">` 로 감쌉니다.
   이 페이지는 요청 헤더 `x-internal-key` 가 `INTERNAL_REPORT_KEY` 와 같을 때만 열리게 합니다.
6. Railway Variables에 `.env.example`의 나머지 값 추가 → Deploy

### 동작 확인 (수동 전송)
```
POST https://refatrix-production.up.railway.app/internal/reports/daily-cash/send
헤더: x-internal-key: <INTERNAL_REPORT_KEY>
```

---

## 주의
- Railway 서비스 인스턴스는 **1개**로 유지 (2개 이상이면 일일 보고가 중복 발송됨)
- 수신 번호는 `52` + 10자리 (`521...` 아님)
- `WA_TOKEN`은 24시간 임시 토큰이 아니라 **시스템 사용자 영구 토큰**을 넣어야 함
- 실제 고객 메시지 웹훅은 Meta 앱을 **게시(Publicar)** 해야 들어옴
