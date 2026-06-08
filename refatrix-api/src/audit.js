import { query } from './db.js';

// 민감 행동: 건별 상세 기록
export async function logEvent({ userId, deviceId = null, action, target = null, detail = null, result = 'success' }) {
  await query(
    `INSERT INTO audit_log (user_id, device_id, action, target, detail, result)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, deviceId, action, target, detail ? JSON.stringify(detail) : null, result]
  );
}

// 페이지 열람: 유저별·날짜별 요약(가볍게). 같은 날 같은 페이지는 카운트 증가.
export async function logPageView(userId, pageKey) {
  await query(
    `INSERT INTO page_view_daily (user_id, view_date, page_key, view_count, last_at)
     VALUES ($1, CURRENT_DATE, $2, 1, now())
     ON CONFLICT (user_id, view_date, page_key)
     DO UPDATE SET view_count = page_view_daily.view_count + 1, last_at = now()`,
    [userId, pageKey]
  );
}

// 외부 사용자(투자자)는 열람도 건별 상세로 남기고 싶을 때
export async function logViewDetailed(userId, deviceId, target, detail) {
  await logEvent({ userId, deviceId, action: 'page_view', target, detail, result: 'success' });
}
