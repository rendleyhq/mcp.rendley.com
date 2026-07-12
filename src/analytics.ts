import { PostHog } from "posthog-node";
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
    log.info("analytics_enabled", { host });
  } catch (err) {
    client = null;
    log.warn("analytics_init_failed", {
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
  event: string,
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
    log.warn("analytics_capture_failed", {
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
    log.warn("analytics_shutdown_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
