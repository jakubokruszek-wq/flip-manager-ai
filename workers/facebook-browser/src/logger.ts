export function logFacebookWorker(event: string, data: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event, ...data })}\n`);
}

