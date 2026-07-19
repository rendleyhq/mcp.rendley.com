export class UrlGuardError extends Error {
  constructor(
    public code: "invalid_url" | "unsupported_protocol",
    message: string,
  ) {
    super(message);
    this.name = "UrlGuardError";
  }
}

export function validateExternalUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UrlGuardError("invalid_url", "URL is malformed");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlGuardError(
      "unsupported_protocol",
      `protocol ${url.protocol} is not supported`,
    );
  }

  return url;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain"];

function isBlockedIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return isBlockedOctets(octets as [number, number, number, number]);
}

function isBlockedOctets([a, b]: [number, number, number, number]): boolean {
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

// WHATWG URL rewrites `[::ffff:10.0.0.1]` to the hex form `[::ffff:a00:1]`, so
// both spellings have to decode back to octets and take the IPv4 verdict.
function mappedIpv4Octets(host: string): [number, number, number, number] | null {
  const match = /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!match) return null;
  const hi = Number.parseInt(match[1]!, 16);
  const lo = Number.parseInt(match[2]!, 16);
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function isBlockedIpv6(host: string): boolean {
  if (host === "::" || host === "::1") return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  const mapped = mappedIpv4Octets(host);
  if (mapped) return isBlockedOctets(mapped);
  return false;
}

// Address-literal checks only — a hostname that resolves to a private address is
// not caught here. DNS rebinding is out of scope.
export function validateWebhookUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UrlGuardError("invalid_url", "URL is malformed");
  }

  if (url.protocol !== "https:") {
    throw new UrlGuardError(
      "unsupported_protocol",
      "webhook_url must use https",
    );
  }

  // A single trailing dot is the same name to a resolver but slips past a plain
  // suffix match, so strip it before every check below.
  const host = url.hostname.toLowerCase().replace(/\.$/, "");

  if (host.startsWith("[") && host.endsWith("]")) {
    if (isBlockedIpv6(host.slice(1, -1))) {
      throw new UrlGuardError("invalid_url", "webhook_url host is not routable");
    }
    return url;
  }

  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UrlGuardError("invalid_url", "webhook_url host is not routable");
  }

  if (isBlockedIpv4(host)) {
    throw new UrlGuardError("invalid_url", "webhook_url host is not routable");
  }

  return url;
}

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  headers?: Record<string, string>;
}

export interface SafeFetchResult {
  body: Buffer;
  contentType: string;
  size: number;
}

// Stream cap enforced while reading: a hostile server can't OOM us by lying about Content-Length.
export async function safeFetchMedia(
  rawUrl: string,
  opts: SafeFetchOptions,
): Promise<SafeFetchResult> {
  validateExternalUrl(rawUrl);

  const res = await fetch(rawUrl, {
    headers: opts.headers,
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`fetch_failed:${res.status}`);
  }

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > opts.maxBytes) {
    throw new Error(`payload_too_large:${declared}`);
  }

  if (!res.body) throw new Error("empty_body");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new Error(`payload_too_large:${total}+`);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  const body = Buffer.concat(
    chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)),
  );
  return {
    body,
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
    size: total,
  };
}
