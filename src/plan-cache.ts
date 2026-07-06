import type { ApiClient, PlanTier } from "@/api/client";
import { log } from "@/logger";
import { recordPlanDowngrade } from "@/metrics";

const HIT_TTL_MS = 60_000;
const ERROR_TTL_MS = 10_000;

const MAX_CACHE_ENTRIES = 10_000;

function sweepExpired(map: Map<string, { expiresAt: number }>, now: number): void {
  for (const [key, entry] of map) {
    if (entry.expiresAt <= now) map.delete(key);
  }
}

// ── plan tier (paid-plan gate) ───────────────────────────────────────────────
const tierCache = new Map<string, { tier: PlanTier; expiresAt: number }>();

// Resolves the user's plan tier, cached briefly. On a lookup failure it
// degrades gracefully rather than throwing: it reuses the last known tier
// (even if expired), and with nothing cached it assumes a paid tier
// (fail-open) — so a transient /users/me blip never wrongly blocks a paying
// user from the paid-only MCP.
export async function resolvePlanTier(
  userId: string,
  apiClient: ApiClient,
): Promise<PlanTier> {
  const now = Date.now();
  const hit = tierCache.get(userId);
  if (hit && hit.expiresAt > now) return hit.tier;
  const lastKnown = hit?.tier;
  if (hit) tierCache.delete(userId);
  if (tierCache.size > MAX_CACHE_ENTRIES) sweepExpired(tierCache, now);

  try {
    const tier = await apiClient.getPlanTier();
    tierCache.set(userId, { tier, expiresAt: now + HIT_TTL_MS });
    return tier;
  } catch (err) {
    recordPlanDowngrade();
    log.warn("plan_tier_resolve_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    const tier = lastKnown ?? "starter";
    tierCache.set(userId, { tier, expiresAt: now + ERROR_TTL_MS });
    return tier;
  }
}

// ── concurrent-edit cap ──────────────────────────────────────────────────────
// The backend owns the value (GET /agent/limits, derived from the plan); this
// cache only avoids a round-trip per request. Fails open to the last known
// value (or a modest default) so a blip never blocks a paying user.
const FALLBACK_MAX_CONCURRENT = 3;
const limitsCache = new Map<string, { max: number; expiresAt: number }>();

export async function resolveMcpMaxConcurrent(
  userId: string,
  apiClient: ApiClient,
): Promise<number> {
  const now = Date.now();
  const hit = limitsCache.get(userId);
  if (hit && hit.expiresAt > now) return hit.max;
  const lastKnown = hit?.max;
  if (hit) limitsCache.delete(userId);
  if (limitsCache.size > MAX_CACHE_ENTRIES) sweepExpired(limitsCache, now);

  try {
    const limits = await apiClient.getAgentLimits();
    const max = limits.mcp_agent_max_concurrent;
    limitsCache.set(userId, { max, expiresAt: now + HIT_TTL_MS });
    return max;
  } catch (err) {
    log.warn("agent_limits_resolve_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    const max = lastKnown ?? FALLBACK_MAX_CONCURRENT;
    limitsCache.set(userId, { max, expiresAt: now + ERROR_TTL_MS });
    return max;
  }
}
