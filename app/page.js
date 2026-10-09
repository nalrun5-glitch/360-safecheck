"use client";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { compressImage } from "../lib/photo";
import QrScanner from "../components/QrScanner";
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
// Код пилота для отчёта /pilot-report (раньше сюда попадал PIN водителя).
const PILOT_CODE = process.env.NEXT_PUBLIC_PILOT_CODE || "KBM-PILOT-2026";
// Минимум секунд между подтверждениями соседних точек (переход + осмотр зоны).
const MIN_STEP_SECONDS = 10;
// Незавершённый осмотр старше этого срока не восстанавливается.
const ACTIVE_TTL_MS = 3 * 60 * 60 * 1000;
const FINAL_STATUSES = [
  "passed",
  "hard_stop",
  "repair_confirmed",
  "reinspection",
  "passed_after_repair",
  "closed",
];

// «К0001» и «K0001» (кириллица/латиница) считаем одинаковыми.
const CYR = "АВЕКМНОРСТХ";
const LAT = "ABEKMHOPCTX";
function normPin(p) {
  return (p || "")
    .trim()
    .toUpperCase()
    .replace(/[АВЕКМНОРСТХ]/g, (c) => LAT[CYR.indexOf(c)]);
}
function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}
// Разбор QR-ссылки вида https://…/?vehicle=CODE&checkpoint=N
function parseQr(text) {
  try {
    const u = new URL(text, window.location.origin);
    const vehicle = u.searchParams.get("vehicle");
    const checkpoint = Number(u.searchParams.get("checkpoint") || 0);
    if (!vehicle || !checkpoint) return null;
    return { vehicle, checkpoint };
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
  // Последний отсканированный QR (из ссылки камеры телефона или из встроенного сканера)
  const [scan, setScan] = useState(
    paramCar && paramCheckpoint
      ? { vehicle: paramCar, checkpoint: paramCheckpoint }
      : null,
  );
  const checkpoint = scan && scan.vehicle === car ? scan.checkpoint : 0;
  const [recheck, setRecheck] = useState(params?.get("recheck") || "");
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
  // Этап 1 (демо): список пилотных водителей остаётся в клиенте.
  // Этап 2 (ветка feature/secure-backend): водители и PIN — в Supabase, только хеш.
  const pilotDrivers = [
    { name: "Айдос Нұрланұлы", pin: "К0001" },
    { name: "Ерлан Серікұлы", pin: "К0001" },
    { name: "Марат Асқарұлы", pin: "К0001" },
    { name: "Данияр Болатұлы", pin: "К0001" },
    { name: "Нұржан Әлиұлы", pin: "К0001" },
    { name: "Серік Бауыржанұлы", pin: "К0001" },
    { name: "Арман Талғатұлы", pin: "К0001" },
    { name: "Бекзат Ермекұлы", pin: "К0001" },
    { name: "Қайрат Асқарұлы", pin: "К0001" },
    { name: "Руслан Маратұлы", pin: "К0001" },
    { name: "Нұрбол Дәулетұлы", pin: "К0001" },
    { name: "Самат Жандосұлы", pin: "К0001" },
    { name: "Азамат Берікұлы", pin: "К0001" },
    { name: "Ермек Қанатұлы", pin: "К0001" },
    { name: "Талғат Нұрланұлы", pin: "К0001" },
  ];
  const [session, setSession] = useState(null);
  const [loginError, setLoginError] = useState("");
  // inspection: { id, startedAt, lastStepAt } — время в мс, переживает перезагрузку страницы
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

  // Вход водителя и восстановление незавершённого осмотра
  useEffect(() => {
    let saved = readJSON("safecheck-driver-session");
    if (saved?.demo || String(saved?.no || "").startsWith("DEMO-")) {
      localStorage.removeItem("safecheck-driver-session");
      saved = null;
    }
    let active = readJSON("safecheck-active");
    if (
      active &&
      (!active.id ||
        !active.startedAt ||
        Date.now() - active.startedAt > ACTIVE_TTL_MS)
    ) {
      localStorage.removeItem("safecheck-active");
      active = null;
    }
    // Осмотр продолжается, если QR-ссылка того же ТС (или ссылка без ТС)
    const activeMatches =
      active && (!paramCar || paramCar === active.vehicle) && saved?.name;
    const continuing =
      paramCheckpoint > 0 ||
      params?.get("resume") === "1" ||
      !!params?.get("recheck") ||
      !!activeMatches;
    if (continuing && saved?.no && saved?.name) {
      setSession(saved);
      setDriver(saved.name);
    } else {
      setSession(null);
      setDriver("");
      setPin("");
    }
    if (activeMatches && continuing) {
      setSelectedCar(active.vehicle);
      setInspection({
        id: active.id,
        startedAt: active.startedAt,
        lastStepAt: active.lastStepAt || active.startedAt,
      });
      setI(active.step || 0);
      setHasCritical(!!active.critical);
      if (active.recheck) setRecheck(active.recheck);
    }
  }, []);

  function login() {
    const u = pilotDrivers.find(
      (x) => x.name === driver && normPin(x.pin) === normPin(pin),
    );
    if (!u) {
      setLoginError(
        lang === "ru"
          ? "Выберите ФИО и введите свой табельный номер"
          : "Аты-жөніңізді таңдап, табельдік нөміріңізді енгізіңіз",
      );
      return;
    }
    const saved = { no: u.pin, name: u.name };
    localStorage.setItem("safecheck-driver-session", JSON.stringify(saved));
    setSession(saved);
    setPin("");
    setLoginError("");
  }
  function logout() {
    localStorage.removeItem("safecheck-driver-session");
    setSession(null);
    setDriver("");
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
      // «Исправно» не может быть критическим дефектом
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
        lang === "ru"
          ? "Это не QR-код SafeCheck"
          : "Бұл SafeCheck QR-коды емес",
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

  // Последний завершённый статус ТС: открытый HARD STOP блокирует новый осмотр,
  // подтверждённый механиком ремонт превращает осмотр в повторный.
  async function lastVehicleStatus(vehicleId) {
    const { data } = await supabase
      .from("inspections")
      .select("id,status,started_at")
      .eq("vehicle_id", vehicleId)
      .in("status", FINAL_STATUSES)
      .order("started_at", { ascending: false })
      .limit(1);
    return data?.[0] || null;
  }

  async function start() {
    if (!session || !driver)
      return setError(
        lang === "ru"
          ? "Сначала авторизуйтесь как водитель"
          : "Алдымен жүргізуші ретінде кіріңіз",
      );
    setBusy(true);
    setError("");
    try {
      const { data: v, error: ve } = await supabase
        .from("vehicles")
        .select("id")
        .eq("code", car)
        .single();
      if (ve || !v)
        throw new Error(
          lang === "ru" ? "ТС не найдено в системе" : "Көлік жүйеде табылмады",
        );
      let recheckId = recheck;
      const last = await lastVehicleStatus(v.id);
      if (!recheckId && last?.status === "hard_stop")
        throw new Error(
          lang === "ru"
            ? "ТС заблокировано: открыт HARD STOP. Выезд возможен только после ремонта и повторного осмотра."
            : "Көлік бұғатталған: HARD STOP ашық. Жөндеу мен қайта тексеруден кейін ғана шығуға болады.",
        );
      if (
        !recheckId &&
        ["repair_confirmed", "reinspection"].includes(last?.status)
      )
        recheckId = last.id;
      if (recheckId) {
        const { data: old, error: oe } = await supabase
          .from("inspections")
          .select("id,status")
          .eq("id", recheckId)
          .eq("vehicle_id", v.id)
          .single();
        if (oe || !["repair_confirmed", "reinspection"].includes(old?.status))
          throw new Error(
            lang === "ru"
              ? "Повторный осмотр недоступен"
              : "Қайта тексеру қолжетімсіз",
          );
        if (old.status === "repair_confirmed") {
          const { error: ue } = await supabase
            .from("inspections")
            .update({ status: "reinspection" })
            .eq("id", recheckId);
          if (ue) throw ue;
        }
      }
      const { data, error } = await supabase
        .from("inspections")
        .insert({
          vehicle_id: v.id,
          driver_name: driver.trim(),
          pilot_code: PILOT_CODE,
        })
        .select()
        .single();
      if (error) throw error;
      const startedAt = Date.now();
      setRecheck(recheckId || "");
      setInspection({ id: data.id, startedAt, lastStepAt: startedAt });
      setI(0);
      setHasCritical(false);
      setNow(startedAt);
      localStorage.setItem(
        "safecheck-active",
        JSON.stringify({
          id: data.id,
          vehicle: car,
          driver: driver.trim(),
          step: 0,
          saved: 0,
          critical: false,
          recheck: recheckId || "",
          startedAt,
          lastStepAt: startedAt,
        }),
      );
    } catch (e) {
      setError(e.message);
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
  async function syncPending() {
    if (!navigator.onLine) return;
    let q = [];
    try {
      q = JSON.parse(localStorage.getItem("safecheck-pending") || "[]");
    } catch {}
    if (!q.length) return;
    const left = [];
    for (const item of q) {
      try {
        if (item.type === "inspection_item") {
          const { error } = await supabase
            .from("inspection_items")
            .insert(item.payload);
          if (error && error.code !== "23505") throw error;
        } else if (item.type === "inspection_complete") {
          const { error } = await supabase
            .from("inspections")
            .update(item.payload)
            .eq("id", item.inspection_id);
          if (error) throw error;
        } else if (item.type === "recheck_result") {
          const { error: le } = await supabase
            .from("recheck_log")
            .insert(item.log);
          if (le) throw le;
          const { error: ue } = await supabase
            .from("inspections")
            .update({ status: item.status })
            .eq("id", item.recheck_id);
          if (ue) throw ue;
        }
      } catch {
        left.push(item);
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
    if (!scan || scan.vehicle !== car)
      return setError(
        lang === "ru"
          ? "QR-код относится к другому транспортному средству"
          : "QR-код басқа көлікке тиесілі",
      );
    if (checkpoint !== i + 1)
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
        lang === "ru"
          ? "Опишите выявленный дефект"
          : "Анықталған ақауды сипаттаңыз",
      );
    if (mode === "defect" && !photo && navigator.onLine)
      return setError(
        lang === "ru"
          ? "Сфотографируйте дефект"
          : "Ақауды суретке түсіріңіз",
      );
    setBusy(true);
    setError("");
    try {
      const stepNo = i + 1;
      const stepAt = Date.now();
      const isCritical = mode === "defect" && critical;
      const alreadySaved = (readJSON("safecheck-active")?.saved || 0) >= stepNo;
      if (!alreadySaved) {
        if (!navigator.onLine && mode === "defect" && photo)
          throw new Error(
            lang === "ru"
              ? "Для сохранения фото дефекта требуется сеть. Уберите фото, чтобы сохранить описание офлайн."
              : "Ақау фотосын сақтау үшін желі қажет. Сипаттаманы офлайн сақтау үшін фотоны алып тастаңыз.",
          );
        const photo_url = mode === "defect" ? await upload() : null;
        const itemPayload = {
          inspection_id: inspection.id,
          step_no: stepNo,
          zone: steps.ru[i],
          result: mode,
          critical: isCritical,
          comment: mode === "defect" ? comment.trim() : null,
          photo_url,
          scanned_at: new Date(stepAt).toISOString(),
          seconds_from_start: Math.floor((stepAt - inspection.startedAt) / 1000),
        };
        if (!navigator.onLine) {
          queueOffline({ type: "inspection_item", payload: itemPayload });
        } else {
          const { error: e } = await supabase
            .from("inspection_items")
            .insert(itemPayload);
          if (e && e.code !== "23505") throw e;
        }
        saveActive({
          saved: stepNo,
          critical: hasCritical || isCritical,
          lastStepAt: stepAt,
        });
      }
      const hc = hasCritical || isCritical;
      setHasCritical(hc);
      if (i === 5) {
        const finishPayload = {
          status: hc ? "hard_stop" : "passed",
          completed_at: new Date().toISOString(),
        };
        if (!navigator.onLine)
          queueOffline({
            type: "inspection_complete",
            inspection_id: inspection.id,
            payload: finishPayload,
          });
        else {
          const { error: fe } = await supabase
            .from("inspections")
            .update(finishPayload)
            .eq("id", inspection.id);
          if (fe) throw fe;
        }
        if (recheck) {
          const log = {
            inspection_id: recheck,
            inspector_name: driver.trim(),
            result: hc ? "failed" : "passed",
            comment: hc
              ? "Повторно выявлен критический дефект"
              : "Повторный 360°-осмотр пройден",
          };
          const status = hc ? "hard_stop" : "passed_after_repair";
          if (!navigator.onLine)
            queueOffline({
              type: "recheck_result",
              recheck_id: recheck,
              log,
              status,
            });
          else {
            const { error: le } = await supabase.from("recheck_log").insert(log);
            if (le) throw le;
            const { error: ue } = await supabase
              .from("inspections")
              .update({ status })
              .eq("id", recheck);
            if (ue) throw ue;
          }
        }
        localStorage.removeItem("safecheck-active");
        setDone(true);
      } else {
        const n = i + 1;
        setI(n);
        setInspection({ ...inspection, lastStepAt: stepAt });
        saveActive({ step: n, lastStepAt: stepAt });
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
      setError(e.message);
    }
    setBusy(false);
  }
  const vehicleState = done
    ? hasCritical
      ? ["stop", lang === "ru" ? "HARD STOP" : "HARD STOP"]
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
            {pilotDrivers.map((u) => (
              <option key={u.name} value={u.name}>
                {u.name}
              </option>
            ))}
          </select>
          <label>
            {lang === "ru" ? "Пароль водителя" : "Жүргізуші құпиясөзі"}
          </label>
          <input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder={lang === "ru" ? "Табельный номер" : "Табельдік нөмір"}
          />
          {loginError && <p className="bad pad">{loginError}</p>}
          <button className="btn primary" onClick={login}>
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
                <select
                  className="vehicleSelect"
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