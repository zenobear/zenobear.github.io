/* ===================== Supabase schema (also shown in Settings) ===================== */
const SCHEMA_SQL = `-- ============================================================
-- Till — Supabase schema
-- Run this once in Supabase: Project → SQL Editor → New query → paste → Run
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE throughout.
-- ============================================================

-- ---------- Sequences (used to generate human-readable IDs) ----------
create sequence if not exists product_seq;
create sequence if not exists txn_seq;
create sequence if not exists return_seq;
create sequence if not exists exchange_seq;
create sequence if not exists category_seq;
create sequence if not exists series_seq;
create sequence if not exists event_seq;
create sequence if not exists pos_seq;
create sequence if not exists staff_seq;

-- ---------- Tables ----------
create table if not exists products (
  id text primary key,
  barcode text,
  name text not null,
  category text,
  series text,
  cost numeric not null default 0,
  price numeric not null default 0,
  stock int not null default 0,
  min_stock int not null default 0,
  product_discount numeric not null default 0,
  status text not null default 'Active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists categories (
  id text primary key default ('C' || lpad(nextval('category_seq')::text, 4, '0')),
  name text unique not null,
  discount numeric not null default 0
);

create table if not exists series (
  id text primary key default ('S' || lpad(nextval('series_seq')::text, 4, '0')),
  name text not null,
  category text,
  discount numeric not null default 0
);

create table if not exists bazaars (
  id text primary key default ('EVT' || lpad(nextval('event_seq')::text, 4, '0')),
  name text not null,
  location text,
  start_date date,
  end_date date,
  status text not null default 'Planned',
  category_discounts jsonb not null default '{}'::jsonb
);

create table if not exists pos_devices (
  id text primary key default ('POS-' || lpad(nextval('pos_seq')::text, 2, '0')),
  name text not null,
  type text,
  status text not null default 'Active',
  last_activity timestamptz not null default now()
);

create table if not exists staff (
  id text primary key default ('ST' || lpad(nextval('staff_seq')::text, 4, '0')),
  name text unique not null,
  status text not null default 'Active'
);

create table if not exists transactions (
  id text primary key,
  ts timestamptz not null default now(),
  pos_id text,
  pos_name text,
  event_id text,
  event_name text,
  staff_name text,
  subtotal numeric not null default 0,
  total_discount numeric not null default 0,
  total numeric not null default 0,
  payment text,
  cash_received numeric,
  change numeric,
  status text not null default 'COMPLETED'
);

create table if not exists transaction_items (
  id bigserial primary key,
  transaction_id text references transactions(id),
  product_id text,
  product_name text,
  category text,
  series text,
  qty int not null,
  original_price numeric,
  discount_pct numeric,
  discount_amt numeric,
  final_price numeric,
  subtotal numeric
);

create table if not exists inventory_movements (
  id bigserial primary key,
  ts timestamptz not null default now(),
  product_id text,
  product_name text,
  type text,
  qty int,
  reference text,
  transaction_id text,
  pos_id text,
  reason text
);

create table if not exists payments (
  id text primary key,
  transaction_id text references transactions(id),
  pos_id text,
  method text,
  amount numeric,
  change numeric,
  status text
);

create table if not exists returns (
  id text primary key,
  transaction_id text references transactions(id),
  product_id text,
  product_name text,
  qty int,
  reason text,
  amount numeric,
  ts timestamptz not null default now()
);

create table if not exists exchanges (
  id text primary key,
  transaction_id text references transactions(id),
  old_product_id text,
  old_qty int,
  new_product_id text,
  new_qty int,
  price_difference numeric,
  settlement_method text,
  ts timestamptz not null default now()
);

-- ---------- Row Level Security ----------
-- Every table below is readable by anyone holding the public "anon" key
-- (this app has no login, by design — see the README notes in the app's
-- Settings tab). Writes are NOT allowed directly on any table; every
-- mutation goes through a SECURITY DEFINER function below, so the anon
-- key alone cannot corrupt stock counts or bypass the discount/oversell
-- logic even though it can read everything.
alter table products enable row level security;
alter table categories enable row level security;
alter table series enable row level security;
alter table bazaars enable row level security;
alter table pos_devices enable row level security;
alter table staff enable row level security;
alter table transactions enable row level security;
alter table transaction_items enable row level security;
alter table inventory_movements enable row level security;
alter table payments enable row level security;
alter table returns enable row level security;
alter table exchanges enable row level security;

do $$
declare t text;
begin
  foreach t in array array['products','categories','series','bazaars','pos_devices','staff','transactions','transaction_items','inventory_movements','payments','returns','exchanges']
  loop
    execute format('drop policy if exists "public read" on %I', t);
    execute format('create policy "public read" on %I for select using (true)', t);
  end loop;
end $$;

-- ---------- Realtime (so every device sees changes live, no polling) ----------
alter publication supabase_realtime add table products, transactions, inventory_movements, returns, exchanges;

-- ---------- Helper: discount priority (product > series > active bazaar override > category) ----------
create or replace function effective_discount(p products) returns numeric
language plpgsql stable as $$
declare
  s_disc numeric;
  active_bazaar bazaars;
  b_disc numeric;
  c_disc numeric;
begin
  if p.product_discount > 0 then return p.product_discount; end if;
  select discount into s_disc from series where name = p.series order by id limit 1;
  if s_disc is not null and s_disc > 0 then return s_disc; end if;
  select * into active_bazaar from bazaars where status = 'Active' limit 1;
  if active_bazaar.id is not null then
    b_disc := nullif(active_bazaar.category_discounts ->> p.category, '')::numeric;
    if b_disc is not null and b_disc > 0 then return b_disc; end if;
  end if;
  select discount into c_disc from categories where name = p.category order by id limit 1;
  return coalesce(c_disc, 0);
end;
$$;

-- ---------- Full state snapshot (one round trip for the client) ----------
create or replace function get_state() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'products', coalesce((select jsonb_agg(p) from products p), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(c) from categories c), '[]'::jsonb),
    'series', coalesce((select jsonb_agg(s) from series s), '[]'::jsonb),
    'bazaars', coalesce((select jsonb_agg(b) from bazaars b), '[]'::jsonb),
    'posDevices', coalesce((select jsonb_agg(d) from pos_devices d), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(st) from staff st), '[]'::jsonb),
    'transactions', coalesce((select jsonb_agg(t) from (select * from transactions order by ts desc limit 400) t), '[]'::jsonb),
    'transactionItems', coalesce((select jsonb_agg(ti) from transaction_items ti), '[]'::jsonb),
    'movements', coalesce((select jsonb_agg(m) from (select * from inventory_movements order by ts desc limit 600) m), '[]'::jsonb),
    'returns', coalesce((select jsonb_agg(r) from (select * from returns order by ts desc) r), '[]'::jsonb),
    'exchanges', coalesce((select jsonb_agg(x) from (select * from exchanges order by ts desc) x), '[]'::jsonb)
  );
$$;

-- ---------- Mutations (all SECURITY DEFINER — the only way to write) ----------

create or replace function add_product(p_id text, p_name text, p_category text, p_series text, p_cost numeric, p_price numeric, p_stock int, p_min_stock int, p_discount numeric)
returns jsonb language plpgsql security definer as $$
declare v_id text;
begin
  v_id := nullif(trim(p_id), '');
  if v_id is null then v_id := 'P' || lpad(nextval('product_seq')::text, 6, '0'); end if;
  insert into products(id, barcode, name, category, series, cost, price, stock, min_stock, product_discount)
    values (v_id, v_id, p_name, p_category, p_series, p_cost, p_price, p_stock, p_min_stock, p_discount);
  return jsonb_build_object('id', v_id);
end;
$$;

create or replace function update_product(p_id text, p_name text, p_category text, p_series text, p_cost numeric, p_price numeric, p_stock int, p_min_stock int, p_discount numeric)
returns jsonb language plpgsql security definer as $$
begin
  update products set name=p_name, category=p_category, series=p_series, cost=p_cost, price=p_price, stock=p_stock, min_stock=p_min_stock, product_discount=p_discount, updated_at=now()
    where id = p_id;
  if not found then raise exception 'Product not found'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function set_product_status(p_id text, p_status text)
returns jsonb language plpgsql security definer as $$
begin
  update products set status = p_status, updated_at = now() where id = p_id;
  if not found then raise exception 'Product not found'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function stock_in(p_product_id text, p_qty int, p_reference text, p_pos_id text)
returns jsonb language plpgsql security definer as $$
declare v_new_stock int; v_name text;
begin
  update products set stock = stock + p_qty, updated_at = now()
    where id = p_product_id returning stock, name into v_new_stock, v_name;
  if not found then raise exception 'Product not found'; end if;
  insert into inventory_movements(product_id, product_name, type, qty, reference, reason, pos_id)
    values (p_product_id, v_name, 'STOCK IN', p_qty, coalesce(p_reference, ''), 'New stock', p_pos_id);
  return jsonb_build_object('ok', true, 'newStock', v_new_stock);
end;
$$;

create or replace function adjust_stock(p_product_id text, p_actual_stock int, p_reason text, p_pos_id text)
returns jsonb language plpgsql security definer as $$
declare v_old int; v_diff int; v_name text;
begin
  select stock, name into v_old, v_name from products where id = p_product_id for update;
  if not found then raise exception 'Product not found'; end if;
  v_diff := p_actual_stock - v_old;
  update products set stock = p_actual_stock, updated_at = now() where id = p_product_id;
  insert into inventory_movements(product_id, product_name, type, qty, reference, reason, pos_id)
    values (p_product_id, v_name, 'ADJUSTMENT', v_diff, 'ADJ-' || to_char(now(), 'YYYYMMDDHH24MISS'), coalesce(p_reason, ''), p_pos_id);
  return jsonb_build_object('ok', true, 'diff', v_diff);
end;
$$;

-- The critical one: validates AND deducts stock atomically per line item.
-- If any line's UPDATE affects 0 rows (stock ran out concurrently), the
-- whole function raises and Postgres rolls back every insert/update made
-- so far in this call — no partial sale, no oversold item.
create or replace function create_sale(p_items jsonb, p_payment text, p_cash_received numeric, p_pos_id text, p_pos_name text, p_staff_name text)
returns jsonb language plpgsql security definer as $$
declare
  item jsonb;
  prod products;
  disc numeric; orig numeric; disc_amt numeric; final_price numeric; line_sub numeric;
  v_subtotal numeric := 0; v_discount numeric := 0; v_total numeric := 0;
  v_txn_id text; v_change numeric; v_active bazaars; v_updated int;
  results jsonb := '[]'::jsonb;
begin
  if jsonb_array_length(p_items) = 0 then raise exception 'Cart is empty'; end if;

  for item in select * from jsonb_array_elements(p_items) loop
    select * into prod from products where id = item->>'productId';
    if prod is null then raise exception 'Product not found: %', item->>'productId'; end if;
    if prod.stock < (item->>'qty')::int then
      raise exception 'INSUFFICIENT STOCK. Only % unit(s) of % are currently available.', prod.stock, prod.name;
    end if;
  end loop;

  select * into v_active from bazaars where status = 'Active' limit 1;
  v_txn_id := lpad(nextval('txn_seq')::text, 6, '0');

  for item in select * from jsonb_array_elements(p_items) loop
    select * into prod from products where id = item->>'productId' for update;
    disc := effective_discount(prod);
    orig := prod.price;
    disc_amt := round(orig * disc / 100, 2);
    final_price := round(orig - disc_amt, 2);
    line_sub := round(final_price * (item->>'qty')::int, 2);
    v_subtotal := v_subtotal + orig * (item->>'qty')::int;
    v_discount := v_discount + disc_amt * (item->>'qty')::int;
    v_total := v_total + line_sub;

    update products set stock = stock - (item->>'qty')::int, updated_at = now()
      where id = prod.id and stock >= (item->>'qty')::int;
    get diagnostics v_updated = row_count;
    if v_updated = 0 then
      raise exception 'INSUFFICIENT STOCK. % is no longer available in that quantity.', prod.name;
    end if;

    insert into transaction_items(transaction_id, product_id, product_name, category, series, qty, original_price, discount_pct, discount_amt, final_price, subtotal)
      values (v_txn_id, prod.id, prod.name, prod.category, prod.series, (item->>'qty')::int, orig, disc, disc_amt, final_price, line_sub);
    insert into inventory_movements(product_id, product_name, type, qty, reference, transaction_id, pos_id, reason)
      values (prod.id, prod.name, 'SALE', -(item->>'qty')::int, '#' || v_txn_id, v_txn_id, p_pos_id, 'Sale');

    results := results || jsonb_build_object('productId', prod.id, 'name', prod.name, 'category', prod.category, 'series', prod.series, 'qty', (item->>'qty')::int, 'originalPrice', orig, 'discountPct', disc, 'discountAmt', disc_amt, 'finalPrice', final_price, 'subtotal', line_sub);
  end loop;

  v_change := case when p_payment = 'Cash' then round(p_cash_received - v_total, 2) else null end;

  insert into transactions(id, ts, pos_id, pos_name, event_id, event_name, staff_name, subtotal, total_discount, total, payment, cash_received, change, status)
    values (v_txn_id, now(), p_pos_id, p_pos_name, v_active.id, v_active.name, p_staff_name, round(v_subtotal,2), round(v_discount,2), round(v_total,2), p_payment, p_cash_received, v_change, 'COMPLETED');
  insert into payments(id, transaction_id, pos_id, method, amount, change, status)
    values ('PAY' || v_txn_id, v_txn_id, p_pos_id, p_payment, round(v_total,2), v_change, 'PAID');

  return jsonb_build_object('ok', true, 'txnId', v_txn_id, 'subtotal', round(v_subtotal,2), 'totalDiscount', round(v_discount,2), 'total', round(v_total,2), 'change', v_change, 'items', results, 'timestamp', now(), 'eventName', v_active.name);
end;
$$;

create or replace function do_return(p_transaction_id text, p_product_id text, p_qty int, p_reason text, p_amount numeric, p_pos_id text)
returns jsonb language plpgsql security definer as $$
declare v_id text; v_name text;
begin
  update products set stock = stock + p_qty, updated_at = now()
    where id = p_product_id returning name into v_name;
  if not found then raise exception 'Product not found'; end if;
  v_id := 'R' || lpad(nextval('return_seq')::text, 6, '0');
  insert into returns(id, transaction_id, product_id, product_name, qty, reason, amount)
    values (v_id, p_transaction_id, p_product_id, v_name, p_qty, p_reason, p_amount);
  insert into inventory_movements(product_id, product_name, type, qty, reference, transaction_id, pos_id, reason)
    values (p_product_id, v_name, 'RETURN', p_qty, '#' || p_transaction_id, p_transaction_id, p_pos_id, 'Return: ' || coalesce(p_reason,''));
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

create or replace function do_exchange(p_transaction_id text, p_old_product_id text, p_old_qty int, p_new_product_id text, p_new_qty int, p_pos_id text)
returns jsonb language plpgsql security definer as $$
declare
  old_prod products; new_prod products;
  old_disc numeric; new_disc numeric; old_final numeric; new_final numeric; old_total numeric; new_total numeric; diff numeric;
  v_id text; v_updated int;
begin
  select * into old_prod from products where id = p_old_product_id for update;
  select * into new_prod from products where id = p_new_product_id for update;
  if old_prod is null or new_prod is null then raise exception 'Product not found'; end if;
  if new_prod.stock < p_new_qty then
    raise exception 'INSUFFICIENT STOCK. Only % unit(s) of % are currently available.', new_prod.stock, new_prod.name;
  end if;

  update products set stock = stock + p_old_qty, updated_at = now() where id = p_old_product_id;
  update products set stock = stock - p_new_qty, updated_at = now() where id = p_new_product_id and stock >= p_new_qty;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then raise exception 'INSUFFICIENT STOCK. % is no longer available.', new_prod.name; end if;

  old_disc := effective_discount(old_prod); new_disc := effective_discount(new_prod);
  old_final := round(old_prod.price * (1 - old_disc/100), 2);
  new_final := round(new_prod.price * (1 - new_disc/100), 2);
  old_total := round(old_final * p_old_qty, 2);
  new_total := round(new_final * p_new_qty, 2);
  diff := round(new_total - old_total, 2);

  v_id := 'EX' || lpad(nextval('exchange_seq')::text, 6, '0');
  insert into exchanges(id, transaction_id, old_product_id, old_qty, new_product_id, new_qty, price_difference)
    values (v_id, p_transaction_id, p_old_product_id, p_old_qty, p_new_product_id, p_new_qty, diff);
  insert into inventory_movements(product_id, product_name, type, qty, reference, transaction_id, pos_id, reason)
    values (p_old_product_id, old_prod.name, 'EXCHANGE', p_old_qty, '#' || p_transaction_id, p_transaction_id, p_pos_id, 'Exchange out');
  insert into inventory_movements(product_id, product_name, type, qty, reference, transaction_id, pos_id, reason)
    values (p_new_product_id, new_prod.name, 'EXCHANGE', -p_new_qty, '#' || p_transaction_id, p_transaction_id, p_pos_id, 'Exchange in');

  return jsonb_build_object('ok', true, 'id', v_id, 'priceDifference', diff, 'oldTotal', old_total, 'newTotal', new_total);
end;
$$;

create or replace function add_category(p_name text, p_discount numeric)
returns jsonb language plpgsql security definer as $$
declare v_id text;
begin
  insert into categories(name, discount) values (p_name, coalesce(p_discount,0)) returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;

create or replace function add_series(p_name text, p_category text, p_discount numeric)
returns jsonb language plpgsql security definer as $$
declare v_id text;
begin
  insert into series(name, category, discount) values (p_name, p_category, coalesce(p_discount,0)) returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;

create or replace function add_bazaar(p_name text, p_location text, p_status text, p_start_date date, p_end_date date, p_category_discounts jsonb)
returns jsonb language plpgsql security definer as $$
declare v_id text;
begin
  insert into bazaars(name, location, status, start_date, end_date, category_discounts)
    values (p_name, p_location, coalesce(p_status,'Planned'), p_start_date, p_end_date, coalesce(p_category_discounts,'{}'::jsonb))
    returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;

create or replace function update_bazaar_status(p_id text, p_status text)
returns jsonb language plpgsql security definer as $$
begin
  update bazaars set status = p_status where id = p_id;
  if not found then raise exception 'Event not found'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function add_pos(p_name text, p_type text)
returns jsonb language plpgsql security definer as $$
declare v_id text;
begin
  insert into pos_devices(name, type) values (p_name, p_type) returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;

create or replace function add_staff(p_name text)
returns jsonb language plpgsql security definer as $$
declare v_id text; v_existing text;
begin
  select id into v_existing from staff where lower(name) = lower(trim(p_name));
  if v_existing is not null then return jsonb_build_object('id', v_existing, 'existed', true); end if;
  insert into staff(name) values (trim(p_name)) returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;

-- ---------- Grants ----------
-- Direct table writes are intentionally NOT granted to anon/authenticated —
-- everything mutating goes through the SECURITY DEFINER functions above.
grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;
grant execute on function
  get_state, effective_discount,
  add_product, update_product, set_product_status,
  stock_in, adjust_stock, create_sale, do_return, do_exchange,
  add_category, add_series, add_bazaar, update_bazaar_status,
  add_pos, add_staff
  to anon, authenticated;

-- ============================================================
-- Done. Next: Project Settings → API → copy the Project URL and the
-- "anon public" key into this app's Connect screen.
-- ============================================================
`;

/* ===================== State ===================== */
let cache = { products:[], categories:[], series:[], sizes:[], colors:[], bazaars:[], posDevices:[], staff:[], transactions:[], movements:[], returns:[], exchanges:[] };
/* ===================== Supabase project credentials ===================== */
/* Fill these in ONCE and push to GitHub — every device then connects
   automatically and never sees the "Connect your database" screen.
   Get these from your Supabase project: Project Settings → API.
   The anon key is meant to be public/embeddable — it's safe here as long
   as the schema's Row Level Security stays in place (see schema.sql). */
const SUPABASE_URL = '';
const SUPABASE_ANON_KEY = '';

let local = { supabaseUrl:'', supabaseAnonKey:'', posId:'', posName:'', posType:'', staffName:'', shopName:'Zeno Bear', currency:'₱' };
let sb = null; // Supabase client instance
let realtimeChannel = null;
let refreshDebounceTimer = null;
let cart = [];
let selectedPayment = null;
let html5Scanner = null;
let scanTargetField = null;
let siProduct = null, adjProduct = null;
let reportPeriod = 'today';
let replaceIndex = null;
let returnCtx = null;
let exchangeCtx = null;
let pollTimer = null;
let busy = false;
let currentRole = null; // 'staff' | 'owner' — chosen fresh each app open, never persisted

document.getElementById('onboardScriptBlock').textContent = SCHEMA_SQL;

/* ===================== Local (per-device) settings ===================== */
/* Uses the browser's own localStorage — this is a normal hosted site now,
   not a Claude.ai artifact, so settings are saved directly in the browser
   on whichever device/browser is being used. */
async function loadLocal(){
  try{
    const raw = localStorage.getItem('till-local-settings');
    if(raw) local = Object.assign(local, JSON.parse(raw));
  }catch(e){}
}
async function saveLocal(){
  try{ localStorage.setItem('till-local-settings', JSON.stringify(local)); }catch(e){}
}

/* ===================== Supabase client / API layer ===================== */
function initSupabase(){
  if(!local.supabaseUrl || !local.supabaseAnonKey) return false;
  try{
    sb = window.supabase.createClient(local.supabaseUrl, local.supabaseAnonKey);
    return true;
  }catch(e){ return false; }
}
async function apiGet(){
  const { data, error } = await sb.rpc('get_state');
  if(error) throw new Error(error.message);
  return data;
}
async function apiPost(fnName, params){
  const { data, error } = await sb.rpc(fnName, params);
  if(error) throw new Error(error.message.replace(/^.*?:\s*/, ''));
  if(data && data.error) throw new Error(data.error);
  return data;
}

function normProduct(r){ return {id:r.id, barcode:r.barcode, name:r.name, category:r.category, series:r.series, size:r.size||'', color:r.color||'', cost:Number(r.cost)||0, price:Number(r.price)||0, stock:Number(r.stock)||0, minStock:Number(r.min_stock)||0, discount:Number(r.product_discount)||0, status:r.status||'Active'}; }
function normCategory(r){ return {id:r.id, name:r.name, code:r.code||'', discount:Number(r.discount)||0}; }
function normSeries(r){ return {id:r.id, name:r.name, code:r.code||'', category:r.category, discount:Number(r.discount)||0}; }
function normSize(r){ return {id:r.id, name:r.name}; }
function normColor(r){ return {id:r.id, name:r.name}; }
function normBazaar(r){ return {id:r.id, name:r.name, location:r.location, startDate:r.start_date, endDate:r.end_date, status:r.status, categoryDiscountsJSON:JSON.stringify(r.category_discounts||{})}; }
function normPos(r){ return {id:r.id, name:r.name, type:r.type, status:r.status}; }
function normStaff(r){ return {id:r.id, name:r.name, status:r.status}; }
function normMovement(r){ return {date:r.ts, productId:r.product_id, product:r.product_name, type:r.type, qty:Number(r.qty)||0, reference:r.reference, txnId:r.transaction_id, posId:r.pos_id, reason:r.reason}; }
function normReturn(r){ return {id:r.id, txnId:r.transaction_id, productId:r.product_id, productName:r.product_name, qty:Number(r.qty)||0, reason:r.reason, amount:Number(r.amount)||0, date:r.ts}; }
function normExchange(r){ return {id:r.id, txnId:r.transaction_id, oldProductId:r.old_product_id, oldQty:Number(r.old_qty)||0, newProductId:r.new_product_id, newQty:Number(r.new_qty)||0, priceDifference:Number(r.price_difference)||0, date:r.ts}; }
function normTxn(t, itemsRaw){
  const items = itemsRaw.filter(it=>it.transaction_id===t.id).map(it=>({
    productId:it.product_id, name:it.product_name, category:it.category, series:it.series, qty:Number(it.qty)||0,
    originalPrice:Number(it.original_price)||0, discountPct:Number(it.discount_pct)||0, discountAmt:Number(it.discount_amt)||0,
    finalPrice:Number(it.final_price)||0, subtotal:Number(it.subtotal)||0
  }));
  return {id:t.id, timestamp:t.ts, posId:t.pos_id, posName:t.pos_name, eventId:t.event_id, eventName:t.event_name, staffName:t.staff_name||'',
    subtotal:Number(t.subtotal)||0, totalDiscount:Number(t.total_discount)||0, total:Number(t.total)||0,
    payment:t.payment, cashReceived:t.cash_received, change:t.change, status:t.status, items};
}

async function refreshState(silent){
  if(!sb && !initSupabase()){ setConn(false); return false; }
  try{
    const data = await apiGet();
    cache.products = (data.products||[]).map(normProduct);
    cache.categories = (data.categories||[]).map(normCategory);
    cache.series = (data.series||[]).map(normSeries);
    cache.sizes = (data.sizes||[]).map(normSize);
    cache.colors = (data.colors||[]).map(normColor);
    cache.bazaars = (data.bazaars||[]).map(normBazaar);
    cache.posDevices = (data.posDevices||[]).map(normPos);
    cache.staff = (data.staff||[]).map(normStaff);
    const itemsRaw = data.transactionItems||[];
    cache.transactions = (data.transactions||[]).map(t=>normTxn(t, itemsRaw));
    cache.movements = (data.movements||[]).map(normMovement);
    cache.returns = (data.returns||[]).map(normReturn);
    cache.exchanges = (data.exchanges||[]).map(normExchange);
    setConn(true);
    renderAll();
    ensureRealtime();
    return true;
  }catch(e){
    setConn(false);
    if(!silent) showToast('Could not reach Supabase: '+e.message, true);
    return false;
  }
}
function setConn(ok){
  [['sideConnDot','sideConnText'],['topConnDot','topConnText']].forEach(([d,t])=>{
    const dot=document.getElementById(d), txt=document.getElementById(t);
    if(!dot) return;
    dot.className = 'conn-dot ' + (ok?'ok':'bad');
    txt.textContent = ok ? 'Live' : 'Offline';
  });
}
function debouncedRefresh(){
  clearTimeout(refreshDebounceTimer);
  refreshDebounceTimer = setTimeout(()=>refreshState(true), 350);
}
function ensureRealtime(){
  if(realtimeChannel || !sb) return;
  realtimeChannel = sb.channel('till-live')
    .on('postgres_changes', {event:'*', schema:'public', table:'products'}, debouncedRefresh)
    .on('postgres_changes', {event:'*', schema:'public', table:'transactions'}, debouncedRefresh)
    .on('postgres_changes', {event:'*', schema:'public', table:'inventory_movements'}, debouncedRefresh)
    .on('postgres_changes', {event:'*', schema:'public', table:'returns'}, debouncedRefresh)
    .on('postgres_changes', {event:'*', schema:'public', table:'exchanges'}, debouncedRefresh)
    .subscribe();
}

/* ===================== Helpers ===================== */
function fmt(n){ return (local.currency||'₱') + Number(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function showToast(msg, isErr){ const t=document.getElementById('toast'); t.textContent=msg; t.className='toast show'+(isErr?' err':''); clearTimeout(showToast._t); showToast._t=setTimeout(()=>t.classList.remove('show'),3200); }
function findProduct(code){ if(!code) return null; const c=code.trim().toLowerCase(); return cache.products.find(p=>p.id.toLowerCase()===c)||null; }
function stockStatus(p){ if(p.stock<=0) return 'out'; if(p.stock<=p.minStock) return 'low'; return 'ok'; }
function activeBazaar(){ return cache.bazaars.find(b=>b.status==='Active')||null; }
function clientEffectiveDiscount(p){
  if(p.discount>0) return p.discount;
  const s = cache.series.find(x=>x.name===p.series);
  if(s && s.discount>0) return s.discount;
  const b = activeBazaar();
  if(b){ try{ const map=JSON.parse(b.categoryDiscountsJSON||'{}'); if(map[p.category]!==undefined && Number(map[p.category])>0) return Number(map[p.category]); }catch(e){} }
  const c = cache.categories.find(x=>x.name===p.category);
  return c ? (c.discount||0) : 0;
}
function todayStart(){ const d=new Date(); d.setHours(0,0,0,0); return d; }
function todayTxns(){ const t=todayStart(); return cache.transactions.filter(x=>new Date(x.timestamp)>=t); }
async function withBusy(fn){
  if(busy) return;
  busy = true;
  const btn = document.getElementById('refreshBtn');
  if(btn) btn.classList.add('spin');
  try{ await fn(); } finally { busy=false; if(btn) btn.classList.remove('spin'); }
}

/* ===================== Onboarding ===================== */
document.getElementById('onboardCopyScriptBtn').onclick = ()=>navigator.clipboard.writeText(SCHEMA_SQL).then(()=>showToast('Schema copied.'));
document.getElementById('onboardConnectBtn').onclick = async ()=>{
  const url = document.getElementById('onboardUrl').value.trim();
  const key = document.getElementById('onboardKey').value.trim();
  if(!url || !key){ document.getElementById('onboardMsg').textContent = 'Paste both your Project URL and anon public key.'; return; }
  document.getElementById('onboardMsg').textContent = 'Connecting…';
  local.supabaseUrl = url; local.supabaseAnonKey = key;
  sb = null;
  const ok = await refreshState(true);
  if(ok){ await saveLocal(); startApp(); }
  else { document.getElementById('onboardMsg').textContent = "Couldn't reach Supabase with those credentials. Check the URL/key and that you ran the schema SQL, then try again."; local.supabaseUrl=''; local.supabaseAnonKey=''; sb=null; }
};

function startApp(){
  document.getElementById('connectScreen').style.display = 'none';
  document.getElementById('roleShopName').textContent = local.shopName || 'Zeno Bear';
  document.getElementById('roleShopMark').textContent = (local.shopName||'Zeno Bear').trim().charAt(0).toUpperCase() || 'Z';
  showRoleScreen();
  if(!pollTimer) pollTimer = setInterval(()=>refreshState(true), 45000); // fallback safety net; Realtime handles the live updates
}
function hideAllGateScreens(){
  document.getElementById('connectScreen').style.display = 'none';
  document.getElementById('roleScreen').style.display = 'none';
  document.getElementById('staffSignInScreen').style.display = 'none';
  document.getElementById('appShell').style.display = 'none';
}
function showRoleScreen(){
  hideAllGateScreens();
  document.getElementById('roleScreen').style.display = 'flex';
}
document.getElementById('roleSettingsBtn').onclick = ()=>{ hideAllGateScreens(); document.getElementById('connectScreen').style.display='flex'; };
document.getElementById('chooseOwnerBtn').onclick = ()=>{
  currentRole = 'owner';
  if(!local.posId){ openPosSetup(); } else { enterApp('owner'); }
};
document.getElementById('chooseStaffBtn').onclick = ()=>{
  if(!local.posId){ pendingRoleAfterPos = 'staff'; openPosSetup(); }
  else { showStaffSignIn(); }
};
let pendingRoleAfterPos = null;

function showStaffSignIn(){
  hideAllGateScreens();
  document.getElementById('staffSignInScreen').style.display = 'flex';
  const quick = document.getElementById('staffQuickContinue');
  const lastBtn = document.getElementById('staffContinueLastBtn');
  if(local.staffName){
    quick.style.display = 'block';
    lastBtn.textContent = 'Continue as '+local.staffName;
    lastBtn.onclick = ()=>enterApp('staff');
  } else {
    quick.style.display = 'none';
  }
  const grid = document.getElementById('staffRosterGrid');
  if(!cache.staff.length){
    grid.innerHTML = '<div class="hint" style="margin:0;">No names saved yet — add one below.</div>';
  } else {
    grid.innerHTML = cache.staff.map(s=>`<button class="btn" data-staff="${escapeHtml(s.name)}">${escapeHtml(s.name)}</button>`).join('');
    grid.querySelectorAll('button[data-staff]').forEach(b=>b.onclick=async ()=>{
      local.staffName = b.dataset.staff;
      await saveLocal();
      enterApp('staff');
    });
  }
  document.getElementById('staffNewName').value = '';
}
document.getElementById('staffBackBtn').onclick = ()=>showRoleScreen();
document.getElementById('staffAddContinueBtn').onclick = async ()=>{
  const name = document.getElementById('staffNewName').value.trim();
  if(!name){ showToast('Type a name, or pick one above.'); return; }
  const btn = document.getElementById('staffAddContinueBtn'); btn.disabled=true; btn.textContent='Saving…';
  try{
    await apiPost('add_staff', {p_name:name});
    local.staffName = name;
    await saveLocal();
    await refreshState(true);
    enterApp('staff');
  }catch(e){ showToast(e.message, true); }
  finally{ btn.disabled=false; btn.textContent='Continue'; }
};

function enterApp(role){
  currentRole = role;
  hideAllGateScreens();
  document.getElementById('appShell').style.display = 'flex';
  document.body.classList.toggle('staff-mode', role==='staff');
  applyLocalToUI();
  switchView('sell');
  if(role==='owner') switchView('dashboard');
  showToast(role==='staff' ? ('Selling as '+(local.staffName||'—')) : 'Signed in as Owner / Admin');
}
document.getElementById('switchUserBtn').onclick = ()=>{ currentRole=null; document.body.classList.remove('staff-mode'); showRoleScreen(); };
document.getElementById('switchUserBtnSell').onclick = ()=>{ currentRole=null; document.body.classList.remove('staff-mode'); showRoleScreen(); };

/* ===================== POS identity ===================== */
function openPosSetup(){
  const sel = document.getElementById('posSetupExisting');
  sel.innerHTML = '<option value="">—</option>' + cache.posDevices.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${escapeHtml(p.type)})</option>`).join('');
  document.getElementById('posSetupBg').classList.add('show');
}
function afterPosSetup(){
  document.getElementById('posSetupBg').classList.remove('show');
  applyLocalToUI();
  if(pendingRoleAfterPos==='staff'){ pendingRoleAfterPos=null; showStaffSignIn(); }
  else { enterApp('owner'); }
}
document.getElementById('posSetupUseBtn').onclick = async ()=>{
  const id = document.getElementById('posSetupExisting').value;
  if(!id){ showToast('Pick a device first.'); return; }
  const p = cache.posDevices.find(x=>x.id===id);
  local.posId = p.id; local.posName = p.name;
  await saveLocal();
  showToast('This device is now '+p.name+'.');
  afterPosSetup();
};
document.getElementById('posSetupCreateBtn').onclick = async ()=>{
  const name = document.getElementById('posSetupName').value.trim();
  const type = document.getElementById('posSetupType').value;
  if(!name){ showToast('Enter a device name.'); return; }
  try{
    const r = await apiPost('add_pos', {p_name:name, p_type:type});
    local.posId = r.id; local.posName = name; local.posType = type;
    await saveLocal();
    showToast('Registered as '+name+'.');
    await refreshState(true);
    afterPosSetup();
  }catch(e){ showToast(e.message, true); }
};

/* ===================== Nav ===================== */
function switchView(view){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+view).classList.add('active');
  document.querySelectorAll('.nav-item, #mobilenav button').forEach(b=>b.classList.toggle('active', b.dataset.view===view));
  const titles={dashboard:'Dashboard',sell:'Sell',products:'Products',inventory:'Inventory',history:'Sales History',settings:'Settings'};
  document.getElementById('viewTitle').textContent = titles[view];
  if(view==='sell') document.getElementById('scanInput').focus();
  if(view==='dashboard') renderDashboard();
  if(view==='settings') renderSettingsLists();
}
document.querySelectorAll('.nav-item, #mobilenav button').forEach(b=>b.addEventListener('click', ()=>switchView(b.dataset.view)));
document.getElementById('refreshBtn').addEventListener('click', ()=>withBusy(()=>refreshState(false)));

document.getElementById('staffBadge').onclick = ()=>{
  const dl = document.getElementById('staffNameOptions');
  dl.innerHTML = cache.staff.map(s=>`<option value="${escapeHtml(s.name)}"></option>`).join('');
  document.getElementById('staffNameInput').value = local.staffName || '';
  document.getElementById('staffModalBg').classList.add('show');
  setTimeout(()=>document.getElementById('staffNameInput').focus(),50);
};
document.getElementById('cancelStaffBtn').onclick = ()=>document.getElementById('staffModalBg').classList.remove('show');
document.getElementById('confirmStaffBtn').onclick = async ()=>{
  const name = document.getElementById('staffNameInput').value.trim();
  const btn = document.getElementById('confirmStaffBtn'); btn.disabled=true; btn.textContent='Saving…';
  try{
    if(name && !cache.staff.some(s=>s.name.toLowerCase()===name.toLowerCase())){
      await apiPost('add_staff', {p_name:name});
      refreshState(true);
    }
    local.staffName = name;
    await saveLocal();
    document.getElementById('staffModalBg').classList.remove('show');
    renderCart(); applyLocalToUI();
    showToast(local.staffName ? 'Sales on this device now tag as '+local.staffName : 'Staff tag cleared.');
  }catch(e){ showToast(e.message, true); }
  finally{ btn.disabled=false; btn.textContent='Set'; }
};

/* ===================== SELL / CART ===================== */
const scanInput = document.getElementById('scanInput');
scanInput.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); handleScan(scanInput.value); scanInput.value=''; } });

function handleScan(code){
  const p = findProduct(code);
  const msgEl = document.getElementById('scanMsg');
  if(!p || p.status!=='Active'){ msgEl.innerHTML = `<div class="scan-msg err">No product matches "${escapeHtml(code)}". Try again or browse products.</div>`; return; }
  if(stockStatus(p)==='out'){ msgEl.innerHTML = `<div class="scan-msg err"><b>${escapeHtml(p.name)}</b> is out of stock.</div>`; return; }
  if(replaceIndex !== null){
    const old = cart[replaceIndex];
    cart.splice(replaceIndex, 1);
    const existing = cart.find(c=>c.productId===p.id);
    if(existing){ existing.qty = Math.min(existing.qty + old.qty, existing.stock); }
    else cart.push(cartLineFor(p, Math.min(old.qty, p.stock)));
    replaceIndex = null;
    msgEl.innerHTML = `<div class="scan-msg ok">Replaced ${escapeHtml(old.name)} with ${escapeHtml(p.name)}.</div>`;
    renderCart();
    setTimeout(()=>{ if(msgEl) msgEl.innerHTML=''; }, 2600);
    return;
  }
  addToCart(p);
  msgEl.innerHTML = `<div class="scan-msg ok">Added ${escapeHtml(p.name)} to cart.</div>`;
  setTimeout(()=>{ if(msgEl) msgEl.innerHTML=''; }, 2200);
}
function startReplace(i){
  replaceIndex = i;
  document.getElementById('scanMsg').innerHTML = `<div class="scan-msg ok">Scan the replacement for <b>${escapeHtml(cart[i].name)}</b>…</div>`;
  document.getElementById('scanInput').focus();
}
function cartLineFor(p, qty){ return {productId:p.id, name:p.name, category:p.category, series:p.series, size:p.size, color:p.color, price:p.price, discountPct:clientEffectiveDiscount(p), qty, stock:p.stock}; }
function addToCart(p){
  const existing = cart.find(c=>c.productId===p.id);
  if(existing){
    if(existing.qty < p.stock) existing.qty += 1;
    else { showToast('No more stock available for '+p.name); return; }
  } else {
    cart.push(cartLineFor(p, 1));
  }
  renderCart();
}
function renderCart(){
  const list = document.getElementById('cartList');
  const totalsBox = document.getElementById('cartTotals');
  document.getElementById('staffBadge').textContent = local.staffName ? 'Staff: '+local.staffName : 'Staff —';
  const b = activeBazaar();
  document.getElementById('bazaarPill').style.display = b ? 'inline-block' : 'none';
  if(b) document.getElementById('bazaarPill').textContent = b.name;
  if(!cart.length){
    list.innerHTML = '<div class="cart-empty">Scan a product to start this sale.</div>';
    totalsBox.style.display='none';
    return;
  }
  totalsBox.style.display='block';
  list.innerHTML = cart.map((c,i)=>{
    const finalPrice = +(c.price*(1-c.discountPct/100)).toFixed(2);
    const variant = [c.size, c.color].filter(Boolean).join(' · ');
    return `<div class="cart-item">
      <div class="ci-info">
        <div class="ci-name">${escapeHtml(c.name)}${variant?` <span class="tag">${escapeHtml(variant)}</span>`:''}</div>
        <div class="ci-sku mono">${escapeHtml(c.productId)}</div>
        <div class="ci-price-line">${c.discountPct>0?`<span class="ci-price-orig">${fmt(c.price)}</span><span>${fmt(finalPrice)}</span><span class="disc-badge">-${c.discountPct}%</span>`:`<span>${fmt(c.price)}</span>`}</div>
      </div>
      <div class="ci-step">
        <button data-i="${i}" data-d="-1">−</button>
        <span class="qv">${c.qty}</span>
        <button data-i="${i}" data-d="1">+</button>
      </div>
      <div class="ci-sub mono">${fmt(finalPrice*c.qty)}</div>
      <button class="ci-rep" data-i="${i}" data-rep="1" title="Replace item">⇄</button>
      <button class="ci-rm" data-i="${i}" data-rm="1" title="Remove item">✕</button>
    </div>`;
  }).join('');
  list.querySelectorAll('button[data-d]').forEach(b=>b.onclick=()=>{
    const i=+b.dataset.i, d=+b.dataset.d, item=cart[i];
    const q=item.qty+d;
    if(q<1){ cart.splice(i,1); } else if(q>item.stock){ showToast('Not enough stock.'); } else { item.qty=q; }
    renderCart();
  });
  list.querySelectorAll('button[data-rm]').forEach(b=>b.onclick=()=>{ cart.splice(+b.dataset.i,1); renderCart(); });
  list.querySelectorAll('button[data-rep]').forEach(b=>b.onclick=()=>startReplace(+b.dataset.i));
  updateTotals();
}
function cartTotals(){
  let sub=0, disc=0;
  cart.forEach(c=>{ const finalPrice=+(c.price*(1-c.discountPct/100)).toFixed(2); sub += c.price*c.qty; disc += (c.price-finalPrice)*c.qty; });
  return {sub, disc, total: sub-disc};
}
function updateTotals(){
  const {sub,disc,total} = cartTotals();
  document.getElementById('ctSub').textContent = fmt(sub);
  document.getElementById('ctDisc').textContent = '−'+fmt(disc);
  document.getElementById('ctTotal').textContent = fmt(total);
  updateChange();
}
document.getElementById('clearCartBtn').addEventListener('click', ()=>{
  if(!cart.length) return;
  if(!confirm('Cancel this transaction? No sale will be recorded and no stock will change.')) return;
  cart=[]; selectedPayment=null; replaceIndex=null; renderCart(); resetPayUI();
  document.getElementById('scanMsg').innerHTML='';
  showToast('Transaction cancelled — no sale recorded.');
});
function resetPayUI(){
  selectedPayment=null;
  document.getElementById('btnSelCash').className='btn-toggle';
  document.getElementById('btnSelCard').className='btn-toggle';
  document.getElementById('cashPanel').style.display='none';
  document.getElementById('cardPanel').style.display='none';
}
document.getElementById('btnSelCash').onclick = ()=>{ selectedPayment='Cash'; document.getElementById('btnSelCash').className='btn-toggle sel-cash'; document.getElementById('btnSelCard').className='btn-toggle'; document.getElementById('cashPanel').style.display='block'; document.getElementById('cardPanel').style.display='none'; updateChange(); };
document.getElementById('btnSelCard').onclick = ()=>{ selectedPayment='Card'; document.getElementById('btnSelCard').className='btn-toggle sel-card'; document.getElementById('btnSelCash').className='btn-toggle'; document.getElementById('cardPanel').style.display='block'; document.getElementById('cashPanel').style.display='none'; };
document.getElementById('cashReceived').addEventListener('input', updateChange);
function updateChange(){
  const {total} = cartTotals();
  const received = parseFloat(document.getElementById('cashReceived').value)||0;
  const change = received-total;
  const el = document.getElementById('changeLine');
  el.className = 'change-line'+(change<0?' neg':'');
  el.innerHTML = `<span>${change<0?'Amount short':'Change'}</span><span class="mono">${fmt(Math.abs(change))}</span>`;
}

document.getElementById('confirmCashBtn').onclick = ()=>{
  const {total} = cartTotals();
  const received = parseFloat(document.getElementById('cashReceived').value)||0;
  if(received < total){ showToast('Cash received is less than the total.'); return; }
  completeTransaction('Cash', {cashReceived:received});
};
document.getElementById('confirmCardBtn').onclick = ()=>completeTransaction('Card', {});

async function completeTransaction(method, extra){
  if(!cart.length) return;
  const btn = method==='Cash' ? document.getElementById('confirmCashBtn') : document.getElementById('confirmCardBtn');
  btn.disabled = true; btn.textContent = 'Processing…';
  try{
    const r = await apiPost('create_sale', {
      p_items: cart.map(c=>({productId:c.productId, qty:c.qty})),
      p_payment: method, p_cash_received: extra.cashReceived!=null ? extra.cashReceived : null,
      p_pos_id: local.posId, p_pos_name: local.posName, p_staff_name: local.staffName||''
    });
    renderReceipt(r);
    cart = []; renderCart(); resetPayUI();
    document.getElementById('cashReceived').value = '';
    scanInput.focus();
    showToast('Sale complete — #'+r.txnId);
    await refreshState(true);
  }catch(e){
    showToast(e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = method==='Cash' ? 'Complete cash sale' : 'Complete card sale';
  }
}
function renderReceipt(t){
  const wrap = document.getElementById('receiptWrap');
  const dt = new Date(t.timestamp);
  wrap.innerHTML = `<div class="receipt" id="liveReceipt">
    <div class="receipt-title">${escapeHtml(local.shopName||'ZENO BEAR')} · TXN #${t.txnId}${t.eventName?' · '+escapeHtml(t.eventName):''}</div>
    ${t.items.map(it=>`<div class="receipt-line"><span>${escapeHtml(it.name)} ×${it.qty}${it.discountPct>0?` (-${it.discountPct}%)`:''}</span><span>${fmt(it.subtotal)}</span></div>`).join('')}
    <div class="receipt-line" style="color:var(--ink-soft);"><span>Subtotal</span><span>${fmt(t.subtotal)}</span></div>
    ${t.totalDiscount>0?`<div class="receipt-line" style="color:var(--ink-soft);"><span>Discount</span><span>−${fmt(t.totalDiscount)}</span></div>`:''}
    <div class="receipt-total"><span>Total</span><span>${fmt(t.total)}</span></div>
    ${t.change!=null?`<div class="receipt-line" style="color:var(--ink-soft);"><span>Change</span><span>${fmt(t.change)}</span></div>`:''}
    <div class="receipt-pay">${local.staffName?escapeHtml(local.staffName)+' · ':''}${dt.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>
  </div>`;
  requestAnimationFrame(()=>document.getElementById('liveReceipt').classList.add('show'));
}

/* ===================== Camera ===================== */
document.getElementById('openCamBtn').onclick = ()=>openCamera('sell');
document.getElementById('closeCamBtn').onclick = closeCamera;
async function openCamera(target){
  scanTargetField = target;
  document.getElementById('camModal').classList.add('show');
  html5Scanner = new Html5Qrcode('camReader');
  try{
    await html5Scanner.start({facingMode:'environment'}, {fps:10, qrbox:{width:240,height:160}}, (decodedText)=>{
      closeCamera();
      if(scanTargetField==='sell'){ handleScan(decodedText); }
      else if(scanTargetField==='stockin'){ document.getElementById('siScan').value=decodedText; lookupSiProduct(decodedText); }
      else if(scanTargetField==='adjust'){ document.getElementById('adjScan').value=decodedText; lookupAdjProduct(decodedText); }
      else if(scanTargetField==='exchange'){ document.getElementById('exchangeScan').value=decodedText; lookupExchangeNew(decodedText); }
    }, ()=>{});
  }catch(err){ showToast('Camera unavailable: '+err, true); closeCamera(); }
}
function closeCamera(){
  document.getElementById('camModal').classList.remove('show');
  if(html5Scanner){ html5Scanner.stop().then(()=>html5Scanner.clear()).catch(()=>{}); html5Scanner=null; }
}

/* ===================== Browse / quick pick ===================== */
document.getElementById('browseBtn').onclick = ()=>{ document.getElementById('browseModalBg').classList.add('show'); document.getElementById('browseSearch').value=''; renderQuickPick(); };
document.getElementById('closeBrowseBtn').onclick = ()=>document.getElementById('browseModalBg').classList.remove('show');
document.getElementById('browseSearch').addEventListener('input', renderQuickPick);
function renderQuickPick(){
  const q = document.getElementById('browseSearch').value.toLowerCase();
  const list = cache.products.filter(p=>p.status==='Active' && (!q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)));
  const el = document.getElementById('quickPickList');
  if(!list.length){ el.innerHTML = '<div class="cart-empty">No products found.</div>'; return; }
  el.innerHTML = list.map(p=>`
    <div class="qp-row">
      <div><div class="qp-name">${escapeHtml(p.name)}</div><div class="qp-meta">${escapeHtml(p.id)} · ${fmt(p.price)} · ${p.stock} in stock</div></div>
      <button class="btn btn-sm" data-id="${escapeHtml(p.id)}" ${stockStatus(p)==='out'?'disabled':''}>${stockStatus(p)==='out'?'Out':'Add'}</button>
    </div>`).join('');
  el.querySelectorAll('button[data-id]').forEach(b=>b.onclick=()=>{
    const p = findProduct(b.dataset.id);
    if(p){ addToCart(p); showToast('Added '+p.name); }
    document.getElementById('browseModalBg').classList.remove('show');
  });
}

/* ===================== PRODUCTS ===================== */
function populateCategorySelects(){
  const opts = '<option value="">Select category…</option>' + cache.categories.map(c=>`<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}${c.code?' ('+escapeHtml(c.code)+')':''}</option>`).join('');
  document.getElementById('fCategory').innerHTML = opts;
  const filterOpts = '<option value="">All categories</option>' + cache.categories.map(c=>`<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  document.getElementById('prodCategoryFilter').innerHTML = filterOpts;
  document.getElementById('fSizeOptions').innerHTML = cache.sizes.map(s=>`<option value="${escapeHtml(s.name)}"></option>`).join('');
  document.getElementById('fColorOptions').innerHTML = cache.colors.map(c=>`<option value="${escapeHtml(c.name)}"></option>`).join('');
}
document.getElementById('fCategory').addEventListener('change', ()=>{
  const cat = document.getElementById('fCategory').value;
  const opts = ['<option value="">—</option>'].concat(cache.series.filter(s=>s.category===cat).map(s=>`<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}${s.code?' ('+escapeHtml(s.code)+')':''}</option>`));
  document.getElementById('fSeries').innerHTML = opts.join('');
  updateSkuPreview();
});
document.getElementById('fSeries').addEventListener('change', updateSkuPreview);
document.getElementById('fSize').addEventListener('input', updateSkuPreview);
document.getElementById('fColor').addEventListener('input', updateSkuPreview);
document.getElementById('fSku').addEventListener('input', ()=>{ skuManuallyEdited = true; });

/* Inline "+ New category" / "+ New design" quick-add inside the product modal */
document.getElementById('fCategoryNewToggle').onclick = ()=>{
  const box = document.getElementById('fCategoryNewBox');
  box.style.display = box.style.display==='none' ? 'block' : 'none';
};
document.getElementById('fSeriesNewToggle').onclick = ()=>{
  const box = document.getElementById('fSeriesNewBox');
  box.style.display = box.style.display==='none' ? 'block' : 'none';
};
document.getElementById('fCategoryNewSave').onclick = async ()=>{
  const name = document.getElementById('fNewCatName').value.trim();
  const code = document.getElementById('fNewCatCode').value.trim();
  const discount = parseFloat(document.getElementById('fNewCatDiscount').value)||0;
  if(!name){ showToast('Enter a category name.'); return; }
  try{
    await apiPost('add_category', {p_name:name, p_code:code, p_discount:discount});
    await refreshState(true);
    populateCategorySelects();
    document.getElementById('fCategory').value = name;
    document.getElementById('fCategory').dispatchEvent(new Event('change'));
    document.getElementById('fCategoryNewBox').style.display = 'none';
    document.getElementById('fNewCatName').value=''; document.getElementById('fNewCatCode').value=''; document.getElementById('fNewCatDiscount').value='';
    showToast('Category added.');
  }catch(e){ showToast(e.message, true); }
};
document.getElementById('fSeriesNewSave').onclick = async ()=>{
  const category = document.getElementById('fCategory').value;
  const name = document.getElementById('fNewSerName').value.trim();
  const code = document.getElementById('fNewSerCode').value.trim();
  const discount = parseFloat(document.getElementById('fNewSerDiscount').value)||0;
  if(!category){ showToast('Pick a category first.'); return; }
  if(!name){ showToast('Enter a design name.'); return; }
  try{
    await apiPost('add_series', {p_name:name, p_code:code, p_category:category, p_discount:discount});
    await refreshState(true);
    document.getElementById('fCategory').dispatchEvent(new Event('change'));
    document.getElementById('fSeries').value = name;
    document.getElementById('fSeriesNewBox').style.display = 'none';
    document.getElementById('fNewSerName').value=''; document.getElementById('fNewSerCode').value=''; document.getElementById('fNewSerDiscount').value='';
    updateSkuPreview();
    showToast('Design added.');
  }catch(e){ showToast(e.message, true); }
};

/* Live SKU builder: {Brand}-{CategoryCode}-{DesignCode}-{Size}-{Color} */
let skuManuallyEdited = false;
let lastAutoSku = '';
function brandCode(){
  const words = (local.shopName||'ZB').trim().split(/\s+/);
  const code = words.map(w=>w.charAt(0)).join('').toUpperCase();
  return code || 'ZB';
}
function buildSkuPreview(){
  const catName = document.getElementById('fCategory').value;
  const serName = document.getElementById('fSeries').value;
  const size = document.getElementById('fSize').value.trim();
  const color = document.getElementById('fColor').value.trim();
  const cat = cache.categories.find(c=>c.name===catName);
  const ser = cache.series.find(s=>s.name===serName && s.category===catName);
  const catCode = cat ? (cat.code || cat.name.charAt(0).toUpperCase()) : '';
  const serCode = ser ? (ser.code || ser.name.charAt(0).toUpperCase()) : '';
  const parts = [brandCode(), catCode, serCode, size, color].map(x=>String(x||'').trim().toUpperCase().replace(/\s+/g,'')).filter(Boolean);
  return parts.join('-');
}
function updateSkuPreview(){
  if(skuManuallyEdited) return;
  const sku = buildSkuPreview();
  document.getElementById('fSku').value = sku;
  lastAutoSku = sku;
}

function renderProductsTable(){
  const q = (document.getElementById('prodSearch').value||'').toLowerCase();
  const catF = document.getElementById('prodCategoryFilter').value;
  const statF = document.getElementById('prodStatusFilter').value;
  const tbody = document.getElementById('prodTbody');
  const list = cache.products.filter(p=>{
    if(q && !p.name.toLowerCase().includes(q) && !p.id.toLowerCase().includes(q)) return false;
    if(catF && p.category!==catF) return false;
    if(statF && p.status!==statF) return false;
    return true;
  });
  document.getElementById('prodEmpty').style.display = cache.products.length?'none':'block';
  tbody.innerHTML = list.map(p=>{
    const status = stockStatus(p);
    const rowCls = (p.status!=='Active'?'row-inactive':'') + ' ' + (status==='out'?'row-out':(status==='low'?'row-low':''));
    const statusLabel = status==='out'?'<span class="tag" style="border:1px solid var(--black);font-weight:700;">Out of stock</span>':status==='low'?'<span class="tag" style="border:1px solid var(--black);">Low stock</span>':'<span class="tag">In stock</span>';
    const disc = clientEffectiveDiscount(p);
    return `<tr class="${rowCls}">
      <td><b>${escapeHtml(p.name)}</b>${p.status!=='Active'?' <span class="tag">Inactive</span>':''}</td>
      <td class="mono">${escapeHtml(p.id)}</td>
      <td>${p.category?`<span class="tag">${escapeHtml(p.category)}</span>`:'—'}${p.series?` <span class="tag">${escapeHtml(p.series)}</span>`:''}</td>
      <td>${p.size?`<span class="tag">${escapeHtml(p.size)}</span>`:''}${p.color?` <span class="tag">${escapeHtml(p.color)}</span>`:''}${!p.size && !p.color?'—':''}</td>
      <td class="mono">${fmt(p.cost)}</td>
      <td class="mono">${fmt(p.price)}</td>
      <td class="mono">${disc>0?disc+'%':'—'}</td>
      <td class="mono">${p.stock}</td>
      <td>${statusLabel}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-sm" data-act="hist" data-id="${escapeHtml(p.id)}">History</button>
        <button class="btn btn-sm" data-act="label" data-id="${escapeHtml(p.id)}">Label</button>
        <button class="btn btn-sm" data-act="edit" data-id="${escapeHtml(p.id)}">Edit</button>
        <button class="btn btn-sm ${p.status==='Active'?'btn-danger':''}" data-act="toggle" data-id="${escapeHtml(p.id)}">${p.status==='Active'?'Deactivate':'Activate'}</button>
      </td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('button').forEach(b=>{
    b.onclick=()=>{
      const p = cache.products.find(x=>x.id===b.dataset.id), act=b.dataset.act;
      if(act==='edit') openProductModal(p);
      if(act==='toggle') toggleProductStatus(p);
      if(act==='label') openLabelModal(p);
      if(act==='hist') openProductHistory(p);
    };
  });
}
['prodSearch','prodCategoryFilter','prodStatusFilter'].forEach(id=>document.getElementById(id).addEventListener('input', renderProductsTable));
document.getElementById('addProductBtn').onclick = ()=>openProductModal(null);
document.getElementById('cancelProdBtn').onclick = ()=>document.getElementById('prodModalBg').classList.remove('show');
function openProductModal(p){
  populateCategorySelects();
  document.getElementById('fCategoryNewBox').style.display = 'none';
  document.getElementById('fSeriesNewBox').style.display = 'none';
  document.getElementById('prodModalTitle').textContent = p?'Edit product':'Add product';
  document.getElementById('fName').value = p?p.name:'';
  document.getElementById('fCategory').value = p?(p.category||''):'';
  document.getElementById('fCategory').dispatchEvent(new Event('change'));
  setTimeout(()=>{ document.getElementById('fSeries').value = p?(p.series||''):''; }, 0);
  document.getElementById('fSize').value = p?(p.size||''):'';
  document.getElementById('fColor').value = p?(p.color||''):'';
  document.getElementById('fCost').value = p?p.cost:'';
  document.getElementById('fPrice').value = p?p.price:'';
  document.getElementById('fSku').value = p?p.id:'';
  document.getElementById('fEditingSku').value = p?p.id:'';
  skuManuallyEdited = !!p; // don't auto-rewrite the SKU of an existing product
  lastAutoSku = p?p.id:'';
  if(!p) setTimeout(updateSkuPreview, 0);
  document.getElementById('prodModalBg').classList.add('show');
}
async function ensureRosterValue(kind, name){
  if(!name) return;
  const list = kind==='size' ? cache.sizes : cache.colors;
  if(list.some(x=>x.name.toLowerCase()===name.toLowerCase())) return;
  try{ await apiPost(kind==='size' ? 'add_size' : 'add_color', {p_name:name}); }catch(e){ /* non-fatal */ }
}
document.getElementById('saveProdBtn').onclick = async ()=>{
  const name = document.getElementById('fName').value.trim();
  const category = document.getElementById('fCategory').value;
  const series = document.getElementById('fSeries').value;
  const size = document.getElementById('fSize').value.trim();
  const color = document.getElementById('fColor').value.trim();
  const cost = parseFloat(document.getElementById('fCost').value)||0;
  const price = parseFloat(document.getElementById('fPrice').value);
  const id = document.getElementById('fSku').value.trim();
  const editing = document.getElementById('fEditingSku').value;
  if(!name || !category || isNaN(price)){ showToast('Fill in name, category, and price.'); return; }
  const btn = document.getElementById('saveProdBtn'); btn.disabled=true; btn.textContent='Saving…';
  try{
    await ensureRosterValue('size', size);
    await ensureRosterValue('color', color);
    if(!editing){
      await apiPost('add_product', {p_id:id, p_name:name, p_category:category, p_series:series, p_size:size, p_color:color, p_cost:cost, p_price:price, p_discount:0});
    } else {
      await apiPost('update_product', {p_id:editing, p_name:name, p_category:category, p_series:series, p_size:size, p_color:color, p_cost:cost, p_price:price, p_discount:0});
    }
    document.getElementById('prodModalBg').classList.remove('show');
    showToast('Product saved.');
    await refreshState(true);
  }catch(e){
    const msg = /duplicate key/i.test(e.message) ? 'That SKU already exists — adjust the Size/Color, or edit the SKU field.' : e.message;
    showToast(msg, true);
  }
  finally{ btn.disabled=false; btn.textContent='Save product'; }
};
async function toggleProductStatus(p){
  const newStatus = p.status==='Active'?'Inactive':'Active';
  if(newStatus==='Inactive' && !confirm('Deactivate '+p.name+'? It will be hidden from Sell but its history is kept.')) return;
  try{ await apiPost('set_product_status', {p_id:p.id, p_status:newStatus}); showToast(p.name+' is now '+newStatus+'.'); await refreshState(true); }
  catch(e){ showToast(e.message, true); }
}

/* Product sales history */
function openProductHistory(p){
  const lines = [];
  cache.transactions.forEach(t=>t.items.forEach(it=>{ if(it.productId===p.id) lines.push({txnId:t.id, qty:it.qty, subtotal:it.subtotal}); }));
  const totalSold = lines.reduce((a,l)=>a+l.qty,0);
  const revenue = lines.reduce((a,l)=>a+l.subtotal,0);
  const moves = cache.movements.filter(m=>m.productId===p.id).slice(0,15);
  const modal = document.createElement('div');
  document.getElementById('prodHistBg') || (function(){
    const bg = document.createElement('div'); bg.className='modal-bg'; bg.id='prodHistBg';
    bg.innerHTML = '<div class="modal" id="prodHistModal" style="max-width:480px;"></div>';
    document.body.appendChild(bg);
  })();
  document.getElementById('prodHistModal').innerHTML = `
    <h3>${escapeHtml(p.name)} <span class="tag">${escapeHtml(p.id)}</span></h3>
    <div class="stat-cards" style="grid-template-columns:repeat(2,1fr);">
      <div class="card stat-card"><div class="v">${p.stock}</div><div class="l">Current stock</div></div>
      <div class="card stat-card"><div class="v">${totalSold}</div><div class="l">Total sold</div></div>
      <div class="card stat-card"><div class="v">${lines.length}</div><div class="l">Transactions</div></div>
      <div class="card stat-card"><div class="v">${fmt(revenue)}</div><div class="l">Sales revenue</div></div>
    </div>
    <div class="section-title">Recent transactions</div>
    <div style="max-height:160px;overflow-y:auto;margin-bottom:14px;">
      ${lines.length?lines.slice(0,10).map(l=>`<div class="mini-row"><span class="mono">#${l.txnId}</span><span>Qty ${l.qty}</span><span class="mono">${fmt(l.subtotal)}</span></div>`).join(''):'<div class="cart-empty">No sales yet.</div>'}
    </div>
    <div class="section-title">Recent stock movements</div>
    <div style="max-height:140px;overflow-y:auto;">
      ${moves.length?moves.map(m=>`<div class="mini-row"><span>${m.type}</span><span class="mono ${m.qty>0?'qty-pos':'qty-neg'}">${m.qty>0?'+':''}${m.qty}</span></div>`).join(''):'<div class="cart-empty">No movements yet.</div>'}
    </div>
    <div class="modal-actions"><button class="btn btn-block" id="closeProdHistBtn">Close</button></div>`;
  document.getElementById('closeProdHistBtn').onclick = ()=>document.getElementById('prodHistBg').classList.remove('show');
  document.getElementById('prodHistBg').classList.add('show');
}

/* Labels */
let labelTargetProduct = null;
function openLabelModal(p){ labelTargetProduct=p; document.getElementById('labelTypeSelect').value='barcode'; drawLabelPreview(); document.getElementById('labelModalBg').classList.add('show'); }
document.getElementById('closeLabelBtn').onclick = ()=>document.getElementById('labelModalBg').classList.remove('show');
document.getElementById('labelTypeSelect').addEventListener('change', drawLabelPreview);
function drawLabelPreview(){
  const type = document.getElementById('labelTypeSelect').value, p = labelTargetProduct;
  const holder = document.getElementById('labelPreview'); holder.innerHTML='';
  const codeWrap = document.createElement('div'); holder.appendChild(codeWrap);
  if(type==='barcode'){
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg'); codeWrap.appendChild(svg);
    JsBarcode(svg, p.id, {format:'CODE128', width:2, height:55, displayValue:true, fontSize:12, margin:4});
  } else {
    const qdiv = document.createElement('div'); qdiv.style.display='inline-block'; codeWrap.appendChild(qdiv);
    new QRCode(qdiv, {text:p.id, width:120, height:120});
  }
  const nameEl=document.createElement('div'); nameEl.className='lname'; nameEl.textContent=p.name;
  const priceEl=document.createElement('div'); priceEl.className='lprice'; priceEl.textContent=fmt(p.price);
  holder.appendChild(nameEl); holder.appendChild(priceEl);
}
document.getElementById('printLabelBtn').onclick = ()=>{
  document.getElementById('printArea').innerHTML = document.getElementById('labelPreview').innerHTML;
  document.body.classList.add('printing-label');
  window.print();
};
const printStyle = document.createElement('style');
printStyle.textContent = `@media print{ body.printing-label > *:not(#printArea){display:none !important;} #printArea{display:block !important;text-align:center;padding:20px;} }`;
document.head.appendChild(printStyle);
window.addEventListener('afterprint', ()=>document.body.classList.remove('printing-label'));

/* ===================== INVENTORY ===================== */
function renderInventory(){
  const totalUnits = cache.products.reduce((a,p)=>a+p.stock,0);
  const low = cache.products.filter(p=>p.status==='Active' && stockStatus(p)==='low').length;
  const out = cache.products.filter(p=>p.status==='Active' && stockStatus(p)==='out').length;
  document.getElementById('invTotalUnits').textContent = totalUnits;
  document.getElementById('invLowCount').textContent = low;
  document.getElementById('invOutCount').textContent = out;
  document.getElementById('invMoveCount').textContent = cache.movements.length;
  const tbody = document.getElementById('moveTbody');
  document.getElementById('moveEmpty').style.display = cache.movements.length?'none':'block';
  tbody.innerHTML = cache.movements.slice(0,300).map(m=>{
    const typeCls = m.type==='SALE'?'sale':(m.type==='STOCK IN'?'stockin':(m.type==='RETURN'?'return':(m.type==='EXCHANGE'?'exchange':'adjustment')));
    return `<tr>
      <td>${new Date(m.date).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</td>
      <td>${escapeHtml(m.product)}</td>
      <td><span class="mv-tag ${typeCls}">${m.type}</span></td>
      <td class="mono ${m.qty>0?'qty-pos':'qty-neg'}">${m.qty>0?'+':''}${m.qty}</td>
      <td class="mono">${escapeHtml(m.reference||'—')}</td>
      <td class="mono">${escapeHtml(m.posId||'—')}</td>
      <td>${escapeHtml(m.reason||'—')}</td>
    </tr>`;
  }).join('');
}

function productPickerOptions(){
  return '<option value="">— Choose a product —</option>' + cache.products
    .filter(p=>p.status==='Active')
    .map(p=>{
      const variant = [p.size, p.color].filter(Boolean).join(' · ');
      return `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}${variant?' — '+escapeHtml(variant):''} (${escapeHtml(p.id)}) · ${p.stock} in stock</option>`;
    }).join('');
}
document.getElementById('stockInBtn').onclick = ()=>{
  siProduct=null;
  document.getElementById('siProductSelect').innerHTML = productPickerOptions();
  document.getElementById('siScan').value=''; document.getElementById('siQty').value=1; document.getElementById('siRef').value='';
  document.getElementById('siProductInfo').innerHTML='';
  document.getElementById('stockInModalBg').classList.add('show');
};
document.getElementById('cancelSiBtn').onclick = ()=>document.getElementById('stockInModalBg').classList.remove('show');
document.getElementById('siProductSelect').addEventListener('change', e=>{ if(e.target.value) lookupSiProduct(e.target.value); });
document.getElementById('siScan').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); lookupSiProduct(e.target.value); } });
function lookupSiProduct(code){
  const p = findProduct(code); siProduct = p;
  const el = document.getElementById('siProductInfo');
  if(p){ document.getElementById('siProductSelect').value = p.id; }
  el.innerHTML = p ? `<div class="info-box"><div class="big">${escapeHtml(p.name)}</div>Current stock: ${p.stock} · ${fmt(p.price)}</div>` : `<div class="scan-msg err">No product found for "${escapeHtml(code)}".</div>`;
}
document.getElementById('confirmSiBtn').onclick = async ()=>{
  if(!siProduct){ showToast('Select or scan a product first.'); return; }
  const qty = parseInt(document.getElementById('siQty').value,10);
  if(!qty || qty<1){ showToast('Enter a quantity to add.'); return; }
  const ref = document.getElementById('siRef').value.trim() || ('SI-'+Date.now().toString().slice(-6));
  const btn = document.getElementById('confirmSiBtn'); btn.disabled=true; btn.textContent='Saving…';
  try{
    await apiPost('stock_in', {p_product_id:siProduct.id, p_qty:qty, p_reference:ref, p_pos_id:local.posId});
    document.getElementById('stockInModalBg').classList.remove('show');
    showToast('Stock updated: '+siProduct.name);
    await refreshState(true);
  }catch(e){ showToast(e.message, true); }
  finally{ btn.disabled=false; btn.textContent='Confirm stock in'; }
};
document.getElementById('adjustBtn').onclick = ()=>{
  adjProduct=null;
  document.getElementById('adjProductSelect').innerHTML = productPickerOptions();
  document.getElementById('adjScan').value=''; document.getElementById('adjActual').value='';
  document.getElementById('adjProductInfo').innerHTML='';
  document.getElementById('adjModalBg').classList.add('show');
};
document.getElementById('cancelAdjBtn').onclick = ()=>document.getElementById('adjModalBg').classList.remove('show');
document.getElementById('adjProductSelect').addEventListener('change', e=>{ if(e.target.value) lookupAdjProduct(e.target.value); });
document.getElementById('adjScan').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); lookupAdjProduct(e.target.value); } });
function lookupAdjProduct(code){
  const p = findProduct(code); adjProduct = p;
  const el = document.getElementById('adjProductInfo');
  if(p){ document.getElementById('adjProductSelect').value = p.id; document.getElementById('adjActual').value = p.stock; }
  el.innerHTML = p ? `<div class="info-box"><div class="big">${escapeHtml(p.name)}</div>System stock: ${p.stock}</div>` : `<div class="scan-msg err">No product found for "${escapeHtml(code)}".</div>`;
}
document.getElementById('confirmAdjBtn').onclick = async ()=>{
  if(!adjProduct){ showToast('Select or scan a product first.'); return; }
  const actual = parseInt(document.getElementById('adjActual').value,10);
  if(isNaN(actual)){ showToast('Enter the actual counted stock.'); return; }
  const reason = document.getElementById('adjReason').value;
  const btn = document.getElementById('confirmAdjBtn'); btn.disabled=true; btn.textContent='Saving…';
  try{
    const r = await apiPost('adjust_stock', {p_product_id:adjProduct.id, p_actual_stock:actual, p_reason:reason, p_pos_id:local.posId});
    document.getElementById('adjModalBg').classList.remove('show');
    showToast('Adjusted '+adjProduct.name+' by '+(r.diff>0?'+':'')+r.diff);
    await refreshState(true);
  }catch(e){ showToast(e.message, true); }
  finally{ btn.disabled=false; btn.textContent='Confirm adjustment'; }
};

/* ===================== SALES HISTORY ===================== */
function populatePosFilter(){
  const sel = document.getElementById('hPos');
  const cur = sel.value;
  sel.innerHTML = '<option value="all">All POS</option>' + cache.posDevices.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  sel.value = cur || 'all';
}
function filteredTxns(){
  const from=document.getElementById('hFrom').value, to=document.getElementById('hTo').value;
  const pay=document.getElementById('hPayment').value, pos=document.getElementById('hPos').value, q=(document.getElementById('hSearch').value||'').toLowerCase();
  return cache.transactions.filter(t=>{
    const d=(t.timestamp||'').slice(0,10);
    if(from && d<from) return false;
    if(to && d>to) return false;
    if(pay!=='all' && t.payment!==pay) return false;
    if(pos!=='all' && t.posId!==pos) return false;
    if(q){
      const inItems = t.items.some(it=>it.name.toLowerCase().includes(q)||it.productId.toLowerCase().includes(q));
      if(!t.id.includes(q) && !inItems) return false;
    }
    return true;
  });
}
function renderHistory(){
  populatePosFilter();
  const list = filteredTxns();
  const tbody = document.getElementById('histTbody');
  document.getElementById('histEmpty').style.display = cache.transactions.length?'none':'block';
  tbody.innerHTML = list.map(t=>`
    <tr class="clickable" data-id="${t.id}">
      <td class="mono">#${t.id}</td>
      <td>${new Date(t.timestamp).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</td>
      <td class="mono">${escapeHtml(t.posId||'—')}</td>
      <td>${t.items.reduce((a,i)=>a+i.qty,0)}</td>
      <td><span class="pay-tag ${t.payment.toLowerCase()}">${t.payment}</span></td>
      <td class="mono">${fmt(t.total)}</td>
    </tr>`).join('');
  tbody.querySelectorAll('tr').forEach(tr=>tr.onclick=()=>openTxnDetail(tr.dataset.id));
}
['hFrom','hTo','hPayment','hPos','hSearch'].forEach(id=>document.getElementById(id).addEventListener('input', renderHistory));
document.getElementById('exportTxnCsvBtn').onclick = ()=>{
  const list = filteredTxns();
  const rows=[['Transaction ID','Date','POS','Product ID','Product','Qty','Unit Price','Discount %','Subtotal','Payment','Total']];
  list.forEach(t=>{ const d=new Date(t.timestamp);
    t.items.forEach(it=>rows.push([t.id, d.toLocaleString(), t.posId, it.productId, it.name, it.qty, it.originalPrice, it.discountPct, it.subtotal, t.payment, t.total]));
  });
  const csv = rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv],{type:'text/csv'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='sales-history.csv'; a.click();
};

function returnedQtyFor(txnId, productId){ return cache.returns.filter(r=>r.txnId===txnId && r.productId===productId).reduce((a,r)=>a+r.qty,0); }
function openTxnDetail(id){
  const t = cache.transactions.find(x=>x.id===id); if(!t) return;
  const dt = new Date(t.timestamp);
  const txnReturns = cache.returns.filter(r=>r.txnId===id);
  const txnExchanges = cache.exchanges.filter(x=>x.txnId===id);
  document.getElementById('txnDetailModal').innerHTML = `
    <h3>Transaction #${t.id} <span class="tag" style="border:1px solid var(--black);font-weight:700;">LOCKED · COMPLETED</span></h3>
    <div style="font-size:13px;color:var(--ink-soft);margin-bottom:12px;">${dt.toLocaleString()} · POS ${escapeHtml(t.posId||'—')}${t.staffName?' · '+escapeHtml(t.staffName):''}${t.eventName?' · '+escapeHtml(t.eventName):''}</div>
    <table><thead><tr><th>Item</th><th>Qty</th><th>Disc.</th><th>Final</th><th>Subtotal</th><th></th></tr></thead>
    <tbody>${t.items.map(it=>{
      const returned = returnedQtyFor(t.id, it.productId);
      const remaining = it.qty - returned;
      return `<tr>
        <td>${escapeHtml(it.name)}${returned>0?`<div style="font-size:11px;color:var(--ink-soft);">${returned} returned</div>`:''}</td>
        <td class="mono">${it.qty}</td>
        <td class="mono">${it.discountPct>0?it.discountPct+'%':'—'}</td>
        <td class="mono">${fmt(it.finalPrice)}</td>
        <td class="mono">${fmt(it.subtotal)}</td>
        <td style="white-space:nowrap;">${remaining>0?`<button class="btn btn-sm" data-return-pid="${escapeHtml(it.productId)}" data-return-name="${escapeHtml(it.name)}" data-return-price="${it.finalPrice}" data-return-max="${remaining}">Return</button> <button class="btn btn-sm" data-exch-pid="${escapeHtml(it.productId)}" data-exch-name="${escapeHtml(it.name)}" data-exch-max="${remaining}">Exchange</button>`:'<span class="tag">Fully returned</span>'}</td>
      </tr>`;
    }).join('')}</tbody></table>
    <div class="cart-totals" style="margin-top:12px;">
      <div class="ct-row"><span>Subtotal</span><span class="mono">${fmt(t.subtotal)}</span></div>
      <div class="ct-row"><span>Discount</span><span class="mono">−${fmt(t.totalDiscount)}</span></div>
      <div class="ct-row grand"><span>Total</span><span class="mono">${fmt(t.total)}</span></div>
      <div class="ct-row"><span>Payment</span><span class="pay-tag ${t.payment.toLowerCase()}">${t.payment}</span></div>
      ${t.payment==='Cash'?`<div class="ct-row"><span>Received / Change</span><span class="mono">${fmt(t.cashReceived)} / ${fmt(t.change)}</span></div>`:''}
    </div>
    ${txnReturns.length?`<div class="section-title" style="margin-top:16px;">Returns</div>${txnReturns.map(r=>`<div class="mini-row"><span>${escapeHtml(r.productName)} ×${r.qty} — ${escapeHtml(r.reason)}</span><span class="mono">−${fmt(r.amount)}</span></div>`).join('')}`:''}
    ${txnExchanges.length?`<div class="section-title" style="margin-top:16px;">Exchanges</div>${txnExchanges.map(x=>`<div class="mini-row"><span>${escapeHtml(x.oldProductId)} ×${x.oldQty} → ${escapeHtml(x.newProductId)} ×${x.newQty}</span><span class="mono">${x.priceDifference>=0?'+':''}${fmt(x.priceDifference)}</span></div>`).join('')}`:''}
    <div class="modal-actions"><button class="btn btn-block" id="closeTxnDetailBtn">Close</button></div>`;
  document.getElementById('closeTxnDetailBtn').onclick = ()=>document.getElementById('txnDetailBg').classList.remove('show');
  document.querySelectorAll('button[data-return-pid]').forEach(b=>b.onclick=()=>openReturnModal(t.id, b.dataset.returnPid, b.dataset.returnName, parseFloat(b.dataset.returnPrice), parseInt(b.dataset.returnMax,10)));
  document.querySelectorAll('button[data-exch-pid]').forEach(b=>b.onclick=()=>openExchangeModal(t.id, b.dataset.exchPid, b.dataset.exchName, parseInt(b.dataset.exchMax,10)));
  document.getElementById('txnDetailBg').classList.add('show');
}

/* Returns */
function openReturnModal(txnId, productId, productName, price, maxQty){
  returnCtx = {txnId, productId, productName, price, maxQty};
  document.getElementById('returnInfo').innerHTML = `<div class="big">${escapeHtml(productName)}</div>Transaction #${txnId} · up to ${maxQty} returnable`;
  document.getElementById('returnQty').value = 1;
  document.getElementById('returnQty').max = maxQty;
  document.getElementById('returnModalBg').classList.add('show');
}
document.getElementById('cancelReturnBtn').onclick = ()=>document.getElementById('returnModalBg').classList.remove('show');
document.getElementById('confirmReturnBtn').onclick = async ()=>{
  if(!returnCtx) return;
  const qty = parseInt(document.getElementById('returnQty').value,10);
  if(!qty || qty<1 || qty>returnCtx.maxQty){ showToast('Enter a valid quantity (max '+returnCtx.maxQty+').'); return; }
  const reason = document.getElementById('returnReason').value;
  const amount = +(qty*returnCtx.price).toFixed(2);
  const btn = document.getElementById('confirmReturnBtn'); btn.disabled=true; btn.textContent='Saving…';
  try{
    await apiPost('do_return', {p_transaction_id:returnCtx.txnId, p_product_id:returnCtx.productId, p_qty:qty, p_reason:reason, p_amount:amount, p_pos_id:local.posId});
    document.getElementById('returnModalBg').classList.remove('show');
    showToast('Return recorded: '+qty+' × '+returnCtx.productName);
    await refreshState(true);
    openTxnDetail(returnCtx.txnId);
  }catch(e){ showToast(e.message, true); }
  finally{ btn.disabled=false; btn.textContent='Confirm return'; returnCtx=null; }
};

/* Exchanges */
let exchangeNewProduct = null;
function openExchangeModal(txnId, oldProductId, oldName, maxQty){
  exchangeCtx = {txnId, oldProductId, oldName, maxQty};
  exchangeNewProduct = null;
  document.getElementById('exchangeOldInfo').innerHTML = `<div class="big">${escapeHtml(oldName)}</div>Transaction #${txnId} · returning up to ${maxQty}`;
  document.getElementById('exchangeScan').value = '';
  document.getElementById('exchangeQty').value = 1;
  document.getElementById('exchangeNewInfo').innerHTML = '';
  document.getElementById('exchangeModalBg').classList.add('show');
  setTimeout(()=>document.getElementById('exchangeScan').focus(),50);
}
document.getElementById('cancelExchangeBtn').onclick = ()=>document.getElementById('exchangeModalBg').classList.remove('show');
document.getElementById('exchangeScan').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); lookupExchangeNew(e.target.value); } });
function lookupExchangeNew(code){
  const p = findProduct(code); exchangeNewProduct = p;
  const el = document.getElementById('exchangeNewInfo');
  el.innerHTML = p ? `<div class="info-box"><div class="big">${escapeHtml(p.name)}</div>${fmt(p.price)} · ${p.stock} in stock</div>` : `<div class="scan-msg err">No product found for "${escapeHtml(code)}".</div>`;
}
document.getElementById('confirmExchangeBtn').onclick = async ()=>{
  if(!exchangeCtx || !exchangeNewProduct){ showToast('Scan the replacement product first.'); return; }
  const oldQty = 1; // old item quantity being exchanged (kept to 1 per exchange for clarity)
  const newQty = parseInt(document.getElementById('exchangeQty').value,10)||1;
  const btn = document.getElementById('confirmExchangeBtn'); btn.disabled=true; btn.textContent='Saving…';
  try{
    const r = await apiPost('do_exchange', {p_transaction_id:exchangeCtx.txnId, p_old_product_id:exchangeCtx.oldProductId, p_old_qty:oldQty, p_new_product_id:exchangeNewProduct.id, p_new_qty:newQty, p_pos_id:local.posId});
    document.getElementById('exchangeModalBg').classList.remove('show');
    const diff = r.priceDifference;
    showToast(diff>0 ? ('Customer owes '+fmt(diff)) : diff<0 ? ('Refund '+fmt(Math.abs(diff))) : 'Even exchange — no difference.');
    await refreshState(true);
    openTxnDetail(exchangeCtx.txnId);
  }catch(e){ showToast(e.message, true); }
  finally{ btn.disabled=false; btn.textContent='Confirm exchange'; }
};

/* ===================== DASHBOARD (merged with Reports) ===================== */
function renderDashboard(){
  // inventory snapshot — always current, not period-scoped
  document.getElementById('dInv').textContent = cache.products.reduce((a,p)=>a+p.stock,0);
  document.getElementById('dLow').textContent = cache.products.filter(p=>p.status==='Active' && stockStatus(p)==='low').length;
  document.getElementById('dOut').textContent = cache.products.filter(p=>p.status==='Active' && stockStatus(p)==='out').length;
  const lowList = cache.products.filter(p=>p.status==='Active' && stockStatus(p)!=='ok').sort((a,b)=>a.stock-b.stock);
  document.getElementById('dashLow').innerHTML = lowList.length ? lowList.slice(0,8).map(p=>`<div class="mini-row"><span>${escapeHtml(p.name)}</span><span class="mono" style="font-weight:${stockStatus(p)==='out'?'800':'600'};text-decoration:${stockStatus(p)==='out'?'underline':'none'};">${p.stock} left</span></div>`).join('') : '<div class="cart-empty">All stock levels are healthy.</div>';

  const recent = cache.transactions.slice(0,6);
  const recentEl = document.getElementById('dashRecent');
  recentEl.innerHTML = recent.length ? recent.map(tx=>`<div class="mini-row" style="cursor:pointer;" data-txn="${tx.id}"><span class="mono">#${tx.id}</span><span>${new Date(tx.timestamp).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span><span class="pay-tag ${tx.payment.toLowerCase()}">${tx.payment}</span><span class="mono">${fmt(tx.total)}</span></div>`).join('') : '<div class="cart-empty">No transactions yet.</div>';
  recentEl.querySelectorAll('[data-txn]').forEach(row=>row.onclick=()=>openTxnDetail(row.dataset.txn));

  renderPeriodReport();
}
function renderTopStats(){
  const t = todayTxns();
  document.getElementById('topToday').textContent = fmt(t.reduce((a,x)=>a+x.total,0));
  document.getElementById('topTxns').textContent = t.length;
}

/* Period-scoped report section (Today / Week / Month / Custom) inside the merged Dashboard */
document.querySelectorAll('.tab-btn').forEach(b=>b.addEventListener('click', ()=>{
  document.querySelectorAll('.tab-btn').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  reportPeriod = b.dataset.period;
  document.getElementById('customRangeRow').style.display = reportPeriod==='custom' ? 'flex' : 'none';
  if(reportPeriod!=='custom') renderPeriodReport();
}));
document.getElementById('repApply').addEventListener('click', renderPeriodReport);
function reportRange(){
  const now = new Date();
  if(reportPeriod==='today'){ const s=new Date(); s.setHours(0,0,0,0); return [s, now]; }
  if(reportPeriod==='week'){ const s=new Date(); s.setDate(s.getDate()-s.getDay()); s.setHours(0,0,0,0); return [s, now]; }
  if(reportPeriod==='month'){ const s=new Date(now.getFullYear(), now.getMonth(), 1); return [s, now]; }
  const f=document.getElementById('repFrom').value, t=document.getElementById('repTo').value;
  const s = f ? new Date(f+'T00:00:00') : new Date(0);
  const e = t ? new Date(t+'T23:59:59') : now;
  return [s,e];
}
function renderPeriodReport(){
  const [start,end] = reportRange();
  const list = cache.transactions.filter(t=>{ const d=new Date(t.timestamp); return d>=start && d<=end; });
  const sales = list.reduce((a,t)=>a+t.total,0);
  const totalDiscount = list.reduce((a,t)=>a+t.totalDiscount,0);
  const items = list.reduce((a,t)=>a+t.items.reduce((s,i)=>s+i.qty,0),0);
  const cash = list.filter(t=>t.payment==='Cash').reduce((a,t)=>a+t.total,0);
  const card = list.filter(t=>t.payment==='Card').reduce((a,t)=>a+t.total,0);
  let profit = 0;
  const sold = {}, byCat = {}, bySeries = {}, byPos = {}, byStaff = {};
  list.forEach(t=>{
    t.items.forEach(it=>{
      const p = cache.products.find(x=>x.id===it.productId);
      const cost = p ? p.cost : 0;
      profit += (it.finalPrice-cost)*it.qty;
      sold[it.productId] = (sold[it.productId]||0)+it.qty;
      const cat = it.category||'Uncategorized';
      byCat[cat] = byCat[cat]||{qty:0,total:0}; byCat[cat].qty+=it.qty; byCat[cat].total+=it.subtotal;
      if(it.series){ bySeries[it.series]=bySeries[it.series]||{qty:0,total:0}; bySeries[it.series].qty+=it.qty; bySeries[it.series].total+=it.subtotal; }
    });
    const posKey = t.posId||'—';
    byPos[posKey] = byPos[posKey]||{count:0,total:0}; byPos[posKey].count++; byPos[posKey].total+=t.total;
    const staffKey = t.staffName||'Untagged';
    byStaff[staffKey] = byStaff[staffKey]||{count:0,total:0}; byStaff[staffKey].count++; byStaff[staffKey].total+=t.total;
  });
  document.getElementById('repSales').textContent = fmt(sales);
  document.getElementById('repTxns').textContent = list.length;
  document.getElementById('repItems').textContent = items;
  document.getElementById('repProfit').textContent = fmt(profit);
  document.getElementById('repCash').textContent = fmt(cash);
  document.getElementById('repCard').textContent = fmt(card);
  document.getElementById('repDiscount').textContent = fmt(totalDiscount);
  document.getElementById('repNet').textContent = fmt(sales);
  const best = Object.entries(sold).sort((a,b)=>b[1]-a[1]).slice(0,8);
  document.getElementById('repBest').innerHTML = best.length ? best.map(([id,qty])=>{ const p=cache.products.find(x=>x.id===id); return `<div class="mini-row"><span>${p?escapeHtml(p.name):id}</span><span class="mono">${qty} sold</span></div>`; }).join('') : '<div class="cart-empty">No sales in this period.</div>';
  document.getElementById('repByCategory').innerHTML = Object.keys(byCat).length ? Object.entries(byCat).map(([c,v])=>`<div class="mini-row"><span>${escapeHtml(c)}</span><span>${v.qty} sold</span><span class="mono">${fmt(v.total)}</span></div>`).join('') : '<div class="cart-empty">No sales in this period.</div>';
  document.getElementById('repBySeries').innerHTML = Object.keys(bySeries).length ? Object.entries(bySeries).map(([s,v])=>`<div class="mini-row"><span>${escapeHtml(s)}</span><span>${v.qty} sold</span><span class="mono">${fmt(v.total)}</span></div>`).join('') : '<div class="cart-empty">No design sales in this period.</div>';
  document.getElementById('repByPos').innerHTML = Object.keys(byPos).length ? Object.entries(byPos).map(([id,v])=>`<div class="mini-row"><span class="mono">${escapeHtml(id)}</span><span>${v.count} txns</span><span class="mono">${fmt(v.total)}</span></div>`).join('') : '<div class="cart-empty">No transactions in this period.</div>';
  document.getElementById('repByStaff').innerHTML = Object.keys(byStaff).length ? Object.entries(byStaff).map(([n,v])=>`<div class="mini-row"><span>${escapeHtml(n)}</span><span>${v.count} txns</span><span class="mono">${fmt(v.total)}</span></div>`).join('') : '<div class="cart-empty">No transactions in this period.</div>';
}

/* ===================== SETTINGS ===================== */
function applyLocalToUI(){
  document.getElementById('shopNameLabel').textContent = local.shopName || 'Zeno Bear';
  document.getElementById('setShopName').value = local.shopName || '';
  document.getElementById('setCurrency').value = local.currency || '₱';
  document.getElementById('posBadge').textContent = local.posName ? 'POS: '+local.posName : 'POS —';
  document.getElementById('sidePosLabel').innerHTML = local.posName ? `This device: <b>${escapeHtml(local.posName)}</b>` : '';
  document.getElementById('sideRoleLabel').innerHTML = currentRole ? `Signed in as: <b>${currentRole==='staff' ? escapeHtml(local.staffName||'Staff') : 'Owner / Admin'}</b>` : '';
  document.getElementById('thisPosInfo').innerHTML = local.posName ? `<div class="big">${escapeHtml(local.posName)}</div>${escapeHtml(local.posType||'')} · ${escapeHtml(local.posId)}` : 'Not set up yet.';
}
document.getElementById('saveShopBtn').onclick = async ()=>{
  local.shopName = document.getElementById('setShopName').value.trim() || 'Zeno Bear';
  local.currency = document.getElementById('setCurrency').value.trim() || '₱';
  await saveLocal(); applyLocalToUI(); renderAll();
  showToast('Saved.');
};

function renderSettingsLists(){
  populateCategorySelects();
  const sel = document.getElementById('switchPosSelect');
  sel.innerHTML = cache.posDevices.map(p=>`<option value="${escapeHtml(p.id)}" ${p.id===local.posId?'selected':''}>${escapeHtml(p.name)} (${escapeHtml(p.type)})</option>`).join('');
}
document.getElementById('switchPosBtn').onclick = async ()=>{
  const id = document.getElementById('switchPosSelect').value;
  const p = cache.posDevices.find(x=>x.id===id);
  if(!p){ showToast('Pick a device.'); return; }
  local.posId = p.id; local.posName = p.name; local.posType = p.type;
  await saveLocal(); applyLocalToUI();
  showToast('Switched to '+p.name+'.');
};
document.getElementById('addPosBtn').onclick = async ()=>{
  const name = document.getElementById('newPosName').value.trim();
  const type = document.getElementById('newPosType').value;
  if(!name){ showToast('Enter a device name.'); return; }
  try{
    const r = await apiPost('add_pos', {p_name:name, p_type:type});
    document.getElementById('newPosName').value='';
    showToast('Registered '+name+'.');
    await refreshState(true); renderSettingsLists();
  }catch(e){ showToast(e.message, true); }
};

/* ===================== Render all ===================== */
function renderAll(){
  renderTopStats(); renderDashboard(); renderProductsTable(); renderInventory(); renderHistory();
  applyLocalToUI();
}

/* ===================== Boot ===================== */
(async function boot(){
  await loadLocal();
  // Use hardcoded project credentials if this device doesn't already have
  // its own saved ones (lets the app connect with zero setup screens).
  if(!local.supabaseUrl && !local.supabaseAnonKey && SUPABASE_URL && SUPABASE_ANON_KEY){
    local.supabaseUrl = SUPABASE_URL;
    local.supabaseAnonKey = SUPABASE_ANON_KEY;
    await saveLocal();
  }
  applyLocalToUI();
  if(!local.supabaseUrl || !local.supabaseAnonKey){
    document.getElementById('connectScreen').style.display='flex';
    return;
  }
  document.getElementById('onboardUrl').value = local.supabaseUrl;
  document.getElementById('onboardKey').value = local.supabaseAnonKey;
  const ok = await refreshState(true);
  if(ok){ startApp(); }
  else {
    document.getElementById('onboardMsg').textContent = "Couldn't reach Supabase with your saved credentials. Check your connection or update them below.";
    document.getElementById('connectScreen').style.display='flex';
  }
})();
