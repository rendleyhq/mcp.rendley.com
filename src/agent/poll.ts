import { bridge } from "@/bridge/index";
import { log } from "@/logger";
import { config } from "@/config";
import type { PollOptions, PollOutcome } from "@/types/agent.types";
import type { BridgeStatus } from "@/types/bridge.types";

export type { PollOptions, PollOutcome };

const POLL_INTERVAL_MS = 500;
const IDLE_CONFIRMATIONS = 8;
const ENSURE_SAVED_TIMEOUT_MS = 60_000;
const SAVE_ATTEMPTS = 3;
const HEAP_SAMPLE_EVERY_TICKS = 10;

interface HeapSample {
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
  jsHeapSizeLimit?: number;
}

async function sampleJsHeap(page: import("playwright").Page): Promise<HeapSample | null> {
  try {
    return await page.evaluate(() => {
      const mem = (performance as unknown as { memory?: HeapSample }).memory;
      if (!mem) return null;
      return {
        usedJSHeapSize: mem.usedJSHeapSize,
        totalJSHeapSize: mem.totalJSHeapSize,
        jsHeapSizeLimit: mem.jsHeapSizeLimit,
      };
    });
  } catch {
    return null;
  }
}

// Deterministic completion (bridge v2): the editor reports the run lifecycle
// directly, so we exit the instant the run reaches a terminal state instead of
// waiting for IDLE_CONFIRMATIONS quiet ticks. Only trusted when the terminal
// state belongs to a run started after `runIdFloor` (guards reused pages).
function terminalRunState(
  status: BridgeStatus,
  runIdFloor: number,
): "completed" | "error" | "cancelled" | null {
  const runStatus = status.lastRunStatus;
  if (runStatus !== "completed" && runStatus !== "error" && runStatus !== "cancelled") return null;
  if ((status.runId ?? 0) <= runIdFloor) return null;
  return runStatus;
}

export async function pollAgentCore(opts: PollOptions): Promise<PollOutcome> {
  const { page, projectId, release, maxWaitMs, autoApprove } = opts;
  const logger = (opts.logger ?? log).child({
    projectId,
    component: "pollAgentCore",
  });
  const onProgress = opts.onProgress ?? (() => {});
  const runIdFloor = opts.runIdFloor ?? 0;

  let lastCommandCount = 0;
  let lastStreaming: boolean | null = null;
  let lastMessageCount = 0;
  const heapBudgetBytes = config.chromiumJsHeapMb * 1024 * 1024;

  const close = async () => {
    await release(page);
  };

  const saveBeforeCut = async () => {
    if (lastCommandCount <= 0) return;
    await bridge.flushSave(page, ENSURE_SAVED_TIMEOUT_MS).catch(() => {});
  };

  // Shared completion tail: read the final message, flush the save with
  // retries, and return the outcome. Used by both the deterministic exit and
  // the legacy idle-heuristic exit.
  const finishCompleted = async (status: BridgeStatus, mode: string): Promise<PollOutcome> => {
    const messages = await bridge.getMessages(page);
    const lastMessage = bridge.lastAssistantContent(messages);

    // Flush save before close, else the context teardown races an in-flight PATCH and drops edits.
    await onProgress("Saving project…");
    let save: { status: string } = { status: "unknown" };
    for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt++) {
      try {
        save = await bridge.flushSave(page, ENSURE_SAVED_TIMEOUT_MS);
      } catch (err) {
        save = { status: `error:${err instanceof Error ? err.message : String(err)}` };
      }
      if (save.status === "synced") break;
      logger.warn("save_retry", { attempt, saveStatus: save.status, mode });
    }

    if (save.status !== "synced") {
      await close();
      logger.warn("save_not_confirmed", { saveStatus: save.status, mode });
      return { kind: "save_failed", saveStatus: save.status, lastMessage };
    }

    await close();
    logger.info("completed", {
      commandExecutions: status.commandExecutions,
      mode,
      closed: true,
    });
    return { kind: "completed", status, lastMessage };
  };

  const startTime = Date.now();
  let idleCount = 0;
  let ticks = 0;

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    ticks++;

    if (ticks % HEAP_SAMPLE_EVERY_TICKS === 0) {
      const heap = await sampleJsHeap(page);
      if (heap?.usedJSHeapSize && heap.usedJSHeapSize > heapBudgetBytes) {
        logger.warn("heap_budget_exceeded", {
          usedJSHeapSize: heap.usedJSHeapSize,
          budgetBytes: heapBudgetBytes,
          ticks,
        });
        const messages = await bridge.getMessages(page).catch(() => []);
        const lastMessage = bridge.lastAssistantContent(messages);
        await saveBeforeCut();
        await close();
        return {
          kind: "timeout",
          lastMessage:
            lastMessage ||
            "Session aborted: renderer memory budget exceeded. Try splitting the work into smaller requests.",
        };
      }
    }

    const status = await bridge.getStatus(page);
    if (!status) continue;

    if (status.lastError && !status.isStreaming) {
      if (status.commandExecutions > 0) {
        await bridge.flushSave(page, ENSURE_SAVED_TIMEOUT_MS).catch(() => {});
      }
      const messages = await bridge.getMessages(page).catch(() => []);
      const lastMessage = bridge.lastAssistantContent(messages);
      await close();
      logger.warn("agent_error", {
        error: status.lastError,
        commandExecutions: status.commandExecutions,
        ticks,
      });
      return { kind: "error", status, error: status.lastError, lastMessage };
    }

    if (lastStreaming !== status.isStreaming) {
      lastStreaming = status.isStreaming;
      if (status.isStreaming) await onProgress("Agent is thinking…");
    }
    if (status.commandExecutions > lastCommandCount) {
      const delta = status.commandExecutions - lastCommandCount;
      lastCommandCount = status.commandExecutions;
      idleCount = 0;
      await onProgress(
        `Applied ${status.commandExecutions} command${status.commandExecutions === 1 ? "" : "s"} (+${delta})`,
      );
    }

    if (status.messageCount > lastMessageCount) {
      lastMessageCount = status.messageCount;
      idleCount = 0;
    }

    if (status.hasInterrupt) {
      // Never blind-approve request_upgrade: "approve" can't satisfy a paywall.
      if (autoApprove && status.interruptType !== "request_upgrade") {
        await bridge.resumeInterrupt(page, "approve");
        idleCount = 0;
        await onProgress(`Auto-approved ${status.interruptType ?? "interrupt"}`);
        logger.debug("interrupt_auto_approved", {
          interruptType: status.interruptType,
        });
        continue;
      }
      const messages = await bridge.getMessages(page);
      const lastMessage = bridge.lastAssistantContent(messages);
      await close();
      logger.info("interrupt_rejected_no_resume", {
        interruptType: status.interruptType,
      });
      return { kind: "interrupt", status, lastMessage };
    }

    // Deterministic path (bridge v2): the editor tells us the run ended.
    if (status.lastRunStatus !== undefined) {
      const terminal = terminalRunState(status, runIdFloor);
      if (terminal === "error" || terminal === "cancelled") {
        if (status.commandExecutions > 0) {
          await bridge.flushSave(page, ENSURE_SAVED_TIMEOUT_MS).catch(() => {});
        }
        const messages = await bridge.getMessages(page).catch(() => []);
        const lastMessage = bridge.lastAssistantContent(messages);
        await close();
        logger.warn("agent_run_terminal", { runStatus: terminal, ticks });
        return {
          kind: "error",
          status,
          error: status.lastError ?? `Agent run ${terminal}`,
          lastMessage,
        };
      }
      if (terminal === "completed") {
        return await finishCompleted(status, "deterministic");
      }
      // Run still in flight — no idle-heuristic bookkeeping needed.
      continue;
    }

    // Legacy heuristic (old editor builds without lastRunStatus): declare
    // completion after IDLE_CONFIRMATIONS consecutive quiet ticks.
    if (!status.isStreaming && !status.isSyncing && status.messageCount > 1) {
      idleCount++;
    } else {
      idleCount = 0;
    }

    if (idleCount >= IDLE_CONFIRMATIONS) {
      const finalStatus = await bridge.getStatus(page);
      if (finalStatus?.isStreaming || finalStatus?.hasInterrupt || finalStatus?.isSyncing) {
        idleCount = 0;
        continue;
      }
      return await finishCompleted(finalStatus ?? status, "idle_heuristic");
    }
  }

  await saveBeforeCut();
  const messages = await bridge.getMessages(page);
  const lastMessage = bridge.lastAssistantContent(messages);
  await close();
  logger.warn("timeout", { maxWaitMs, ticks });
  return { kind: "timeout", lastMessage };
}
