-- Локальная имитация Supabase для проверки миграции (НЕ запускать в Supabase).
do $$ begin create role anon nologin; exception when others then null; end $$;
do $$ begin create role authenticated nologin; exception when others then null; end $$;
create schema extensions; create extension pgcrypto with schema extensions;
create schema storage; create table storage.buckets(id text primary key, file_size_limit bigint, allowed_mime_types text[]);
insert into storage.buckets(id) values ('defect-photos');
grant usage on schema public to anon, authenticated;
create table public.vehicles(id uuid primary key default gen_random_uuid(), code text unique, plate text, model text, active boolean default true);
create table public.inspections(id uuid primary key default gen_random_uuid(), vehicle_id uuid references public.vehicles(id), driver_name text, pilot_code text, status text, started_at timestamptz default now(), completed_at timestamptz);
create table public.inspection_items(id bigserial primary key, inspection_id uuid references public.inspections(id), step_no int, zone text, result text, critical boolean, comment text, photo_url text, scanned_at timestamptz, seconds_from_start int);
create table public.defect_closures(id bigserial primary key, inspection_id uuid references public.inspections(id), mechanic_name text, action_taken text, repair_photo_url text, reinspection_required boolean, closed_at timestamptz default now());
create table public.recheck_log(id bigserial primary key, inspection_id uuid references public.inspections(id), inspector_name text, result text, comment text, created_at timestamptz default now());
-- как в прототипе: всё открыто
grant all on all tables in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;
alter table public.inspections enable row level security;
create policy "allow all" on public.inspections for all using (true) with check (true);
insert into public.vehicles(code,plate,model) values ('KBM-262AG12','262 AG 12','ПАЗ-320540-22'),('KBM-OTHER','111 AA 12','УАЗ');
insert into public.inspections(vehicle_id, driver_name, pilot_code, status) select id,'Старый','К0001','passed' from public.vehicles where code='KBM-262AG12';