import { askPlannerLocal } from "./plannerLocal";
import { getSecret } from "./secrets";
import { speak, stopSpeaking } from "./speech";

export type VoiceCheckStage = {
  id: "keys" | "planner" | "voice";
  label: string;
  ok: boolean;
  message: string;
};

/**
 * End-to-end proof that the stored keys actually work — not just that
 * fields are filled in. Runs the real paths: stored keys → planner ping
 * (real model call) → spoken reply (real TTS). STT is covered by the
 * ElevenLabs Test button (silent-wav ping); speaking into the mic can't
 * be self-tested without the user.
 */
export async function runVoiceSelfTest(): Promise<VoiceCheckStage[]> {
  const stages: VoiceCheckStage[] = [];

  const llm = (await getSecret("llm_key").catch(() => null))?.trim() ?? "";
  const el = (await getSecret("el_key").catch(() => null))?.trim() ?? "";
  if (!llm || !el) {
    const missing = [!llm ? "AI key" : null, !el ? "ElevenLabs key" : null].filter(Boolean).join(" and ");
    stages.push({
      id: "keys",
      label: "Keys saved",
      ok: false,
      message: `Missing ${missing} in storage — testing a typed key is not enough. Type each key above, Test it, then press Save.`,
    });
    return stages;
  }
  stages.push({ id: "keys", label: "Keys saved", ok: true, message: "Both keys are stored on this device." });

  try {
    const res = await askPlannerLocal("Reply with exactly: voice check OK. Do not call any tools.", []);
    const reply = res.reply.trim();
    if (!reply) throw new Error("The planner answered with nothing.");
    stages.push({ id: "planner", label: "Planner thinks", ok: true, message: `Model replied: “${reply.slice(0, 80)}”.` });
  } catch (e) {
    stages.push({
      id: "planner",
      label: "Planner thinks",
      ok: false,
      message: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    });
    return stages;
  }

  try {
    await speak("Voice check OK.");
    stages.push({ id: "voice", label: "Voice speaks", ok: true, message: "You should have heard that out loud." });
  } catch (e) {
    stopSpeaking();
    stages.push({
      id: "voice",
      label: "Voice speaks",
      ok: false,
      message: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    });
  }
  return stages;
}
