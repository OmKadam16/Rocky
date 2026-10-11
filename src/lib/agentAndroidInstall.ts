/**
 * Android app start: register the on-phone booking agent (when this APK has
 * the RockyAgentBrowser plugin) and clean up after a run Android killed.
 * Loaded only inside the Android app (nativeShell.ts).
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import { createAndroidAgent, createModelCaller, recoverInterruptedRun, type AgentBrowser, type AndroidAgent } from "./agentAndroid";
import { setLocalAgentBridge } from "./agentClient";
import { finalHoldTitle } from "./bookingTask";
import { db } from "./db";
import { emitDataChange } from "./supaDb";
import { getSecret } from "./secrets";

const storage = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* not remembered */
    }
  },
  remove: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* nothing */
    }
  },
};

let agent: AndroidAgent | null = null;
export const androidAgent = () => agent;

export async function installAndroidAgent(): Promise<void> {
  if (agent || !Capacitor.isPluginAvailable("RockyAgentBrowser")) return; // older APK: laptop relay
  const browser = registerPlugin<AgentBrowser>("RockyAgentBrowser");
  const keepAwake = (on: boolean) =>
    void import("@capacitor-community/keep-awake").then(({ KeepAwake }) => (on ? KeepAwake.keepAwake() : KeepAwake.allowSleep())).catch(() => {});
  agent = createAndroidAgent({
    browser,
    callModel: createModelCaller(() => getSecret("browser_key")),
    hasKey: async () => Boolean(await getSecret("browser_key").catch(() => null)),
    storage,
    keepAwake,
  });
  setLocalAgentBridge(agent as never);
  // A run Android killed in the background: its hold says "finish by hand".
  await recoverInterruptedRun(storage, async (id) => {
    const block = await db.scheduled_blocks.get(id);
    if (!block) return;
    await db.scheduled_blocks.update(id, {
      title: finalHoldTitle(block.title, "failed"),
      notes: [block.notes, "The app was closed during the booking. Finish it by hand."].filter(Boolean).join("\n"),
    } as never);
    emitDataChange("scheduled_blocks");
  }).catch(() => {});
}
