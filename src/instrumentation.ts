// PostHog Logs pipeline (OTLP/HTTP), preloaded via `bun --preload`. Logs only —
// PostHog ingests no traces or metrics, so the Grafana-era NodeSDK, trace and
// metric exporters are gone. logger.ts bridges every pino line into the global
// logger provider registered here.
import logsAPI from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";

const POSTHOG_LOGS_URL = "https://us.i.posthog.com/i/v1/logs";

let loggerProvider: LoggerProvider | null = null;

if (process.env.LOGS_ENABLED === "true" && process.env.POSTHOG_API_KEY) {
  loggerProvider = new LoggerProvider({
    resource: resourceFromAttributes({
      "service.name": "mcp",
      "deployment.environment.name": process.env.NODE_ENV ?? "production",
      // SERVICE_VERSION (git sha) injected at deploy so a failure spike ties to a
      // release; falls back to "dev" locally.
      "service.version": process.env.SERVICE_VERSION ?? "dev",
    }),
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: POSTHOG_LOGS_URL,
          headers: { Authorization: `Bearer ${process.env.POSTHOG_API_KEY}` },
        }),
      }),
    ],
  });

  logsAPI.logs.setGlobalLoggerProvider(loggerProvider);
}

// Flush pending log batches; called from the graceful-shutdown path. Never throws.
export async function shutdownTelemetry(): Promise<void> {
  if (!loggerProvider) return;
  try {
    await loggerProvider.shutdown();
  } catch {
    // Telemetry teardown must never fail a shutdown.
  }
}
