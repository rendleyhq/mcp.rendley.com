import { config } from "@/config";
import { log } from "@/logger";
import {
  BrowserBusyError,
  RemoteBrowserError,
  paceLaunch,
  sleep,
} from "@/sdk/worker-client";
import type {
  MotionOp,
  MotionOpResult,
  MotionRunOutcome,
  MotionWorkerEvent,
} from "@/types/motion.types";

export interface RemoteMotionSessionInput {
  projectId: string;
  headlessUrl: string;
  save: boolean;
  onOpDone?: (index: number, result: MotionOpResult) => void;
}

// Covers browser admission + editor open + stream teardown on the worker side,
// on top of the per-op budget. Same constant as the remote agent path.
const WORKER_OVERHEAD_MS = 300_000;
const SAVE_BUDGET_MS = 90_000;

// Runs a motion session on the Cloudflare browser worker (POST /v1/motion-run,
// NDJSON stream) — the remote twin of runLocalMotionSession. Same retry
// personality as the remote agent path: BROWSER_BUSY waits and retries,
// transient connect/pre-work failures re-dispatch, and once an op may have
// mutated the project (op_start seen) a stall is terminal, never re-dispatched.
export async function runRemoteMotionSession(
  input: RemoteMotionSessionInput,
  ops: MotionOp[],
): Promise<MotionOpResult[]> {
  if (!config.browserWorkerUrl) {
    throw new RemoteBrowserError(
      "NOT_CONFIGURED",
      "BROWSER_WORKER_URL is not set — the browser worker endpoint is required for motion-graphics tools (or set BROWSER_MODE=local for local dev)",
    );
  }

  const maxWaitMs = ops.length * config.motionOpTimeoutMs + SAVE_BUDGET_MS;
  const deadline = AbortSignal.timeout(maxWaitMs + WORKER_OVERHEAD_MS);

  let busyAttempt = 0;
  let connectAttempt = 0;
  for (;;) {
    try {
      return await runOnce(input, ops, maxWaitMs, deadline);
    } catch (err) {
      if (
        err instanceof BrowserBusyError &&
        busyAttempt < config.maxBrowserBusyRetries &&
        !deadline.aborted
      ) {
        busyAttempt += 1;
        const waitSec = Math.min(err.retryAfterSeconds || 5, 15);
        log.warn("remote_motion_browser_busy_retry", {
          projectId: input.projectId,
          attempt: busyAttempt,
          waitSeconds: waitSec,
        });
        await sleep(waitSec * 1000, deadline);
        continue;
      }
      if (
        err instanceof RemoteBrowserError &&
        err.retryable &&
        connectAttempt < config.maxWorkerConnectRetries &&
        !deadline.aborted
      ) {
        connectAttempt += 1;
        const waitMs = Math.min(1000 * 2 ** (connectAttempt - 1), 5000);
        log.warn("remote_motion_worker_retry", {
          projectId: input.projectId,
          attempt: connectAttempt,
          code: err.code,
          waitMs,
        });
        await sleep(waitMs, deadline);
        continue;
      }
      throw err;
    }
  }
}

async function runOnce(
  input: RemoteMotionSessionInput,
  ops: MotionOp[],
  maxWaitMs: number,
  signal: AbortSignal,
): Promise<MotionOpResult[]> {
  const logger = log.child({ projectId: input.projectId, component: "remoteMotion" });

  // Stall guard: if the worker stops streaming (op events/ping) for longer than
  // the stall window, abort this read instead of hanging until the deadline.
  const stall = new AbortController();
  const streamSignal = AbortSignal.any([signal, stall.signal]);
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => stall.abort(), config.workerStallTimeoutMs);
    stallTimer.unref?.();
  };

  // Every attempt launches a fresh browser on the worker, so every attempt
  // pays the (process-wide, shared with agent runs) pacer.
  await paceLaunch(signal);

  let res: Response;
  try {
    res = await fetch(`${config.browserWorkerUrl}/v1/motion-run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.browserWorkerToken
          ? { authorization: `Bearer ${config.browserWorkerToken}` }
          : {}),
      },
      body: JSON.stringify({
        headlessUrl: input.headlessUrl,
        projectId: input.projectId,
        ops,
        save: input.save,
        maxWaitMs,
      }),
      signal: streamSignal,
    });
  } catch (err) {
    if (signal.aborted) {
      throw abortError(signal);
    }
    throw new RemoteBrowserError(
      "WORKER_UNREACHABLE",
      `could not reach browser worker: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }

  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.message) detail = `${body.error.code ?? res.status}: ${body.error.message}`;
    } catch {
    }
    throw new RemoteBrowserError(
      "WORKER_HTTP_ERROR",
      `browser worker error ${detail}`,
      res.status >= 500,
    );
  }

  if (!res.body) {
    throw new RemoteBrowserError("EMPTY_STREAM", "browser worker returned no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outcome: MotionRunOutcome | null = null;
  // Once op 0 may have mutated the project, a later stall must not re-dispatch
  // (it could double-apply clips). Readiness-phase stalls stay retryable.
  let sawWork = false;

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt: MotionWorkerEvent;
    try {
      evt = JSON.parse(trimmed) as MotionWorkerEvent;
    } catch {
      logger.warn("remote_motion_unparseable_line", { line: trimmed.slice(0, 200) });
      return;
    }
    switch (evt.type) {
      case "progress":
      case "ping":
        break;
      case "op_start":
        sawWork = true;
        break;
      case "op_done":
        sawWork = true;
        logger.info("motion_op_done", {
          index: evt.index,
          ok: evt.result.ok,
          ...(evt.result.error ? { error: evt.result.error } : {}),
        });
        input.onOpDone?.(evt.index, evt.result);
        break;
      case "result":
        sawWork = true;
        outcome = evt.outcome;
        break;
      case "error":
        if (evt.code === "BROWSER_BUSY") {
          throw new BrowserBusyError(evt.message, evt.retryAfterSeconds);
        }
        throw new RemoteBrowserError(evt.code, evt.message);
    }
  };

  armStall();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      armStall(); // any bytes prove the worker is alive
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    }
    buffer += decoder.decode();
    handleLine(buffer);
  } catch (err) {
    if (signal.aborted) {
      throw abortError(signal);
    }
    if (stall.signal.aborted) {
      throw new RemoteBrowserError(
        "WORKER_STALL",
        `browser worker sent no events for ${config.workerStallTimeoutMs}ms`,
        !sawWork,
      );
    }
    throw err;
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    // cancel() tears down the socket; releaseLock alone leaves the connection open.
    await reader.cancel().catch(() => {});
  }

  if (!outcome) {
    throw new RemoteBrowserError(
      "NO_RESULT",
      "browser worker closed the stream without returning a result",
    );
  }

  const settled: MotionRunOutcome = outcome;
  if (input.save && settled.results.some((r) => r.ok) && settled.saved !== "synced") {
    // Same error text and retry policy as the local runner's save failure.
    throw new Error(
      `Motion graphics applied but the save was not confirmed (${settled.saved}). Please retry.`,
    );
  }
  return settled.results;
}

function abortError(signal: AbortSignal): RemoteBrowserError {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason instanceof DOMException && reason.name === "TimeoutError") {
    return new RemoteBrowserError(
      "TIMEOUT",
      "browser worker exceeded the overall run deadline",
    );
  }
  return new RemoteBrowserError("ABORTED", "run aborted before it completed");
}
