-- Проверка сценариев на локальной имитации Supabase (00_stub_supabase.sql + миграция).
\set ON_ERROR_STOP 1
create or replace function pg_temp.expect_error(q text, code text) returns void language plpgsql as $$
begin
  begin execute q; exception when others then
    if sqlerrm like '%' || code || '%' then raise notice 'PASS: % -> %', left(q, 60), code; return; end if;
    raise exception 'FAIL: % -> expected %, got %', q, code, sqlerrm;
  end;
  raise exception 'FAIL: % -> expected %, got success', q, code;
end $$;
create or replace function pg_temp.ok(cond boolean, msg text) returns void language plpgsql as $$
begin if cond then raise notice 'PASS: %', msg; else raise exception 'FAIL: %', msg; end if; end $$;

-- админ задаёт PIN (как в SQL Editor)
select public.admin_upsert_driver('Арман Талғатұлы', '482915', 'K0007');
select public.admin_upsert_staff('Механик Тест', 'mechanic', '111111');
select public.admin_upsert_staff('Админ Тест', 'admin', '999999');
create temp table qr as select v.code, g as step, public.sc_qr_token(v.id, g) tok from public.vehicles v, generate_series(1,6) g;
grant select on qr to anon;

set role anon;
-- RLS / права
select pg_temp.expect_error($$insert into public.inspections(driver_name) values ('x')$$, 'permission denied');
select pg_temp.expect_error($$update public.inspections set status='passed'$$, 'permission denied');
select pg_temp.expect_error($$select qr_secret from public.vehicles$$, 'permission denied');
select pg_temp.expect_error($$select * from public.drivers$$, 'permission denied');
select pg_temp.expect_error($$select public.admin_reset_driver_pins()$$, 'permission denied');
select pg_temp.expect_error($$select public.sc_qr_token((select id from public.vehicles limit 1), 1)$$, 'permission denied');
select pg_temp.ok((select count(*) from public.vehicles) = 2, 'anon читает vehicles (code, plate, model)');
select pg_temp.ok((select count(*) from public.driver_names()) = 15, 'список ФИО водителей');

-- вход
select pg_temp.ok((public.driver_login('Арман Талғатұлы', '000000')->>'error') = 'SC_LOGIN', 'неверный PIN отклонён');
select pg_temp.ok((public.driver_login('Арман Талғатұлы', 'к482915')->>'error') = 'SC_LOGIN', 'лишний символ отклонён');
select public.driver_login('Арман Талғатұлы', '482915')->>'token' as tok \gset
select pg_temp.expect_error($$select public.start_inspection('00000000-0000-0000-0000-000000000000', 'KBM-262AG12')$$, 'SC_SESSION');

-- полный осмотр без дефектов
select public.start_inspection(:'tok', 'KBM-262AG12', 'KBM-PILOT-2026')->>'id' as insp \gset
select pg_temp.ok((public.start_inspection(:'tok', 'KBM-262AG12')->>'id') = :'insp', 'повторный старт продолжает тот же осмотр');
reset role;
-- «прошло время» — сдвигаем отметки назад, чтобы не ждать 10 с
create or replace function pg_temp.age(i uuid) returns void language sql as $$ update public.inspections set last_step_at = last_step_at - interval '15 seconds' where id = i $$;
set role anon;
select pg_temp.expect_error(format($$select public.record_step(%L, %L, 1, %L, 'ok')$$, :'tok', :'insp', (select tok from qr where code='KBM-262AG12' and step=1)), 'SC_TOO_FAST');
reset role; select pg_temp.age(:'insp'); set role anon;
select pg_temp.expect_error(format($$select public.record_step(%L, %L, 1, 'wrong', 'ok')$$, :'tok', :'insp'), 'SC_QR_INVALID');
select pg_temp.expect_error(format($$select public.record_step(%L, %L, 1, %L, 'ok')$$, :'tok', :'insp', (select tok from qr where code='KBM-OTHER' and step=1)), 'SC_QR_INVALID');
select pg_temp.expect_error(format($$select public.record_step(%L, %L, 2, %L, 'ok')$$, :'tok', :'insp', (select tok from qr where code='KBM-262AG12' and step=2)), 'SC_STEP_ORDER');
select pg_temp.expect_error(format($$select public.record_step(%L, %L, 1, %L, 'defect', true, 'течь')$$, :'tok', :'insp', (select tok from qr where code='KBM-262AG12' and step=1)), 'SC_PHOTO_REQUIRED');
-- «Исправно» + critical=true → critical не сохраняется
select public.record_step(:'tok', :'insp', 1, (select tok from qr where code='KBM-262AG12' and step=1), 'ok', true);
select pg_temp.ok(not (select critical from public.inspection_items where inspection_id = :'insp' and step_no = 1), 'ok + critical → critical=false');
-- повторная отправка той же точки — не ошибка и не дубль
select public.record_step(:'tok', :'insp', 1, (select tok from qr where code='KBM-262AG12' and step=1), 'ok');
select pg_temp.ok((select count(*) from public.inspection_items where inspection_id = :'insp') = 1, 'идемпотентность точки');
reset role; select pg_temp.age(:'insp'); set role anon;
select public.record_step(:'tok', :'insp', 2, (select tok from qr where code='KBM-262AG12' and step=2), 'ok');
reset role; select pg_temp.age(:'insp'); set role anon;
select public.record_step(:'tok', :'insp', 3, (select tok from qr where code='KBM-262AG12' and step=3), 'ok');
reset role; select pg_temp.age(:'insp'); set role anon;
select public.record_step(:'tok', :'insp', 4, (select tok from qr where code='KBM-262AG12' and step=4), 'ok');
reset role; select pg_temp.age(:'insp'); set role anon;
select public.record_step(:'tok', :'insp', 5, (select tok from qr where code='KBM-262AG12' and step=5), 'ok');
reset role; select pg_temp.age(:'insp'); set role anon;
select public.record_step(:'tok', :'insp', 6, (select tok from qr where code='KBM-262AG12' and step=6), 'ok');
select pg_temp.ok((select status from public.inspections where id = :'insp') = 'passed', 'итог PASSED считает сервер');
select pg_temp.ok((select count(*) from public.inspection_items where inspection_id = :'insp') = 6, '6 точек');
select pg_temp.expect_error(format($$select public.record_step(%L, %L, 7, 'x', 'ok')$$, :'tok', :'insp'), 'SC_ALREADY_DONE');

-- осмотр с критическим дефектом → HARD STOP → блок → ремонт → повторный
select public.start_inspection(:'tok', 'KBM-262AG12')->>'id' as insp2 \gset
select pg_temp.ok(:'insp2' <> :'insp', 'новый осмотр после завершённого');
reset role; select pg_temp.age(:'insp2'); set role anon;
select public.record_step(:'tok', :'insp2', 1, (select tok from qr where code='KBM-262AG12' and step=1), 'defect', true, 'утечка масла', 'https://x/photo.jpg');
reset role; select pg_temp.age(:'insp2'); set role anon;
select public.record_step(:'tok', :'insp2', 2, (select tok from qr where code='KBM-262AG12' and step=2), 'ok');
reset role; select pg_temp.age(:'insp2'); set role anon;
select public.record_step(:'tok', :'insp2', 3, (select tok from qr where code='KBM-262AG12' and step=3), 'ok');
reset role; select pg_temp.age(:'insp2'); set role anon;
select public.record_step(:'tok', :'insp2', 4, (select tok from qr where code='KBM-262AG12' and step=4), 'ok');
reset role; select pg_temp.age(:'insp2'); set role anon;
select public.record_step(:'tok', :'insp2', 5, (select tok from qr where code='KBM-262AG12' and step=5), 'ok');
reset role; select pg_temp.age(:'insp2'); set role anon;
select public.record_step(:'tok', :'insp2', 6, (select tok from qr where code='KBM-262AG12' and step=6), 'ok');
select pg_temp.ok((select status from public.inspections where id = :'insp2') = 'hard_stop', 'итог HARD STOP');
select pg_temp.ok((public.vehicle_status('KBM-262AG12')->>'blocked')::boolean, 'vehicle_status: заблокировано');
select pg_temp.expect_error(format($$select public.start_inspection(%L, 'KBM-262AG12')$$, :'tok'), 'SC_VEHICLE_BLOCKED');
-- водитель не может сам снять блок
select pg_temp.ok((public.mechanic_close('Арман Талғатұлы', '482915', :'insp2', 'ремонт', 'https://x/r.jpg')->>'error') = 'SC_LOGIN', 'водитель не механик');
select pg_temp.ok((public.mechanic_close('Механик Тест', '000000', :'insp2', 'ремонт', 'https://x/r.jpg')->>'error') = 'SC_LOGIN', 'неверный PIN механика');
select pg_temp.ok((public.mechanic_close('Механик Тест', '111111', :'insp2', 'Заменён сальник', 'https://x/r.jpg')->>'ok')::boolean, 'механик закрыл');
select pg_temp.ok((select status from public.inspections where id = :'insp2') = 'repair_confirmed', 'статус repair_confirmed');
select public.start_inspection(:'tok', 'KBM-262AG12')->>'id' as insp3 \gset
select pg_temp.ok((select recheck_of from public.inspections where id = :'insp3') = :'insp2', 'осмотр автоматически повторный');
select pg_temp.ok((select status from public.inspections where id = :'insp2') = 'reinspection', 'исходный → reinspection');
reset role; select pg_temp.age(:'insp3'); set role anon;
select public.record_step(:'tok', :'insp3', 1, (select tok from qr where code='KBM-262AG12' and step=1), 'ok');
reset role; select pg_temp.age(:'insp3'); set role anon;
select public.record_step(:'tok', :'insp3', 2, (select tok from qr where code='KBM-262AG12' and step=2), 'ok');
reset role; select pg_temp.age(:'insp3'); set role anon;
select public.record_step(:'tok', :'insp3', 3, (select tok from qr where code='KBM-262AG12' and step=3), 'ok');
reset role; select pg_temp.age(:'insp3'); set role anon;
select public.record_step(:'tok', :'insp3', 4, (select tok from qr where code='KBM-262AG12' and step=4), 'ok');
reset role; select pg_temp.age(:'insp3'); set role anon;
select public.record_step(:'tok', :'insp3', 5, (select tok from qr where code='KBM-262AG12' and step=5), 'ok');
reset role; select pg_temp.age(:'insp3'); set role anon;
select public.record_step(:'tok', :'insp3', 6, (select tok from qr where code='KBM-262AG12' and step=6), 'ok');
select pg_temp.ok((select status from public.inspections where id = :'insp2') = 'passed_after_repair', 'исходный → passed_after_repair');
select pg_temp.ok((select count(*) from public.recheck_log where inspection_id = :'insp2' and result = 'passed') = 1, 'recheck_log записан');

-- QR-токены: только админ
select pg_temp.ok((select count(*) from public.admin_qr_tokens('Механик Тест', '111111', 'KBM-262AG12')) = 0, 'механик не получает QR-токены');
select pg_temp.ok((select count(*) from public.admin_qr_tokens('Админ Тест', '999999', 'KBM-262AG12')) = 6, 'админ получает 6 токенов');

-- подбор PIN блокируется после 5 ошибок
select public.driver_login('Ерлан Серікұлы', '1') from generate_series(1,5);
select pg_temp.expect_error($$select public.driver_login('Ерлан Серікұлы', '2')$$, 'SC_LOGIN_LOCKED');

-- чужой осмотр
reset role; select public.admin_upsert_driver('Ерлан Серікұлы', '123123'); delete from public.login_attempts; set role anon;
select public.driver_login('Ерлан Серікұлы', '123123')->>'token' as tok2 \gset
select pg_temp.expect_error(format($$select public.inspection_state(%L, %L)$$, :'tok2', :'insp3'), 'SC_NOT_YOURS');
reset role;
select pg_temp.ok((select pilot_code from public.inspections where driver_name = 'Старый') = 'KBM-PILOT-2026', 'старый pilot_code перенесён');
select 'ALL TESTS PASSED' as result;