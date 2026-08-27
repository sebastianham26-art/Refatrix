#!/bin/bash
# 랙 칸의 콤마 분리(2026-08-27) — 실 PostgreSQL 16 에서 검증.
# 두 쿼리를 **운영 소스에서 그대로 추출**해 실행한다(복붙 아님):
#   ① zoneRoutes.js  존 지정 목록 집계
#   ② inboundRoutes.js 선적 상세의 라인+존 조회
set -e
PSQL="sudo -u postgres psql -qtAX -v ON_ERROR_STOP=1 -d rack_test"
sudo -u postgres psql -qtAX -c "DROP DATABASE IF EXISTS rack_test" >/dev/null
sudo -u postgres psql -qtAX -c "CREATE DATABASE rack_test" >/dev/null

$PSQL >/dev/null <<'SQL'
CREATE TABLE products (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT, name TEXT, rack_location TEXT, deleted_at TIMESTAMPTZ);
CREATE TABLE warehouse_zones (zone INT PRIMARY KEY, name TEXT);
CREATE TABLE rack_zones (rack TEXT PRIMARY KEY, zone INT, updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE inbound_pallets (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id BIGINT, order_no TEXT, pl_no INT, status TEXT, checked_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ, working_by BIGINT, working_step TEXT, working_at TIMESTAMPTZ);
CREATE TABLE inbound_pallet_items (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pallet_id BIGINT, shipment_id BIGINT, product_id BIGINT, input_code TEXT,
  cartons INT DEFAULT 0, qty NUMERIC(15,3) DEFAULT 0,
  scanned_cartons INT DEFAULT 0, put_cartons INT DEFAULT 0,
  rack_saved TEXT, box_from INT, box_to INT);

INSERT INTO warehouse_zones (zone,name) VALUES (1,'A동 앞'),(2,'A동 뒤'),(3,'B동'),(4,'2층');
-- 현장 실제 모양: 랙 칸 하나에 콤마로 여러 랙
INSERT INTO products (code,name,rack_location) VALUES
  ('P1','한 랙',        'AA3-1'),
  ('P2','두 랙 같은 존', 'AA3-2, AA10-1'),
  ('P3','두 랙 다른 존', 'A3-1, AA3-1'),
  ('P4','세 랙',        'AA3-2, B2-2, B2-1'),
  ('P5','공백 섞임',     '  B2-2 ,B10-1  '),
  ('P6','랙 없음',       NULL),
  ('P7','삭제된 제품',   'ZZ9-9');
UPDATE products SET deleted_at=now() WHERE code='P7';
-- 존 매핑(낱개 랙 기준)
INSERT INTO rack_zones (rack,zone) VALUES
  ('A3-1',1),('AA3-1',2),('AA3-2',2),('AA10-1',2),('B2-1',3),('B2-2',3),('B10-1',4);

INSERT INTO inbound_pallets (id,shipment_id,order_no,pl_no,status) OVERRIDING SYSTEM VALUE VALUES (1,1,'100RA1',1,'unloaded');
SQL
$PSQL -c "INSERT INTO inbound_pallet_items (pallet_id,shipment_id,product_id,input_code,cartons,qty)
          SELECT 1,1,id,code,1,10 FROM products WHERE deleted_at IS NULL AND code IN ('P1','P2','P3','P4','P5','P6')" >/dev/null

# ── ① 존 지정 목록 집계 (zoneRoutes.js 에서 추출)
node -e '
const fs=require("fs");
const src=fs.readFileSync("/home/claude/repo/refatrix-api/src/routes/zoneRoutes.js","utf8");
const i=src.indexOf("const rackRows = (await query(");
const a=src.indexOf("`",i), b=src.indexOf("`",a+1);
fs.writeFileSync("/tmp/racks.sql", src.slice(a+1,b)+" ORDER BY 1;");
'
echo "① 존 지정 목록 — 랙 | 제품 수"
$PSQL -f /tmp/racks.sql | sed "s/^/   /"
GOT=$($PSQL -f /tmp/racks.sql | tr '\n' ' ')
EXP="A3-1|1 AA10-1|1 AA3-1|2 AA3-2|2 B10-1|1 B2-1|1 B2-2|2 "
[ "$GOT" = "$EXP" ] && echo "✅ 콤마·공백이 낱개 랙으로 쪼개지고 제품 수가 맞음" || { echo "❌ 기대: $EXP"; exit 1; }
echo "   (통짜 문자열 'AA3-2, B2-2' 같은 행이 없어야 한다)"
$PSQL -f /tmp/racks.sql | grep -q "," && { echo "❌ 콤마가 남은 랙이 있음"; exit 1; } || echo "✅ 콤마가 남은 랙 없음"

# ── ② 선적 상세 라인+존 조회 (inboundRoutes.js 에서 추출)
node -e '
const fs=require("fs");
const src=fs.readFileSync("/home/claude/repo/refatrix-api/src/routes/inboundRoutes.js","utf8");
const i=src.indexOf("const items = (await query(");
const a=src.indexOf("`",i), b=src.indexOf("`",a+1);
let sql=src.slice(a+1,b).replace(/\$1/g,"1");
fs.writeFileSync("/tmp/items.sql",
  "SELECT input_code, COALESCE(array_to_string(rack_zones_arr,\x27+\x27),\x27-\x27) AS zones FROM ("+sql+") q ORDER BY input_code;");
'
echo ""
echo "② 검수·적치 존 조회 — 제품 | 존"
$PSQL -f /tmp/items.sql | sed "s/^/   /"
GOT2=$($PSQL -f /tmp/items.sql | tr '\n' ' ')
EXP2="P1|2 P2|2 P3|1+2 P4|2+3 P5|3+4 P6|- "
[ "$GOT2" = "$EXP2" ] && echo "✅ 랙마다 존을 찾고, 여러 존이면 전부 돌려준다" || { echo "❌ 기대: $EXP2"; exit 1; }

# ── ③ 라인 중복 복제가 없어야 한다(카톤·수량 부풀림 회귀)
N=$($PSQL -c "SELECT COUNT(*) FROM ($(cat /tmp/items.sql | sed 's/^SELECT input_code.*FROM (//; s/) q ORDER BY input_code;//')) x")
[ "$N" = "6" ] && echo "✅ 라인 6건 그대로(중복 복제 없음)" || { echo "❌ 라인 수 $N (기대 6)"; exit 1; }

# ── ④ 대소문자 무시 매칭 회귀
$PSQL -c "UPDATE products SET rack_location='aa3-1, b2-2' WHERE code='P1'" >/dev/null
Z=$($PSQL -f /tmp/items.sql | grep '^P1|' )
[ "$Z" = "P1|2+3" ] && echo "✅ 소문자 랙도 매칭됨 ($Z)" || { echo "❌ $Z"; exit 1; }

echo ""
echo "SQL 검증 통과"
