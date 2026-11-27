-- ═══════════════════════════════════════════════════════════════════════════
-- REFATRIX Platform · 시장 데이터 (월별 신차 판매 EMA × 저장 VIO) · 신규 차종 · 차종별 OE
--   파일: refatrix_market.sql                  생성: 2026-11-27
--   실행: Supabase 대시보드 → SQL Editor → 전체 붙여넣고 RUN (재실행 안전)
--   전제: refatrix_syd_master_v2.sql(_sm_user) · refatrix_syd_price.sql(_sm_dir) 실행 완료
--
--   pf_mkt_sales   — 월별 모델 판매 (EMA "Ventas Menudeo Segmento" 표) · 보고 월 단위로 통째 교체
--   pf_mkt_upload  — 업로드 기록 (보고 월 · 파일 · 행 수 · 업로더)
--   pf_mkt_alias   — EMA 모델 ↔ 차량·부품 마스터 차종 연결 (자동 연결을 사람이 고친 것만)
--   pf_mkt_veh     — 마스터에 없는 신규 차종 (판매 상위에서 자동 등록 · 수동 추가)
--   pf_mkt_oe      — 차종 × 부품 카테고리 × 위치 OE 번호 (+ SYD · CTR · 단가 · 출처 · 메모)
--   pf_mkt_kv      — 설정 (VIO 기준 월 등)
--   RPC
--     app_mkt_all(p_token)                                   → {sales, uploads, alias, veh, kv}     (로그인)
--     app_mkt_put(p_token, p_ym, p_label, p_file, p_rows)    → {saved}  해당 월 교체           (디렉터)
--     app_mkt_del(p_token, p_ym)                             → {deleted}                        (디렉터)
--     app_mkt_alias(p_token, p_ekey, p_vkey)                 → ok   p_vkey null = 자동으로 되돌림 (디렉터)
--     app_mkt_veh_add(p_token, p_rows)                       → {added}  [{k,brand,model,seg,origin,src,auto}] (디렉터)
--     app_mkt_veh_del(p_token, p_k)                          → ok                                (디렉터)
--     app_mkt_kv(p_token, p_k, p_v)                          → ok                                (디렉터)
--     app_mkt_oe_get(p_token, p_vkey)                        → [{cat,pos,oe,syd,ctr,price,src,note,by,at}]  (로그인)
--     app_mkt_oe_set(p_token, p_vkey, p_rows)                → {saved}  그 차종의 OE 표를 통째로 저장 (로그인)
--     app_mkt_oe_all(p_token)                                → [{v,cat,pos,oe,syd,ctr}]           (로그인 · 샘플 계획용)
--     app_mkt_push(p_token, p_k, p_vio, p_yr)                → {rk, version_id, parts}  🆕 신규 차종 → 차량·부품 본체 (디렉터)
--         vehicles(rk 맨 뒤 번호 · brand · model) + versions(세대 'EMA 신규' · 연식 · VIO) + parts(입력한 OE 줄 · 없으면 기본 16줄)
--     app_mkt_veh_erp(p_token, p_k, p_st, p_id, p_msg, p_yf, p_yt) → ok  ERP 차종 전송 결과 기록 (디렉터)
--     app_mkt_unpush(p_token, p_k)                           → ok  본체에서 다시 빼기 — 본체에서 아무도 고치지 않았을 때만 (디렉터)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists pf_mkt_sales (
  ym        text not null,                    -- 보고 월 YYYY-MM
  kind      text not null default 'pas',      -- pas 승용 · com 상용
  brand     text not null default '',
  model     text not null,
  seg       text not null default '',
  origin    text not null default '',
  m         int,                              -- 당월 판매
  m_prev    int,                              -- 전년 같은 달
  ytd       int,                              -- 1월~당월 누적
  ytd_prev  int,                              -- 전년 1월~같은 달 누적
  primary key (ym, kind, brand, model)
);
create table if not exists pf_mkt_upload (
  ym text primary key, label text not null default '', file text not null default '', n int not null default 0,
  at timestamptz not null default now(), by_name text not null default ''
);
create table if not exists pf_mkt_alias (
  ekey text primary key, vkey text not null, at timestamptz not null default now(), by_name text not null default ''
);
create table if not exists pf_mkt_veh (
  k text primary key,                         -- 'NEW|브랜드|모델'
  brand text not null, model text not null, seg text not null default '', origin text not null default '',
  src text not null default '',               -- EMA 모델 키
  auto boolean not null default false,
  at timestamptz not null default now(), by_name text not null default ''
);
create table if not exists pf_mkt_oe (
  vkey text not null,                         -- 마스터 '브랜드|모델' 또는 'NEW|브랜드|모델'
  cat  text not null,                         -- BALL JOINT · INNER TIE ROD …
  pos  text not null default '',              -- Front Lower LH …
  oe   text not null default '',
  syd  text not null default '',
  ctr  text not null default '',
  note text not null default '',
  at timestamptz not null default now(), by_name text not null default '',
  primary key (vkey, cat, pos)
);
alter table pf_mkt_veh add column if not exists pushed_rk int;
alter table pf_mkt_veh add column if not exists pushed_vid bigint;
alter table pf_mkt_veh add column if not exists pushed_at timestamptz;
-- 2026-11-27 — ERP 차종 전송 (POST /api/pf-catalog/vehicles) 상태
alter table pf_mkt_veh add column if not exists erp_st  text not null default '';   -- '' 미전송 · sent 등록 · linked 이미 있음 · pending API 준비 전 · fail 실패
alter table pf_mkt_veh add column if not exists erp_id  text not null default '';
alter table pf_mkt_veh add column if not exists erp_msg text not null default '';
alter table pf_mkt_veh add column if not exists erp_at  timestamptz;
alter table pf_mkt_veh add column if not exists yr_from int;
alter table pf_mkt_veh add column if not exists yr_to   int;
create table if not exists pf_mkt_kv (k text primary key, v text not null default '', at timestamptz not null default now(), by_name text not null default '');
alter table pf_mkt_sales  enable row level security;
alter table pf_mkt_upload enable row level security;
alter table pf_mkt_alias  enable row level security;
alter table pf_mkt_veh    enable row level security;
alter table pf_mkt_oe     enable row level security;
-- 2026-11-27 — 대리점 견적서(Cotización) 단가 · 출처
alter table pf_mkt_oe add column if not exists price numeric(14,2);          -- 단가 (MXN · 부가세 별도)
alter table pf_mkt_oe add column if not exists src   text not null default '';  -- 예: 견적서 · Geely · EMGRAND · 24/11/2026
alter table pf_mkt_kv     enable row level security;

create or replace function app_mkt_all(p_token text)
returns json language plpgsql security definer as $fn$
begin
  perform _sm_user(p_token);
  return json_build_object(
    'sales',   coalesce((select json_agg(json_build_array(ym, kind, brand, model, seg, origin, m, m_prev, ytd, ytd_prev)) from pf_mkt_sales), '[]'::json),
    'uploads', coalesce((select json_agg(json_build_object('ym', ym, 'label', label, 'file', file, 'n', n, 'at', at, 'by', by_name) order by ym) from pf_mkt_upload), '[]'::json),
    'alias',   coalesce((select json_object_agg(ekey, vkey) from pf_mkt_alias), '{}'::json),
    'veh',     coalesce((select json_agg(json_build_object('k', k, 'brand', brand, 'model', model, 'seg', seg, 'origin', origin, 'src', src, 'auto', auto, 'at', at, 'by', by_name, 'pushed_rk', pushed_rk,
                                                   'erp_st', erp_st, 'erp_id', erp_id, 'erp_msg', erp_msg, 'erp_at', erp_at, 'yr_from', yr_from, 'yr_to', yr_to)) from pf_mkt_veh), '[]'::json),
    'oen',     coalesce((select json_object_agg(vkey, n) from (select vkey, count(*) filter (where oe <> '' or syd <> '' or ctr <> '') n from pf_mkt_oe group by vkey) t), '{}'::json),
    'kv',      coalesce((select json_object_agg(k, v) from pf_mkt_kv), '{}'::json));
end $fn$;

-- p_rows = [[kind, brand, model, seg, origin, m, m_prev, ytd, ytd_prev], …] — 그 보고 월 자료를 통째로 바꿈
create or replace function app_mkt_put(p_token text, p_ym text, p_label text, p_file text, p_rows json)
returns json language plpgsql security definer as $fn$
declare nm text; r json; n int := 0;
begin
  nm := _sm_dir(p_token);
  if p_ym !~ '^\d{4}-\d{2}$' then raise exception 'MES_INVALIDO'; end if;
  delete from pf_mkt_sales where ym = p_ym;
  for r in select * from json_array_elements(p_rows) loop
    if coalesce(btrim(r->>2), '') = '' then continue; end if;
    insert into pf_mkt_sales(ym, kind, brand, model, seg, origin, m, m_prev, ytd, ytd_prev)
    values (p_ym, coalesce(nullif(r->>0, ''), 'pas'), coalesce(btrim(r->>1), ''), btrim(r->>2), coalesce(r->>3, ''), coalesce(r->>4, ''),
            nullif(r->>5, '')::numeric::int, nullif(r->>6, '')::numeric::int, nullif(r->>7, '')::numeric::int, nullif(r->>8, '')::numeric::int)
    on conflict (ym, kind, brand, model) do update set m = excluded.m, m_prev = excluded.m_prev, ytd = excluded.ytd, ytd_prev = excluded.ytd_prev, seg = excluded.seg, origin = excluded.origin;
    n := n + 1;
  end loop;
  insert into pf_mkt_upload(ym, label, file, n, at, by_name) values (p_ym, coalesce(p_label, ''), coalesce(p_file, ''), n, now(), nm)
  on conflict (ym) do update set label = excluded.label, file = excluded.file, n = excluded.n, at = excluded.at, by_name = excluded.by_name;
  begin perform app_log(p_token := p_token, p_type := 'user', p_txt := '시장 데이터 업로드 · EMA ' || p_ym || ' · ' || n || '개 모델'); exception when others then null; end;
  return json_build_object('saved', n);
end $fn$;

create or replace function app_mkt_del(p_token text, p_ym text)
returns json language plpgsql security definer as $fn$
declare n int;
begin
  perform _sm_dir(p_token);
  delete from pf_mkt_sales where ym = p_ym; get diagnostics n = row_count;
  delete from pf_mkt_upload where ym = p_ym;
  return json_build_object('deleted', n);
end $fn$;

create or replace function app_mkt_alias(p_token text, p_ekey text, p_vkey text)
returns boolean language plpgsql security definer as $fn$
declare nm text;
begin
  nm := _sm_dir(p_token);
  if p_vkey is null or p_vkey = '' then delete from pf_mkt_alias where ekey = p_ekey; return true; end if;
  insert into pf_mkt_alias(ekey, vkey, at, by_name) values (p_ekey, p_vkey, now(), nm)
  on conflict (ekey) do update set vkey = excluded.vkey, at = excluded.at, by_name = excluded.by_name;
  return true;
end $fn$;

create or replace function app_mkt_veh_add(p_token text, p_rows json)
returns json language plpgsql security definer as $fn$
declare nm text; r json; n int := 0;
begin
  nm := _sm_dir(p_token);
  for r in select * from json_array_elements(p_rows) loop
    if coalesce(r->>'k', '') = '' then continue; end if;
    insert into pf_mkt_veh(k, brand, model, seg, origin, src, auto, at, by_name)
    values (r->>'k', coalesce(r->>'brand', ''), coalesce(r->>'model', ''), coalesce(r->>'seg', ''), coalesce(r->>'origin', ''), coalesce(r->>'src', ''),
            coalesce((r->>'auto')::boolean, false), now(), nm)
    on conflict (k) do nothing;
    if found then n := n + 1; end if;
  end loop;
  return json_build_object('added', n);
end $fn$;

create or replace function app_mkt_veh_del(p_token text, p_k text)
returns boolean language plpgsql security definer as $fn$
begin
  perform _sm_dir(p_token);
  delete from pf_mkt_veh where k = p_k;
  return true;
end $fn$;

create or replace function app_mkt_kv(p_token text, p_k text, p_v text)
returns boolean language plpgsql security definer as $fn$
declare nm text;
begin
  nm := _sm_dir(p_token);
  insert into pf_mkt_kv(k, v, at, by_name) values (p_k, coalesce(p_v, ''), now(), nm)
  on conflict (k) do update set v = excluded.v, at = excluded.at, by_name = excluded.by_name;
  return true;
end $fn$;

create or replace function app_mkt_oe_get(p_token text, p_vkey text)
returns json language plpgsql security definer as $fn$
begin
  perform _sm_user(p_token);
  return coalesce((select json_agg(json_build_object('cat', cat, 'pos', pos, 'oe', oe, 'syd', syd, 'ctr', ctr, 'price', price, 'src', src, 'note', note, 'by', by_name, 'at', at) order by cat, pos)
                     from pf_mkt_oe where vkey = p_vkey), '[]'::json);
end $fn$;

-- p_rows = [{cat,pos,oe,syd,ctr,note}, …] — 그 차종의 OE 표를 통째로 저장 (빈 줄은 지움)
create or replace function app_mkt_oe_set(p_token text, p_vkey text, p_rows json)
returns json language plpgsql security definer as $fn$
declare nm text; r json; n int := 0;
begin
  nm := _sm_user(p_token);
  delete from pf_mkt_oe where vkey = p_vkey;
  for r in select * from json_array_elements(p_rows) loop
    if coalesce(btrim(r->>'oe'), '') = '' and coalesce(btrim(r->>'syd'), '') = '' and coalesce(btrim(r->>'ctr'), '') = '' and coalesce(btrim(r->>'note'), '') = ''
       and coalesce(btrim(r->>'price'), '') = '' then continue; end if;
    insert into pf_mkt_oe(vkey, cat, pos, oe, syd, ctr, price, src, note, at, by_name)
    values (p_vkey, coalesce(r->>'cat', ''), coalesce(r->>'pos', ''), coalesce(btrim(r->>'oe'), ''), upper(coalesce(btrim(r->>'syd'), '')), upper(coalesce(btrim(r->>'ctr'), '')),
            case when coalesce(btrim(r->>'price'), '') ~ '^[0-9]+(\.[0-9]+)?$' then round((r->>'price')::numeric, 2) end, coalesce(r->>'src', ''),
            coalesce(r->>'note', ''), now(), nm)
    on conflict (vkey, cat, pos) do update set oe = excluded.oe, syd = excluded.syd, ctr = excluded.ctr, price = excluded.price, src = excluded.src, note = excluded.note, at = excluded.at, by_name = excluded.by_name;
    n := n + 1;
  end loop;
  begin perform app_log(p_token := p_token, p_type := 'user', p_txt := '시장 데이터 OE 입력 · ' || p_vkey || ' · ' || n || '줄'); exception when others then null; end;
  return json_build_object('saved', n);
end $fn$;

create or replace function app_mkt_oe_all(p_token text)
returns json language plpgsql security definer as $fn$
begin
  perform _sm_user(p_token);
  return coalesce((select json_agg(json_build_object('v', vkey, 'cat', cat, 'pos', pos, 'oe', oe, 'syd', syd, 'ctr', ctr, 'price', price)) from pf_mkt_oe), '[]'::json);
end $fn$;

-- ── 🆕 신규 차종 → 차량·부품 본체 (vehicles · versions · parts) ──────────────
--   id 열에 기본값(시퀀스)이 있으면 그대로 쓰고, 없으면 최대값+1 로 넣음
create or replace function _mkt_has_default(p_tbl text, p_col text)
returns boolean language sql stable as $fn$
  select coalesce((select column_default is not null from information_schema.columns
                    where table_schema = 'public' and table_name = p_tbl and column_name = p_col), false)
$fn$;

create or replace function app_mkt_push(p_token text, p_k text, p_vio bigint, p_yr text)
returns json language plpgsql security definer set search_path = public as $fn$
declare nm text; v pf_mkt_veh; new_rk int; vid bigint; br text; n int := 0; r record; o int := 0; mkey text;
  tpl text[][] := array[['BALL JOINT','Front Lower'],['BALL JOINT','Front Upper'],['INNER TIE ROD','Front'],['OUTER TIE ROD','Front LH'],['OUTER TIE ROD','Front RH'],
    ['CONTROL ARM','Front Lower LH'],['CONTROL ARM','Front Lower RH'],['CONTROL ARM BUSHING','Front Lower'],['STABILIZER LINK','Front'],['STABILIZER LINK','Rear'],
    ['STABILIZER BAR BUSHING','Front'],['SHOCK ABSORBER','Front'],['SHOCK ABSORBER','Rear'],['TOP STRUT MOUNT','Front'],['ENGINE MOUNT',''],['TRANSMISSION MOUNT','']];
begin
  nm := _sm_dir(p_token);
  select * into v from pf_mkt_veh where k = p_k;
  if not found then raise exception '신규 차종 목록에 없습니다: %', p_k; end if;
  if v.pushed_rk is not null and exists (select 1 from vehicles where rk = v.pushed_rk) then
    return json_build_object('rk', v.pushed_rk, 'already', true);
  end if;
  /* 브랜드 표기는 본체에 이미 있는 표기를 따름 (NISSAN → Nissan) */
  select brand into br from vehicles where upper(brand) = upper(v.brand) limit 1;
  br := coalesce(br, initcap(v.brand));
  select rk into new_rk from vehicles where upper(brand) = upper(br) and upper(model) = upper(v.model) limit 1;
  if new_rk is null then
    select coalesce(max(rk), 0) + 1 into new_rk from vehicles;
    insert into vehicles(rk, brand, model) values (new_rk, br, v.model);
  end if;
  if _mkt_has_default('versions', 'id') then
    insert into versions(rk, code, yr, vio) values (new_rk, 'EMA 신규', coalesce(p_yr, ''), coalesce(p_vio, 0)) returning id into vid;
  else
    select coalesce(max(id), 0) + 1 into vid from versions;
    insert into versions(id, rk, code, yr, vio) values (vid, new_rk, 'EMA 신규', coalesce(p_yr, ''), coalesce(p_vio, 0));
  end if;
  /* 부품 줄: 시장 데이터에서 입력한 OE 줄 + 기본 16줄 중 빠진 것 */
  for r in
    select cat, pos, oe, syd, ctr,
           btrim(note || case when price is not null then ' · 견적 단가 $' || to_char(price, 'FM999,999,990.00') || ' (IVA 별도' || case when src <> '' then ' · ' || src else '' end || ')' else '' end, ' ·') as note,
           0 as srt from pf_mkt_oe where vkey = p_k
    union all
    select t.cat, t.pos, '', '', '', '', 1 from (select tpl[gi][1] as cat, tpl[gi][2] as pos from generate_subscripts(tpl, 1) as gs(gi)) t
     where not exists (select 1 from pf_mkt_oe x where x.vkey = p_k and x.cat = t.cat and x.pos = t.pos)
    order by srt, cat, pos
  loop
    o := o + 1;
    if _mkt_has_default('parts', 'id') then
      insert into parts(version_id, ord, blk, name, pos, oe, syd, baw, grob, moog, kyb, vaslo, yoko, ctr, st, note, by_name)
      values (vid, o, case when r.pos ilike 'rear%' then 'R' else 'F' end, r.cat, r.pos, coalesce(r.oe, ''), coalesce(r.syd, ''), '', '', '', '', '', '', coalesce(r.ctr, ''),
              case when coalesce(r.ctr, '') <> '' then 'cand' else 'none' end, coalesce(r.note, ''), nm);
    else
      insert into parts(id, version_id, ord, blk, name, pos, oe, syd, baw, grob, moog, kyb, vaslo, yoko, ctr, st, note, by_name)
      values ((select coalesce(max(id), 0) + 1 from parts), vid, o, case when r.pos ilike 'rear%' then 'R' else 'F' end, r.cat, r.pos, coalesce(r.oe, ''), coalesce(r.syd, ''), '', '', '', '', '', '', coalesce(r.ctr, ''),
              case when coalesce(r.ctr, '') <> '' then 'cand' else 'none' end, coalesce(r.note, ''), nm);
    end if;
    n := n + 1;
  end loop;
  mkey := br || '|' || v.model;
  update pf_mkt_veh set pushed_rk = new_rk, pushed_vid = vid, pushed_at = now() where k = p_k;
  update pf_mkt_oe set vkey = mkey where vkey = p_k and not exists (select 1 from pf_mkt_oe y where y.vkey = mkey and y.cat = pf_mkt_oe.cat and y.pos = pf_mkt_oe.pos);
  if coalesce(v.src, '') <> '' then
    insert into pf_mkt_alias(ekey, vkey, at, by_name) values (v.src, mkey, now(), nm) on conflict (ekey) do update set vkey = excluded.vkey, at = excluded.at, by_name = excluded.by_name;
  end if;
  begin perform app_log(p_token := p_token, p_type := 'user', p_txt := '시장 데이터 → 차량·부품 본체 추가 · #' || new_rk || ' ' || br || ' ' || v.model || ' · 부품 ' || n || '줄'); exception when others then null; end;
  return json_build_object('rk', new_rk, 'version_id', vid, 'parts', n, 'brand', br);
end $fn$;

-- 본체에서 다시 빼기 — 그 세대에 VIN이 없고, 부품을 본체 화면에서 아무도 고치지 않았을 때만
create or replace function app_mkt_unpush(p_token text, p_k text)
returns boolean language plpgsql security definer set search_path = public as $fn$
declare nm text; v pf_mkt_veh; mkey text;
begin
  nm := _sm_dir(p_token);
  select * into v from pf_mkt_veh where k = p_k;
  if not found or v.pushed_vid is null then raise exception '본체로 보낸 기록이 없습니다'; end if;
  if exists (select 1 from vins where version_id = v.pushed_vid) then raise exception 'VIN이 등록된 차종이라 뺄 수 없습니다 — 차량·부품 화면에서 정리하세요'; end if;
  if exists (select 1 from parts where version_id = v.pushed_vid and (coalesce(oe_by, '') <> '' or coalesce(syd_by, '') <> '' or coalesce(ctr_prev, '') <> '' or coalesce(syd_prev, '') <> '' or coalesce(oe_prev, '') <> '')) then
    raise exception '본체 화면에서 이미 고친 부품이 있어 뺄 수 없습니다';
  end if;
  select brand || '|' || model into mkey from vehicles where rk = v.pushed_rk;
  delete from parts where version_id = v.pushed_vid;
  delete from versions where id = v.pushed_vid;
  if not exists (select 1 from versions where rk = v.pushed_rk) then delete from vehicles where rk = v.pushed_rk; end if;
  if mkey is not null then
    update pf_mkt_oe set vkey = p_k where vkey = mkey;
    delete from pf_mkt_alias where ekey = v.src and vkey = mkey;
  end if;
  update pf_mkt_veh set pushed_rk = null, pushed_vid = null, pushed_at = null where k = p_k;
  return true;
end $fn$;

-- ERP 차종 전송 결과 기록 (전송은 화면에서 ERP API 로 — 여기서는 상태만 남김)
create or replace function app_mkt_veh_erp(p_token text, p_k text, p_st text, p_id text, p_msg text, p_yf int, p_yt int)
returns boolean language plpgsql security definer as $fn$
declare nm text;
begin
  nm := _sm_dir(p_token);
  if coalesce(p_st, '') not in ('', 'sent', 'linked', 'pending', 'fail') then raise exception 'ESTADO_INVALIDO'; end if;
  update pf_mkt_veh set erp_st = coalesce(p_st, ''), erp_id = coalesce(p_id, ''), erp_msg = left(coalesce(p_msg, ''), 500), erp_at = now(),
                        yr_from = coalesce(p_yf, yr_from), yr_to = p_yt
   where k = p_k;
  if not found then raise exception '신규 차종 목록에 없습니다: %', p_k; end if;
  if p_st in ('sent', 'linked') then
    begin perform app_log(p_token := p_token, p_type := 'user', p_txt := 'ERP 차종 전송 · ' || p_k || ' · ' || p_st || case when coalesce(p_id, '') <> '' then ' #' || p_id else '' end); exception when others then null; end;
  end if;
  return true;
end $fn$;

grant execute on function app_mkt_veh_erp(text, text, text, text, text, int, int) to anon, authenticated;
grant execute on function app_mkt_push(text, text, bigint, text)     to anon, authenticated;
grant execute on function app_mkt_unpush(text, text)                 to anon, authenticated;
grant execute on function app_mkt_all(text)                          to anon, authenticated;
grant execute on function app_mkt_put(text, text, text, text, json)  to anon, authenticated;
grant execute on function app_mkt_del(text, text)                    to anon, authenticated;
grant execute on function app_mkt_alias(text, text, text)            to anon, authenticated;
grant execute on function app_mkt_veh_add(text, json)                to anon, authenticated;
grant execute on function app_mkt_veh_del(text, text)                to anon, authenticated;
grant execute on function app_mkt_kv(text, text, text)               to anon, authenticated;
grant execute on function app_mkt_oe_get(text, text)                 to anon, authenticated;
grant execute on function app_mkt_oe_set(text, text, json)           to anon, authenticated;
grant execute on function app_mkt_oe_all(text)                       to anon, authenticated;

select '시장 데이터 모듈 준비 완료 — 보고 월 ' || (select count(*) from pf_mkt_upload) || '개 · 판매 ' || (select count(*) from pf_mkt_sales) || '줄' as resultado;
