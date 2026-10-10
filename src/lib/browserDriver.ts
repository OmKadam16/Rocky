/**
 * Renderer side of the browser booking agent.
 *
 * Every function below is a thin IPC call into the desktop agent window
 * (see electron/main.cjs). In a plain browser there is no agent window, so
 * every call throws AgentUnavailableError and the planner falls back to
 * handing the user a booking link instead.
 */

export type AgentSnapshot = {
  url: string;
  title: string;
  text: string;
};

export class AgentUnavailableError extends Error {
  constructor() {
    super("Browser agent needs the Rocky desktop app.");
  }
}

type BrowserBridge = {
  available: () => Promise<boolean>;
  open: () => Promise<void>;
  navigate: (url: string) => Promise<AgentSnapshot>;
  snapshot: () => Promise<AgentSnapshot>;
  click: (selector: string) => Promise<AgentSnapshot>;
  type: (selector: string, text: string) => Promise<AgentSnapshot>;
  close: () => Promise<void>;
};

const bridge = (): BrowserBridge | null =>
  (typeof window !== "undefined" && (window as unknown as { rocky?: { browser?: BrowserBridge } }).rocky?.browser) || null;

/** True only on desktop with the agent handlers registered. */
export async function isAgentAvailable(): Promise<boolean> {
  try {
    return (await bridge()?.available()) === true;
  } catch {
    return false;
  }
}

async function call<K extends keyof BrowserBridge>(name: K, ...args: any[]): Promise<any> {
  const b = bridge();
  if (!b) throw new AgentUnavailableError();
  try {
    return await (b[name] as (...a: any[]) => Promise<any>)(...args);
  } catch (e) {
    if (e instanceof AgentUnavailableError) throw e;
    throw new AgentUnavailableError();
  }
}

export const agentOpen = (): Promise<void> => call("open");
export const agentNavigate = (url: string): Promise<AgentSnapshot> => call("navigate", url);
export const agentSnapshot = (): Promise<AgentSnapshot> => call("snapshot");
export const agentClick = (selector: string): Promise<AgentSnapshot> => call("click", selector);
export const agentType = (selector: string, text: string): Promise<AgentSnapshot> => call("type", selector, text);
export const agentClose = (): Promise<void> => call("close");
