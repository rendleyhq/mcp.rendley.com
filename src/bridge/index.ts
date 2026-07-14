import type { Page } from "playwright";
import type {
  BridgeAddMotionGraphicOptions,
  BridgeAttachment,
  BridgeMessage,
  BridgeMotionClipResource,
  BridgeMotionGraphicInfo,
  BridgeMotionGraphicResult,
  BridgeMotionGraphicSummary,
  BridgeMotionKeyframe,
  BridgeOpResult,
  BridgeStatus,
  FlushSaveResult,
} from "@/types/bridge.types";

export type {
  BridgeAttachment,
  BridgeMessage,
  BridgeStatus,
  FlushSaveResult,
};

const MISSING_MOTION_API_ERROR =
  "This editor build does not expose the motion-graphics bridge API. The app must be deployed with the motion-graphics headless bridge methods.";

export const bridge = {
  async getStatus(page: Page): Promise<BridgeStatus | null> {
    return (await page.evaluate(() => window.__rendleyAgent?.getStatus() ?? null)) as
      | BridgeStatus
      | null;
  },

  async getMessages(page: Page): Promise<BridgeMessage[]> {
    return (await page.evaluate(
      () => window.__rendleyAgent?.getMessages() ?? [],
    )) as BridgeMessage[];
  },

  async sendMessage(
    page: Page,
    message: string,
    attachments?: BridgeAttachment[],
  ): Promise<void> {
    await page.evaluate(
      async ({ msg, atts }) => {
        await window.__rendleyAgent?.sendMessage(msg, atts);
      },
      { msg: message, atts: attachments },
    );
  },

  async resumeInterrupt(page: Page, response: "approve" | "reject"): Promise<void> {
    await page.evaluate(async (res) => {
      await window.__rendleyAgent?.resumeInterrupt(res);
    }, response);
  },

  async ensureSaved(page: Page, timeoutMs = 60000): Promise<FlushSaveResult> {
    return (await page.evaluate(
      async (ms) =>
        (await window.__rendleyAgent?.ensureSaved(ms)) ?? { status: "error" as const },
      timeoutMs,
    )) as FlushSaveResult;
  },

  // Prefers the deterministic saveNow (bridge v2, awaits the actual PATCH) and
  // falls back to the event + sync-poll ensureSaved on older editor builds.
  async flushSave(page: Page, timeoutMs = 60000): Promise<FlushSaveResult> {
    return (await page.evaluate(async (ms) => {
      const agent = window.__rendleyAgent;
      if (!agent) return { status: "error" as const };
      if (typeof agent.saveNow === "function") return await agent.saveNow(ms);
      return await agent.ensureSaved(ms);
    }, timeoutMs)) as FlushSaveResult;
  },

  async addMotionGraphic(
    page: Page,
    options: BridgeAddMotionGraphicOptions,
  ): Promise<BridgeMotionGraphicResult> {
    return (await page.evaluate(async (opts) => {
      const agent = window.__rendleyAgent;
      if (!agent?.addMotionGraphic) return { ok: false, error: "__MISSING_MOTION_API__" };
      return await agent.addMotionGraphic(opts);
    }, options)) as BridgeMotionGraphicResult;
  },

  async updateMotionGraphicScript(
    page: Page,
    clipId: string,
    options: { script: string; resources?: BridgeMotionClipResource[] },
  ): Promise<BridgeMotionGraphicResult> {
    return (await page.evaluate(
      async ({ id, opts }) => {
        const agent = window.__rendleyAgent;
        if (!agent?.updateMotionGraphicScript) return { ok: false, error: "__MISSING_MOTION_API__" };
        return await agent.updateMotionGraphicScript(id, opts);
      },
      { id: clipId, opts: options },
    )) as BridgeMotionGraphicResult;
  },

  async setMotionGraphicProperty(
    page: Page,
    clipId: string,
    property: string,
    value: unknown,
  ): Promise<BridgeOpResult> {
    return (await page.evaluate(
      async ({ id, prop, val }) => {
        const agent = window.__rendleyAgent;
        if (!agent?.setMotionGraphicProperty) return { ok: false, error: "__MISSING_MOTION_API__" };
        return await agent.setMotionGraphicProperty(id, prop, val);
      },
      { id: clipId, prop: property, val: value },
    )) as BridgeOpResult;
  },

  async getMotionGraphic(
    page: Page,
    clipId: string,
  ): Promise<BridgeMotionGraphicInfo | null | "__MISSING__"> {
    return (await page.evaluate(async (id) => {
      const agent = window.__rendleyAgent;
      if (!agent?.getMotionGraphic) return "__MISSING__";
      return await agent.getMotionGraphic(id);
    }, clipId)) as BridgeMotionGraphicInfo | null | "__MISSING__";
  },

  async listMotionGraphics(
    page: Page,
  ): Promise<BridgeMotionGraphicSummary[] | "__MISSING__"> {
    return (await page.evaluate(() => {
      const agent = window.__rendleyAgent;
      if (!agent?.listMotionGraphics) return "__MISSING__";
      return agent.listMotionGraphics();
    })) as BridgeMotionGraphicSummary[] | "__MISSING__";
  },

  async setMotionGraphicKeyframes(
    page: Page,
    clipId: string,
    property: string,
    keyframes: BridgeMotionKeyframe[],
    reset?: boolean,
  ): Promise<BridgeOpResult> {
    return (await page.evaluate(
      async ({ id, prop, kfs, rst }) => {
        const agent = window.__rendleyAgent;
        if (!agent?.setMotionGraphicKeyframes) return { ok: false, error: "__MISSING_MOTION_API__" };
        return await agent.setMotionGraphicKeyframes(id, prop, kfs, rst);
      },
      { id: clipId, prop: property, kfs: keyframes, rst: reset },
    )) as BridgeOpResult;
  },

  async getMotionGraphicKeyframes(
    page: Page,
    clipId: string,
  ): Promise<string | "__MISSING__"> {
    return (await page.evaluate(async (id) => {
      const agent = window.__rendleyAgent;
      if (!agent?.getMotionGraphicKeyframes) return "__MISSING__";
      return await agent.getMotionGraphicKeyframes(id);
    }, clipId)) as string | "__MISSING__";
  },

  motionApiMissingError(): Error {
    return new Error(MISSING_MOTION_API_ERROR);
  },

  lastAssistantContent(messages: BridgeMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].content ?? "";
    }
    return "";
  },
};
