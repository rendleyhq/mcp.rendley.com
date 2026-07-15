import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { otel } from "@hono/otel";
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
import {
  registerMotionGraphicsTools,
  MOTION_GRAPHICS_TOOL_NAMES,
} from "@/tools/motion-graphics";
import { isPaidPlan } from "@/plan";
import { fail } from "@/response";
import { handleStartAgentJob } from "@/http/agent";
import { handleGetJob, handleCancelJob } from "@/http/jobs";
import { handleUploadBrandAsset } from "@/http/brandkit";
import { handleStreamUpload } from "@/http/uploads";
import { MAX_UPLOAD_BYTES } from "@/http/upload-tokens";
import { log } from "@/logger";
import { getQueueStats } from "@/queue";
import { installShutdownHandlers } from "@/shutdown";

const app = new Hono<AppEnv>();

// Unwinds last to override secureHeaders' CORP so /.well-known stays cross-origin.
app.use("/.well-known/*", async (c, next) => {
  await next();
  c.header("Cross-Origin-Resource-Policy", "cross-origin");
});

app.use("*", otel());

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
// POST is accepted as an alias: LLM callers routinely POST despite the tool
// text saying PUT, and the method mismatch used to surface as an opaque 404.
app.on(["PUT", "POST"], "/v1/uploads/stream/:token", (c) =>
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

// Tools that stay usable on free plans: motion graphics are authored by the
// user's own assistant (their Claude/ChatGPT subscription) and cost 0 Rendley
// credits, so they're exempt from the paid-plan paywall.
// check_edit included: it is the poller for the (exempt) motion-graphics jobs.
const PAYWALL_EXEMPT_TOOLS = new Set<string>([...MOTION_GRAPHICS_TOOL_NAMES, "check_edit"]);

// Keeps every tool listed (so the assistant sees what's possible) but swaps each
// handler for an upgrade prompt. Used for free plans: the MCP is a paid feature,
// but a soft paywall lets the assistant nudge the user rather than failing to
// connect. Wrap before registering so all tools are covered in one place.
// Exempt tools keep their real handler.
function installFreePlanPaywall(server: McpServer): void {
  const register = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    cb: unknown,
  ) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (
    name,
    config,
    cb,
  ) =>
    PAYWALL_EXEMPT_TOOLS.has(name)
      ? register(name, config, cb)
      : register(name, config, async () => fail(FREE_PLAN_PAYWALL_MESSAGE));
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

  // Paid-only: free plans get every tool call answered with an upgrade prompt.
  if (!(await isPaidPlan(apiClient))) {
    installFreePlanPaywall(server);
  }

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
  registerMotionGraphicsTools(server, {
    apiClient,
    userId,
    apiKey: c.get("apiKey"),
    apiKeyId: c.get("apiKeyId"),
  });

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

log.info("mcp_server_started", {
  port: config.port,
  queueConcurrency: config.queueConcurrency,
  browserMode: config.browserMode,
  ...(config.browserMode === BrowserMode.Remote
    ? { browserWorkerUrl: config.browserWorkerUrl }
    : {}),
});
