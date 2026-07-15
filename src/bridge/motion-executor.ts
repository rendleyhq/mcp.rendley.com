import type { Page } from "playwright";

import { bridge } from "@/bridge/index";
import type { BridgeMotionGraphicResult } from "@/types/bridge.types";
import type { MotionFrameCapture, MotionOp, MotionOpResult } from "@/types/motion.types";

// Interprets one serializable MotionOp against the live headless editor.
// This is the LOCAL twin of executeMotionOp in the browser worker
// (rendley-agent-browser-cloudflare src/motion-run.ts) — keep them in sync.

export const MISSING_MOTION_API_SENTINEL = "__MISSING_MOTION_API__";

const FRAME_QUALITY = 0.6;
// A 960x540 JPEG this small is near-uniform — almost certainly nothing drawn.
const BLANK_JPEG_BASE64_LENGTH = 6000;

function stripDataUriPrefix(dataUri: string): string {
  const comma = dataUri.indexOf(",");
  return dataUri.startsWith("data:") && comma >= 0 ? dataUri.slice(comma + 1) : dataUri;
}

// Capture start/mid/end frames of the clip so the authoring LLM can SEE what
// it produced. Best-effort: capture problems never fail the op.
export async function captureClipFrames(
  page: Page,
  clipId: string,
): Promise<MotionFrameCapture[] | undefined> {
  try {
    const info = await bridge.getMotionGraphic(page, clipId);
    if (!info || info === "__MISSING__" || !(info.duration > 0)) {
      return undefined;
    }
    const times = [0.1, 0.5, 0.9].map((f) => info.startTime + info.duration * f);
    const frames: MotionFrameCapture[] = [];
    for (const time of times) {
      const dataUri = await bridge.captureFrame(page, time, FRAME_QUALITY);
      if (!dataUri) {
        return undefined;
      }
      const jpegBase64 = stripDataUriPrefix(dataUri);
      frames.push({
        time,
        jpegBase64,
        ...(jpegBase64.length < BLANK_JPEG_BASE64_LENGTH ? { blank: true } : {}),
      });
    }
    return frames;
  } catch {
    return undefined;
  }
}

async function withFrames(page: Page, result: MotionOpResult): Promise<MotionOpResult> {
  if (!result.ok || !result.clipId) {
    return result;
  }
  const frames = await captureClipFrames(page, result.clipId);
  return frames ? { ...result, frames } : result;
}

export async function executeMotionOp(page: Page, op: MotionOp): Promise<MotionOpResult> {
  switch (op.kind) {
    case "create": {
      const result = await bridge.addMotionGraphic(page, {
        script: op.script,
        duration: op.duration,
        width: op.width,
        height: op.height,
        startTime: op.startTime,
        layerId: op.layerId,
        name: op.name,
        resources: op.resources,
        skipSave: true,
      });
      return withFrames(page, result);
    }
    case "update": {
      if (op.script) {
        const r = await bridge.updateMotionGraphicScript(page, op.clipId, {
          script: op.script,
          resources: op.resources,
          skipSave: true,
        });
        if (r.error === MISSING_MOTION_API_SENTINEL || !r.ok) {
          return r;
        }
      }
      const failed: string[] = [];
      for (const { name, value } of op.properties ?? []) {
        const r = await bridge.setMotionGraphicProperty(page, op.clipId, name, value, true);
        if (r.error === MISSING_MOTION_API_SENTINEL) {
          return r as BridgeMotionGraphicResult;
        }
        if (!r.ok) {
          failed.push(`${name}: ${r.error ?? "failed"}`);
        }
      }
      if (failed.length) {
        return { ok: false, error: `Some properties could not be set: ${failed.join("; ")}` };
      }
      return withFrames(page, { ok: true, clipId: op.clipId });
    }
    case "set_property": {
      return bridge.setMotionGraphicProperty(page, op.clipId, op.property, op.value, true);
    }
    case "set_keyframes": {
      const r = await bridge.setMotionGraphicKeyframes(
        page,
        op.clipId,
        op.property,
        op.keyframes,
        op.reset,
        true,
      );
      return withFrames(page, { ...r, clipId: op.clipId });
    }
    case "get": {
      const info = await bridge.getMotionGraphic(page, op.clipId);
      if (info === "__MISSING__") {
        return { ok: false, error: MISSING_MOTION_API_SENTINEL };
      }
      return { ok: true, clipId: op.clipId, clip: info };
    }
    case "list": {
      const clips = await bridge.listMotionGraphics(page);
      if (clips === "__MISSING__") {
        return { ok: false, error: MISSING_MOTION_API_SENTINEL };
      }
      return { ok: true, clips };
    }
  }
}
