# Rendley MCP

The [MCP](https://modelcontextprotocol.io) server for [Rendley](https://rendley.com). It gives an AI assistant a full video editor: connect it once, then create and edit video by describing what you want, in the same chat you already work in. Under the hood it drives the hosted Rendley editor in a browser and calls the hosted Rendley API on your behalf:

- Editor: `https://app.rendley.com`
- API: `https://api.rendley.com/v1`

The same agent is also reachable over plain HTTP (`POST /v1/agent`) for backends that don't speak MCP. See [REST example](#rest-example).

There are two ways to use it:

1. **Use the hosted server** at `https://mcp.rendley.com/mcp`. Nothing to run. See [Connect a client](#connect-a-client).
2. **Self-host this server** against the hosted Rendley API. See [Self-host the server](#self-host-the-server).

📖 **Full documentation, with step-by-step setup guides and screenshots: [docs.rendley.com/mcp](https://docs.rendley.com/mcp)**

---

## Connect a client

Any client that speaks remote MCP can connect. Point it at the endpoint and authenticate by signing in or with an API key:

```
https://mcp.rendley.com/mcp
```

- **Sign in with Rendley** (recommended): the client opens a Rendley sign-in tab and you approve access. Nothing to copy, and you can revoke it later.
- **API key**: the client sends an `Authorization: Bearer YOUR_RENDLEY_API_KEY` header. Create one at [Settings → API Keys](https://app.rendley.com/settings); see [Get an API key](https://docs.rendley.com/mcp/authentication#get-an-api-key).

Most clients accept a JSON config like this:

```json
{
  "mcpServers": {
    "rendley": {
      "url": "https://mcp.rendley.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_RENDLEY_API_KEY" }
    }
  }
}
```

For sign-in, drop the `headers` block and let the client run the browser flow.

The docs have illustrated, per-client walkthroughs:

- **[Claude](https://docs.rendley.com/mcp/claude)**: desktop, web, and Claude Code.
- **[Codex](https://docs.rendley.com/mcp/openai)**: the Codex desktop app and CLI.
- **[Other clients](https://docs.rendley.com/mcp/other-clients)**: any other client that speaks remote MCP, plus the `mcp-remote` bridge for local-only clients.

For Claude Code specifically:

```bash
claude mcp add --transport http rendley https://mcp.rendley.com/mcp \
  --header "Authorization: Bearer YOUR_RENDLEY_API_KEY"
```

### Try it

Ask the client what it can do, then try a simple request:

> What can Rendley do here?

> List my projects.

If it lists the Rendley tools and your projects, you're connected. From there, describe the video you want and the assistant creates a project, builds the edit, and returns a link.

---

## Self-host the server

This repo is the MCP server only; it does not run the full Rendley stack locally. It talks to the hosted Rendley API and editor. When you self-host, point clients at your own `https://<host>/mcp` instead of `https://mcp.rendley.com/mcp`.

### Requirements

- [Bun](https://bun.sh) `>= 1.1` (or Docker)
- A Rendley account to connect with. Clients authenticate per request with their own API key ([Settings → API Keys](https://app.rendley.com/settings), [guide](https://docs.rendley.com/mcp/authentication#get-an-api-key)) or OAuth sign-in. The server stores no key of its own.

### Run locally

```bash
git clone https://github.com/rendleyhq/rendley-mcp.git
cd rendley-mcp

bun install
bun dev                       # http://localhost:8787
```

`API_BASE_URL` and `APP_BASE_URL` default to the hosted Rendley API and editor, so the server boots out of the box with no `.env` at all; copy `.env.example` only to point at a different stack. The server holds no credentials of its own: every request authenticates with the caller's own API key or OAuth token.

By default the server drives the editor with a **local Chrome** (`BROWSER_MODE=local`), so no extra infrastructure is needed. `bun install` downloads a bundled Chromium; with `USE_CHROME_CHANNEL=true` it prefers your installed Google Chrome and falls back to the bundled browser. Set `HEADLESS=false` to watch the editor in a visible window, and `CPU_ONLY=true` on machines without a usable GPU.

Verify it's up:

```bash
curl http://localhost:8787/health
# {"status":"ok","browser_mode":"local"}
```

### Docker

```bash
docker compose up -d --build
curl http://localhost:8787/health
```

### Connecting a client to your instance

Use the same client steps as the [hosted server](#connect-a-client), but swap the endpoint for your host (e.g. `http://localhost:8787/mcp`) and authenticate with your API key as a bearer token:

```json
{
  "mcpServers": {
    "rendley": {
      "url": "http://localhost:8787/mcp",
      "headers": { "Authorization": "Bearer YOUR_RENDLEY_API_KEY" }
    }
  }
}
```

**OAuth.** OAuth sign-in is always on. Clients that support it (Claude connectors, ChatGPT, `codex mcp login rendley`) can sign in via the hosted login flow instead of pasting a key; the server advertises the authorization server through RFC 9728 protected-resource metadata. Set `MCP_PUBLIC_URL` to this server's public URL so discovery points at the right host.

### Remote browser mode

For hosted deployments, set `BROWSER_MODE=remote` and point the server at a deployed remote browser worker. The server mints a short-lived editor session token and posts it to the worker, so the caller's credential never leaves this process:

```bash
BROWSER_MODE=remote
BROWSER_WORKER_URL=https://<your-browser-worker-host>
BROWSER_WORKER_TOKEN=<must match the worker's secret>
```

---

## Configuration

All configuration is via environment variables; start from [`.env.example`](./.env.example), which documents every option. The essentials:

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_BASE_URL` | `https://api.rendley.com/v1` | Rendley API root. Override for staging or a self-hosted stack. |
| `APP_BASE_URL` | `https://app.rendley.com` | Rendley editor root. Override for staging or a self-hosted stack. |
| `MCP_PUBLIC_URL` | none | This server's public URL, advertised for OAuth discovery. |
| `BROWSER_MODE` | `local` | `local` = in-process Playwright Chrome; `remote` = remote browser worker. |
| `HEADLESS` | `true` | Local mode only; `false` shows the browser window. |
| `USE_CHROME_CHANNEL` | `true` | Local mode only; prefer installed Chrome over bundled Chromium. |
| `CPU_ONLY` | `false` | Force software WebGL (SwiftShader) on hosts without a GPU. |
| `QUEUE_CONCURRENCY` | `120` | Max concurrent browser-backed jobs per container. |
| `CORS_ORIGINS` | none | CSV allowlist of browser origins. Empty disables CORS. |
| `WEBHOOK_SIGNING_SECRET` | none | Master secret for outbound job [webhooks](#webhooks). Empty disables them. |

## Endpoints

| Method | Path | |
| --- | --- | --- |
| `POST` | `/mcp` | MCP Streamable HTTP transport |
| `POST` | `/v1/agent` | Start an async edit job |
| `GET` | `/v1/jobs/:id` | Poll a job |
| `GET` | `/health` | Liveness |

## REST example

You don't need an MCP client to drive the agent. The same agent is available over plain HTTP. Start a job, get an id back, and poll until the video is ready. Full reference: [docs.rendley.com/mcp/api-access](https://docs.rendley.com/mcp/api-access).

```bash
# Start a job (swap in http://localhost:8787 for a self-hosted instance)
curl -X POST https://mcp.rendley.com/v1/agent \
  -H "Authorization: Bearer $RENDLEY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Create a 9:16 slideshow from these files",
    "files": [
      { "url": "https://cdn.example.com/photo1.jpg" },
      { "url": "https://cdn.example.com/photo2.jpg" }
    ],
    "webhook_url": "https://your-app.example.com/hooks/rendley"
  }'

# Poll it
curl -H "Authorization: Bearer $RENDLEY_API_KEY" \
  https://mcp.rendley.com/v1/jobs/<job_id>
```

`webhook_url` is optional — see [Webhooks](#webhooks). Without it, poll `GET /v1/jobs/:id` until the status is terminal.

## Webhooks

Pass a `webhook_url` (public `https` only) to `POST /v1/agent` or to the `edit_video` MCP tool and the server POSTs the job once, when it reaches a terminal state (`completed`, `failed`, or `cancelled`). Delivery is at-least-once in spirit but best-effort in practice: one 10s attempt, then two retries (after 1s and 4s) on a network error or a non-2xx response. Redirects are not followed. Keep polling as your fallback.

Each delivery carries:

| Header | |
| --- | --- |
| `X-Rendley-Signature` | `t=<unix-seconds>,v1=<hex-hmac>` |
| `X-Rendley-Event` | `job.updated` |
| `X-Rendley-Job-Id` | the job id |

Body:

```json
{
  "job_id": "9d0b1c2e-4f6a-4a9c-8f1b-1a2b3c4d5e6f",
  "kind": "agent",
  "status": "completed",
  "project_id": "prj_123",
  "thread_id": "thr_456",
  "result": {
    "project_id": "prj_123",
    "project_url": "https://app.rendley.com/editor/prj_123",
    "commands_applied": 7,
    "saved": true,
    "thread_id": "thr_456"
  },
  "created_at": "2026-07-19T10:31:04.512Z",
  "updated_at": "2026-07-19T10:33:47.109Z"
}
```

### Verifying the signature

`v1` is `HMAC-SHA256(secret, "<t>." + rawBody)`, hex-encoded, where `rawBody` is the exact bytes received — verify before parsing the JSON. Compare in constant time, and reject a `t` more than ~5 minutes from now to blunt replays.

The `secret` is per-user. Fetch it once from `GET https://api.rendley.com/v1/webhooks/secret` with your API key. **One secret verifies deliveries from both hosts** — `api.rendley.com` export webhooks and `mcp.rendley.com` job webhooks sign identically.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, header, secret) {
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=").map((s) => s.trim())),
  );
  const expected = createHmac("sha256", secret)
    .update(`${parts.t}.${rawBody}`)
    .digest();
  const actual = Buffer.from(parts.v1, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

Self-hosting: set `WEBHOOK_SIGNING_SECRET` to the same master secret `api.rendley.com` uses, otherwise the secret it serves won't verify this server's deliveries. When it's unset, any request carrying a `webhook_url` is rejected up front with `400 WEBHOOKS_DISABLED` (the `edit_video` tool returns the equivalent error) — no job is started.

## Runtime notes

- Single tenant per instance.
- The browser launches lazily on the first browser-backed request; concurrent requests reuse it via separate tabs, which close on completion.
- Media attachments are public URLs only. The editor imports them via the batch upload API (no local-file uploads through MCP).
- REST jobs are asynchronous and must be polled. Job state is held in memory: completed records are retained for 1 hour, and a restart drops all job state (in-flight jobs are lost, finished results become unfetchable).
- `/health` is healthy whenever the server can serve; browser launch failures surface on browser-backed requests.

## Scripts

```bash
bun dev          # watch mode, pretty logs
bun start        # production start
bun run typecheck
```

## License

[Apache License 2.0](./LICENSE). © 2026 Rendley.
</content>
</invoke>
