/**
 * Run a storage write, trying again after short pauses. A browser can drop its IndexedDB connection or
 * refuse a write for a moment; one hiccup must not end a recording. The last error is thrown.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { delaysMs?: number[]; onRetry?: (e: unknown, attempt: number) => void; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const delays = opts.delaysMs ?? [200, 600, 1500];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= delays.length) throw e;
      opts.onRetry?.(e, attempt + 1);
      await sleep(delays[attempt]);
    }
  }
}

/** "QuotaExceededError: The quota has been exceeded", cut to `max` characters. */
export function describeError(e: unknown, max = 300): string {
  const name = typeof (e as { name?: unknown })?.name === "string" ? (e as { name: string }).name : "Error";
  const message = typeof (e as { message?: unknown })?.message === "string" ? (e as { message: string }).message : String(e ?? "");
  const text = message && message !== name ? `${name}: ${message}` : name;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
