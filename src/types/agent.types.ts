import type { Page } from "playwright";
import type { Logger } from "@/logger";
import type { BridgeStatus } from "@/types/bridge.types";

export type PollOutcome =
  | { kind: "completed"; status: BridgeStatus; lastMessage: string }
  | { kind: "save_failed"; saveStatus: string; lastMessage: string }
  | { kind: "timeout"; lastMessage: string }
  | { kind: "interrupt"; status: BridgeStatus; lastMessage: string }
  | { kind: "error"; status: BridgeStatus; error: string; lastMessage: string };

export interface PollOptions {
  page: Page;
  projectId: string;
  release: (page: Page) => Promise<void>;
  threadId: string | null;
  maxWaitMs: number;
  autoApprove: boolean;
  logger?: Logger;
  onProgress?: (message: string) => Promise<void> | void;
}
