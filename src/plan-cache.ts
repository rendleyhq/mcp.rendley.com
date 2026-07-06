import type { ApiClient, PlanTier } from "@/api/client";
import { classifyPlanTier } from "@/api/client";
import { log } from "@/logger";
import { recordPlanDowngrade } from "@/metrics";

const HIT_TTL_MS = 60_000;
const ERROR_TTL_MS = 10_000;

const MAX_CACHE_ENTRIES = 10_000;

// Concurrent-edit cap used when /users/me can't be reached; fails open to a
// modest value so a transient blip never blocks a paying user.
const FALLBACK_MAX_CONCURRENT = 3;

interface PlanInfo {
  tier: PlanTier;
  maxConcurrent: number;
}

const cache = new Map<string, { info: PlanInfo; expiresAt: number }>();

function sweepExpired(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

// Resolves the user's plan info (tier + concurrent-edit cap) from /users/me,
// cached briefly. On a lookup failure it degrades gracefully rather than
// throwing: it reuses the last known value (even if expired), and with nothing
// cached it assumes a paid tier (fail-open) — so a transient /users/me blip
// never wrongly blocks a paying user from the paid-only MCP.
async function resolvePlanInfo(
  userId: string,
  apiClient: ApiClient,
): Promise<PlanInfo> {
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > now) return hit.info;
  const lastKnown = hit?.info;
  if (hit) cache.delete(userId);
  if (cache.size > MAX_CACHE_ENTRIES) sweepExpired(now);

  try {
    const me = await apiClient.getMe();
    const sub = me.subscription;
    const info: PlanInfo = {
      tier: classifyPlanTier(sub?.plan_name),
      maxConcurrent: sub?.mcp_agent_max_concurrent ?? FALLBACK_MAX_CONCURRENT,
    };
    cache.set(userId, { info, expiresAt: now + HIT_TTL_MS });
    return info;
  } catch (err) {
    recordPlanDowngrade();
    log.warn("plan_info_resolve_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    const info: PlanInfo = lastKnown ?? {
      tier: "starter",
      maxConcurrent: FALLBACK_MAX_CONCURRENT,
    };
    cache.set(userId, { info, expiresAt: now + ERROR_TTL_MS });
    return info;
  }
}

export async function resolvePlanTier(
  userId: string,
  apiClient: ApiClient,
): Promise<PlanTier> {
  return (await resolvePlanInfo(userId, apiClient)).tier;
}

export async function resolveMcpMaxConcurrent(
  userId: string,
  apiClient: ApiClient,
): Promise<number> {
  return (await resolvePlanInfo(userId, apiClient)).maxConcurrent;
}
