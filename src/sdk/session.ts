import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  chromium,
  type BrowserContext,
  type Page,
} from "playwright";
import { config } from "@/config";
import { log, scrubUrls } from "@/logger";
import { paceLaunch } from "@/sdk/worker-client";

function getBrowserArgs(): string[] {
  const args = [
    "--disable-dev-shm-usage",
    "--no-zygote",
    "--disable-features=CalculateNativeWinOcclusion",
    "--enable-webgl",
    "--ignore-gpu-blacklist",
    "--ignore-gpu-blocklist",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-extensions",
    "--metrics-recording-only",
    "--no-first-run",
    "--mute-audio",
    `--js-flags=--max-old-space-size=${config.chromiumJsHeapMb}`,
    `--disk-cache-size=${config.diskCacheBytes}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
  ];
  if (config.cpuOnly) {
    args.unshift("--use-gl=swiftshader", "--use-angle=swiftshader", "--enable-unsafe-swiftshader");
  }
  return args;
}

const VIEWPORT = { width: 960, height: 540 };

// Each session gets its OWN unique user-data-dir, which doubles as the kill
// handle: a plain Browser from launch() has no process() in Playwright's public
// API, and launchServer()+connect() doesn't work under Bun (the ws connect
// never completes) — so a wedged browser is killed by `pkill -f <profile dir>`
// instead of being abandoned to leak and starve every later launch.
const sessions = new WeakMap<Page, { userDataDir: string }>();

const DEFAULT_ACQUIRE_TIMEOUT_MS = 4 * 60 * 1000;
const GRACEFUL_CLOSE_TIMEOUT_MS = 10 * 1000;

function killByUserDataDir(userDataDir: string): void {
  // -f matches the full command line; the mkdtemp dir is unique per session.
  execFile("pkill", ["-9", "-f", userDataDir], () => {});
}

function removeUserDataDir(userDataDir: string): void {
  void fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

async function launchEditorContext(userDataDir: string): Promise<BrowserContext> {
  const common = {
    headless: config.headless,
    args: getBrowserArgs(),
    viewport: VIEWPORT,
  };
  try {
    return config.useChromeChannel
      ? await chromium.launchPersistentContext(userDataDir, { ...common, channel: "chrome" })
      : await chromium.launchPersistentContext(userDataDir, common);
  } catch (err) {
    if (config.useChromeChannel) {
      log.warn("chrome_channel_unavailable_falling_back", { err });
      return chromium.launchPersistentContext(userDataDir, common);
    }
    throw err;
  }
}

interface AuthRequestResult {
  ok: boolean;
  status: number;
  body?: string;
  errorText?: string;
}

interface AuthDiagnostics {
  verify?: AuthRequestResult;
  getSession?: AuthRequestResult;
  verifyRequestSeen: boolean;
  getSessionRequestSeen: boolean;
  currentUrl?: string;
  pageErrors: string[];
  consoleErrors: string[];
}

interface AuthDiagnosticsHandle {
  state: AuthDiagnostics;
  dispose: () => void;
}

function createAuthDiagnostics(page: Page): AuthDiagnosticsHandle {
  const state: AuthDiagnostics = {
    verifyRequestSeen: false,
    getSessionRequestSeen: false,
    currentUrl: page.url(),
    pageErrors: [],
    consoleErrors: [],
  };

  const handleResponse = async (response: { url(): string; ok(): boolean; status(): number; text(): Promise<string> }) => {
    const url = response.url();

    if (url.includes("/v1/auth/one-time-token/verify")) {
      state.verifyRequestSeen = true;
      state.verify = {
        ok: response.ok(),
        status: response.status(),
        body: await response.text().catch(() => undefined),
      };
    }

    if (url.includes("/v1/auth/get-session")) {
      state.getSessionRequestSeen = true;
      state.getSession = {
        ok: response.ok(),
        status: response.status(),
        body: await response.text().catch(() => undefined),
      };
    }
  };

  const handleRequestFailed = (request: { url(): string; failure(): { errorText?: string } | null }) => {
    const url = request.url();
    const failure = request.failure();

    if (url.includes("/v1/auth/one-time-token/verify")) {
      state.verifyRequestSeen = true;
      state.verify = { ok: false, status: 0, errorText: failure?.errorText };
    }

    if (url.includes("/v1/auth/get-session")) {
      state.getSessionRequestSeen = true;
      state.getSession = { ok: false, status: 0, errorText: failure?.errorText };
    }
  };

  const handlePageError = (error: Error) => {
    if (state.pageErrors.length < 5) state.pageErrors.push(error.message);
  };

  const handleConsole = (message: { type(): string; text(): string }) => {
    if (message.type() !== "error") return;
    if (state.consoleErrors.length < 5) state.consoleErrors.push(message.text());
  };

  page.on("response", handleResponse);
  page.on("requestfailed", handleRequestFailed);
  page.on("pageerror", handlePageError);
  page.on("console", handleConsole);

  return {
    state,
    dispose: () => {
      state.currentUrl = page.url();
      page.off("response", handleResponse);
      page.off("requestfailed", handleRequestFailed);
      page.off("pageerror", handlePageError);
      page.off("console", handleConsole);
    },
  };
}

function trimBody(body?: string): string | undefined {
  const value = body?.trim();
  return value ? value : undefined;
}

function diagnosticsDetail(diagnostics: AuthDiagnostics): string {
  const parts: string[] = [];
  // currentUrl carries the session token; scrubUrls must redact it before logging.
  if (diagnostics.currentUrl) parts.push(`url=${scrubUrls(diagnostics.currentUrl)}`);
  if (diagnostics.pageErrors.length > 0) parts.push(`pageErrors=${diagnostics.pageErrors.join(" | ")}`);
  if (diagnostics.consoleErrors.length > 0) parts.push(`consoleErrors=${diagnostics.consoleErrors.join(" | ")}`);
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

function explainAuthFailure(projectId: string, diagnostics: AuthDiagnostics): Error {
  if (diagnostics.verify && !diagnostics.verify.ok) {
    const detail = trimBody(diagnostics.verify.body) ?? diagnostics.verify.errorText;
    return new Error(
      `Editor session exchange failed for project ${projectId}: ` +
        `${diagnostics.verify.status}` +
        (detail ? ` ${detail}` : "") +
        diagnosticsDetail(diagnostics),
    );
  }

  if (diagnostics.verifyRequestSeen && diagnostics.verify?.ok && diagnostics.getSessionRequestSeen) {
    const getSession = diagnostics.getSession;
    if (!getSession) {
      return new Error(`Editor session lookup did not complete for project ${projectId}`);
    }

    const body = trimBody(getSession.body);
    if (!getSession.ok) {
      return new Error(
        `Editor session lookup failed for project ${projectId}: ` +
          `${getSession.status}` +
          (body ? ` ${body}` : "") +
          diagnosticsDetail(diagnostics),
      );
    }

    if (!body || body === "null") {
      return new Error(
        `Editor session was verified for project ${projectId} but getSession stayed invalid` +
          diagnosticsDetail(diagnostics),
      );
    }
  }

  if (diagnostics.verifyRequestSeen && !diagnostics.verify) {
    return new Error(
      `Editor session exchange did not complete for project ${projectId}` + diagnosticsDetail(diagnostics),
    );
  }

  return new Error(`Editor failed to become ready for project ${projectId}` + diagnosticsDetail(diagnostics));
}

export async function acquireEditorPage(
  headlessUrl: string,
  projectId: string,
  opts: { timeoutMs?: number } = {},
): Promise<Page> {
  // Pace local launches too (shared state with the remote pacer): an unpaced
  // burst of Chromium launches starves the host until launches themselves
  // start timing out, which is how the leak death-spiral used to begin.
  await paceLaunch();

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "rendley-mcp-chromium-"));
  const acquire = doAcquire(userDataDir, headlessUrl, projectId);
  try {
    return await withTimeout(
      acquire,
      opts.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
      "Opening the headless editor timed out. Retry the operation.",
    );
  } catch (err) {
    // The abandoned acquire may still materialize a page/process later —
    // destroy it as soon as it settles instead of leaking it with no handle.
    // (A launch that never settles is bounded by Playwright's own 180s launch
    // timeout, after which the catch path kills by profile dir.)
    void acquire
      .then((page) => releasePage(page))
      .catch(() => {
        killByUserDataDir(userDataDir);
        removeUserDataDir(userDataDir);
      });
    throw err;
  }
}

async function doAcquire(
  userDataDir: string,
  headlessUrl: string,
  projectId: string,
): Promise<Page> {
  const logger = log.child({ projectId, component: "editorAcquire" });
  const startedAt = Date.now();
  const stage = (name: string) => logger.info("acquire_stage", { name, ms: Date.now() - startedAt });

  const context = await launchEditorContext(userDataDir);
  stage("browser_launched");
  let page: Page;
  try {
    page = context.pages()[0] ?? (await context.newPage());
    sessions.set(page, { userDataDir });
    stage("page_created");
  } catch (err) {
    await context.close().catch(() => {});
    killByUserDataDir(userDataDir);
    removeUserDataDir(userDataDir);
    throw err;
  }

  const authDiagnostics = createAuthDiagnostics(page);
  try {
    await page.goto(headlessUrl, { waitUntil: "commit", timeout: 60000 });
    stage("navigation_committed");
  } catch (err) {
    authDiagnostics.dispose();
    await releasePage(page);
    throw err;
  }

  try {
    await page.waitForFunction(
      (id: string) => {
        if (window.location.pathname.startsWith("/login")) return true;
        return (
          (window as unknown as { __rendleyEditorReady?: boolean }).__rendleyEditorReady === true &&
          !!(window as unknown as { __rendleyAgent?: unknown }).__rendleyAgent &&
          window.location.pathname.includes(`/editor/${id}`)
        );
      },
      projectId,
      { timeout: 120000 },
    );
  } catch {
    authDiagnostics.dispose();
    await releasePage(page);
    throw explainAuthFailure(projectId, authDiagnostics.state);
  }

  if (page.url().includes("/login")) {
    authDiagnostics.dispose();
    await releasePage(page);
    throw explainAuthFailure(projectId, authDiagnostics.state);
  }

  stage("editor_ready");
  authDiagnostics.dispose();

  // Debug: stream the editor's console errors and failed/error API responses to
  // our logs for the rest of the run. Gated so it never adds noise in prod.
  if (config.keepBrowserOpen) attachDebugStream(page, projectId);

  return page;
}

// Streams the editor page's console errors, uncaught page errors, and failed or
// 4xx/5xx API responses to our logs. Debug-only (see KEEP_BROWSER_OPEN) — it
// runs for the whole session, so it's too chatty for normal operation.
function attachDebugStream(page: Page, projectId: string): void {
  const logger = log.child({ projectId, component: "editorDebugStream" });

  page.on("console", (message) => {
    const type = message.type();
    if (type !== "error" && type !== "warning") return;
    logger.warn("editor_console", { level: type, text: message.text() });
  });

  page.on("pageerror", (error) => {
    logger.error("editor_page_error", { message: error.message });
  });

  page.on("requestfailed", (request) => {
    logger.warn("editor_request_failed", {
      url: scrubUrls(request.url()),
      error: request.failure()?.errorText,
    });
  });

  page.on("response", async (response) => {
    const status = response.status();
    if (status < 400) return;
    // Only bodies for API calls; asset 404s aren't worth the read.
    const url = response.url();
    const isApi = url.includes("/v1/") || url.includes("/api/");
    const body = isApi ? await response.text().catch(() => undefined) : undefined;
    logger.warn("editor_response_error", {
      status,
      url: scrubUrls(url),
      ...(body ? { body: body.slice(0, 500) } : {}),
    });
  });
}

export async function releasePage(page: Page): Promise<void> {
  // Debug escape hatch: keep the browser open so it can be inspected by hand.
  // Leaks a browser per run, so it's env-gated and local-only.
  if (config.keepBrowserOpen) {
    log.warn("keep_browser_open", {
      url: scrubUrls(page.url()),
      hint: "KEEP_BROWSER_OPEN is set — browser left open for inspection; restart the process to reclaim it",
    });
    return;
  }
  const session = sessions.get(page);
  try {
    if (session) {
      // Graceful close, bounded; a wedged browser is then SIGKILLed (by its
      // unique profile dir) so the process can never leak and starve later
      // launches.
      try {
        await withTimeout(page.context().close(), GRACEFUL_CLOSE_TIMEOUT_MS, "browser close timed out");
      } catch {
        log.warn("motion_release_force_killed");
        killByUserDataDir(session.userDataDir);
      }
      removeUserDataDir(session.userDataDir);
      return;
    }
    const browser = page.context().browser();
    if (browser) await browser.close();
    else if (!page.isClosed()) await page.close();
  } catch {
  }
}
