import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { config, PROTECTED_RESOURCE_METADATA_PATH } from "@/config";
import { BrowserMode } from "@/constants";
import { requireBearer, requirePaidPlan, type AppEnv } from "@/middlewares/auth";
import "@/metrics";
import { registerProjectTools } from "@/tools/projects";
import { registerAccountTools } from "@/tools/account";
import { registerAgentTools } from "@/tools/agent";
import { registerExportTools } from "@/tools/export";
import { registerBrandkitTools } from "@/tools/brandkit";
import { registerUploadTools } from "@/tools/uploads";
import { resolvePlanInfo } from "@/plan";
import { fail } from "@/response";
import { handleStartAgentJob } from "@/http/agent";
import { handleGetJob, handleCancelJob } from "@/http/jobs";
import { handleUploadBrandAsset } from "@/http/brandkit";
import { handleStreamUpload } from "@/http/uploads";
import { MAX_UPLOAD_BYTES } from "@/http/upload-tokens";
import { log } from "@/logger";
import { getQueueStats } from "@/queue";
import { installShutdownHandlers } from "@/shutdown";
import { runWithRequestContext } from "@/request-context";

const app = new Hono<AppEnv>();

// Request context runs outermost so every log during the request carries
// request_id/user_id (see logger mixin). It also emits the http_request wide
// event, but keeps by outcome rather than logging every request: failures
// (4xx/5xx) and unusually slow requests always, the ordinary fast 2xx/3xx never
// — their real work is already captured by tool_completed / agent_job_finished,
// so a line per successful poll/list call would be pure noise. /health* is
// skipped entirely. The finally guarantees the event even on throw.
const HEALTH_PATHS = new Set(["/health", "/health/details"]);
const SLOW_REQUEST_MS = 3000;
app.use("*", async (c, next) => {
  if (HEALTH_PATHS.has(c.req.path)) {
    return next();
  }
  const requestId = crypto.randomUUID();
  const start = performance.now();
  return runWithRequestContext({ request_id: requestId }, async () => {
    try {
      await next();
    } finally {
      const status = c.res.status;
      const duration_ms = Math.round(performance.now() - start);
      const attrs = {
        method: c.req.method,
        path: c.req.routePath,
        status,
        duration_ms,
      };
      if (status >= 500) {
        log.error("http request failed", attrs);
      } else if (status >= 400) {
        log.warn("http request client error", attrs);
      } else if (duration_ms >= SLOW_REQUEST_MS) {
        log.info("slow http request", attrs);
      }
    }
  });
});

// Unwinds last to override secureHeaders' CORP so /.well-known stays cross-origin.
app.use("/.well-known/*", async (c, next) => {
  await next();
  c.header("Cross-Origin-Resource-Policy", "cross-origin");
});


app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
    xFrameOptions: "DENY",
    referrerPolicy: "no-referrer",
  }),
);

app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  if (
    origin &&
    config.corsOrigins.length > 0 &&
    !config.corsOrigins.includes(origin) &&
    !c.req.path.startsWith("/.well-known/")
  ) {
    return c.json(
      { error: { code: "FORBIDDEN_ORIGIN", message: "Origin not allowed" } },
      403,
    );
  }
  await next();
});

app.use("/.well-known/*", cors({ origin: "*" }));

if (config.corsOrigins.length > 0) {
  app.use(
    "/*",
    cors({
      origin: config.corsOrigins,
      allowMethods: ["POST", "GET", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "mcp-session-id",
        "Mcp-Session-Id",
        "last-event-id",
        "Last-Event-ID",
        "mcp-protocol-version",
        "Mcp-Protocol-Version",
      ],
      exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
    }),
  );
}

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    browser_mode: config.browserMode,
  });
});

app.get("/health/details", requireBearer, (c) => {
  return c.json({
    status: "ok",
    browser_mode: config.browserMode,
    ...(config.browserMode === BrowserMode.Remote
      ? { browser_worker_url: config.browserWorkerUrl }
      : {}),
    queue: getQueueStats(),
  });
});

const protectedResourceMetadata = () => ({
  resource: config.mcpResource,
  authorization_servers: [config.authIssuer],
  bearer_methods_supported: ["header"],
});
app.get(PROTECTED_RESOURCE_METADATA_PATH, (c) =>
  c.json(protectedResourceMetadata()),
);
app.get(`${PROTECTED_RESOURCE_METADATA_PATH}/mcp`, (c) =>
  c.json(protectedResourceMetadata()),
);

if (config.openaiAppsChallengeToken) {
  app.get("/.well-known/openai-apps-challenge", (c) =>
    c.text(config.openaiAppsChallengeToken),
  );
}

// Free plans can connect and list tools, but each tool call returns an upgrade
// prompt (paywall handled per-tool in handleMCPRequest) — softer than a hard
// transport block, so the assistant can nudge the user to upgrade in-chat.
app.all("/mcp", requireBearer, (c) => handleMCPRequest(c));

app.post("/v1/agent", requireBearer, requirePaidPlan, (c) =>
  handleStartAgentJob(c.req.raw, {
    apiClient: c.get("apiClient"),
    apiKey: c.get("apiKey"),
    apiKeyId: c.get("apiKeyId"),
    userId: c.get("userId"),
  }),
);

app.post("/v1/brandkit/assets", requireBearer, requirePaidPlan, (c) =>
  handleUploadBrandAsset(c.req.raw, { apiClient: c.get("apiClient") }),
);

// The single-use capability token in the path IS the auth, so no requireBearer.
app.put("/v1/uploads/stream/:token", (c) =>
  handleStreamUpload(c.req.raw, c.req.param("token")),
);

app.get("/v1/jobs/:id", requireBearer, (c) =>
  handleGetJob(c.req.param("id"), c.get("apiKeyId")),
);
app.get("/v1/agent/jobs/:id", requireBearer, (c) =>
  handleGetJob(c.req.param("id"), c.get("apiKeyId")),
);
app.post("/v1/agent/jobs/:id/cancel", requireBearer, (c) =>
  handleCancelJob(c.req.param("id"), c.get("apiKeyId"), c.get("apiClient")),
);

function withMcpAccept(req: Request): Request {
  if (req.method !== "POST") {
    return req;
  }
  const accept = req.headers.get("accept") ?? "";
  if (
    accept.includes("application/json") &&
    accept.includes("text/event-stream")
  ) {
    return req;
  }
  const headers = new Headers(req.headers);
  headers.set("accept", "application/json, text/event-stream");
  return new Request(req, { headers });
}

const FREE_PLAN_PAYWALL_MESSAGE =
  "The Rendley MCP is available on paid plans. Let the user know they need to upgrade at https://app.rendley.com to create or edit videos from their assistant, then stop — do not retry.";

// Keeps every tool listed (so the assistant sees what's possible) but swaps each
// handler for an upgrade prompt. Used for free plans: the MCP is a paid feature,
// but a soft paywall lets the assistant nudge the user rather than failing to
// connect. Wrap before registering so all tools are covered in one place.
// Wraps every tool handler to emit one event per tool call — tool name, outcome
// (tools return { isError } rather than throwing on business failures, so those
// are otherwise invisible: the MCP HTTP response is a 200), and duration. Runs
// inside the request context, so user_id/request_id are stamped automatically.
function installToolLogging(server: McpServer): void {
  const register = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    cb: (...args: unknown[]) => unknown,
  ) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (
    name,
    config,
    cb,
  ) =>
    register(name, config, async (...args: unknown[]) => {
      const start = performance.now();
      try {
        const result = (await cb(...args)) as { isError?: boolean };
        const duration_ms = Math.round(performance.now() - start);
        if (result?.isError) {
          log.warn("tool failed", { tool: name, duration_ms });
        } else {
          log.info("tool completed", { tool: name, duration_ms });
        }
        return result;
      } catch (err) {
        log.error("tool threw unhandled error", {
          tool: name,
          duration_ms: Math.round(performance.now() - start),
          err,
        });
        throw err;
      }
    });
}

function installFreePlanPaywall(server: McpServer): void {
  const register = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    cb: unknown,
  ) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (
    name,
    config,
    _cb,
  ) => register(name, config, async () => fail(FREE_PLAN_PAYWALL_MESSAGE));
}

async function handleMCPRequest(c: Context<AppEnv>): Promise<Response> {
  const apiClient = c.get("apiClient");

  const server = new McpServer(
    { name: "Rendley", version: "1.0.0" },
    {
      instructions:
        "Create and edit videos by describing what you want. Connects your assistant to your Rendley projects, media, and brand kit, so it can pull in your own footage, apply your brand colors and assets, and export finished videos.",
    },
  );

  const userId = c.get("userId");

  // One /users/me read serves both paywall gating and the analytics plan label.
  const planInfo = await resolvePlanInfo(apiClient);

  // Paid-only: free plans get every tool call answered with an upgrade prompt.
  if (!planInfo.isPaid) {
    installFreePlanPaywall(server);
  }

  // Applied last so it wraps the real (or paywall) handler — one event per call.
  installToolLogging(server);

  registerProjectTools(server, apiClient);
  registerAccountTools(server, apiClient);
  registerAgentTools(server, {
    apiClient,
    userId,
    apiKey: c.get("apiKey"),
    apiKeyId: c.get("apiKeyId"),
  });
  registerExportTools(server, apiClient);
  registerBrandkitTools(server, apiClient);
  registerUploadTools(server, apiClient);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);
  return transport.handleRequest(withMcpAccept(c.req.raw));
}

const server = Bun.serve({
  port: config.port,
  idleTimeout: 0,
  maxRequestBodySize: MAX_UPLOAD_BYTES + 8 * 1024 * 1024,
  fetch: app.fetch,
});

installShutdownHandlers({ server });

log.info("mcp server started", {
  port: config.port,
  queueConcurrency: config.queueConcurrency,
  browserMode: config.browserMode,
  ...(config.browserMode === BrowserMode.Remote
    ? { browserWorkerUrl: config.browserWorkerUrl }
    : {}),
});
