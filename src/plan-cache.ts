import type { ApiClient, PlanTier } from "@/api/client";
import { config } from "@/config";
import { log } from "@/logger";
import { recordPlanDowngrade } from "@/metrics";

const HIT_TTL_MS = 60_000;
const ERROR_TTL_MS = 10_000;

interface PlanInfo {
  tier: PlanTier;
  cap: number;
}

const cache = new Map<string, PlanInfo & { expiresAt: number }>();

const MAX_CACHE_ENTRIES = 10_000;

function sweepExpired(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

// Resolves the user's plan tier and derived concurrency cap, cached briefly.
// On a lookup failure it degrades gracefully rather than throwing: it reuses the
// last known plan (even if expired), and with nothing cached it assumes a paid
// tier (fail-open) — so a transient /users/me blip never downgrades the cap of a
// paying user nor wrongly blocks them from the paid-only MCP.
async function resolvePlan(
  userId: string,
  apiClient: ApiClient,
): Promise<PlanInfo> {
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > now) return hit;
  const lastKnown: PlanInfo | undefined = hit
    ? { tier: hit.tier, cap: hit.cap }
    : undefined;
  if (hit) cache.delete(userId);
  if (cache.size > MAX_CACHE_ENTRIES) sweepExpired(now);

  try {
    const tier = await apiClient.getPlanTier();
    const cap = config.planConcurrency[tier] ?? config.planConcurrency.free;
    log.debug("plan_cap_resolved", { tier, cap });
    const info: PlanInfo = { tier, cap };
    cache.set(userId, { ...info, expiresAt: now + HIT_TTL_MS });
    return info;
  } catch (err) {
    recordPlanDowngrade();
    log.warn("plan_cap_resolve_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    // Fail open: never downgrade or block a (likely paid) user on a lookup blip.
    const info: PlanInfo = lastKnown ?? {
      tier: "starter",
      cap: config.planConcurrency.starter,
    };
    cache.set(userId, { ...info, expiresAt: now + ERROR_TTL_MS });
    return info;
  }
}

export async function resolvePlanCap(
  userId: string,
  apiClient: ApiClient,
): Promise<number> {
  return (await resolvePlan(userId, apiClient)).cap;
}

export async function resolvePlanTier(
  userId: string,
  apiClient: ApiClient,
): Promise<PlanTier> {
  return (await resolvePlan(userId, apiClient)).tier;
}
