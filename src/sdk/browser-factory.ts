import { config } from "@/config";
import { BrowserMode } from "@/constants";
import { log } from "@/logger";
import type { AgentBrowser } from "@/sdk/agent-browser";
import { RemoteAgentBrowser } from "@/sdk/remote-browser";
import { LocalAgentBrowser } from "@/sdk/local-browser";

let instance: AgentBrowser | null = null;

export function getAgentBrowser(): AgentBrowser {
  if (!instance) {
    instance =
      config.browserMode === BrowserMode.Local
        ? new LocalAgentBrowser()
        : new RemoteAgentBrowser();
    log.debug("browser backend selected", {
      mode: config.browserMode,
      ...(config.browserMode === BrowserMode.Remote
        ? { workerUrl: config.browserWorkerUrl }
        : {}),
    });
  }
  return instance;
}
