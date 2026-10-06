/**
 * Runs `fn` inside one fixed window of `windowMs` (a minute, an hour, a UTC day): when less than
 * `marginMs` remains of the current window, waits for the next one first, so a test that counts or
 * seeds a window's rate-limit row never sees the window roll over under it (the suite is slow under
 * load, as in the Docker `verify` stage). A test using it needs a timeout above `marginMs`.
 */
export async function withinOneWindow<T>(windowMs: number, fn: () => Promise<T>, marginMs = 10_000): Promise<T> {
  const left = windowMs - (Date.now() % windowMs);
  if (left < marginMs) await new Promise((resolve) => setTimeout(resolve, left + 50));
  return fn();
}
