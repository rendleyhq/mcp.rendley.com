import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { log } from "@/logger";
import type { BridgeMotionClipResource } from "@/types/bridge.types";

const PREFLIGHT_TIMEOUT_MS = 15_000;

// 1×1 png data URI — stand-in for every declared image resource. Preflight only
// cares that the script runs, not what it looks like.
const STUB_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// Runs in a SEPARATE bun process with a scrubbed env (authored code must not
// see server state). Mirrors how the editor executes the script: a sloppy-mode
// classic worker — hence the indirect eval into the global scope, self/
// postMessage shims, and the same INIT/SET_PROPERTY/UPDATE message protocol.
// Browser-only APIs the code rules forbid are stubbed to throw, and
// OffscreenCanvas measureText is approximated so fitFontSize-style helpers work.
const HARNESS = String.raw`
const fs = require("node:fs");
const scriptPath = process.argv[2];
const resources = JSON.parse(process.argv[3] || "{}");
const duration = Number(process.argv[4] || "5");

function fail(stage, message) {
  console.error(JSON.stringify({ stage, message: String(message).slice(0, 2000) }));
  process.exit(1);
}

const messages = [];
globalThis.self = globalThis;
globalThis.postMessage = (msg) => {
  messages.push(msg);
};
globalThis.fetch = () => {
  throw new Error("network access (fetch) is forbidden in motion clips — inline everything");
};
globalThis.XMLHttpRequest = function () {
  throw new Error("network access (XMLHttpRequest) is forbidden in motion clips");
};
globalThis.importScripts = () => {
  throw new Error("importScripts is forbidden in motion clips");
};
globalThis.OffscreenCanvas = class {
  getContext() {
    return {
      font: "16px sans-serif",
      measureText(text) {
        const size = Number((String(this.font).match(/(\d+(?:\.\d+)?)px/) || [])[1] || 16);
        return { width: String(text).length * size * 0.6 };
      },
    };
  }
};

let script;
try {
  script = fs.readFileSync(scriptPath, "utf8");
} catch (err) {
  fail("read", err);
}

try {
  (0, eval)(script);
} catch (err) {
  fail("load", "the script failed to load (top-level error): " + (err && err.message ? err.message : err));
}

if (typeof self.onmessage !== "function") {
  fail("load", "the script did not install a message handler — worker footer missing or overwritten");
}

function takeError() {
  const err = messages.find((m) => m && m.type === "error");
  if (!err) return null;
  const payload = err.payload;
  return (payload && payload.message) || (typeof payload === "string" ? payload : JSON.stringify(payload));
}

let nextId = 0;
function dispatch(sendType, payload, expectType, what) {
  messages.length = 0;
  const id = ++nextId;
  try {
    self.onmessage({ data: { id, type: sendType, payload } });
  } catch (err) {
    fail(sendType, what + " threw: " + (err && err.message ? err.message : err));
  }
  const workerError = takeError();
  if (workerError) {
    fail(sendType, what + " reported an error: " + workerError);
  }
  if (!expectType) return null;
  const reply = messages.find((m) => m && m.type === expectType && m.id === id);
  if (!reply) {
    fail(sendType, what + " produced no " + expectType + " message");
  }
  return reply;
}

const init = dispatch(
  "init",
  { width: 1080, height: 1080, properties: {}, resources },
  "response",
  "INIT",
);
if (!Array.isArray(init.payload)) {
  fail("init", "INIT must respond with the propertyDefines array (got " + typeof init.payload + ")");
}

// Exercise setProperty with each property's own default — a crash here means
// the editor's property panel would break the clip.
for (const prop of init.payload) {
  if (!prop || typeof prop.name !== "string" || prop.defaultValue === undefined) continue;
  dispatch("set-property", { name: prop.name, value: prop.defaultValue }, null, 'setProperty("' + prop.name + '")');
}

const times = Array.from(new Set([0, duration / 2, Math.max(0, duration - 0.05)]));
for (const time of times) {
  const label = "UPDATE(t=" + time.toFixed(2) + "s)";
  const drawMsg = dispatch("update", { time }, "draw", label);
  const svg = typeof drawMsg.payload === "string" ? drawMsg.payload : drawMsg.payload && drawMsg.payload.svg;
  if (typeof svg !== "string" || !svg.startsWith("data:image/svg+xml")) {
    fail("draw", label + ": draw() must return a data:image/svg+xml data URI (use svgStringToBase64)");
  }
  let markup = "";
  try {
    const comma = svg.indexOf(",");
    const body = svg.slice(comma + 1);
    markup = /;base64/i.test(svg.slice(0, comma)) ? atob(body) : decodeURIComponent(body);
  } catch (err) {
    fail("draw", label + ": the data URI does not decode: " + err);
  }
  if (!markup.includes("<svg")) {
    fail("draw", label + ": decoded output has no <svg> root element");
  }
}

console.log("ok");
process.exit(0);
`;

function buildStubResources(resources?: BridgeMotionClipResource[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const resource of resources ?? []) {
    if (resource.type === "font") {
      out[resource.id] = {
        url: "",
        width: 0,
        height: 0,
        mimeType: "",
        type: "font",
        fit: "cover",
        offsetX: 50,
        offsetY: 50,
        family: resource.family ?? "",
        css: resource.css ?? "",
      };
      continue;
    }
    out[resource.id] = {
      url: STUB_PNG,
      width: 8,
      height: 8,
      mimeType: "image/png",
      type: "image",
      fit: resource.fit ?? "cover",
      offsetX: resource.offsetX ?? 50,
      offsetY: resource.offsetY ?? 50,
    };
  }
  return out;
}

export interface PreflightInput {
  // The full assembled worker script (header + userCode + footer).
  script: string;
  resources?: BridgeMotionClipResource[];
  duration?: number;
}

// Executes the assembled worker script the way the editor's MotionClip worker
// does, BEFORE any job/browser: catches syntax errors, guideline violations
// (forbidden APIs), crashes in setProperties/setProperty/draw, wrong draw
// output, and infinite loops. Returns an actionable error message, or null when
// the script passes.
export async function preflightMotionScript(input: PreflightInput): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "rendley-motion-preflight-"));
  try {
    const scriptPath = join(dir, "script.js");
    const harnessPath = join(dir, "harness.js");
    await Promise.all([
      writeFile(scriptPath, input.script, "utf8"),
      writeFile(harnessPath, HARNESS, "utf8"),
    ]);

    const proc = Bun.spawn(
      [
        process.execPath,
        harnessPath,
        scriptPath,
        JSON.stringify(buildStubResources(input.resources)),
        String(input.duration ?? 5),
      ],
      { env: {}, stdout: "pipe", stderr: "pipe" },
    );

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, PREFLIGHT_TIMEOUT_MS);
    const exitCode = await proc.exited;
    clearTimeout(timer);

    if (timedOut) {
      return `The script hung during preflight (likely an infinite loop or unbounded work in draw/setProperties) and was killed after ${PREFLIGHT_TIMEOUT_MS / 1000}s. Simplify the userCode and resubmit.`;
    }
    if (exitCode === 0) {
      return null;
    }

    const stderr = await new Response(proc.stderr).text();
    let detail = stderr.trim();
    try {
      const parsed = JSON.parse(detail.split("\n").pop() ?? "") as { stage?: string; message?: string };
      if (parsed.message) {
        detail = `[${parsed.stage ?? "run"}] ${parsed.message}`;
      }
    } catch {
      // non-JSON stderr (e.g. a bun-level crash) — pass it through as-is
    }
    return `The script failed preflight — it was executed exactly as the editor's worker runs it. ${detail || "unknown error"}. Fix the userCode per get_motion_graphics_guide and resubmit.`;
  } catch (err) {
    // Preflight infrastructure trouble must not block authoring — the editor-side
    // broken-clip checks still guard the actual apply.
    log.warn("motion_preflight_unavailable", { err });
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
