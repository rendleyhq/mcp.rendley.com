import { createHash } from "crypto";
import type { Context, MiddlewareHandler } from "hono";
import { ApiClient } from "@/api/client";
import { config, protectedResourceMetadataUrl } from "@/config";
import { log } from "@/logger";
import { resolvePlanTier } from "@/plan-cache";

// Short-lived cache of successful credential verifications, keyed by a hash of
// the token (never the token itself). Skips a network round-trip to the API on
// every request — polling-heavy callers (check_edit / GET jobs) hit this hard.
// Only successes are cached, so revocation takes effect within the TTL and
// failed guesses are never remembered.
const AUTH_CACHE_TTL_MS = 60_000;
const AUTH_CACHE_MAX = 10_000;

interface CachedAuth {
  apiKeyId: string;
  userId: string;
  expiresAt: number;
}

const authCache = new Map<string, CachedAuth>();

function tokenCacheKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function getCachedAuth(key: string): CachedAuth | null {
  const hit = authCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    authCache.delete(key);
    return null;
  }
  return hit;
}

function setCachedAuth(key: string, value: Omit<CachedAuth, "expiresAt">): void {
  if (authCache.size >= AUTH_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of authCache) {
      if (v.expiresAt <= now) authCache.delete(k);
    }
    // Still full of live entries — drop oldest-inserted to stay bounded.
    if (authCache.size >= AUTH_CACHE_MAX) {
      const first = authCache.keys().next().value;
      if (first) authCache.delete(first);
    }
  }
  authCache.set(key, { ...value, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
}

export type AppEnv = {
  Variables: {
    apiKey: string;
    apiClient: ApiClient;
    apiKeyId: string;
    userId: string;
  };
};

function unauthorized(c: Context<AppEnv>, message: string) {
  const scope =
    config.oauthScopes.length > 0
      ? ` scope="${config.oauthScopes.join(" ")}"`
      : "";
  c.header(
    "WWW-Authenticate",
    `Bearer resource_metadata="${protectedResourceMetadataUrl()}"${scope}`,
  );
  return c.json({ error: { code: "UNAUTHORIZED", message } }, 401);
}

// Pull the credential out of the Authorization header, tolerant of how it was
// typed. Accepts a proper "Bearer <token>", a lowercased "bearer", a raw token
// with no scheme (user pasted just the key), and an accidentally doubled
// "Bearer Bearer <token>" that some connector UIs produce when they prepend the
// scheme to a field the user already filled in. An invalid token still fails
// verification below and returns 401, so this only relaxes formatting.
function extractBearerToken(header?: string): string {
  if (!header) return "";
  let value = header.trim();
  while (/^bearer\s+/i.test(value)) {
    value = value.slice(value.indexOf(" ") + 1).trim();
  }
  return value;
}

export const requireBearer: MiddlewareHandler<AppEnv> = async (c, next) => {
  const bearer = extractBearerToken(c.req.header("authorization"));
  if (!bearer) {
    return unauthorized(
      c,
      "Authentication required. Send an API key as Authorization: Bearer <key>, or follow the WWW-Authenticate header to sign in via OAuth.",
    );
  }

  const cacheKey = tokenCacheKey(bearer);
  const cached = getCachedAuth(cacheKey);
  if (cached) {
    c.set("apiKey", bearer);
    c.set(
      "apiClient",
      new ApiClient({ baseUrl: config.apiBaseUrl, apiKey: bearer }),
    );
    c.set("apiKeyId", cached.apiKeyId);
    c.set("userId", cached.userId);
    return next();
  }

  // Verifier outage (not invalid_api_key) must fall through to OAuth, not 502 yet.
  let verified = null;
  let apiKeyUnavailable = false;
  try {
    verified = await ApiClient.verifyApiKey(config.apiBaseUrl, bearer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message !== "invalid_api_key") {
      log.error("verify_api_key_failed", { err });
      apiKeyUnavailable = true;
    }
  }
  if (verified) {
    setCachedAuth(cacheKey, { apiKeyId: verified.keyId, userId: verified.userId });
    c.set("apiKey", bearer);
    c.set(
      "apiClient",
      new ApiClient({ baseUrl: config.apiBaseUrl, apiKey: bearer }),
    );
    c.set("apiKeyId", verified.keyId);
    c.set("userId", verified.userId);
    return next();
  }

  // Not a valid API key; try it as an OAuth access token.
  let oauth = null;
  let oauthUnavailable = false;
  try {
    oauth = await ApiClient.verifyMcpToken(config.authBaseUrl, bearer);
  } catch (err) {
    log.error("verify_oauth_token_failed", { err });
    oauthUnavailable = true;
  }
  if (oauth) {
    setCachedAuth(cacheKey, { apiKeyId: `oauth:${oauth.userId}`, userId: oauth.userId });
    c.set("apiKey", bearer);
    c.set(
      "apiClient",
      new ApiClient({ baseUrl: config.apiBaseUrl, apiKey: bearer }),
    );
    c.set("apiKeyId", `oauth:${oauth.userId}`);
    c.set("userId", oauth.userId);
    return next();
  }
  if (oauthUnavailable && apiKeyUnavailable) {
    return c.json(
      {
        error: {
          code: "AUTH_UNAVAILABLE",
          message: "Could not validate credentials",
        },
      },
      502,
    );
  }

  return unauthorized(c, "Invalid credentials");
};

// Gates MCP surface (the /mcp endpoint and REST agent/brandkit routes) to paid
// plans — the AI agent stays available in the app, but connecting it to an
// external assistant is a paid feature. Runs after requireBearer, so userId and
// apiClient are set. resolvePlanTier fails open (assumes paid on a lookup
// error), so a transient /users/me blip never locks out a paying customer.
export const requirePaidPlan: MiddlewareHandler<AppEnv> = async (c, next) => {
  const tier = await resolvePlanTier(c.get("userId"), c.get("apiClient"));
  if (tier === "free") {
    log.info("mcp_blocked_free_plan", { userId: c.get("userId") });
    return c.json(
      {
        error: {
          code: "UPGRADE_REQUIRED",
          message:
            "The Rendley MCP is available on paid plans. Upgrade to connect the editor to your assistant.",
        },
      },
      402,
    );
  }
  return next();
};
