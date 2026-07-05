import { z } from "zod";
import { BrowserMode, HEADLESS_AUTH_PARAM } from "@/constants";

const boolSchema = (fallback: boolean) =>
  z.preprocess(
    (value) => value ?? String(fallback),
    z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.enum(["true", "1", "yes", "false", "0", "no"]))
      .transform(
        (value) => value === "true" || value === "1" || value === "yes",
      ),
  );

const intSchema = (fallback: number, min = 1) =>
  z.preprocess(
    (value) =>
      value === undefined || value === ""
        ? fallback
        : Number.parseInt(String(value), 10),
    z.number().int().min(min),
  );

// Fixed tuning, not configurable via env.
const constants = {
  exportPollTimeoutMs: 25 * 60 * 1000,
  exportPollIntervalMs: 3000,
  planConcurrency: {
    starter: 3,
    pro: 5,
    business: 10,
    free: 1,
  },
  maxConcurrentPerEndUser: 3,
  maxBrowserBusyRetries: 2,
  diskCacheBytes: 2 * 1024 * 1024 * 1024,
} as const;

// Defaults for the env-overridable tuning knobs below.
const defaults = {
  queueConcurrency: 120,
  queueMaxQueued: 1000,
  agentTimeoutMs: 8 * 60 * 1000,
  browserRecycleAfter: 8,
  chromiumJsHeapMb: 512,
  headless: true,
  useChromeChannel: true,
} as const;

const csvSchema = z
  .string()
  .optional()
  .transform((value) =>
    value
      ? value
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
      : [],
  );

const EnvSchema = z.object({
  PORT: intSchema(8787),
  // Default to the hosted Rendley API/editor so the server boots without a
  // copied .env; set these to override (e.g. staging or a self-hosted stack).
  API_BASE_URL: z.string().url().default("https://api.rendley.com/v1"),
  APP_BASE_URL: z.string().url().default("https://app.rendley.com"),
  CORS_ORIGINS: csvSchema,
  AUTH_BASE_URL: z.string().url().optional(),
  MCP_PUBLIC_URL: z.string().url().optional(),
  OAUTH_SCOPES: csvSchema,
  OPENAI_APPS_CHALLENGE_TOKEN: z.string().default(""),
  BROWSER_WORKER_URL: z.string().url().optional(),
  BROWSER_WORKER_TOKEN: z.string().default(""),
  // Durable job store. Unset → in-memory (jobs lost on restart; dev only).
  REDIS_URL: z.string().optional(),
  BROWSER_MODE: z.preprocess(
    (value) =>
      value === undefined || value === ""
        ? BrowserMode.Local
        : String(value).trim().toLowerCase(),
    z.nativeEnum(BrowserMode),
  ),

  QUEUE_CONCURRENCY: intSchema(defaults.queueConcurrency),
  QUEUE_MAX_QUEUED: intSchema(defaults.queueMaxQueued),
  BROWSER_RECYCLE_AFTER: intSchema(defaults.browserRecycleAfter),
  AGENT_TIMEOUT_MS: intSchema(defaults.agentTimeoutMs),
  // How long edit_video blocks synchronously before handing back a job_id for
  // check_edit polling. Edits regularly run several minutes (video generation
  // steps), so the window is generous by default — progress notifications keep
  // MCP clients alive during it. The run itself continues up to agentTimeoutMs.
  SYNC_WINDOW_MS: intSchema(3 * 60 * 1000),
  // How long the browser worker holds a finished session warm for follow-up
  // edits on the same thread. Held browsers bill while idle, so keep this
  // short. 0 disables sending reuse hints entirely.
  SESSION_HOLD_MS: intSchema(60 * 1000, 0),
  CHROMIUM_JS_HEAP_MB: intSchema(defaults.chromiumJsHeapMb),
  HEADLESS: boolSchema(defaults.headless),
  USE_CHROME_CHANNEL: boolSchema(defaults.useChromeChannel),
  CPU_ONLY: boolSchema(false),
  // Debug only (local browser mode): leave the browser open after a run so you
  // can inspect the editor's console/network/timeline. Pair with HEADLESS=false.
  // Every run then leaks a browser, so only use it while debugging locally.
  KEEP_BROWSER_OPEN: boolSchema(false),

  RATE_LIMIT_WINDOW_MS: intSchema(60_000),
  RATE_LIMIT_MAX: intSchema(240, 0),
});

const env = EnvSchema.parse(process.env);

const trimTrailingSlash = (value: string) => value.replace(/\/$/, "");

const authBaseUrl = trimTrailingSlash(
  env.AUTH_BASE_URL ?? `${trimTrailingSlash(env.API_BASE_URL)}/auth`,
);

const mcpPublicUrl = env.MCP_PUBLIC_URL ? trimTrailingSlash(env.MCP_PUBLIC_URL) : "";

export const config = {
  port: env.PORT,
  apiBaseUrl: env.API_BASE_URL,
  appBaseUrl: env.APP_BASE_URL,
  ...constants,
  queueConcurrency: env.QUEUE_CONCURRENCY,
  queueMaxQueued: env.QUEUE_MAX_QUEUED,
  browserRecycleAfter: env.BROWSER_RECYCLE_AFTER,
  agentTimeoutMs: env.AGENT_TIMEOUT_MS,
  syncWindowMs: env.SYNC_WINDOW_MS,
  sessionHoldMs: env.SESSION_HOLD_MS,
  chromiumJsHeapMb: env.CHROMIUM_JS_HEAP_MB,
  headless: env.HEADLESS,
  useChromeChannel: env.USE_CHROME_CHANNEL,
  cpuOnly: env.CPU_ONLY,
  keepBrowserOpen: env.KEEP_BROWSER_OPEN,
  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
  },
  corsOrigins: env.CORS_ORIGINS,
  authBaseUrl,
  authIssuer: new URL(authBaseUrl).origin,
  mcpPublicUrl,
  mcpResource: mcpPublicUrl
    ? mcpPublicUrl.endsWith("/mcp")
      ? mcpPublicUrl
      : `${mcpPublicUrl}/mcp`
    : "",
  oauthScopes: env.OAUTH_SCOPES,
  openaiAppsChallengeToken: env.OPENAI_APPS_CHALLENGE_TOKEN.trim(),
  browserWorkerUrl: env.BROWSER_WORKER_URL
    ? trimTrailingSlash(env.BROWSER_WORKER_URL)
    : "",
  browserWorkerToken: env.BROWSER_WORKER_TOKEN.trim(),
  browserMode: env.BROWSER_MODE,
  redisUrl: env.REDIS_URL?.trim() ?? "",
};

export const PROTECTED_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource";

export function protectedResourceMetadataUrl(): string {
  return `${config.mcpPublicUrl.replace(/\/$/, "")}${PROTECTED_RESOURCE_METADATA_PATH}`;
}

export function projectUrl(projectId: string): string {
  return `${config.appBaseUrl}/editor/${projectId}`;
}

export function headlessProjectUrl(
  projectId: string,
  sessionToken: string,
  threadId?: string,
): string {
  const url = new URL(projectUrl(projectId));
  url.searchParams.set("mode", "headless");
  if (threadId) url.searchParams.set("thread_id", threadId);
  url.searchParams.set(HEADLESS_AUTH_PARAM, sessionToken);
  return url.toString();
}
