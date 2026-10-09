-- =====================================================================
-- 360° SafeCheck — серверная проверка осмотра (Supabase / PostgreSQL)
--
-- Что делает миграция:
--   1. Водители и механики/администраторы с PIN-кодами (хранится только хеш).
--   2. Сессии водителей (токен вместо пароля в браузере).
--   3. QR-токены: у каждого ТС свой секрет, QR без правильного токена
--      не принимается. QR-наклейки нужно перепечатать на /qr.
--   4. Весь осмотр идёт через функции (RPC): порядок точек, минимальное
--      время между точками, итоговый статус и HARD STOP считает сервер.
--   5. ТС с открытым HARD STOP нельзя «пройти» новым осмотром — только
--      после ремонта механиком и повторного 360°-осмотра.
--   6. RLS: из браузера таблицы только читаются, запись — только через RPC.
--
-- Запуск: Supabase → SQL Editor → вставить файл целиком → Run.
-- Затем:  select * from public.admin_reset_driver_pins();   -- PIN водителей
--         select public.admin_upsert_staff('ФИО', 'admin', '123456');
--         select public.admin_upsert_staff('ФИО', 'mechanic', '654321');
-- Миграцию можно запускать повторно.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- 1. Справочники
-- ---------------------------------------------------------------------
create table if not exists public.drivers (
  id          uuid primary key default gen_random_uuid(),
  full_name   text not null unique,
  tab_no      text,
  pin_hash    text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.driver_sessions (
  token       uuid primary key default gen_random_uuid(),
  driver_id   uuid not null references public.drivers(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '14 hours'
);

create table if not exists public.staff (
  id          uuid primary key default gen_random_uuid(),
  full_name   text not null unique,
  role        text not null check (role in ('mechanic', 'admin')),
  pin_hash    text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.login_attempts (
  id          bigserial primary key,
  login_name  text not null,
  ok          boolean not null,
  at          timestamptz not null default now()
);
create index if not exists login_attempts_name_at on public.login_attempts (login_name, at desc);

alter table public.vehicles    add column if not exists qr_secret text;
update public.vehicles set qr_secret = encode(extensions.gen_random_bytes(16), 'hex') where qr_secret is null;
alter table public.vehicles    alter column qr_secret set default encode(extensions.gen_random_bytes(16), 'hex');

alter table public.inspections add column if not exists driver_id    uuid references public.drivers(id);
alter table public.inspections add column if not exists recheck_of   uuid references public.inspections(id);
alter table public.inspections add column if not exists last_step_at timestamptz;

-- Одна запись на точку в каждом осмотре (если в старых данных есть дубли — пропускаем).
do $$ begin
  create unique index if not exists inspection_items_one_per_step
    on public.inspection_items (inspection_id, step_no);
exception when others then
  raise notice 'inspection_items_one_per_step не создан: в данных есть дубли (%).', sqlerrm;
end $$;

-- Пилотные осмотры раньше писали PIN «К0001» в pilot_code — переносим в код пилота.
update public.inspections set pilot_code = 'KBM-PILOT-2026' where pilot_code = 'К0001';

-- Пилотные водители (PIN выдаётся через admin_reset_driver_pins()).
insert into public.drivers (full_name, pin_hash)
select n, extensions.crypt(encode(extensions.gen_random_bytes(12), 'hex'), extensions.gen_salt('bf'))
from unnest(array[
  'Айдос Нұрланұлы','Ерлан Серікұлы','Марат Асқарұлы','Данияр Болатұлы','Нұржан Әлиұлы',
  'Серік Бауыржанұлы','Арман Талғатұлы','Бекзат Ермекұлы','Қайрат Асқарұлы','Руслан Маратұлы',
  'Нұрбол Дәулетұлы','Самат Жандосұлы','Азамат Берікұлы','Ермек Қанатұлы','Талғат Нұрланұлы'
]) as n
on conflict (full_name) do nothing;

-- ---------------------------------------------------------------------
-- 2. Служебные функции (не доступны из браузера)
-- ---------------------------------------------------------------------
create or replace function public.sc_norm_pin(p text) returns text
language sql immutable set search_path = public as $$
  -- кириллические буквы, похожие на латинские, приводим к латинице: «К0001» = «K0001»
  select translate(upper(trim(coalesce(p, ''))), 'АВЕКМНОРСТХ', 'ABEKMHOPCTX')
$$;

create or replace function public.sc_min_step_seconds() returns int
language sql immutable as $$ select 10 $$;   -- минимум секунд между точками

create or replace function public.sc_zone(p_step int) returns text
language sql immutable as $$
  select (array[
    'Передняя часть: фары, стекло, препятствия',
    'Правая передняя зона: колесо и шина',
    'Правая сторона: кузов, двери, утечки',
    'Задняя часть: фонари, пространство позади',
    'Левая сторона: кузов, двери, утечки',
    'Левая передняя зона: колесо, шина, зона перед стартом'
  ])[p_step]
$$;

create or replace function public.sc_qr_token(p_vehicle_id uuid, p_step int) returns text
language sql stable security definer set search_path = public as $$
  select left(encode(extensions.hmac(v.code || ':' || p_step, v.qr_secret, 'sha256'), 'hex'), 16)
  from public.vehicles v where v.id = p_vehicle_id
$$;

create or replace function public.sc_check_rate(p_login text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.login_attempts
      where login_name = p_login and not ok and at > now() - interval '10 minutes') >= 5 then
    raise exception 'SC_LOGIN_LOCKED';
  end if;
end $$;

create or replace function public.sc_driver(p_token uuid) returns public.drivers
language plpgsql security definer set search_path = public as $$
declare d public.drivers;
begin
  select dr.* into d from public.driver_sessions s join public.drivers dr on dr.id = s.driver_id
  where s.token = p_token and s.expires_at > now() and dr.active;
  if not found then raise exception 'SC_SESSION'; end if;
  return d;
end $$;

create or replace function public.sc_staff(p_name text, p_pin text, p_roles text[]) returns public.staff
language plpgsql security definer set search_path = public as $$
declare s public.staff;
begin
  perform public.sc_check_rate('staff:' || coalesce(p_name, ''));
  select * into s from public.staff
  where full_name = p_name and active and role = any(p_roles)
    and pin_hash = extensions.crypt(public.sc_norm_pin(p_pin), pin_hash);
  -- Неверный PIN: без исключения, иначе откатится запись о неудачной попытке
  insert into public.login_attempts (login_name, ok) values ('staff:' || coalesce(p_name, ''), s.id is not null);
  return s;  -- id is null, если PIN неверный
end $$;

create or replace function public.sc_state(p_inspection uuid) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'id', i.id,
    'vehicle_code', v.code,
    'started_at', i.started_at,
    'last_step_at', i.last_step_at,
    'status', i.status,
    'completed', i.completed_at is not null,
    'recheck_of', i.recheck_of,
    'steps_done', (select count(*) from public.inspection_items it where it.inspection_id = i.id),
    'has_critical', exists (select 1 from public.inspection_items it where it.inspection_id = i.id and it.critical)
  )
  from public.inspections i join public.vehicles v on v.id = i.vehicle_id
  where i.id = p_inspection
$$;

-- ---------------------------------------------------------------------
-- 3. RPC для приложения водителя
-- ---------------------------------------------------------------------
create or replace function public.driver_names() returns setof text
language sql stable security definer set search_path = public as $$
  select full_name from public.drivers where active order by full_name
$$;

create or replace function public.driver_login(p_name text, p_pin text) returns json
language plpgsql security definer set search_path = public as $$
declare d public.drivers; s public.driver_sessions;
begin
  perform public.sc_check_rate('driver:' || coalesce(p_name, ''));
  select * into d from public.drivers
  where full_name = p_name and active
    and pin_hash = extensions.crypt(public.sc_norm_pin(p_pin), pin_hash);
  insert into public.login_attempts (login_name, ok) values ('driver:' || coalesce(p_name, ''), d.id is not null);
  if d.id is null then return json_build_object('error', 'SC_LOGIN'); end if;
  delete from public.driver_sessions where expires_at < now();
  insert into public.driver_sessions (driver_id) values (d.id) returning * into s;
  return json_build_object('token', s.token, 'name', d.full_name, 'tab_no', d.tab_no, 'expires_at', s.expires_at);
end $$;

create or replace function public.driver_logout(p_token uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.driver_sessions where token = p_token
$$;

-- Статус ТС перед осмотром: свободно / открыт HARD STOP / ждёт повторного осмотра
create or replace function public.vehicle_status(p_code text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'found', v.id is not null,
    'status', last.status,
    'blocked', coalesce(last.status = 'hard_stop', false),
    'recheck', coalesce(last.status in ('repair_confirmed', 'reinspection'), false)
  )
  from (select 1) one
  left join public.vehicles v on v.code = p_code and v.active
  left join lateral (
    select i.status from public.inspections i
    where i.vehicle_id = v.id
      and i.status in ('passed','hard_stop','repair_confirmed','reinspection','passed_after_repair','closed')
    order by i.started_at desc
    limit 1
  ) last on true
$$;

create or replace function public.start_inspection(p_token uuid, p_vehicle_code text, p_pilot_code text default null)
returns json
language plpgsql security definer set search_path = public as $$
declare
  d public.drivers := public.sc_driver(p_token);
  v public.vehicles;
  open_id uuid;
  last public.inspections;
  new_id uuid;
begin
  select * into v from public.vehicles where code = p_vehicle_code and active;
  if not found then raise exception 'SC_VEHICLE_NOT_FOUND'; end if;

  -- Незавершённый осмотр этого водителя на этом ТС (за 3 часа) — продолжаем его.
  select id into open_id from public.inspections
  where vehicle_id = v.id and driver_id = d.id and completed_at is null
    and coalesce(status, 'in_progress') not in ('passed','hard_stop','repair_confirmed','passed_after_repair','closed','reinspection','abandoned')
    and started_at > now() - interval '3 hours'
  order by started_at desc limit 1;
  if open_id is not null then
    return (public.sc_state(open_id)::jsonb || '{"resumed": true}'::jsonb)::json;
  end if;

  -- Последний значимый осмотр ТС
  select * into last from public.inspections i
  where i.vehicle_id = v.id
    and i.status in ('passed','hard_stop','repair_confirmed','reinspection','passed_after_repair','closed')
  order by i.started_at desc limit 1;

  if last.status = 'hard_stop' then raise exception 'SC_VEHICLE_BLOCKED'; end if;

  -- Прочие незавершённые осмотры этого ТС закрываем как брошенные
  update public.inspections set status = 'abandoned'
  where vehicle_id = v.id and completed_at is null
    and coalesce(status, 'in_progress') not in ('passed','hard_stop','repair_confirmed','passed_after_repair','closed','reinspection','abandoned');

  insert into public.inspections (vehicle_id, driver_name, driver_id, pilot_code, recheck_of, last_step_at)
  values (v.id, d.full_name, d.id, nullif(trim(p_pilot_code), ''),
          case when last.status in ('repair_confirmed','reinspection') then last.id end, now())
  returning id into new_id;

  if last.status = 'repair_confirmed' then
    update public.inspections set status = 'reinspection' where id = last.id;
  end if;

  return (public.sc_state(new_id)::jsonb || '{"resumed": false}'::jsonb)::json;
end $$;

create or replace function public.inspection_state(p_token uuid, p_inspection uuid) returns json
language plpgsql security definer set search_path = public as $$
declare d public.drivers := public.sc_driver(p_token);
begin
  if not exists (select 1 from public.inspections where id = p_inspection and driver_id = d.id) then
    raise exception 'SC_NOT_YOURS';
  end if;
  return public.sc_state(p_inspection);
end $$;

create or replace function public.record_step(
  p_token       uuid,
  p_inspection  uuid,
  p_step        int,
  p_qr          text,
  p_result      text,
  p_critical    boolean default false,
  p_comment     text default null,
  p_photo_url   text default null,
  p_scanned_at  timestamptz default null,
  p_offline     boolean default false
) returns json
language plpgsql security definer set search_path = public as $$
declare
  d      public.drivers := public.sc_driver(p_token);
  insp   public.inspections;
  done   int;
  prev   timestamptz;
  t      timestamptz;
  crit   boolean;
  final  text;
begin
  select * into insp from public.inspections where id = p_inspection for update;
  if not found or insp.driver_id is distinct from d.id then raise exception 'SC_NOT_YOURS'; end if;

  select count(*) into done from public.inspection_items where inspection_id = insp.id;

  -- Повторная отправка уже сохранённой точки (офлайн-очередь, двойное нажатие) — не ошибка
  if p_step <= done then return public.sc_state(insp.id); end if;

  if insp.completed_at is not null then raise exception 'SC_ALREADY_DONE'; end if;
  if p_step <> done + 1 or p_step not between 1 and 6 then raise exception 'SC_STEP_ORDER'; end if;
  if p_qr is null or p_qr <> public.sc_qr_token(insp.vehicle_id, p_step) then raise exception 'SC_QR_INVALID'; end if;
  if p_result not in ('ok', 'defect') then raise exception 'SC_BAD_RESULT'; end if;

  if p_result = 'defect' then
    if length(trim(coalesce(p_comment, ''))) < 3 then raise exception 'SC_COMMENT_REQUIRED'; end if;
    if p_photo_url is null and not p_offline then raise exception 'SC_PHOTO_REQUIRED'; end if;
  end if;

  prev := coalesce(insp.last_step_at, insp.started_at);
  -- Онлайн — время сервера. Офлайн — время телефона, но не раньше прошлой точки и не позже «сейчас».
  t := case when p_offline and p_scanned_at is not null
            then least(greatest(p_scanned_at, prev), now())
            else now() end;
  if extract(epoch from t - prev) < public.sc_min_step_seconds() then raise exception 'SC_TOO_FAST'; end if;

  insert into public.inspection_items
    (inspection_id, step_no, zone, result, critical, comment, photo_url, scanned_at, seconds_from_start)
  values
    (insp.id, p_step, public.sc_zone(p_step), p_result,
     p_result = 'defect' and coalesce(p_critical, false),
     case when p_result = 'defect' then trim(p_comment)
          else nullif(trim(coalesce(p_comment, '')), '') end,
     case when p_result = 'defect' then p_photo_url end,
     t, greatest(0, extract(epoch from t - insp.started_at))::int);

  update public.inspections set last_step_at = t where id = insp.id;

  if p_step = 6 then
    select exists (select 1 from public.inspection_items where inspection_id = insp.id and critical) into crit;
    final := case when crit then 'hard_stop' else 'passed' end;
    update public.inspections set status = final, completed_at = t where id = insp.id;
    if insp.recheck_of is not null then
      insert into public.recheck_log (inspection_id, inspector_name, result, comment)
      values (insp.recheck_of, d.full_name,
              case when crit then 'failed' else 'passed' end,
              case when crit then 'Повторно выявлен критический дефект' else 'Повторный 360°-осмотр пройден' end);
      update public.inspections
        set status = case when crit then 'hard_stop' else 'passed_after_repair' end
        where id = insp.recheck_of;
      -- Новый осмотр с HARD STOP сам станет открытым случаем для механика;
      -- исходный остаётся в истории с тем же статусом.
    end if;
  end if;

  return public.sc_state(insp.id);
end $$;

-- ---------------------------------------------------------------------
-- 4. RPC для механика и администратора
-- ---------------------------------------------------------------------
create or replace function public.staff_names(p_role text default null) returns table(full_name text, role text)
language sql stable security definer set search_path = public as $$
  select s.full_name, s.role from public.staff s
  where s.active and (p_role is null or s.role = p_role or s.role = 'admin')
  order by s.full_name
$$;

create or replace function public.staff_check(p_name text, p_pin text, p_role text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  return (public.sc_staff(p_name, p_pin, case when p_role = 'admin' then array['admin'] else array['mechanic','admin'] end)).id is not null;
end $$;

create or replace function public.mechanic_close(p_name text, p_pin text, p_inspection uuid, p_action text, p_photo_url text)
returns json
language plpgsql security definer set search_path = public as $$
declare s public.staff := public.sc_staff(p_name, p_pin, array['mechanic','admin']); insp public.inspections; v_code text;
begin
  if s.id is null then return json_build_object('ok', false, 'error', 'SC_LOGIN'); end if;
  select * into insp from public.inspections where id = p_inspection for update;
  if not found then raise exception 'SC_NOT_FOUND'; end if;
  if insp.status <> 'hard_stop' then raise exception 'SC_NOT_HARD_STOP'; end if;
  if length(trim(coalesce(p_action, ''))) < 3 then raise exception 'SC_COMMENT_REQUIRED'; end if;
  if p_photo_url is null then raise exception 'SC_PHOTO_REQUIRED'; end if;

  insert into public.defect_closures (inspection_id, mechanic_name, action_taken, repair_photo_url, reinspection_required)
  values (insp.id, s.full_name, trim(p_action), p_photo_url, true);
  update public.inspections set status = 'repair_confirmed' where id = insp.id;
  -- Остальные открытые HARD STOP этого ТС закрываем тем же ремонтом
  update public.inspections set status = 'repair_confirmed'
  where vehicle_id = insp.vehicle_id and status = 'hard_stop' and id <> insp.id;

  select code into v_code from public.vehicles where id = insp.vehicle_id;
  return json_build_object('ok', true, 'vehicle_code', v_code);
end $$;

create or replace function public.admin_qr_tokens(p_name text, p_pin text, p_vehicle_code text)
returns table(step int, token text)
language plpgsql security definer set search_path = public as $$
declare vid uuid;
begin
  if (public.sc_staff(p_name, p_pin, array['admin'])).id is null then return; end if;  -- неверный PIN: пусто
  select id into vid from public.vehicles where code = p_vehicle_code;
  if vid is null then raise exception 'SC_VEHICLE_NOT_FOUND'; end if;
  return query select g, public.sc_qr_token(vid, g) from generate_series(1, 6) g;
end $$;

-- Только из SQL Editor (у браузера нет прав):
create or replace function public.admin_upsert_driver(p_name text, p_pin text, p_tab_no text default null) returns void
language sql security definer set search_path = public as $$
  insert into public.drivers (full_name, tab_no, pin_hash)
  values (p_name, p_tab_no, extensions.crypt(public.sc_norm_pin(p_pin), extensions.gen_salt('bf')))
  on conflict (full_name) do update set pin_hash = excluded.pin_hash, tab_no = coalesce(excluded.tab_no, public.drivers.tab_no), active = true
$$;

create or replace function public.admin_upsert_staff(p_name text, p_role text, p_pin text) returns void
language sql security definer set search_path = public as $$
  insert into public.staff (full_name, role, pin_hash)
  values (p_name, p_role, extensions.crypt(public.sc_norm_pin(p_pin), extensions.gen_salt('bf')))
  on conflict (full_name) do update set role = excluded.role, pin_hash = excluded.pin_hash, active = true
$$;

-- Выдать новые 6-значные PIN всем (или указанным) водителям. Показывает PIN один раз.
create or replace function public.admin_reset_driver_pins(p_names text[] default null)
returns table(full_name text, pin text)
language plpgsql security definer set search_path = public as $$
declare r record; new_pin text;
begin
  for r in select d.full_name from public.drivers d where d.active and (p_names is null or d.full_name = any(p_names)) order by 1 loop
    new_pin := lpad((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000)::text, 6, '0');
    update public.drivers d set pin_hash = extensions.crypt(new_pin, extensions.gen_salt('bf')) where d.full_name = r.full_name;
    delete from public.driver_sessions s using public.drivers d where s.driver_id = d.id and d.full_name = r.full_name;
    full_name := r.full_name; pin := new_pin; return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 5. Права и RLS
-- ---------------------------------------------------------------------
revoke all on function
  public.sc_norm_pin(text), public.sc_min_step_seconds(), public.sc_zone(int), public.sc_qr_token(uuid, int),
  public.sc_check_rate(text), public.sc_driver(uuid), public.sc_staff(text, text, text[]), public.sc_state(uuid),
  public.admin_upsert_driver(text, text, text), public.admin_upsert_staff(text, text, text),
  public.admin_reset_driver_pins(text[]),
  public.driver_names(), public.driver_login(text, text), public.driver_logout(uuid), public.vehicle_status(text),
  public.start_inspection(uuid, text, text), public.inspection_state(uuid, uuid),
  public.record_step(uuid, uuid, int, text, text, boolean, text, text, timestamptz, boolean),
  public.staff_names(text), public.staff_check(text, text, text),
  public.mechanic_close(text, text, uuid, text, text), public.admin_qr_tokens(text, text, text)
from public, anon, authenticated;

grant execute on function
  public.driver_names(), public.driver_login(text, text), public.driver_logout(uuid), public.vehicle_status(text),
  public.start_inspection(uuid, text, text), public.inspection_state(uuid, uuid),
  public.record_step(uuid, uuid, int, text, text, boolean, text, text, timestamptz, boolean),
  public.staff_names(text), public.staff_check(text, text, text),
  public.mechanic_close(text, text, uuid, text, text), public.admin_qr_tokens(text, text, text)
to anon, authenticated;

-- Служебные таблицы — полностью закрыты для браузера
do $$ declare t text; begin
  foreach t in array array['drivers','driver_sessions','staff','login_attempts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Рабочие таблицы — только чтение из браузера, запись только через RPC.
-- Старые политики (например, «allow all») удаляются.
do $$ declare t text; p record; begin
  foreach t in array array['vehicles','inspections','inspection_items','defect_closures','recheck_log'] loop
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
    execute format('create policy sc_read on public.%I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

-- Секрет QR не должен читаться из браузера: даём доступ только к нужным колонкам
revoke select on public.vehicles from anon, authenticated;
grant select (id, code, plate, model, active) on public.vehicles to anon, authenticated;

-- Фото: только изображения до 5 МБ
update storage.buckets
set file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
where id = 'defect-photos';

-- Сразу показать, что всё на месте
select 'ok' as migration, (select count(*) from public.drivers) as drivers, (select count(*) from public.staff) as staff;