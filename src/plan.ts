import type { ApiClient, PlanTier } from "@/api/client";
import { classifyPlanTier } from "@/api/client";
import { log } from "@/logger";
import { recordPlanDowngrade } from "@/metrics";

// Concurrent-edit cap used when /users/me can't be reached; fails open to a
// modest value so a transient blip never blocks a paying user.
const FALLBACK_MAX_CONCURRENT = 3;

interface PlanInfo {
  tier: PlanTier;
  maxConcurrent: number;
}

// Reads the user's plan (tier + concurrent-edit cap) fresh from /users/me on
// every call — deliberately not cached, so a plan change (e.g. an upgrade in
// the UI) takes effect on the very next request. On a lookup failure it fails
// open to a paid tier so a transient blip never wrongly blocks a paying user
// from the paid-only MCP.
async function resolvePlanInfo(apiClient: ApiClient): Promise<PlanInfo> {
  try {
    const sub = (await apiClient.getMe()).subscription;
    return {
      tier: classifyPlanTier(sub?.plan_name),
      maxConcurrent: sub?.mcp_agent_max_concurrent ?? FALLBACK_MAX_CONCURRENT,
    };
  } catch (err) {
    recordPlanDowngrade();
    log.warn("plan_info_resolve_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return { tier: "starter", maxConcurrent: FALLBACK_MAX_CONCURRENT };
  }
}

export async function resolvePlanTier(apiClient: ApiClient): Promise<PlanTier> {
  return (await resolvePlanInfo(apiClient)).tier;
}

export async function resolveMcpMaxConcurrent(apiClient: ApiClient): Promise<number> {
  return (await resolvePlanInfo(apiClient)).maxConcurrent;
}
