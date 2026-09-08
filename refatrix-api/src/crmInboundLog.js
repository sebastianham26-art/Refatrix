// 수신 이력 — **모든 수신 창구가 공유하는 한 장의 기록** (0208 신설 · 0210 확장)
//
//   무엇이 우리 문을 두드렸는가를 창구별로 남긴다. 거절(401·400)도 남는다 —
//   상대와 "보냈다 / 못 받았다" 로 갈릴 때 근거가 되는 건 이 기록뿐이다.
//
//   ⚠ 행마다 endpoint_key 를 반드시 남긴다. 예전에는 조회가 창구로 갈리지 않아
//     연동 관리의 두 수신 연동이 **같은 목록을 보여 줬다.** 창구가 나뉘어 있으면
//     기록도 조회도 그대로 나뉘어야 한다.
//
//   업무 처리 상태(담당 지정·보류 등)는 여기가 아니라 각 업무 테이블에 있다
//   (리드는 crm_web_leads). 여기는 "수신 그 자체"의 기록이다.
import { query } from './db.js';

// 준비 여부 — 긍정만 영구 캐시, 없을 때만 30초마다 재확인.
//   (Railway 는 배포 후 사람이 콘솔에서 migrate 를 돌린다. 재시작 없이 인식돼야 한다)
let logReady = false; let logProbe = 0;
export async function inboundLogReady() {
  if (logReady) return true;
  if (Date.now() - logProbe < 30000) return false;
  logProbe = Date.now();
  try {
    const r = await query(`SELECT to_regclass('public.crm_inbound_log') AS t`);
    logReady = !!(r.rows[0] && r.rows[0].t);
  } catch (_) { logReady = false; }
  return logReady;
}

/** 수신 1건 기록. 실패해도 응답을 막지 않는다. */
export async function writeInboundLog(rec) {
  if (!(await inboundLogReady())) return;
  if (!rec || !rec.endpoint_key) return;   // 창구 없는 기록은 남기지 않는다(어느 목록에도 못 낀다)
  try {
    await query(
      `INSERT INTO crm_inbound_log
         (endpoint_key, remote_ip, auth_in, auth_ok, rfc, crm_code, customer_id, erp_code,
          result, http_status, codigo_error, mensaje, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
      [rec.endpoint_key, rec.remote_ip || null, rec.auth_in || null, !!rec.auth_ok,
       rec.rfc || null, rec.crm_code || null, rec.customer_id || null, rec.erp_code || null,
       rec.result || null, rec.http_status || null, rec.codigo_error || null, rec.mensaje || null,
       JSON.stringify(rec.payload || {})]);
  } catch (_) { /* 이력 실패가 수신을 막지 않는다 */ }
}

/** 창구별 집계 — { [endpoint_key]: {created,updated,rejected} } */
export async function inboundCounts() {
  const out = {};
  if (!(await inboundLogReady())) return out;
  try {
    const rows = (await query(
      `SELECT COALESCE(endpoint_key,'crm_customer_registration') AS k, result, count(*)::int AS n
         FROM crm_inbound_log GROUP BY 1,2`)).rows;
    for (const r of rows) {
      out[r.k] = out[r.k] || { created: 0, updated: 0, rejected: 0 };
      if (r.result in out[r.k]) out[r.k][r.result] = Number(r.n);
    }
  } catch (_) { /* 0208 전 */ }
  return out;
}
