import type { ApiClient } from "@/api/client";
import { log } from "@/logger";
import { recordPlanResolveFailed } from "@/metrics";

// Concurrent-edit cap used when /users/me can't be reached; fails open to a
// modest value so a transient blip never blocks a paying user.
const FALLBACK_MAX_CONCURRENT = 3;

export interface PlanInfo {
  isPaid: boolean;
  maxConcurrent: number;
  // "free" when unsubscribed, "unknown" when /users/me couldn't be read.
  planName: string;
}

// Reads the user's plan (paid status + concurrent-edit cap) fresh from /users/me
// on every call — deliberately not cached, so a plan change (e.g. an upgrade in
// the UI) takes effect on the very next request. Only paid plans carry a
// `subscription` object. On a lookup failure it fails open to paid so a
// transient blip never wrongly blocks a paying user from the paid-only MCP.
export async function resolvePlanInfo(apiClient: ApiClient): Promise<PlanInfo> {
  try {
    const sub = (await apiClient.getMe()).subscription;
    return {
      isPaid: sub != null,
      maxConcurrent: sub?.mcp_agent_max_concurrent ?? FALLBACK_MAX_CONCURRENT,
      planName: sub?.plan_name ?? "free",
    };
  } catch (err) {
    recordPlanResolveFailed();
    log.warn("failed to resolve plan info", {
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      isPaid: true,
      maxConcurrent: FALLBACK_MAX_CONCURRENT,
      planName: "unknown",
    };
  }
}

export async function isPaidPlan(apiClient: ApiClient): Promise<boolean> {
  return (await resolvePlanInfo(apiClient)).isPaid;
}

export async function resolveMcpMaxConcurrent(apiClient: ApiClient): Promise<number> {
  return (await resolvePlanInfo(apiClient)).maxConcurrent;
}
