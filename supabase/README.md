# Этап 2 — защищённая версия (ветка `feature/secure-backend`)

Сначала база, потом код. Если задеплоить код без миграции, вход водителей не будет работать.

## 1. Перед запуском

- Сделайте резервную копию: Supabase → Database → Backups (или `pg_dump`).
- Лучше всего сначала проверить на отдельном проекте Supabase (копии), а потом на рабочем.

## 2. Миграция

Supabase → SQL Editor → вставить `migrations/20261009_secure_safecheck.sql` целиком → **Run**.
В конце должно появиться `migration = ok`. Повторный запуск безопасен.

Миграция удаляет старые политики RLS у таблиц `vehicles`, `inspections`, `inspection_items`, `defect_closures`, `recheck_log`
и оставляет для браузера только чтение. Писать можно только через функции.

## 3. PIN-коды

```sql
-- новые 6-значные PIN всем пилотным водителям (показываются один раз — сохраните список)
select * from public.admin_reset_driver_pins();

-- или задать конкретный PIN (например, табельный номер + 2 цифры)
select public.admin_upsert_driver('Арман Талғатұлы', '482915', 'K0007');

-- механики и администратор (администратор печатает QR и тоже может закрывать HARD STOP)
select public.admin_upsert_staff('ФИО механика', 'mechanic', '111222');
select public.admin_upsert_staff('ФИО администратора', 'admin', '333444');
```

После 5 неверных попыток вход по этому ФИО блокируется на 10 минут.

## 4. Деплой и QR

1. Влейте `feature/secure-backend` → Vercel задеплоит.
2. Откройте `/qr`, войдите как администратор, распечатайте **новые** наклейки для каждого ТС.
   Старые QR без токена `k=` больше не принимаются.

## 5. Что проверяет сервер

| Проверка | Где |
|---|---|
| PIN (только хеш bcrypt), сессия 14 ч | `driver_login`, `sc_driver` |
| QR-токен точки (HMAC от секрета ТС) | `record_step` |
| Порядок точек 1→6, без пропусков и повторов | `record_step` |
| Минимум 10 с между точками | `sc_min_step_seconds()` |
| Дефект: описание обязательно, фото обязательно онлайн | `record_step` |
| Итог `passed` / `hard_stop` | `record_step` (6-я точка) |
| ТС с открытым HARD STOP не допускается новым осмотром | `start_inspection` |
| Ремонт закрывает только механик/админ по PIN | `mechanic_close` |
| После ремонта осмотр автоматически повторный → `passed_after_repair` | `start_inspection`, `record_step` |

Изменить минимальное время: `create or replace function public.sc_min_step_seconds() returns int language sql immutable as $$ select 15 $$;`

## 6. Проверка локально (необязательно)

`tests/00_stub_supabase.sql` имитирует Supabase на обычном PostgreSQL 16, `tests/01_flow_test.sql` прогоняет сценарии:

```bash
createdb sc && psql -d sc -f supabase/tests/00_stub_supabase.sql \
  && psql -d sc -f supabase/migrations/20261009_secure_safecheck.sql \
  && psql -d sc -f supabase/tests/01_flow_test.sql   # в конце: ALL TESTS PASSED
```

## 7. Что осталось на следующий шаг

- Хранилище фото `defect-photos` пока публичное (ссылки `getPublicUrl`). Для промышленной версии — приватный bucket и подписанные ссылки.
- Панели `/dashboard`, `/vehicle`, `/pilot-report` читаются без входа (только чтение). Для промышленной версии закрыть входом.