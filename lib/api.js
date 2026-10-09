import { supabase } from "./supabase";

// Все записи идут через функции Supabase (RPC) — сервер проверяет порядок точек,
// QR-токен, время и сам выставляет итоговый статус. См. supabase/migrations.

const MESSAGES = {
  SC_LOGIN: ["Неверное ФИО или PIN", "Аты-жөні немесе PIN қате"],
  SC_LOGIN_LOCKED: [
    "Слишком много попыток. Повторите через 10 минут.",
    "Тым көп әрекет. 10 минуттан кейін қайталаңыз.",
  ],
  SC_SESSION: [
    "Сессия истекла. Войдите заново.",
    "Сессия аяқталды. Қайта кіріңіз.",
  ],
  SC_VEHICLE_NOT_FOUND: ["ТС не найдено в системе", "Көлік жүйеде табылмады"],
  SC_VEHICLE_BLOCKED: [
    "ТС заблокировано: открыт HARD STOP. Выезд возможен только после ремонта и повторного осмотра.",
    "Көлік бұғатталған: HARD STOP ашық. Жөндеу мен қайта тексеруден кейін ғана шығуға болады.",
  ],
  SC_QR_INVALID: [
    "QR-код не принят: он от другой точки, другого ТС или устарел. Отсканируйте наклейку на автомобиле.",
    "QR-код қабылданбады: басқа нүкте, басқа көлік немесе ескі. Көліктегі жапсырманы сканерлеңіз.",
  ],
  SC_STEP_ORDER: [
    "Нарушен порядок точек. Обновите страницу.",
    "Нүктелер реті бұзылды. Бетті жаңартыңыз.",
  ],
  SC_TOO_FAST: [
    "Слишком быстро. Осмотрите зону полностью и подтвердите ещё раз.",
    "Тым жылдам. Аймақты толық тексеріп, қайта растаңыз.",
  ],
  SC_COMMENT_REQUIRED: ["Опишите дефект", "Ақауды сипаттаңыз"],
  SC_PHOTO_REQUIRED: ["Сфотографируйте дефект", "Ақауды суретке түсіріңіз"],
  SC_NOT_YOURS: [
    "Этот осмотр начат другим водителем",
    "Бұл тексеруді басқа жүргізуші бастаған",
  ],
  SC_ALREADY_DONE: ["Осмотр уже завершён", "Тексеру аяқталған"],
  SC_NOT_HARD_STOP: [
    "По этому ТС нет открытого HARD STOP",
    "Бұл көлік бойынша ашық HARD STOP жоқ",
  ],
};

export function errorText(e, lang = "ru") {
  const raw = (e && (e.message || e.error || e)) + "";
  const code = Object.keys(MESSAGES)
    .sort((a, b) => b.length - a.length)
    .find((k) => raw.includes(k));
  if (code) return MESSAGES[code][lang === "ru" ? 0 : 1];
  if (/fetch|network/i.test(raw))
    return lang === "ru" ? "Нет связи с сервером" : "Сервермен байланыс жоқ";
  return raw;
}

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  if (data && data.error) throw new Error(data.error);
  return data;
}

export const api = {
  driverNames: () => rpc("driver_names"),
  driverLogin: (name, pin) => rpc("driver_login", { p_name: name, p_pin: pin }),
  driverLogout: (token) => rpc("driver_logout", { p_token: token }),
  vehicleStatus: (code) => rpc("vehicle_status", { p_code: code }),
  startInspection: (token, vehicleCode, pilotCode) =>
    rpc("start_inspection", {
      p_token: token,
      p_vehicle_code: vehicleCode,
      p_pilot_code: pilotCode,
    }),
  inspectionState: (token, id) =>
    rpc("inspection_state", { p_token: token, p_inspection: id }),
  recordStep: (a) => rpc("record_step", a),
  staffNames: (role) => rpc("staff_names", { p_role: role }),
  staffCheck: (name, pin, role) =>
    rpc("staff_check", { p_name: name, p_pin: pin, p_role: role }),
  mechanicClose: (name, pin, id, action, photoUrl) =>
    rpc("mechanic_close", {
      p_name: name,
      p_pin: pin,
      p_inspection: id,
      p_action: action,
      p_photo_url: photoUrl,
    }),
  adminQrTokens: (name, pin, code) =>
    rpc("admin_qr_tokens", { p_name: name, p_pin: pin, p_vehicle_code: code }),
};