// Сжимает фото с камеры перед загрузкой: длинная сторона до 1600 px, JPEG ~80%.
// Фото 4–8 МБ становится 200–500 КБ — загрузка проходит и при слабой связи.
// Если браузер не умеет декодировать формат (например, HEIC), возвращаем исходный файл.
export async function compressImage(file, maxSide = 1600, quality = 0.8) {
  if (!file || !file.type || !file.type.startsWith("image/")) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], "photo.jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}