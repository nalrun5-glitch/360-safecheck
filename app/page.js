"use client";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { compressImage } from "../lib/photo";
import QrScanner from "../components/QrScanner";
import { api, errorText } from "../lib/api";
const copy = {
  ru: {
    title: "Цифровой предрейсовый круговой осмотр",
    driver: "ФИО водителя",
    start: "Начать 360°-осмотр",
    instruction:
      "Выполните физический обход ТС по часовой стрелке. На каждой точке отсканируйте QR-код.",
    ok: "Исправно",
    defect: "Есть дефект",
    comment: "Комментарий по дефекту",
    critical: "Критический дефект — запрет эксплуатации",
    next: "Подтвердить и продолжить",
    finish: "Завершить осмотр",
    scan: "Подтверждение точки",
    scanHint:
      "Для продолжения отсканируйте QR-код этой контрольной точки на автомобиле.",
    photo: "Фото дефекта",
    passed: "✓ ТС ДОПУЩЕНО К ЭКСПЛУАТАЦИИ",
    stop: "HARD STOP — ЭКСПЛУАТАЦИЯ ЗАПРЕЩЕНА",
  },
  kz: {
    title: "Рейс алдындағы цифрлық 360° айналып тексеру",
    driver: "Жүргізушінің Т.А.Ә.",
    start: "360° тексеруді бастау",
    instruction:
      "Көлікті сағат тілі бағытымен толық айналып шығыңыз. Әр нүктеде QR-кодты сканерлеңіз.",
    ok: "Жарамды",
    defect: "Ақау бар",
    comment: "Ақауға түсініктеме",
    critical: "Сындарлы ақау — пайдалануға тыйым салынады",
    next: "Растау және жалғастыру",
    finish: "Тексеруді аяқтау",
    scan: "Нүктені растау",
    scanHint:
      "Жалғастыру үшін көліктегі осы бақылау нүктесінің QR-кодын сканерлеңіз.",
    photo: "Ақау фотосы",
    passed: "✓ КӨЛІКТІ ПАЙДАЛАНУҒА РҰҚСАТ",
    stop: "HARD STOP — ПАЙДАЛАНУҒА ТЫЙЫМ САЛЫНАДЫ",
  },
};
const steps = {
  ru: [
    "Передняя часть: фары, стекло, препятствия",
    "Правая передняя зона: колесо и шина",
    "Правая сторона: кузов, двери, утечки",
    "Задняя часть: фонари, пространство позади",
    "Левая сторона: кузов, двери, утечки",
    "Левая передняя зона: колесо, шина, зона перед стартом",
  ],
  kz: [
    "Алдыңғы бөлік: фаралар, әйнек, кедергілер",
    "Оң алдыңғы аймақ: дөңгелек және шина",
    "Оң жақ: шанақ, есіктер, сұйықтық ағуы",
    "Артқы бөлік: шамдар, артқы кеңістік",
    "Сол жақ: шанақ, есіктер, сұйықтық ағуы",
    "Сол алдыңғы аймақ: дөңгелек, шина, қозғалыс алдындағы аймақ",
  ],
};
// Код пилота для отчёта /pilot-report.
const PILOT_CODE = process.env.NEXT_PUBLIC_PILOT_CODE || "KBM-PILOT-2026";
// Подсказка в интерфейсе; настоящую проверку делает сервер (sc_min_step_seconds).
const MIN_STEP_SECONDS = 10;
const ACTIVE_TTL_MS = 3 * 60 * 60 * 1000;

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}
// QR-ссылка: https://…/?vehicle=CODE&checkpoint=N&k=TOKEN
function parseQr(text) {
  try {
    const u = new URL(text, window.location.origin);
    const vehicle = u.searchParams.get("vehicle");
    const checkpoint = Number(u.searchParams.get("checkpoint") || 0);
    if (!vehicle || !checkpoint) return null;
    return { vehicle, checkpoint, k: u.searchParams.get("k") || "" };
  } catch {
    return null;
  }
}

export default function Home() {
  const params = useMemo(
    () =>
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : null,
    [],
  );
  const paramCar = params?.get("vehicle") || "";
  const paramCheckpoint = Number(params?.get("checkpoint") || 0);
  const [vehicles, setVehicles] = useState([]);
  const [selectedCar, setSelectedCar] = useState(paramCar);
  const car = selectedCar || paramCar;
  const [scan, setScan] = useState(
    paramCar && paramCheckpoint
      ? { vehicle: paramCar, checkpoint: paramCheckpoint, k: params.get("k") || "" }
      : null,
  );
  const checkpoint = scan && scan.vehicle === car ? scan.checkpoint : 0;
  const [recheck, setRecheck] = useState("");
  const [lang, setLang] = useState(() =>
    typeof window !== "undefined"
      ? localStorage.getItem("safecheck-lang") || "ru"
      : "ru",
  );
  const t = copy[lang],
    zones = steps[lang];
  const currentVehicle = vehicles.find((v) => v.code === car);
  const vehicleKind = (currentVehicle?.model || "").includes("ПАЗ")
    ? "🚌"
    : (currentVehicle?.model || "").includes("Yutong")
      ? "🚌"
      : (currentVehicle?.model || "").includes("УАЗ")
        ? "🚙"
        : "🚐";
  const [driver, setDriver] = useState("");
  const [pin, setPin] = useState("");
  const [driverNames, setDriverNames] = useState([]);
  // session: { token, name, expires_at } — PIN в браузере не хранится
  const [session, setSession] = useState(null);
  const [loginError, setLoginError] = useState("");
  const [inspection, setInspection] = useState(null);
  const [vehicleConfirmed, setVehicleConfirmed] = useState(false);
  const [i, setI] = useState(0);
  const [mode, setMode] = useState(null);
  const [critical, setCritical] = useState(false);
  const [comment, setComment] = useState("");
  const [photo, setPhoto] = useState(null);
  const [hasCritical, setHasCritical] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const profileName = session?.name || driver || "—";
  const [showGuide, setShowGuide] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [online, setOnline] = useState(true);
  const [installed, setInstalled] = useState(false);
  const [pending, setPending] = useState(0);
  const elapsed = inspection
    ? Math.max(0, Math.floor((now - inspection.startedAt) / 1000))
    : 0;

  function saveActive(patch) {
    const a = { ...(readJSON("safecheck-active") || {}), ...patch };
    localStorage.setItem("safecheck-active", JSON.stringify(a));
  }
  // Применить состояние осмотра, которое вернул сервер
  function applyState(s, vehicleCode) {
    const startedAt = new Date(s.started_at).getTime();
    const lastStepAt = new Date(s.last_step_at || s.started_at).getTime();
    setInspection({ id: s.id, startedAt, lastStepAt });
    setI(Math.min(5, s.steps_done));
    setHasCritical(!!s.has_critical);
    setRecheck(s.recheck_of || "");
    setDone(!!s.completed);
    if (s.completed) localStorage.removeItem("safecheck-active");
    else
      localStorage.setItem(
        "safecheck-active",
        JSON.stringify({
          id: s.id,
          vehicle: vehicleCode,
          step: s.steps_done,
          startedAt,
          lastStepAt,
        }),
      );
  }
  function dropSession() {
    localStorage.removeItem("safecheck-driver-session");
    setSession(null);
    setDriver("");
  }

  useEffect(() => {
    api
      .driverNames()
      .then((n) => setDriverNames(n || []))
      .catch(() => {});
    let saved = readJSON("safecheck-driver-session");
    if (
      !saved?.token ||
      (saved.expires_at && new Date(saved.expires_at) < new Date())
    ) {
      localStorage.removeItem("safecheck-driver-session");
      saved = null;
    }
    let active = readJSON("safecheck-active");
    if (active && (!active.id || Date.now() - active.startedAt > ACTIVE_TTL_MS)) {
      localStorage.removeItem("safecheck-active");
      active = null;
    }
    const activeMatches = active && (!paramCar || paramCar === active.vehicle);
    const continuing =
      paramCheckpoint > 0 || params?.get("resume") === "1" || !!activeMatches;
    if (!(continuing && saved)) {
      setSession(null);
      setDriver("");
      return;
    }
    setSession(saved);
    setDriver(saved.name);
    if (!activeMatches) return;
    setSelectedCar(active.vehicle);
    // Сначала — из локальной копии (работает без сети), затем сверяем с сервером
    applyState(
      {
        id: active.id,
        started_at: active.startedAt,
        last_step_at: active.lastStepAt,
        steps_done: active.step || 0,
        has_critical: false,
      },
      active.vehicle,
    );
    if (navigator.onLine)
      api
        .inspectionState(saved.token, active.id)
        .then((s) => applyState(s, active.vehicle))
        .catch((e) => {
          if (/SC_SESSION/.test(e.message)) dropSession();
          if (/SC_NOT_YOURS/.test(e.message)) {
            localStorage.removeItem("safecheck-active");
            setInspection(null);
          }
        });
  }, []);

  async function login() {
    if (!driver || !pin.trim())
      return setLoginError(
        lang === "ru"
          ? "Выберите ФИО и введите PIN"
          : "Аты-жөніңізді таңдап, PIN енгізіңіз",
      );
    setBusy(true);
    try {
      const s = await api.driverLogin(driver, pin);
      localStorage.setItem("safecheck-driver-session", JSON.stringify(s));
      setSession(s);
      setPin("");
      setLoginError("");
    } catch (e) {
      setLoginError(errorText(e, lang));
    }
    setBusy(false);
  }
  function logout() {
    if (session?.token) api.driverLogout(session.token).catch(() => {});
    dropSession();
    setProfileOpen(false);
  }
  useEffect(() => {
    const count = () => {
      try {
        setPending(
          JSON.parse(localStorage.getItem("safecheck-pending") || "[]").length,
        );
      } catch {
        setPending(0);
      }
    };
    count();
    const sync = () => {
      setOnline(navigator.onLine);
      count();
    };
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    setInstalled(
      window.matchMedia("(display-mode: standalone)").matches ||
        !!window.Capacitor,
    );
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);
  useEffect(() => {
    if (!inspection || done) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [inspection, done]);
  useEffect(() => {
    supabase
      .from("vehicles")
      .select("code,plate,model")
      .eq("active", true)
      .order("model")
      .then(({ data }) => {
        const v = (data || []).filter((x) => x.code !== "KBM-TEST-001");
        setVehicles(v);
      });
  }, []);
  function language(x) {
    setLang(x);
    localStorage.setItem("safecheck-lang", x);
  }
  function chooseVehicle(e) {
    const v = e.target.value;
    setSelectedCar(v);
    setVehicleConfirmed(false);
    setError("");
    window.history.replaceState(
      {},
      "",
      v ? "/?vehicle=" + encodeURIComponent(v) : "/",
    );
  }
  function chooseResult(r) {
    setMode(r);
    setError("");
    if (r === "ok") {
      setCritical(false);
      setComment("");
      setPhoto(null);
    }
  }
  function onScanned(text) {
    setScannerOpen(false);
    const q = parseQr(text);
    if (!q)
      return setError(
        lang === "ru" ? "Это не QR-код SafeCheck" : "Бұл SafeCheck QR-коды емес",
      );
    if (q.vehicle !== car)
      return setError(
        lang === "ru"
          ? "QR-код относится к другому транспортному средству"
          : "QR-код басқа көлікке тиесілі",
      );
    if (q.checkpoint !== i + 1)
      return setError(
        lang === "ru"
          ? "Это QR точки №" + q.checkpoint + ". Нужна точка №" + (i + 1)
          : "Бұл №" + q.checkpoint + " нүктенің QR-ы. №" + (i + 1) + " нүкте қажет",
      );
    setError("");
    setScan(q);
  }

  async function start() {
    if (!session)
      return setError(
        lang === "ru"
          ? "Сначала авторизуйтесь как водитель"
          : "Алдымен жүргізуші ретінде кіріңіз",
      );
    setBusy(true);
    setError("");
    try {
      const s = await api.startInspection(session.token, car, PILOT_CODE);
      applyState(s, car);
      setNow(Date.now());
    } catch (e) {
      if (/SC_SESSION/.test(e.message)) dropSession();
      setError(errorText(e, lang));
    }
    setBusy(false);
  }

  function queueOffline(item) {
    try {
      const q = JSON.parse(localStorage.getItem("safecheck-pending") || "[]");
      q.push({ ...item, queued_at: new Date().toISOString() });
      localStorage.setItem("safecheck-pending", JSON.stringify(q));
      setPending(q.length);
      return true;
    } catch {
      return false;
    }
  }
  // Офлайн-очередь отправляется по порядку; сервер сам отбрасывает повторы.
  async function syncPending() {
    if (!navigator.onLine) return;
    let q = [];
    try {
      q = JSON.parse(localStorage.getItem("safecheck-pending") || "[]");
    } catch {}
    if (!q.length) return;
    const left = [];
    let blocked = false;
    for (const item of q) {
      if (blocked || item.type !== "record_step") {
        left.push(item);
        continue;
      }
      try {
        await api.recordStep(item.args);
      } catch (e) {
        // Ошибка проверки — запись не будет принята никогда, её не держим
        if (!/SC_/.test(e.message)) {
          left.push(item);
          blocked = true;
        }
      }
    }
    localStorage.setItem("safecheck-pending", JSON.stringify(left));
    setPending(left.length);
  }
  useEffect(() => {
    if (!online) return;
    syncPending();
  }, [online]);
  async function upload() {
    if (!photo) return null;
    const file = await compressImage(photo);
    const ext =
        file.type === "image/jpeg" ? "jpg" : file.name.split(".").pop() || "jpg",
      path = inspection.id + "/" + (i + 1) + "-" + Date.now() + "." + ext;
    const { error } = await supabase.storage
      .from("defect-photos")
      .upload(path, file, { upsert: false, contentType: file.type });
    if (error) throw error;
    return supabase.storage.from("defect-photos").getPublicUrl(path).data
      .publicUrl;
  }
  async function save() {
    if (!scan || scan.vehicle !== car || checkpoint !== i + 1)
      return setError(
        (lang === "ru"
          ? "Сначала отсканируйте QR контрольной точки №"
          : "Алдымен QR сканерлеңіз: №") +
          (i + 1),
      );
    const sinceLast = Math.floor((Date.now() - inspection.lastStepAt) / 1000);
    if (sinceLast < MIN_STEP_SECONDS)
      return setError(
        lang === "ru"
          ? "Слишком быстро. Осмотрите зону полностью — подтвердить можно через " +
              (MIN_STEP_SECONDS - sinceLast) +
              " с."
          : "Тым жылдам. Аймақты толық тексеріңіз — " +
              (MIN_STEP_SECONDS - sinceLast) +
              " с кейін растауға болады.",
      );
    if (mode === "defect" && !comment.trim())
      return setError(
        lang === "ru" ? "Опишите выявленный дефект" : "Анықталған ақауды сипаттаңыз",
      );
    if (mode === "defect" && !photo && navigator.onLine)
      return setError(
        lang === "ru" ? "Сфотографируйте дефект" : "Ақауды суретке түсіріңіз",
      );
    setBusy(true);
    setError("");
    try {
      const stepNo = i + 1;
      const stepAt = Date.now();
      const isCritical = mode === "defect" && critical;
      const offline = !navigator.onLine;
      if (offline && mode === "defect" && photo)
        throw new Error(
          lang === "ru"
            ? "Для сохранения фото дефекта требуется сеть. Уберите фото, чтобы сохранить описание офлайн."
            : "Ақау фотосын сақтау үшін желі қажет. Сипаттаманы офлайн сақтау үшін фотоны алып тастаңыз.",
        );
      const args = {
        p_token: session.token,
        p_inspection: inspection.id,
        p_step: stepNo,
        p_qr: scan.k || "",
        p_result: mode,
        p_critical: isCritical,
        p_comment: mode === "defect" ? comment.trim() : null,
        p_photo_url: mode === "defect" && !offline ? await upload() : null,
        p_scanned_at: new Date(stepAt).toISOString(),
        p_offline: offline,
      };
      let state;
      if (offline) {
        queueOffline({ type: "record_step", args });
        state = {
          id: inspection.id,
          started_at: inspection.startedAt,
          last_step_at: stepAt,
          steps_done: stepNo,
          has_critical: hasCritical || isCritical,
          recheck_of: recheck,
          completed: false,
        };
      } else {
        state = await api.recordStep(args);
      }
      applyState(state, car);
      if (stepNo === 6) {
        // Итоговый статус выставляет сервер; офлайн — показываем предварительный итог
        setDone(true);
        localStorage.removeItem("safecheck-active");
      } else {
        window.history.replaceState(
          {},
          "",
          "/?vehicle=" + encodeURIComponent(car) + "&resume=1",
        );
      }
      setScan(null);
      setMode(null);
      setCritical(false);
      setComment("");
      setPhoto(null);
    } catch (e) {
      if (/SC_SESSION/.test(e.message)) dropSession();
      if (/SC_QR_INVALID/.test(e.message)) setScan(null);
      setError(errorText(e, lang));
    }
    setBusy(false);
  }
  const vehicleState = done
    ? hasCritical
      ? ["stop", "HARD STOP"]
      : ["ready", lang === "ru" ? "ДОПУЩЕНО" : "РҰҚСАТ"]
    : inspection
      ? ["ready", lang === "ru" ? "ИДЁТ ОСМОТР" : "ТЕКСЕРУ ЖҮРУДЕ"]
      : ["ready", lang === "ru" ? "ГОТОВ К ОСМОТРУ" : "ТЕКСЕРУГЕ ДАЙЫН"];
  return (
    <main className="wrap">
      <section className="hero">
        <div className="brandHead">
          <img
            className="kbmLogo"
            src="/kbm-logo.webp"
            alt="АО Каражанбасмунай"
          />
          <div className="brandText">
            <b>АО «Каражанбасмунай»</b>
            <span>360° SafeCheck</span>
          </div>
        </div>
        <div className="lang">
          <button
            className={lang === "ru" ? "active" : ""}
            onClick={() => language("ru")}
          >
            RU
          </button>
          <button
            className={lang === "kz" ? "active" : ""}
            onClick={() => language("kz")}
          >
            KZ
          </button>
        </div>
        <div className="driverTop">
          <button
            className="avatarBtn"
            onClick={() => setProfileOpen(!profileOpen)}
          >
            {(driver || "А").slice(0, 1)}
          </button>
          <div>
            <small>{lang === "ru" ? "Водитель" : "Жүргізуші"}</small>
            <b>
              {session?.name ||
                driver ||
                (lang === "ru" ? "Не выбран" : "Таңдалмаған")}
            </b>
          </div>
        </div>
        <h1>360° SafeCheck</h1>
        <div className="appMeta">
          <span>📱 SafeCheck Driver</span>
          <span className={online ? "online" : "offline"}>
            {online
              ? lang === "ru"
                ? "● Онлайн"
                : "● Онлайн"
              : lang === "ru"
                ? "● Нет сети"
                : "● Желі жоқ"}
          </span>
          {installed && <span>✓ Android</span>}
          {pending > 0 && (
            <span className="offline">
              ↻ {pending} {lang === "ru" ? "в очереди" : "кезекте"}
            </span>
          )}
        </div>
        <div>
          {recheck
            ? lang === "ru"
              ? "ПОВТОРНЫЙ ОСМОТР ПОСЛЕ РЕМОНТА"
              : "ЖӨНДЕУДЕН КЕЙІН ҚАЙТА ТЕКСЕРУ"
            : t.title}{" "}
          · АО «Каражанбасмунай»
        </div>
      </section>
      {profileOpen && (
        <section className="card profileCard">
          <div className="profileAvatar">{profileName.slice(0, 1)}</div>
          <div className="profileMain">
            <h2>{profileName}</h2>
            <div className="profileGrid">
              <div>
                <small>{lang === "ru" ? "Пилот" : "Пилот"}</small>
                <b>{PILOT_CODE}</b>
              </div>
              <div>
                <small>{lang === "ru" ? "Подразделение" : "Бөлімше"}</small>
                <b>{lang === "ru" ? "Транспортная служба" : "Көлік қызметі"}</b>
              </div>
              <div>
                <small>{lang === "ru" ? "Вход" : "Кіру"}</small>
                <b className={session ? "profileOk" : ""}>
                  {session
                    ? "✓ " + (lang === "ru" ? "Подтверждён" : "Расталды")
                    : lang === "ru"
                      ? "Не выполнен"
                      : "Орындалмаған"}
                </b>
              </div>
              <div>
                <small>{lang === "ru" ? "Приложение" : "Қосымша"}</small>
                <b>SafeCheck Driver</b>
              </div>
            </div>
            {session && (
              <button className="btn" onClick={logout}>
                {lang === "ru" ? "Выйти" : "Шығу"}
              </button>
            )}
          </div>
        </section>
      )}
      {!session ? (
        <section className="card">
          <h2>{lang === "ru" ? "Водитель" : "Жүргізуші"}</h2>
          <label>{t.driver}</label>
          <select
            className="vehicleSelect"
            value={driver}
            onChange={(e) => {
              setDriver(e.target.value);
              setPin("");
              setLoginError("");
            }}
          >
            <option value="">
              {lang === "ru"
                ? "Выберите своё ФИО"
                : "Өз аты-жөніңізді таңдаңыз"}
            </option>
            {driverNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <label>
            {lang === "ru" ? "PIN водителя" : "Жүргізуші PIN-коды"}
          </label>
          <input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            placeholder={lang === "ru" ? "PIN из 6 цифр" : "6 саннан тұратын PIN"}
          />
          {loginError && <p className="bad pad">{loginError}</p>}
          <button className="btn primary" disabled={busy} onClick={login}>
            {lang === "ru" ? "Продолжить к выбору ТС" : "Көлікті таңдауға өту"}
          </button>
        </section>
      ) : (
        <>
          <section className="card driverSummaryCard">
            <div className="muted">
              {lang === "ru" ? "Водитель" : "Жүргізуші"}
            </div>
            <div className="driverSummaryName">{driver}</div>
            <div className="small profileOk">
              ✓ {lang === "ru" ? "Вход подтверждён" : "Кіру расталды"}
            </div>
            {!inspection && (
              <button className="btn" onClick={logout}>
                {lang === "ru" ? "Сменить водителя" : "Жүргізушіні ауыстыру"}
              </button>
            )}
          </section>
          <section className="card vehicleCard">
            <div className="vehicleInfo">
              <div className="muted">
                {lang === "ru" ? "Транспортное средство" : "Көлік құралы"}
              </div>
              {!inspection && vehicles.length > 0 ? (
                <select                  className="vehicleSelect"
                  value={car}
                  onChange={chooseVehicle}
                >
                  {!currentVehicle && (
                    <option value={car}>
                      {lang === "ru" ? "Выберите ТС" : "Көлікті таңдаңыз"}
                    </option>
                  )}
                  {vehicles.map((v) => (
                    <option key={v.code} value={v.code}>
                      {v.model} · {v.plate}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="vehicle">
                  {vehicles.find((v) => v.code === car)?.model || car}
                </div>
              )}
              <div className="plate">
                {vehicles.find((v) => v.code === car)?.plate || car}
              </div>
              {!inspection && (
                <button
                  className="btn"
                  disabled={!currentVehicle}
                  onClick={() => setVehicleConfirmed(true)}
                >
                  {vehicleConfirmed
                    ? lang === "ru"
                      ? "✓ ТС выбрано"
                      : "✓ Көлік таңдалды"
                    : lang === "ru"
                      ? "Подтвердить выбор ТС"
                      : "Көлікті таңдауды растау"}
                </button>
              )}
              <div className="small muted">
                360° SafeCheck ·{" "}
                {lang === "ru"
                  ? "цифровое подтверждение обхода"
                  : "айналуды цифрлық растау"}
              </div>
              <div className="safetyStrip">
                <span>QR × 6</span>
                <span>{lang === "ru" ? "Фото дефекта" : "Ақау фотосы"}</span>
                <span>HARD STOP</span>
              </div>
            </div>
            <div className="vehicleVisual">
              <div className="vehicleSilhouette" aria-hidden="true">
                {vehicleKind}
              </div>
              <div className={"vehicleStatus " + vehicleState[0]}>
                {vehicleState[1]}
              </div>
            </div>
          </section>
          {inspection ? (
            <>
              <section className="card routeCard">
                <div className="routeTitle">
                  <b>
                    {lang === "ru"
                      ? "Маршрут кругового осмотра (360°)"
                      : "Айналып тексеру бағыты (360°)"}
                  </b>
                  <span>{done ? 6 : i}/6</span>
                </div>
                <div className="route">
                  {zones.map((z, n) => (
                    <div
                      key={n}
                      className={
                        n < i
                          ? "routePoint complete"
                          : n === i
                            ? "routePoint current"
                            : "routePoint"
                      }
                    >
                      <span>{n + 1}</span>
                      <small>{z.split(":")[0]}</small>
                    </div>
                  ))}
                </div>
              </section>
              <section className="card guideCard">
                <button
                  className="guideToggle"
                  onClick={() => setShowGuide(!showGuide)}
                >
                  <span>ⓘ</span>
                  <b>
                    {lang === "ru"
                      ? "Как работает SafeCheck"
                      : "SafeCheck қалай жұмыс істейді"}
                  </b>
                  <strong>{showGuide ? "−" : "+"}</strong>
                </button>
                {showGuide && (
                  <div className="guideFlow">
                    <div>
                      <b>1</b>
                      <span>
                        {lang === "ru"
                          ? "Сканировать QR точки"
                          : "Нүкте QR-ын сканерлеу"}
                      </span>
                    </div>
                    <div>
                      <b>2</b>
                      <span>
                        {lang === "ru" ? "Осмотреть зону" : "Аймақты тексеру"}
                      </span>
                    </div>
                    <div>
                      <b>3</b>
                      <span>
                        {lang === "ru"
                          ? "Зафиксировать результат"
                          : "Нәтижені тіркеу"}
                      </span>
                    </div>
                    <div>
                      <b>4</b>
                      <span>
                        {lang === "ru"
                          ? "Дефект → HARD STOP"
                          : "Ақау → HARD STOP"}
                      </span>
                    </div>
                  </div>
                )}
              </section>
            </>
          ) : null}
          {!inspection ? (
            <section className="card">
              <p className="muted">{t.instruction}</p>
              {error && <p className="bad pad">{error}</p>}
              <button
                className="btn primary"
                disabled={busy || !vehicleConfirmed}
                onClick={start}
              >
                {busy ? "..." : t.start}
              </button>
              {!vehicleConfirmed && (
                <p className="small muted">
                  {lang === "ru"
                    ? "Сначала выберите и подтвердите транспортное средство."
                    : "Алдымен көлікті таңдап, таңдауды растаңыз."}
                </p>
              )}
            </section>
          ) : !done ? (
            <section className="card">
              <div className="inspectionHead">
                <b>
                  {lang === "ru" ? "Точка" : "Нүкте"} {i + 1}{" "}
                  {lang === "ru" ? "из" : "/"} 6 ·{" "}
                  {lang === "ru" ? "пройдено" : "өтті"} {i}
                </b>
                <span>
                  ⏱ {Math.floor(elapsed / 60)}:
                  {String(elapsed % 60).padStart(2, "0")}
                </span>
              </div>
              <div className="progress">
                <div
                  className="bar"
                  style={{ width: (i / 6) * 100 + "%" }}
                />
              </div>
              <div className="step">
                <div className="num">{i + 1}</div>
                <div>
                  <b>{zones[i]}</b>
                  <div className="small muted">{t.scanHint}</div>
                </div>
              </div>
              <div
                className={
                  checkpoint === i + 1 ? "checkpoint good" : "checkpoint"
                }
              >
                {t.scan}:{" "}
                {checkpoint === i + 1
                  ? "✓ QR " + (i + 1)
                  : lang === "ru"
                    ? "ожидается QR " + (i + 1)
                    : "QR " + (i + 1) + " күтілуде"}
              </div>
              {checkpoint !== i + 1 && (
                <div className="scanAction">
                  <div className="scanPulse">⌁</div>
                  <b>
                    {lang === "ru"
                      ? "Перейдите к точке №" + (i + 1) + " и отсканируйте QR"
                      : "№" + (i + 1) + " нүктеге өтіп, QR сканерлеңіз"}
                  </b>
                  <button
                    className="btn primary"
                    onClick={() => {
                      setError("");
                      setScannerOpen(true);
                    }}
                  >
                    {lang === "ru" ? "Сканировать QR" : "QR сканерлеу"}
                  </button>
                  <small>
                    {lang === "ru"
                      ? "Без QR этой точки продолжить нельзя"
                      : "Осы нүктенің QR-ынсыз жалғастыру мүмкін емес"}
                  </small>
                </div>
              )}
              {checkpoint === i + 1 && (
                <>
                  <div className="row">
                    <button
                      className={"btn ok" + (mode === "ok" ? " active" : "")}
                      onClick={() => chooseResult("ok")}>
                      {t.ok}
                    </button>
                    <button
                      className={
                        "btn danger" + (mode === "defect" ? " active" : "")
                      }
                      onClick={() => chooseResult("defect")}
                    >
                      {t.defect}
                    </button>
                  </div>
                  {mode === "defect" && (
                    <div>
                      <label>{t.comment}</label>
                      <textarea
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                      />
                      <label>{t.photo}</label>
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        onChange={(e) => setPhoto(e.target.files?.[0] || null)}
                      />
                      <label>
                        <input
                          className="check"
                          type="checkbox"
                          checked={critical}
                          onChange={(e) => setCritical(e.target.checked)}
                        />
                        {t.critical}
                      </label>
                    </div>
                  )}
                  {mode && (
                    <button
                      className="btn primary"
                      disabled={busy}
                      onClick={save}
                    >
                      {busy ? "..." : i === 5 ? t.finish : t.next}
                    </button>
                  )}
                </>
              )}
              {error && <p className="bad pad">{error}</p>}
            </section>
          ) : (
            <section className="card">
              {hasCritical ? (
                <>
                  <div className="stop">{t.stop}</div>
                  <p>
                    {lang === "ru"
                      ? "Критический дефект передан контрольному механику. Допуск возможен только после устранения и закрытия."
                      : "Сындарлы ақау бақылаушы механикке жіберілді. Ақау жойылып, жабылғаннан кейін ғана рұқсат беріледі."}
                  </p>
                  <a className="btn danger link" href="/mechanic">
                    {lang === "ru" ? "Кабинет механика" : "Механик кабинеті"}
                  </a>
                </>
              ) : (
                <>
                  <div className="badge">{t.passed}</div>
                  <p>
                    {lang === "ru"
                      ? "Все 6 физических контрольных точек подтверждены QR-сканированием."
                      : "Барлық 6 физикалық бақылау нүктесі QR сканерлеумен расталды."}
                  </p>
                </>
              )}
            </section>
          )}
        </>
      )}
      {scannerOpen && (
        <QrScanner
          lang={lang}
          onResult={onScanned}
          onClose={() => setScannerOpen(false)}
        />
      )}
      <div className="footer">360° SafeCheck · АО «Каражанбасмунай»</div>
    </main>
  );
}