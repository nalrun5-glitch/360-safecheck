"use client";
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { api, errorText } from "../../lib/api";
import { compressImage } from "../../lib/photo";

export default function Mechanic() {
  const [rows, setRows] = useState([]);
  const [names, setNames] = useState([]);
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [authed, setAuthed] = useState(false);
  const [actions, setActions] = useState({});
  const [photos, setPhotos] = useState({});
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  async function load() {
    const { data } = await supabase
      .from("inspections")
      .select(
        "id,driver_name,status,started_at,vehicles(code,plate,model),inspection_items(step_no,zone,result,critical,comment,photo_url)",
      )
      .eq("status", "hard_stop")
      .order("started_at", { ascending: false });
    setRows(data || []);
  }
  useEffect(() => {
    load();
    api.staffNames("mechanic").then((n) => setNames(n || [])).catch(() => {});
  }, []);

  async function signIn() {
    setMsg("");
    try {
      const ok = await api.staffCheck(name, pin, "mechanic");
      if (!ok) return setMsg("Неверное ФИО или PIN");
      setAuthed(true);
    } catch (e) {
      setMsg(errorText(e));
    }
  }

  async function close(r) {
    const action = (actions[r.id] || "").trim();
    const photo = photos[r.id];
    if (!action) return alert("Укажите выполненные работы");
    if (!photo) return alert("Добавьте фото после устранения дефекта");
    setBusy(r.id);
    try {
      const file = await compressImage(photo);
      const ext = file.type === "image/jpeg" ? "jpg" : file.name.split(".").pop() || "jpg";
      const path = "repair/" + r.id + "-" + Date.now() + "." + ext;
      const { error: ue } = await supabase.storage
        .from("defect-photos")
        .upload(path, file, { contentType: file.type });
      if (ue) throw ue;
      const url = supabase.storage.from("defect-photos").getPublicUrl(path).data.publicUrl;
      await api.mechanicClose(name, pin, r.id, action, url);
      setActions({ ...actions, [r.id]: "" });
      setPhotos({ ...photos, [r.id]: null });
      await load();
      alert(
        "Устранение подтверждено. Водитель проходит обычный 360°-осмотр этого ТС — он автоматически засчитывается как повторный.",
      );
    } catch (e) {
      alert(errorText(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <main className="wrap">
      <section className="hero">
        <h1>Контрольный механик / Бақылаушы механик</h1>
        <div>HARD STOP → ремонт → повторный контроль</div>
      </section>
      {!authed ? (
        <section className="card">
          <label>ФИО механика / Механиктің Т.А.Ә.</label>
          <select className="vehicleSelect" value={name} onChange={(e) => setName(e.target.value)}>
            <option value="">Выберите ФИО</option>
            {names.map((n) => (
              <option key={n.full_name} value={n.full_name}>
                {n.full_name}
              </option>
            ))}
          </select>
          <label>PIN</label>
          <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
          {msg && <p className="bad pad">{msg}</p>}
          <button className="btn primary" disabled={!name || !pin} onClick={signIn}>
            Войти / Кіру
          </button>
        </section>
      ) : (
        <section className="card">
          <b>{name}</b> · <span className="profileOk">✓ вход подтверждён</span>
        </section>
      )}
      {rows.length === 0 ? (
        <section className="card">
          <div className="badge">Нет открытых HARD STOP / Ашық HARD STOP жоқ</div>
        </section>
      ) : (
        rows.map((r) => (
          <section className="card" key={r.id}>
            <div className="vehicle">{r.vehicles?.model}</div>
            <div className="plate">{r.vehicles?.plate}</div>
            <p>Водитель / Жүргізуші: {r.driver_name}</p>
            {r.inspection_items
              ?.filter((x) => x.critical)
              .map((x) => (
                <div className="bad pad" key={x.step_no}>
                  <b>
                    Точка {x.step_no}: {x.zone}
                  </b>
                  <br />
                  {x.comment || "Критический дефект"}
                  {x.photo_url && (
                    <a href={x.photo_url} target="_blank" rel="noreferrer">
                      <img className="defectPhoto" src={x.photo_url} alt="Фото дефекта" />
                    </a>
                  )}
                </div>
              ))}
            {authed && (
              <>
                <label>Что устранено / Орындалған жұмыс</label>
                <textarea
                  value={actions[r.id] || ""}
                  onChange={(e) => setActions({ ...actions, [r.id]: e.target.value })}
                />
                <label>Фото после ремонта / Жөндеуден кейінгі фото</label>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(e) => setPhotos({ ...photos, [r.id]: e.target.files?.[0] || null })}
                />
                <div className="warningBox">
                  <b>Важно:</b> подтверждение механика не даёт автоматический допуск. После ремонта ТС
                  должно пройти повторный 360°-контроль.
                </div>
                <button className="btn ok" disabled={busy === r.id} onClick={() => close(r)}>
                  {busy === r.id ? "..." : "Подтвердить ремонт и направить на повторный осмотр"}
                </button>
              </>
            )}
          </section>
        ))
      )}
    </main>
  );
}