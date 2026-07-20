import pino from "pino";
import pretty from "pino-pretty";
import { logs, SeverityNumber, type AnyValue } from "@opentelemetry/api-logs";
import { getRequestContext } from "@/request-context";

const MAX_FIELD_CHARS = 1000;

const SENSITIVE_QUERY_PARAMS = new Set([
  "auth_token",
  "session_token",
  "access_token",
  "token",
  "bearer",
]);

export function scrubUrls(s: string): string {
  if (!s.includes("?")) return s;
  return s.replace(/https?:\/\/[^\s"'<>]+/g, (match) => {
    try {
      const url = new URL(match);
      let changed = false;
      for (const key of url.searchParams.keys()) {
        if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
          url.searchParams.set(key, "[redacted]");
          changed = true;
        }
      }
      return changed ? url.toString() : match;
    } catch {
      return match;
    }
  });
}

function truncateString(s: string): string {
  const scrubbed = scrubUrls(s);
  if (scrubbed.length <= MAX_FIELD_CHARS) return scrubbed;
  return scrubbed.slice(0, MAX_FIELD_CHARS) + `…[${scrubbed.length - MAX_FIELD_CHARS} more chars]`;
}

// Redact secret values at any nesting depth (pino's `redact` only matches fixed paths).
const SENSITIVE_KEYS = new Set([
  "authorization",
  "auth_token",
  "authtoken",
  "session_token",
  "sessiontoken",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "token",
  "bearer",
  "apikey",
  "api_key",
  "password",
  "secret",
  "x-api-key",
]);

function truncateDeep(value: unknown): unknown {
  if (typeof value === "string") return truncateString(value);
  if (value instanceof Error) {
    return {
      message: truncateString(value.message),
      stack: value.stack ? truncateString(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map(truncateDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase())
        ? "[redacted]"
        : truncateDeep(v);
    }
    return out;
  }
  return value;
}

const usePretty = process.env.LOG_PRETTY === "true";
const useOtel = process.env.LOGS_ENABLED === "true" && Boolean(process.env.POSTHOG_API_KEY);

const OTEL_SEVERITY: Record<string, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

// Direct pino -> OTEL bridge; @opentelemetry/instrumentation-pino doesn't hook bun's ESM imports.
function createOtelLogStream(): { write(line: string): void } {
  const otelLogger = logs.getLogger("mcp");
  return {
    write(line: string) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        return;
      }
      const { event, level, ts, pid, hostname, ...attributes } = record as {
        event?: string;
        level?: string;
        ts?: string;
      } & Record<string, unknown>;
      void pid;
      void hostname;
      otelLogger.emit({
        timestamp: typeof ts === "string" ? new Date(ts) : undefined,
        severityText: typeof level === "string" ? level.toUpperCase() : undefined,
        severityNumber: OTEL_SEVERITY[String(level)] ?? SeverityNumber.INFO,
        body: typeof event === "string" ? event : line,
        attributes: attributes as unknown as Record<string, AnyValue>,
      });
    },
  };
}

const options: pino.LoggerOptions = {
  level: (process.env.LOG_LEVEL ?? "info").toLowerCase(),
  messageKey: "event",
  timestamp: () => `,"ts":"${new Date().toISOString()}"`,
  // Stamp request_id / user_id (from AsyncLocalStorage) onto every line so logs
  // from anywhere in a request correlate and link to the person (user_id).
  mixin() {
    const ctx = getRequestContext();
    if (!ctx) {
      return {};
    }
    return {
      request_id: ctx.request_id,
      ...(ctx.user_id ? { user_id: ctx.user_id } : {}),
    };
  },
  formatters: {
    level(label) {
      return { level: label };
    },
    log(obj) {
      return truncateDeep(obj) as Record<string, unknown>;
    },
  },
  redact: {
    paths: [
      "headers.authorization",
      'headers["x-api-key"]',
      "*.headers.authorization",
      '*.headers["x-api-key"]',
      "apiKey",
      "api_key",
      "password",
      "secret",
      "token",
      "auth_token",
      "authToken",
      "session_token",
      "sessionToken",
      "access_token",
      "accessToken",
    ],
    censor: "[redacted]",
    remove: false,
  },
};

// Sync stream, not a pino `transport`: transports use worker threads, unreliable under bun.
const consoleStream = usePretty
  ? pretty({
      colorize: true,
      translateTime: "SYS:HH:MM:ss.l",
      messageKey: "event",
      timestampKey: "ts",
      ignore: "pid,hostname",
    })
  : process.stdout;

const destination = useOtel
  ? pino.multistream([
      { stream: consoleStream },
      { stream: createOtelLogStream() },
    ])
  : consoleStream;

const baseLogger = pino(options, destination);

export interface Logger {
  debug(event: string, ctx?: Record<string, unknown>): void;
  info(event: string, ctx?: Record<string, unknown>): void;
  warn(event: string, ctx?: Record<string, unknown>): void;
  error(event: string, ctx?: Record<string, unknown>): void;
  child(ctx: Record<string, unknown>): Logger;
}

function wrap(inner: pino.Logger): Logger {
  return {
    debug: (event, ctx) => inner.debug(ctx ?? {}, event),
    info: (event, ctx) => inner.info(ctx ?? {}, event),
    warn: (event, ctx) => inner.warn(ctx ?? {}, event),
    error: (event, ctx) => inner.error(ctx ?? {}, event),
    child: (ctx) => wrap(inner.child(ctx)),
  };
}

export const log: Logger = wrap(baseLogger);
