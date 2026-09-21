-- =====================================================================
-- REFATRIX · 카탈로그 조회 API — 「가져갔다는데 동기화 회차가 비었다」 점검
--   읽기 전용. Railway → Postgres → Data(Query) 에 블록을 하나씩 붙여넣기.
-- =====================================================================

-- ① 고객사별 호출 요약 — 운영(prod)/테스트(test) 어느 키로 불렀나
SELECT c.id, c.label, l.env,
       count(*)                                        AS 호출수,
       count(*) FILTER (WHERE l.http_status = 200)     AS 성공,
       sum(l.items) FILTER (WHERE l.http_status = 200) AS 받아간_제품_합계,
       min(l.created_at) AT TIME ZONE 'America/Mexico_City' AS 첫호출_MX,
       max(l.created_at) AT TIME ZONE 'America/Mexico_City' AS 끝호출_MX
  FROM catalog_api_calls l
  LEFT JOIN catalog_api_clients c ON c.id = l.client_id
 GROUP BY c.id, c.label, l.env
 ORDER BY c.id, l.env;

-- ② 실패한 호출 — 막혔다면 이유가 여기 있다 (401 키 / 403 접속창·IP / 429 회차·한도)
SELECT l.created_at AT TIME ZONE 'America/Mexico_City' AS 시각_MX,
       c.label, l.env, l.path, l.http_status, l.codigo_error, l.remote_ip
  FROM catalog_api_calls l
  LEFT JOIN catalog_api_clients c ON c.id = l.client_id
 WHERE l.http_status <> 200
 ORDER BY l.id DESC LIMIT 50;

-- ③ 동기화 회차 표 — 비어 있으면 운영 키로 받은 적이 없다는 뜻
SELECT r.id, c.label, r.period_key, r.env,
       r.started_at AT TIME ZONE 'America/Mexico_City' AS 시작_MX,
       r.closed_at  AT TIME ZONE 'America/Mexico_City' AS 완료_MX,
       r.pages, r.productos
  FROM catalog_api_runs r
  LEFT JOIN catalog_api_clients c ON c.id = r.client_id
 ORDER BY r.id DESC LIMIT 20;

-- ④ 성공 호출을 시간순으로 — 어떤 경로를 불렀나 (/products 전체 · /products/:codigo 단건 · /brands)
SELECT l.created_at AT TIME ZONE 'America/Mexico_City' AS 시각_MX,
       c.label, l.env, l.path, l.query, l.items, l.note
  FROM catalog_api_calls l
  LEFT JOIN catalog_api_clients c ON c.id = l.client_id
 WHERE l.http_status = 200
 ORDER BY l.id DESC LIMIT 100;

-- ⑤ 키 발급 현황 — 고객에게 건넨 키가 운영인지 테스트인지
SELECT id, label, enabled,
       (token_prod IS NOT NULL) AS 운영키, token_prod_at AT TIME ZONE 'America/Mexico_City' AS 운영키_발급_MX,
       (token_test IS NOT NULL) AS 테스트키, token_test_at AT TIME ZONE 'America/Mexico_City' AS 테스트키_발급_MX,
       window_enforced, window_dow, window_start_hour, window_end_hour
  FROM catalog_api_clients ORDER BY id;
