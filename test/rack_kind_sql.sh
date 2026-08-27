#!/bin/bash
# 랙 유형 목록의 콤마 분리 — 실 PostgreSQL 16.
# rackMoveRoutes.js 의 /api/warehouse/racks 집계 쿼리를 **운영 소스에서 추출**해 실행한다.
set -e
PSQL="sudo -u postgres psql -qtAX -v ON_ERROR_STOP=1 -d rk_test"
sudo -u postgres psql -qtAX -c "DROP DATABASE IF EXISTS rk_test" >/dev/null
sudo -u postgres psql -qtAX -c "CREATE DATABASE rk_test" >/dev/null
$PSQL >/dev/null <<'SQL'
CREATE TABLE products (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT, rack_location TEXT, deleted_at TIMESTAMPTZ);
-- 스크린샷의 실제 값 그대로
INSERT INTO products (code,rack_location) VALUES
 ('c01','AA1-1'),('c02','AA1-1'),('c03','AA1-1'),('c04','AA1-1'),
 ('c05','AA1-2'),('c06','AA1-2'),('c07','AA1-2'),
 ('c08','AA2-1'),('c09','AA2-1'),('c10','AA2-1'),
 ('c11','AA2-1, AA2-5'),
 ('c12','AA3-2, B2-2'),
 ('c13','AA3-2, C1-2'),
 ('c14','AA3-2, D2-3'),('c15','AA3-2, D2-3'),
 ('c16','AA2-5');
SQL
node -e '
const fs=require("fs");
const src=fs.readFileSync("/home/claude/repo/refatrix-api/src/routes/rackMoveRoutes.js","utf8");
const i=src.indexOf("const rackRows = (await query(");
const a=src.indexOf("`",i), b=src.indexOf("`",a+1);
fs.writeFileSync("/tmp/rk.sql", src.slice(a+1,b)+" ORDER BY 1;");
'
echo "랙 | 제품 수"
$PSQL -f /tmp/rk.sql | sed "s/^/   /"
GOT=$($PSQL -f /tmp/rk.sql | tr '\n' ' ')
EXP="AA1-1|4 AA1-2|3 AA2-1|4 AA2-5|2 AA3-2|4 B2-2|1 C1-2|1 D2-3|2 "
[ "$GOT" = "$EXP" ] && echo "✅ 낱개 랙으로 쪼개짐 · 제품 수 합산 정확(AA2-1=4, AA3-2=4)" || { echo "❌ 기대: $EXP"; exit 1; }
$PSQL -f /tmp/rk.sql | grep -q "," && { echo "❌ 콤마 남은 랙 있음"; exit 1; } || echo "✅ 'AA3-2, B2-2' 같은 통짜 행 없음"
$PSQL -f /tmp/rk.sql | cut -d'|' -f1 | grep -q "^B2-2$" && echo "✅ B2-2 가 독립 랙으로 분리됨(AA 그룹에서 빠짐)"
echo ""
echo "SQL 검증 통과"
