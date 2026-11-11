import { invoiceDraft } from "./invoice-fields";
export { invoiceDraft } from "./invoice-fields";
async function ocrImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d"); if (!context) return file;
    context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.94));
    return blob ? new File([blob], "ocr.jpg", { type: "image/jpeg" }) : file;
  } finally { bitmap.close(); }
}
export async function recognizeInvoice(file: File, onProgress: (message: string) => void, signal?: AbortSignal) {
  if (!file.type.startsWith("image/")) throw new Error("Odczyt OCR obsługuje zdjęcia JPG, PNG i WebP. PDF możesz dołączyć jako dokument i wpisać kwotę.");
  onProgress("Przygotowanie zdjęcia i silnika OCR…");
  const image = await ocrImage(file);
  if (signal?.aborted) throw new Error("Anulowano odczyt.");
  const { createWorker } = await import("tesseract.js");
  if (signal?.aborted) throw new Error("Anulowano odczyt.");
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (error: Error) => void = () => {};
  const cancel = () => rejectAbort(new Error("Anulowano odczyt."));
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = reject;
    timer = setTimeout(() => reject(new Error("Odczyt trwał zbyt długo. Użyj wyraźniejszego zdjęcia lub wpisz dane ręcznie.")), 150000);
  });
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const created = createWorker("pol+eng", 1, {
      workerPath: "/ocr/worker.min.js", corePath: "/ocr/", langPath: "https://tessdata.projectnaptha.com/4.0.0",
      logger: message => { if (!finished && !signal?.aborted) onProgress(message.status === "recognizing text" ? `Odczyt zdjęcia: ${Math.round(message.progress * 100)}%` : "Przygotowanie języka OCR…"); },
    }).then(async value => { if (finished || signal?.aborted) { await value.terminate(); throw new Error("Anulowano odczyt."); } worker = value; return value; });
    await Promise.race([created, cancelled]);
    const result = await Promise.race([worker!.recognize(image), cancelled]);
    return { text: result.data.text, ...invoiceDraft(result.data.text) };
  } finally { finished = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel); await worker?.terminate(); }
}
