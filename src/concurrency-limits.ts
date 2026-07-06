// In-process concurrency slots (the MCP runs as a single replica). acquireAll
// returns an idempotent release handle, or null when any requested key is at
// capacity. Callers guarantee release via try/finally, and a process restart
// resets the counters, so no TTL healing is needed.
//
// The per-tenant cap VALUE comes from the backend (GET /agent/limits, plan
// config) — only the counting lives here. These slots exist for fairness: they
// stop one user from occupying all the browsers and starving everyone else.
// The admission queue (QUEUE_CONCURRENCY = the Cloudflare browser cap) is the
// global total.

// Fair sharing within one tenant when it attributes requests to end users.
export const MAX_CONCURRENT_PER_END_USER = 3;

// How long a queued edit waits for a run slot before it's marked failed. Runs
// are internally bounded, so slots always free eventually; this is the backstop.
export const SLOT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

export interface SlotRequest {
  key: string;
  max: number;
}

export interface Acquisition {
  release(): Promise<void>;
}

const counts = new Map<string, number>();

function releaseKey(key: string): void {
  const current = counts.get(key) ?? 0;
  if (current <= 1) counts.delete(key);
  else counts.set(key, current - 1);
}

export async function acquireAll(reqs: SlotRequest[]): Promise<Acquisition | null> {
  const acquired: string[] = [];
  for (const { key, max } of reqs) {
    // max <= 0 means unlimited (backend sends -1 for uncapped plans).
    if (max > 0) {
      const current = counts.get(key) ?? 0;
      if (current >= max) {
        acquired.forEach(releaseKey);
        return null;
      }
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    acquired.push(key);
  }
  let done = false;
  return {
    async release() {
      if (done) return;
      done = true;
      acquired.forEach(releaseKey);
    },
  };
}

// Like acquireAll, but when a key is at capacity it waits and retries until the
// slot frees, the signal aborts, or the deadline passes (returns null on the
// latter two). Lets a queued edit wait for a run slot instead of being rejected.
export async function acquireAllOrWait(
  reqs: SlotRequest[],
  opts: { signal?: AbortSignal; timeoutMs: number; pollMs?: number },
): Promise<Acquisition | null> {
  const deadline = Date.now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 500;
  for (;;) {
    if (opts.signal?.aborted) return null;
    const acquired = await acquireAll(reqs);
    if (acquired) return acquired;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export interface ConcurrencyKeys {
  tenantKey: string;
  endUserKey: string;
}

export function resolveKeys(
  userId: string,
  endUserId?: string | null,
): ConcurrencyKeys {
  return {
    tenantKey: userId,
    endUserKey: endUserId ? `${userId}:${endUserId}` : userId,
  };
}
