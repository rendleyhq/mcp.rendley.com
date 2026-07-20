import { PostHog } from "posthog-node";
import { AnalyticsEvent } from "@/analytics.types";
import { log, scrubUrls } from "@/logger";

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
      // Events are captured server-side, so the request IP is the server's, not
      // the user's — disabling GeoIP avoids geo-locating the server.
      disableGeoip: true,
    });
    log.debug("analytics enabled", { host });
  } catch (err) {
    client = null;
    log.warn("failed to initialize analytics", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function sanitizeProps(props: Props): Props {
  const out: Props = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = typeof v === "string" ? scrubUrls(v) : v;
  }
  return out;
}

export function capture(
  userId: string | undefined | null,
  event: AnalyticsEvent,
  props: Props = {},
): void {
  if (!client || !userId) return;
  try {
    client.capture({
      distinctId: userId,
      event,
      properties: { ...sanitizeProps(props), surface: SOURCE_SURFACE },
    });
  } catch (err) {
    log.warn("failed to capture analytics event", {
      event,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function shutdownAnalytics(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown();
  } catch (err) {
    log.warn("failed to shut down analytics", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
