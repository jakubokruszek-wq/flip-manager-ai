/** Finish when the declared bytes arrive, even if the upstream delays its final EOF. */
export function exactStream(body: ReadableStream<Uint8Array>, bytes: number): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("APK_INVALID_LENGTH");
  const reader = body.getReader();
  let remaining = bytes, stopped = false;
  let cancellation: Promise<void> | null = null;
  const cancel = (reason?: unknown) => cancellation ??= reader.cancel(reason).catch(() => {}).finally(() => reader.releaseLock());
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (stopped) return;
      try {
        const {done, value} = await reader.read();
        if (stopped) return;
        if (done) throw new Error("APK_INCOMPLETE_BODY");
        if (value.byteLength > remaining) throw new Error("APK_EXCESS_BODY");
        remaining -= value.byteLength;
        controller.enqueue(value);
        if (remaining === 0) { stopped = true; controller.close(); void cancel("APK_COMPLETE"); }
      } catch (error) {
        if (!stopped) { stopped = true; controller.error(error); void cancel(error); }
      }
    },
    cancel(reason) { stopped = true; return cancel(reason); },
  });
}
