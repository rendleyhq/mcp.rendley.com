import { ApiClient } from "@/api/client";
import { bridge } from "@/bridge/index";
import { executeMotionOp } from "@/bridge/motion-executor";
import { config, headlessProjectUrl } from "@/config";
import { BrowserMode } from "@/constants";
import { log } from "@/logger";
import { runRemoteMotionSession } from "@/sdk/remote-motion";
import { acquireEditorPage, releasePage } from "@/sdk/session";
import type { MotionOp, MotionOpResult } from "@/types/motion.types";

interface MotionClipSessionInput {
  apiKey: string;
  projectId: string;
  // Mutating sessions flush one save before returning; reads skip it.
  save: boolean;
  // Called after each op settles — used as a job heartbeat (bumps updated_at so
  // a long multi-op batch isn't falsely marked orphaned) and for progress lines.
  onOpDone?: (index: number, result: MotionOpResult) => void;
}

export interface MotionOpSpec {
  label: string;
  op: MotionOp;
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
// of N of each. In remote mode the whole session runs on the browser worker
// (POST /v1/motion-run), same contract, no local Chromium.
export async function runMotionClipSession(
  input: MotionClipSessionInput,
  ops: MotionOpSpec[],
): Promise<MotionOpResult[]> {
  const sessionToken = await new ApiClient({
    baseUrl: config.apiBaseUrl,
    apiKey: input.apiKey,
  }).getEditorSessionToken(input.projectId);
  const headlessUrl = headlessProjectUrl(input.projectId, sessionToken);

  if (config.browserMode === BrowserMode.Local) {
    return runLocalMotionSession(input, ops, headlessUrl);
  }
  return runRemoteMotionSession(
    {
      projectId: input.projectId,
      headlessUrl,
      save: input.save,
      onOpDone: input.onOpDone,
    },
    ops.map((spec) => spec.op),
  );
}

async function runLocalMotionSession(
  input: MotionClipSessionInput,
  ops: MotionOpSpec[],
  headlessUrl: string,
): Promise<MotionOpResult[]> {
  const logger = log.child({ projectId: input.projectId, component: "motionClipRunner" });

  const page = await acquireEditorPage(headlessUrl, input.projectId, {
    timeoutMs: ACQUIRE_TIMEOUT_MS,
  });

  try {
    const results: MotionOpResult[] = [];
    let missingApi = false;

    for (const spec of ops) {
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
        executeMotionOp(page, spec.op),
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
          (err): MotionOpResult => ({
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
      logger.info("motion_op_done", {
        label: spec.label,
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
      });
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
    // releasePage closes gracefully with a bounded window, then SIGKILLs the
    // browser-server process — a wedged browser can neither hold the slots nor
    // leak a chrome process that starves later launches.
    await withTimeout(
      releasePage(page).catch(() => {}),
      RELEASE_TIMEOUT_MS,
      "release timeout",
    ).catch(() => {
      logger.warn("motion_release_timed_out_browser_may_leak");
    });
  }
}
