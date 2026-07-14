import type { Page } from "playwright";

import { ApiClient } from "@/api/client";
import { bridge } from "@/bridge/index";
import { config, headlessProjectUrl } from "@/config";
import { BrowserMode } from "@/constants";
import { log } from "@/logger";
import { acquireEditorPage, releasePage } from "@/sdk/session";

interface MotionClipSessionInput {
  apiKey: string;
  projectId: string;
  // Mutating ops flush the save before returning; reads skip it.
  save: boolean;
}

// Loads the project in a headless editor, runs a direct bridge op against the
// live MotionClip/SDK (no agent, no LLM), flushes the save for mutations, then
// tears the page down. This mirrors how the agent path applies edits, but calls
// the motion-clip functions directly for precise, typed control.
export async function runMotionClipSession<T>(
  input: MotionClipSessionInput,
  op: (page: Page) => Promise<T>,
): Promise<T> {
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
  const page = await acquireEditorPage(headlessUrl, input.projectId);

  try {
    // Bound the op: a hanging worker script (infinite loop, never-completing
    // INIT) must not wedge the session, the per-project lock, or the browser.
    // acquireEditorPage and flushSave have their own timeouts; this covers the
    // op itself. On reject, the finally below releases the page and the caller's
    // finally releases the lock.
    let opTimer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      op(page),
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
    ]).finally(() => {
      if (opTimer) clearTimeout(opTimer);
    });

    if (input.save) {
      const save = await bridge.flushSave(page);
      if (save.status !== "synced") {
        throw new Error(
          `Motion graphic applied but the save was not confirmed (${save.status}). Please retry.`,
        );
      }
      logger.info("motion_clip_saved");
    }

    return result;
  } finally {
    await releasePage(page).catch(() => {});
  }
}
