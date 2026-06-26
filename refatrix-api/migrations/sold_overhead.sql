WITH batch AS (
  SELECT il.product_id AS pid,
         SUM(il.qty)                            AS imp_qty,
         SUM(il.qty * il.unit_cost_mxn)         AS landed_mxn,
         SUM(il.qty * COALESCE(il.import_price,0)
             * CASE WHEN b.currency='USD' AND b.fx_rate IS NOT NULL
                    THEN b.fx_rate ELSE 1 END)  AS base_mxn,
         SUM(CASE WHEN COALESCE(il.import_price,0)=0 THEN il.qty ELSE 0 END) AS zerobase_qty
    FROM import_lines il
    JOIN import_batches b ON b.id=il.batch_id
                         AND b.deleted_at IS NULL
                         AND b.exclude_from_cost IS NOT TRUE
   GROUP BY il.product_id
),
unit AS (
  SELECT pid, imp_qty, zerobase_qty,
         CASE WHEN imp_qty>0 THEN GREATEST(0, landed_mxn-base_mxn)/imp_qty ELSE 0 END AS oh_unit
    FROM batch
),
sold AS (
  SELECT sil.product_id AS pid,
         SUM(sil.qty)                                                    AS sold_qty,
         SUM(COALESCE(sil.cogs_mxn, sil.qty*sil.applied_unit_cost, 0))   AS cogs
    FROM sales_invoice_lines sil
    JOIN sales_invoices si ON si.id=sil.invoice_id
   WHERE si.status='posted' AND si.deleted_at IS NULL
   GROUP BY sil.product_id
)
SELECT
  ROUND(SUM(s.cogs)::numeric,2)                                     AS sold_cogs_mxn,
  ROUND(SUM(u.oh_unit * s.sold_qty)::numeric,2)                     AS sold_overhead_mxn,
  ROUND(SUM(CASE WHEN u.zerobase_qty>0 THEN u.oh_unit*s.sold_qty ELSE 0 END)::numeric,2)
                                                                    AS overhead_from_zerobase_mxn,
  ROUND(100.0*SUM(u.oh_unit*s.sold_qty)/NULLIF(SUM(s.cogs),0),1)    AS overhead_pct_of_cogs
FROM sold s
LEFT JOIN unit u ON u.pid=s.pid;
