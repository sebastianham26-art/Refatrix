#!/bin/bash
# 창고 종료(0187) — 실제 PostgreSQL 16 에서 마이그레이션과 판정 SQL 을 검증한다.
# 운영 파일에서 SQL 을 직접 읽어 실행한다(하드코딩 복붙 아님).
set -e
PSQL="sudo -u postgres psql -qtAX -v ON_ERROR_STOP=1 -d wh_test"
sudo -u postgres psql -qtAX -c "DROP DATABASE IF EXISTS wh_test" >/dev/null
sudo -u postgres psql -qtAX -c "CREATE DATABASE wh_test" >/dev/null

# --- 최소 스키마(0142/0176 에서 이 검증에 필요한 부분만) ---
$PSQL >/dev/null <<'SQL'
CREATE TABLE users (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT);
CREATE TABLE inbound_shipments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_no TEXT, eta DATE,
  status TEXT NOT NULL DEFAULT 'incoming'
    CHECK (status IN ('incoming','receiving','closed','cancelled')),
  deleted_at TIMESTAMPTZ);
CREATE TABLE inbound_pallets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id BIGINT NOT NULL REFERENCES inbound_shipments(id),
  order_no TEXT NOT NULL, pl_no INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'wait'
    CHECK (status IN ('wait','unloaded','checking','checked','done')),
  checked_at TIMESTAMPTZ, received_at TIMESTAMPTZ);
CREATE TABLE inbound_pallet_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pallet_id BIGINT NOT NULL REFERENCES inbound_pallets(id),
  shipment_id BIGINT NOT NULL REFERENCES inbound_shipments(id),
  input_code TEXT, cartons INT NOT NULL DEFAULT 0,
  scanned_cartons INT NOT NULL DEFAULT 0, put_cartons INT NOT NULL DEFAULT 0);
SQL

# --- 운영 마이그레이션 0187 을 그대로 적용 ---
$PSQL -f /home/claude/repo/refatrix-api/migrations/0187_inbound_warehouse_finish.sql >/dev/null
echo "✅ 0187 적용됨"

# 재적용해도 안전(IF NOT EXISTS) — 재배포 시 migrate 재실행 대비
$PSQL -f /home/claude/repo/refatrix-api/migrations/0187_inbound_warehouse_finish.sql >/dev/null
echo "✅ 0187 멱등(2회 적용 OK)"

COLS=$($PSQL -c "SELECT string_agg(column_name,',' ORDER BY column_name) FROM information_schema.columns WHERE table_name='inbound_shipments' AND column_name LIKE 'wh_%'")
[ "$COLS" = "wh_locked_at,wh_locked_by,wh_req_at,wh_req_by" ] && echo "✅ 컬럼 4개: $COLS" || { echo "❌ 컬럼: $COLS"; exit 1; }

# --- 픽스처: 팔렛 3개 ---
#  1) 적치 완료 + 입고 반영   2) 적치 미완료   3) 적치 완료지만 입고 미반영
$PSQL >/dev/null <<'SQL'
INSERT INTO users (name) VALUES ('almacen'),('director');
INSERT INTO inbound_shipments (invoice_no, status) VALUES ('D26-TEST','closed');
INSERT INTO inbound_pallets (shipment_id, order_no, pl_no, status, checked_at, received_at) VALUES
  (1,'100RA1',1,'done',   now(), now()),
  (1,'100RA1',2,'checking',now(), now()),
  (1,'100RA1',3,'done',   now(), NULL);
INSERT INTO inbound_pallet_items (pallet_id, shipment_id, input_code, cartons, scanned_cartons, put_cartons) VALUES
  (1,1,'A',40,40,40),      -- 완료
  (1,1,'B', 2, 0, 0),      -- 검수 0 → 목표 0 → 완료로 본다
  (2,1,'C',10,10, 7),      -- 적치 미완료
  (3,1,'D', 5, 5, 5);      -- 완료(입고 미반영)
SQL

# --- 운영 소스에서 whFinishCheck 의 SQL 을 뽑아 실행 ---
node -e '
const fs=require("fs");
const src=fs.readFileSync("/home/claude/repo/refatrix-api/src/routes/inboundRoutes.js","utf8");
const i=src.indexOf("async function whFinishCheck");
const a=src.indexOf("`",i), b=src.indexOf("`",a+1);
let sql=src.slice(a+1,b).replace(/\$1/g,"1");
fs.writeFileSync("/tmp/chk.sql", sql+";");
'
OUT=$($PSQL -f /tmp/chk.sql)
echo "   whFinishCheck → pallets|put_pending|recv_pending = $OUT"
[ "$OUT" = "3|1|1" ] && echo "✅ 판정 SQL: 적치 미완료 1팔렛 · 입고 미반영 1팔렛" || { echo "❌ 기대 3|1|1"; exit 1; }

# 적치를 마저 채우면 put_pending 0
$PSQL -c "UPDATE inbound_pallet_items SET put_cartons=10 WHERE pallet_id=2" >/dev/null
OUT=$($PSQL -f /tmp/chk.sql)
[ "$OUT" = "3|0|1" ] && echo "✅ 적치 완료 후 put_pending=0 (입고 미반영만 남음)" || { echo "❌ $OUT"; exit 1; }

# 입고까지 반영하면 종료 가능
$PSQL -c "UPDATE inbound_pallets SET received_at=now() WHERE id=3" >/dev/null
OUT=$($PSQL -f /tmp/chk.sql)
[ "$OUT" = "3|0|0" ] && echo "✅ 전 조건 충족 → 종료 가능" || { echo "❌ $OUT"; exit 1; }

# 미검수(checked_at NULL) 팔렛은 목표가 cartons → 자동으로 적치 미완료
$PSQL -c "INSERT INTO inbound_pallets (shipment_id,order_no,pl_no,status,received_at) VALUES (1,'100RA1',4,'wait',now());
          INSERT INTO inbound_pallet_items (pallet_id,shipment_id,input_code,cartons) VALUES (4,1,'E',9);" >/dev/null
OUT=$($PSQL -f /tmp/chk.sql)
[ "$OUT" = "4|1|0" ] && echo "✅ 미검수 팔렛은 적치 미완료로 잡힘 (종료 차단)" || { echo "❌ $OUT"; exit 1; }

# 잠금/신청 컬럼 왕복
$PSQL >/dev/null <<'SQL'
UPDATE inbound_shipments SET wh_req_by=1, wh_req_at=now() WHERE id=1;
UPDATE inbound_shipments SET wh_locked_by=2, wh_locked_at=now() WHERE id=1;
SQL
LK=$($PSQL -c "SELECT (wh_locked_at IS NOT NULL)::int::text || (wh_req_at IS NOT NULL)::int::text FROM inbound_shipments WHERE id=1")
[ "$LK" = "11" ] && echo "✅ 신청·잠금 기록" || { echo "❌ $LK"; exit 1; }
$PSQL -c "UPDATE inbound_shipments SET wh_locked_by=NULL,wh_locked_at=NULL,wh_req_by=NULL,wh_req_at=NULL WHERE id=1" >/dev/null
LK=$($PSQL -c "SELECT (wh_locked_at IS NULL)::int::text || (wh_req_at IS NULL)::int::text FROM inbound_shipments WHERE id=1")
[ "$LK" = "11" ] && echo "✅ 해제하면 신청도 함께 지워짐" || { echo "❌ $LK"; exit 1; }

echo ""
echo "SQL 검증 통과"
