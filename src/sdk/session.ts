import {
  chromium,
  type Browser,
  type Page,
} from "playwright";
import { config } from "@/config";
import { log, scrubUrls } from "@/logger";

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

async function launchLocalBrowser(): Promise<Browser> {
  const common = { headless: config.headless, args: getBrowserArgs() };
  try {
    return config.useChromeChannel
      ? await chromium.launch({ ...common, channel: "chrome" })
      : await chromium.launch(common);
  } catch (err) {
    if (config.useChromeChannel) {
      log.warn("chrome_channel_unavailable_falling_back", { err });
      return chromium.launch(common);
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
): Promise<Page> {
  const browser = await launchLocalBrowser();
  let page: Page;
  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    page = await context.newPage();
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }

  const authDiagnostics = createAuthDiagnostics(page);
  await page.goto(headlessUrl, { waitUntil: "commit", timeout: 60000 });

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
  const browser = page.context().browser();
  try {
    if (browser) await browser.close();
    else if (!page.isClosed()) await page.close();
  } catch {
  }
}
