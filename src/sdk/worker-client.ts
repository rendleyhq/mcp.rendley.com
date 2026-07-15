import { config } from "@/config";

// Shared plumbing for everything that launches browsers — the remote agent
// runs, the remote motion runs, and local Playwright launches. Lives here so
// the launch pacer is a SINGLE module-level state: if each path paced
// independently they'd still exceed the browser-rendering admission rate (and
// locally, still stampede the machine) when used together.

export class RemoteBrowserError extends Error {
  constructor(
    public code: string,
    message: string,
    // Safe to re-dispatch only when no edit has started yet (connect failure,
    // 5xx, or a stall before any progress). Mid-run failures must not retry —
    // the worker may have partially applied the edit.
    public retryable = false,
  ) {
    super(message);
    this.name = "RemoteBrowserError";
  }
}

export class BrowserBusyError extends RemoteBrowserError {
  constructor(
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super("BROWSER_BUSY", message);
    this.name = "BrowserBusyError";
  }
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RemoteBrowserError("ABORTED", "run aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RemoteBrowserError("ABORTED", "run aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

// Launch pacer: space launch attempts to the browser admission rate so a burst
// of simultaneous runs queues here (bounded by each run's overall deadline)
// instead of failing with BROWSER_BUSY (remote) or thrashing the host (local).
let nextLaunchAt = 0;
export async function paceLaunch(signal?: AbortSignal): Promise<void> {
  const interval = config.browserLaunchIntervalMs;
  if (interval <= 0) return;
  const now = Date.now();
  const waitMs = Math.max(0, nextLaunchAt - now);
  nextLaunchAt = Math.max(now, nextLaunchAt) + interval;
  if (waitMs > 0) await sleep(waitMs, signal);
}
