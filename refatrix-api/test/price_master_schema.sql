-- price_master_pg.test.mjs 전용 최소 스키마(운영 스키마의 일부만 흉내 낸다)
CREATE TABLE users (id BIGSERIAL PRIMARY KEY, name TEXT, login_id TEXT, role TEXT, pin_hash TEXT, dept TEXT);
CREATE TABLE audit_log (id BIGSERIAL PRIMARY KEY, occurred_at TIMESTAMPTZ DEFAULT now(), user_id BIGINT, device_id BIGINT, action TEXT, target TEXT, detail JSONB, result TEXT);
CREATE TABLE products (
  id BIGSERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, scode TEXT, app TEXT, name TEXT, sat_code TEXT, origin TEXT,
  list_price NUMERIC, discount NUMERIC, iva_rate NUMERIC, ean TEXT, location TEXT, list_price_syd NUMERIC,
  price_customer_syd NUMERIC, price_customer_ctr NUMERIC, material TEXT, rack_location TEXT,
  stock_qty NUMERIC DEFAULT 0, avg_cost NUMERIC, is_active BOOLEAN NOT NULL DEFAULT true, inactive_reason TEXT,
  status_changed_at TIMESTAMPTZ, status_changed_by BIGINT, deleted_at TIMESTAMPTZ,
  created_by BIGINT, updated_by BIGINT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE product_syd_codes (product_id BIGINT REFERENCES products(id) ON DELETE CASCADE, syd_code TEXT, PRIMARY KEY(product_id, syd_code));
CREATE TABLE product_applications (id BIGSERIAL PRIMARY KEY, product_id BIGINT REFERENCES products(id) ON DELETE CASCADE, app_text TEXT, maker TEXT, model TEXT, year_from INT, year_to INT);
CREATE TABLE product_change_log (id BIGSERIAL PRIMARY KEY, product_id BIGINT, code TEXT, action TEXT, source TEXT, changes JSONB, changed_by BIGINT, changed_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE product_status_log (id BIGSERIAL PRIMARY KEY, product_id BIGINT, code TEXT, action TEXT, reason TEXT, check_id BIGINT, open_summary JSONB, changed_by BIGINT, changed_at TIMESTAMPTZ DEFAULT now());
-- 제품 삭제 점검이 「차단」으로 보는 표 하나(견적 줄)
CREATE TABLE quote_lines (id BIGSERIAL PRIMARY KEY, product_id BIGINT REFERENCES products(id));
-- v2: 환율 · 구매 기록
CREATE TABLE fx_rates (id BIGSERIAL PRIMARY KEY, base TEXT, quote TEXT, rate NUMERIC, rate_date DATE);
CREATE TABLE purchase_orders (id BIGSERIAL PRIMARY KEY, ref_no TEXT, order_date DATE, currency TEXT, status TEXT, note TEXT,
  created_by BIGINT, created_at TIMESTAMPTZ DEFAULT now(), deleted_at TIMESTAMPTZ);
CREATE TABLE purchase_order_lines (id BIGSERIAL PRIMARY KEY, po_id BIGINT REFERENCES purchase_orders(id), product_id BIGINT REFERENCES products(id),
  input_code TEXT, qty NUMERIC, unit_cost_usd NUMERIC, amount_usd NUMERIC, received_qty NUMERIC DEFAULT 0);
-- ⑦ 제품 수익성: 매출 · 수입원가 배치
CREATE TABLE sales_invoices (id BIGSERIAL PRIMARY KEY, inv_date DATE, status TEXT, deleted_at TIMESTAMPTZ);
CREATE TABLE sales_invoice_lines (id BIGSERIAL PRIMARY KEY, invoice_id BIGINT REFERENCES sales_invoices(id), product_id BIGINT REFERENCES products(id),
  qty NUMERIC, line_amount_mxn NUMERIC, cogs_mxn NUMERIC, applied_unit_cost NUMERIC);
CREATE TABLE import_batches (id BIGSERIAL PRIMARY KEY, status TEXT, deleted_at TIMESTAMPTZ, currency TEXT DEFAULT 'USD', fx_rate NUMERIC, exclude_from_cost BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE import_lines (id BIGSERIAL PRIMARY KEY, batch_id BIGINT REFERENCES import_batches(id), product_id BIGINT REFERENCES products(id),
  qty NUMERIC, import_price NUMERIC, currency TEXT);
CREATE TABLE import_overheads (id BIGSERIAL PRIMARY KEY, batch_id BIGINT REFERENCES import_batches(id), label TEXT, amount NUMERIC, currency TEXT);
