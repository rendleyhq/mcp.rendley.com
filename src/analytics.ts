import { PostHog } from "posthog-node";
import { log, scrubUrls } from "@/logger";

// Server-side product analytics (PostHog). This is deliberately separate from the
// OTel infra metrics (`src/metrics.ts`) — these are product events, not infra.
//
// Safety contract:
// - NO-OP when POSTHOG_API_KEY is absent (mirrors how the rest of the app gates
//   optional infra).
// - Never throws into a caller: every entrypoint is wrapped so an analytics
//   failure can never break a tool call.
// - Product-relevant props only: bounded, low-cardinality values (tool_name,
//   project_id, duration_ms, reason, error_code, plan). Raw error messages,
//   stack traces and URLs are diagnostics — they belong in the logs (OTel), not
//   here. sanitizeProps still scrubs tokenized URLs as a defensive backstop.

const SOURCE_SURFACE = "mcp";
const DEFAULT_HOST = "https://analytics.rendley.com";

const apiKey = process.env.POSTHOG_API_KEY?.trim();
const host = process.env.POSTHOG_HOST?.trim() || DEFAULT_HOST;

type Props = Record<string, unknown>;

let client: PostHog | null = null;

if (apiKey) {
  try {
    client = new PostHog(apiKey, {
      host,
      // These match posthog-node's defaults. The request path flushes manually
      // (flushAnalytics), so request events don't wait on the interval; background
      // events (agent-runner) rely on the interval + the shutdown flush.
      flushAt: 20,
      flushInterval: 10_000,
      // No personal API key here, so no feature-flag polling — but be explicit.
      disableGeoip: true,
    });
    log.info("analytics_enabled", { host });
  } catch (err) {
    client = null;
    log.warn("analytics_init_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// Scrub any free-form string prop that could carry a tokenized URL (e.g. an error
// message that echoed a headless/session URL). Cheap and only touches strings.
function sanitizeProps(props: Props): Props {
  const out: Props = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = typeof v === "string" ? scrubUrls(v) : v;
  }
  return out;
}

export function capture(
  distinctId: string | undefined | null,
  event: string,
  props: Props = {},
): void {
  if (!client || !distinctId) return;
  try {
    client.capture({
      distinctId,
      event,
      // surface stamped last so a caller-supplied `surface` prop can't override it.
      properties: { ...sanitizeProps(props), surface: SOURCE_SURFACE },
    });
  } catch (err) {
    log.warn("analytics_capture_failed", {
      event,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export function identifyUser(
  distinctId: string | undefined | null,
  props: Props = {},
): void {
  if (!client || !distinctId) return;
  try {
    client.identify({
      distinctId,
      properties: { ...sanitizeProps(props), surface: SOURCE_SURFACE },
    });
  } catch (err) {
    log.warn("analytics_identify_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// Best-effort flush after request handling — posthog-node batches, so nudge it so
// short-lived handlers don't leave events sitting in the buffer. Never throws.
export async function flushAnalytics(): Promise<void> {
  if (!client) return;
  try {
    await client.flush();
  } catch (err) {
    log.warn("analytics_flush_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// Flush + stop on process shutdown. Wired into the graceful-shutdown path.
export async function shutdownAnalytics(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown();
  } catch (err) {
    log.warn("analytics_shutdown_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
