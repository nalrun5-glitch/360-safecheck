"use client";
import { useEffect, useRef, useState } from "react";

// Сканер QR внутри приложения: страница не перезагружается, осмотр не теряется.
// Использует встроенный BarcodeDetector (Chrome/Android), иначе — библиотеку jsQR.
export default function QrScanner({ lang, onResult, onClose }) {
  const videoRef = useRef(null);
  const [error, setError] = useState("");
  const resultRef = useRef(onResult);
  resultRef.current = onResult;

  useEffect(() => {
    let stream;
    let stopped = false;
    let raf;

    async function run() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch {
        setError(
          lang === "ru"
            ? "Камера недоступна. Разрешите доступ к камере или отсканируйте QR обычной камерой телефона."
            : "Камера қолжетімсіз. Камераға рұқсат беріңіз немесе QR-ды телефонның әдеттегі камерасымен сканерлеңіз.",
        );
        return;
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play().catch(() => {});

      let detector = null;
      if ("BarcodeDetector" in window) {
        try {
          detector = new window.BarcodeDetector({ formats: ["qr_code"] });
        } catch {}
      }
      const jsQR = detector ? null : (await import("jsqr")).default;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      const tick = async () => {
        if (stopped) return;
        if (video.readyState >= 2) {
          try {
            let text = null;
            if (detector) {
              const codes = await detector.detect(video);
              text = codes[0]?.rawValue || null;
            } else {
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              ctx.drawImage(video, 0, 0);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              text = jsQR(img.data, img.width, img.height)?.data || null;
            }
            if (text) {
              stopped = true;
              resultRef.current(text);
              return;
            }
          } catch {}
        }
        raf = setTimeout(tick, 250);
      };
      tick();
    }
    run();
    return () => {
      stopped = true;
      clearTimeout(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [lang]);

  return (
    <div className="scannerOverlay" role="dialog" aria-modal="true">
      <div className="scannerBox">
        <b>{lang === "ru" ? "Наведите камеру на QR точки" : "Камераны нүкте QR-ына бағыттаңыз"}</b>
        {error ? (
          <p className="bad pad">{error}</p>
        ) : (
          <video ref={videoRef} className="scannerVideo" playsInline muted />
        )}
        <button className="btn" onClick={onClose}>
          {lang === "ru" ? "Закрыть" : "Жабу"}
        </button>
      </div>
    </div>
  );
}