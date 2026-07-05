import { config } from "@/config";
import { log } from "@/logger";
import { AgentBrowser, type RunAgentInput, type AgentProgress } from "@/sdk/agent-browser";
import type { PollOutcome } from "@/types/agent.types";

export class RemoteBrowserError extends Error {
  constructor(
    public code: string,
    message: string,
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
  | {
      type: "result";
      outcome: PollOutcome;
      // Session-reuse observability from newer worker builds.
      meta?: { reusedSession?: boolean; held?: boolean; sessionRunCount?: number };
    }
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

    let attempt = 0;
    for (;;) {
      try {
        return await this.runOnce(input, onProgress, combined);
      } catch (err) {
        if (
          err instanceof BrowserBusyError &&
          attempt < config.maxBrowserBusyRetries &&
          !combined.aborted
        ) {
          attempt += 1;
          const waitSec = Math.min(err.retryAfterSeconds || 5, 15);
          log.warn("remote_agent_browser_busy_retry", {
            attempt,
            waitSeconds: waitSec,
          });
          await sleep(waitSec * 1000, combined);
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
        signal,
      });
    } catch (err) {
      if (signal.aborted) {
        throw this.abortError(signal);
      }
      throw new RemoteBrowserError(
        "WORKER_UNREACHABLE",
        `could not reach browser worker: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        if (body.error?.message) detail = `${body.error.code ?? res.status}: ${body.error.message}`;
      } catch {
      }
      throw new RemoteBrowserError("WORKER_HTTP_ERROR", `browser worker error ${detail}`);
    }

    if (!res.body) {
      throw new RemoteBrowserError("EMPTY_STREAM", "browser worker returned no body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let outcome: PollOutcome | null = null;

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
          await onProgress(evt.message);
          break;
        case "ping":
          break;
        case "result":
          outcome = evt.outcome;
          if (evt.meta) {
            log.info("remote_agent_session_meta", {
              projectId: input.projectId,
              ...evt.meta,
            });
          }
          break;
        case "error":
          if (evt.code === "BROWSER_BUSY") {
            throw new BrowserBusyError(evt.message, evt.retryAfterSeconds);
          }
          throw new RemoteBrowserError(evt.code, evt.message);
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
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
      throw err;
    } finally {
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
