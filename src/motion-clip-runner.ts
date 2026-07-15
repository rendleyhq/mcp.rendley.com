import type { Page } from "playwright";

import { ApiClient } from "@/api/client";
import { bridge } from "@/bridge/index";
import { config, headlessProjectUrl } from "@/config";
import { BrowserMode } from "@/constants";
import { log } from "@/logger";
import { acquireEditorPage, releasePage } from "@/sdk/session";
import type { BridgeMotionGraphicResult } from "@/types/bridge.types";

interface MotionClipSessionInput {
  apiKey: string;
  projectId: string;
  // Mutating sessions flush one save before returning; reads skip it.
  save: boolean;
  // Called after each op settles — used as a job heartbeat (bumps updated_at so
  // a long multi-op batch isn't falsely marked orphaned) and for progress lines.
  onOpDone?: (index: number, result: BridgeMotionGraphicResult) => void;
}

export interface MotionOpSpec {
  label: string;
  run: (page: Page) => Promise<BridgeMotionGraphicResult>;
}

// Hard bounds on the session stages that are otherwise unbounded at the
// Playwright level. A wedged browser (hung newPage, a livelocked editor main
// thread that never returns from page.evaluate, a browser.close() that never
// resolves) would otherwise hold the per-project lock forever — starving every
// later job on the project until the store marks them "orphaned".
const ACQUIRE_TIMEOUT_MS = 4 * 60 * 1000;
const SAVE_TIMEOUT_MS = 90 * 1000;
const RELEASE_TIMEOUT_MS = 15 * 1000;

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

// Loads the project in a headless editor ONCE, runs each op in order via direct
// bridge calls against the live MotionClip/SDK (no agent, no LLM), flushes a
// single save for mutations, then tears the page down. Ops are independent: one
// failing does not stop the rest — outcomes are returned positionally. This is
// what makes batches cheap: N clips cost one browser launch + one save instead
// of N of each.
export async function runMotionClipSession(
  input: MotionClipSessionInput,
  ops: MotionOpSpec[],
): Promise<BridgeMotionGraphicResult[]> {
  if (config.browserMode !== BrowserMode.Local) {
    throw new Error(
      "Motion-graphics tools currently require the local headless browser (BROWSER_MODE=local).",
    );
  }

  const logger = log.child({ projectId: input.projectId, component: "motionClipRunner" });

  const sessionToken = await new ApiClient({
    baseUrl: config.apiBaseUrl,
    apiKey: input.apiKey,
  }).getEditorSessionToken(input.projectId);

  const headlessUrl = headlessProjectUrl(input.projectId, sessionToken);
  // On timeout the underlying launch may still complete later and leak a
  // browser we have no handle to — an accepted cost; a leaked process beats a
  // permanently wedged project lock.
  const page = await withTimeout(
    acquireEditorPage(headlessUrl, input.projectId),
    ACQUIRE_TIMEOUT_MS,
    "Opening the headless editor timed out. Retry the operation.",
  );

  try {
    const results: BridgeMotionGraphicResult[] = [];
    let missingApi = false;

    for (const op of ops) {
      // Once the editor build is known to lack the motion API, every remaining
      // op would fail the same way — skip the round-trips.
      if (missingApi) {
        results.push({ ok: false, error: "__MISSING_MOTION_API__" });
        continue;
      }

      // Bound each op: a hanging worker script (infinite loop, never-completing
      // INIT) must not wedge the session, the per-project lock, or the browser —
      // and must not eat the time budget of the ops that follow it.
      // acquireEditorPage and flushSave have their own timeouts.
      let opTimer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        op.run(page),
        new Promise<never>((_, reject) => {
          opTimer = setTimeout(
            () =>
              reject(
                new Error(
                  `Motion-clip op timed out after ${config.motionOpTimeoutMs}ms — the script likely hangs (infinite loop) or is too heavy. Simplify the userCode and retry.`,
                ),
              ),
            config.motionOpTimeoutMs,
          );
        }),
      ])
        .catch(
          (err): BridgeMotionGraphicResult => ({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
        .finally(() => {
          if (opTimer) {
            clearTimeout(opTimer);
          }
        });

      if (result.error === "__MISSING_MOTION_API__") {
        missingApi = true;
      }
      results.push(result);
      logger.info("motion_op_done", { label: op.label, ok: result.ok });
      input.onOpDone?.(results.length - 1, result);
    }

    // One terminal save covers every applied op (the ops themselves run with
    // skipSave). Nothing changed if no op succeeded, so skip the flush then.
    // The save's own 60s timer runs INSIDE the page — a livelocked editor main
    // thread never returns from evaluate at all, hence the outer bound.
    if (input.save && results.some((r) => r.ok)) {
      const save = await withTimeout(
        bridge.flushSave(page),
        SAVE_TIMEOUT_MS,
        "The editor became unresponsive while saving. Retry the operation.",
      );
      if (save.status !== "synced") {
        throw new Error(
          `Motion graphics applied but the save was not confirmed (${save.status}). Please retry.`,
        );
      }
      logger.info("motion_clip_saved");
    }

    return results;
  } finally {
    // browser.close() can hang on a wedged browser; don't let teardown hold the
    // slots — give it a bounded window, then abandon it (it keeps trying in the
    // background; worst case a browser process leaks).
    await withTimeout(
      releasePage(page).catch(() => {}),
      RELEASE_TIMEOUT_MS,
      "release timeout",
    ).catch(() => {
      logger.warn("motion_release_timed_out_browser_may_leak");
    });
  }
}
