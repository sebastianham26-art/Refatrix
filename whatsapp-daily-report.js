// whatsapp-daily-report.js
// Refatrix ERP · 일일 자금 요약을 이미지로 만들어 WhatsApp으로 매일 자동 전송
//
// 필요 패키지: npm i playwright node-cron   (+ npx playwright install --with-deps chromium)
// 필요 환경변수 (Railway):
//   WA_TOKEN             시스템 사용자 영구 토큰
//   WA_PHONE_NUMBER_ID   새로 등록한 번호의 Phone Number ID
//   ERP_BASE_URL         예) https://refatrix-production.up.railway.app
//   INTERNAL_REPORT_KEY  내부 리포트 페이지 접근용 비밀키 (임의 문자열)
//   DAILY_REPORT_TO      수신자 번호, 쉼표 구분. 예) 528112345678,529991234567  (52 + 10자리, "1" 없이)

import { chromium } from 'playwright';
import cron from 'node-cron';

const GRAPH = 'https://graph.facebook.com/v25.0';
const {
  WA_TOKEN,
  WA_PHONE_NUMBER_ID,
  ERP_BASE_URL,
  INTERNAL_REPORT_KEY,
  DAILY_REPORT_TO = '',
} = process.env;

const TEMPLATE_NAME = 'resumen_diario_fondos'; // Meta에서 승인받은 템플릿 이름
const TEMPLATE_LANG = 'es_MX';

// 1) ERP 내부 페이지(지금 쓰는 표 화면)를 PNG로 캡처
async function renderReportPng() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({
      viewport: { width: 1400, height: 800 },
      deviceScaleFactor: 2, // 휴대폰에서 글씨가 선명하도록
    });
    await page.setExtraHTTPHeaders({ 'x-internal-key': INTERNAL_REPORT_KEY });
    await page.goto(`${ERP_BASE_URL}/internal/reports/daily-cash`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#daily-cash-summary'); // 표를 감싼 요소의 id

    // WhatsApp 이미지 헤더는 1.91:1 비율로 잘려 보이므로,
    // 표를 1.91:1 흰색 캔버스 가운데에 놓고 캔버스째 캡처 → 좌우가 잘리지 않음
    await page.evaluate(() => {
      const table = document.getElementById('daily-cash-summary');
      const pad = 24;
      const w = table.offsetWidth + pad * 2;
      const frame = document.createElement('div');
      frame.id = 'wa-frame';
      Object.assign(frame.style, {
        width: `${w}px`,
        height: `${Math.round(w / 1.91)}px`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#ffffff',
        boxSizing: 'border-box',
      });
      table.parentNode.insertBefore(frame, table);
      frame.appendChild(table);
    });
    const frame = await page.$('#wa-frame');
    return await frame.screenshot({ type: 'png' });
  } finally {
    await browser.close();
  }
}

// 2) WhatsApp 미디어로 업로드 (공개 URL 불필요) → media id 반환
async function uploadImage(pngBuffer) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'image/png');
  form.append('file', new Blob([pngBuffer], { type: 'image/png' }), 'resumen-diario.png');

  const res = await fetch(`${GRAPH}/${WA_PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
    body: form,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`media upload failed: ${JSON.stringify(json)}`);
  return json.id;
}

// 3) 이미지 헤더 템플릿으로 전송 (회사가 먼저 보내는 메시지이므로 템플릿 필수)
async function sendTemplate(to, mediaId, dateLabel) {
  const res = await fetch(`${GRAPH}/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: TEMPLATE_NAME,
        language: { code: TEMPLATE_LANG },
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { id: mediaId } }] },
          { type: 'body', parameters: [{ type: 'text', text: dateLabel }] },
        ],
      },
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`send to ${to} failed: ${JSON.stringify(json)}`);
  return json.messages?.[0]?.id;
}

export async function sendDailyCashReport(log = console) {
  const dateLabel = new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mexico_City',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  }).format(new Date()); // 예) "mar, 06/10"

  const png = await renderReportPng();
  const mediaId = await uploadImage(png); // 한 번 업로드해서 모든 수신자에게 재사용
  const recipients = DAILY_REPORT_TO.split(',').map((s) => s.trim()).filter(Boolean);

  for (const to of recipients) {
    try {
      const id = await sendTemplate(to, mediaId, dateLabel);
      log.info({ to, id }, 'daily cash report sent');
    } catch (err) {
      log.error({ to, err: err.message }, 'daily cash report failed');
    }
  }
}

// Fastify 등록: 매일 자동 전송 + 수동 재전송용 엔드포인트
export function registerDailyCashReport(fastify) {
  // 월~금 06:05 (멕시코시티). 토요일 포함하려면 '5 6 * * 1-6'
  cron.schedule(
    '5 6 * * 1-5',
    () => sendDailyCashReport(fastify.log).catch((e) => fastify.log.error(e)),
    { timezone: 'America/Mexico_City' }
  );

  // 수동 전송 (테스트/재전송). 내부 키 필수
  fastify.post('/internal/reports/daily-cash/send', async (req, reply) => {
    if (req.headers['x-internal-key'] !== INTERNAL_REPORT_KEY) return reply.code(403).send();
    await sendDailyCashReport(fastify.log);
    return { ok: true };
  });
}

// 서버 진입점에서:
//   import { registerDailyCashReport } from './whatsapp-daily-report.js';
//   registerDailyCashReport(fastify);
//
// 주의: /internal/reports/daily-cash 페이지도 x-internal-key 헤더를 검사해서
//       외부에서는 열리지 않도록 막아야 합니다.
