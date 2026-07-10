// Shutdown order must hold: stop HTTP, then drain in-flight jobs.
import { jobQueue } from "@/queue";
import { failInterruptedJobs } from "@/jobs/index";
import { shutdownAnalytics } from "@/analytics";
import { log } from "@/logger";

interface ClosableServer {
  stop(closeActiveConnections?: boolean): Promise<void>;
}

interface ShutdownDeps {
  server: ClosableServer;
}

let shuttingDown = false;
const SERVER_CLOSE_TIMEOUT_MS = 5000;
const QUEUE_DRAIN_TIMEOUT_MS = 10_000;

export function installShutdownHandlers(deps: ShutdownDeps): void {
  const run = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    gracefulShutdown(signal, deps).then(
      () => process.exit(0),
      (err) => {
        log.error("shutdown_error", { err });
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => run("SIGTERM"));
  process.on("SIGINT", () => run("SIGINT"));
}

async function gracefulShutdown(
  signal: string,
  { server }: ShutdownDeps,
): Promise<void> {
  log.info("shutdown_start", { signal });

  await closeServer(server);

  await Promise.race([
    jobQueue.onIdle(),
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        log.warn("queue_drain_timeout", { timeoutMs: QUEUE_DRAIN_TIMEOUT_MS });
        resolve();
      }, QUEUE_DRAIN_TIMEOUT_MS);
      t.unref?.();
    }),
  ]);

  // Anything still non-terminal after the drain window won't finish — mark it
  // failed so pollers get a clean, retryable terminal state instead of a job
  // stuck "running" until the orphan window (or a 404 with the in-memory store).
  try {
    const failed = await failInterruptedJobs();
    if (failed > 0) log.warn("shutdown_failed_interrupted_jobs", { count: failed });
  } catch (err) {
    log.error("shutdown_fail_jobs_error", { err });
  }

  // Flush any buffered product-analytics events before the process exits.
  await shutdownAnalytics();

  log.info("shutdown_complete");
}

async function closeServer(server: ClosableServer): Promise<void> {
  try {
    await withTimeout(server.stop(), SERVER_CLOSE_TIMEOUT_MS, "server_stop_timeout");
  } catch (err) {
    log.warn("server_stop_timeout", { timeoutMs: SERVER_CLOSE_TIMEOUT_MS, err });
    try {
      await server.stop(true);
    } catch (forceErr) {
      log.warn("server_force_stop_failed", { err: forceErr });
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(code)), timeoutMs);
        timeoutId.unref?.();
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
