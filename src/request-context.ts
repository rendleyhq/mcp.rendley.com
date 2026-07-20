import { AsyncLocalStorage } from "node:async_hooks";

// Request-scoped fields that the logger stamps on every line automatically, so
// logs emitted anywhere during a request (auth, tools, api client) correlate.
// No session id: the MCP is called by AI assistants over the MCP protocol, not
// a browser, so there's no posthog-js session / replay to link to.
export interface RequestContext {
  request_id: string;
  user_id?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

// Set once auth resolves the user, so the request-completion event and every
// subsequent log line carry user_id even though auth runs after the context
// is established.
export function setRequestUser(userId: string): void {
  const store = storage.getStore();
  if (store) {
    store.user_id = userId;
  }
}
