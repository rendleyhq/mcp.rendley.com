import { config } from "@/config";
import { log } from "@/logger";
import { AgentBrowser, type RunAgentInput, type AgentProgress } from "@/sdk/agent-browser";
import type { PollOutcome } from "@/types/agent.types";

export class RemoteBrowserError extends Error {
  constructor(
    public code: string,
    message: string,
    // Safe to re-dispatch only when no edit has started yet (connect failure,
    // 5xx, or a stall before any progress). Mid-run failures must not retry —
    // the worker may have partially applied the edit.
    public retryable = false,
  ) {
    super(message);
    this.name = "RemoteBrowserError";
  }
}

export class BrowserBusyError extends RemoteBrowserError {
  constructor(
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super("BROWSER_BUSY", message);
    this.name = "BrowserBusyError";
  }
}

type WorkerEvent =
  | { type: "progress"; message: string }
  | { type: "ping" }
  | { type: "result"; outcome: PollOutcome }
  | { type: "error"; code: string; message: string; retryAfterSeconds?: number };

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RemoteBrowserError("ABORTED", "run aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RemoteBrowserError("ABORTED", "run aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

// Launch pacer: space launch attempts to Cloudflare's account-wide admission
// rate so a burst of simultaneous edits queues here (bounded by each run's
// overall deadline) instead of failing with BROWSER_BUSY.
let nextLaunchAt = 0;
async function paceLaunch(signal: AbortSignal): Promise<void> {
  const interval = config.browserLaunchIntervalMs;
  if (interval <= 0) return;
  const now = Date.now();
  const waitMs = Math.max(0, nextLaunchAt - now);
  nextLaunchAt = Math.max(now, nextLaunchAt) + interval;
  if (waitMs > 0) await sleep(waitMs, signal);
}

export class RemoteAgentBrowser extends AgentBrowser {
  async runAgent(
    input: RunAgentInput,
    onProgress: AgentProgress,
    signal?: AbortSignal,
  ): Promise<PollOutcome> {
    if (!config.browserWorkerUrl) {
      throw new RemoteBrowserError(
        "NOT_CONFIGURED",
        "BROWSER_WORKER_URL is not set — the browser worker endpoint is required to run edit_video (or set BROWSER_MODE=local for local dev)",
      );
    }

    const WORKER_OVERHEAD_MS = 300_000;
    const deadline = AbortSignal.timeout(
      (input.maxWaitMs ?? config.agentTimeoutMs) + WORKER_OVERHEAD_MS,
    );
    const combined = signal
      ? AbortSignal.any([signal, deadline])
      : deadline;

    let busyAttempt = 0;
    let connectAttempt = 0;
    for (;;) {
      try {
        return await this.runOnce(input, onProgress, combined);
      } catch (err) {
        if (
          err instanceof BrowserBusyError &&
          busyAttempt < config.maxBrowserBusyRetries &&
          !combined.aborted
        ) {
          busyAttempt += 1;
          const waitSec = Math.min(err.retryAfterSeconds || 5, 15);
          log.warn("remote_agent_browser_busy_retry", {
            attempt: busyAttempt,
            waitSeconds: waitSec,
          });
          await sleep(waitSec * 1000, combined);
          continue;
        }
        // Transient connect/pre-stream failures (worker cold start, 5xx,
        // unreachable, stall before any progress) re-dispatch a fresh run.
        if (
          err instanceof RemoteBrowserError &&
          err.retryable &&
          connectAttempt < config.maxWorkerConnectRetries &&
          !combined.aborted
        ) {
          connectAttempt += 1;
          const waitMs = Math.min(1000 * 2 ** (connectAttempt - 1), 5000);
          log.warn("remote_agent_worker_retry", {
            attempt: connectAttempt,
            code: err.code,
            waitMs,
          });
          await sleep(waitMs, combined);
          continue;
        }
        throw err;
      }
    }
  }

  private async runOnce(
    input: RunAgentInput,
    onProgress: AgentProgress,
    signal: AbortSignal,
  ): Promise<PollOutcome> {
    // Stall guard: if the worker stops streaming (progress/result/ping) for
    // longer than the stall window, abort this read instead of hanging until the
    // overall run deadline. Wired into the fetch signal so it tears the socket.
    const stall = new AbortController();
    const streamSignal = AbortSignal.any([signal, stall.signal]);
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stall.abort(), config.workerStallTimeoutMs);
      stallTimer.unref?.();
    };

    // Every attempt (first dispatch and retries) launches a fresh browser on
    // the worker, so every attempt pays the pacer.
    await paceLaunch(signal);

    let res: Response;
    try {
      res = await fetch(`${config.browserWorkerUrl}/v1/agent-run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.browserWorkerToken
            ? { authorization: `Bearer ${config.browserWorkerToken}` }
            : {}),
        },
        body: JSON.stringify(input),
        signal: streamSignal,
      });
    } catch (err) {
      if (signal.aborted) {
        throw this.abortError(signal);
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
      // 5xx is a transient worker fault (cold start, deploy) — safe to retry
      // since no run has started; 4xx is our request's fault and won't improve.
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
    let outcome: PollOutcome | null = null;
    // Once the worker emits progress or a result, an edit is in flight — a later
    // stall must not re-dispatch (it would double-apply).
    let sawWork = false;

    const handleLine = async (line: string): Promise<void> => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let evt: WorkerEvent;
      try {
        evt = JSON.parse(trimmed) as WorkerEvent;
      } catch {
        log.warn("remote_agent_unparseable_line", { line: trimmed.slice(0, 200) });
        return;
      }
      switch (evt.type) {
        case "progress":
          sawWork = true;
          await onProgress(evt.message);
          break;
        case "ping":
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
          await handleLine(line);
        }
      }
      buffer += decoder.decode();
      await handleLine(buffer);
    } catch (err) {
      if (signal.aborted) {
        throw this.abortError(signal);
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
    return outcome;
  }

  private abortError(signal: AbortSignal): RemoteBrowserError {
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    if (reason instanceof DOMException && reason.name === "TimeoutError") {
      return new RemoteBrowserError(
        "TIMEOUT",
        "browser worker exceeded the overall run deadline",
      );
    }
    return new RemoteBrowserError("ABORTED", "run aborted before it completed");
  }
}
