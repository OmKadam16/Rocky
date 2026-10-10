import type { PastelColor } from "../types";

export const SURFACE_MUTED = "bg-done border border-line-block rounded-[3px]";
export const SURFACE_CARD = "bg-card border border-line-block rounded-[3px]";
export const SURFACE_ACCENT = "bg-accent-bg border border-accent-line rounded-[3px]";

export const PASTEL_SURFACES: Record<PastelColor, string> = {
  magenta: "bg-pastel-magenta border border-pastel-magenta-line rounded-[3px]",
  orange: "bg-pastel-orange border border-pastel-orange-line rounded-[3px]",
  green: "bg-pastel-green border border-pastel-green-line rounded-[3px]",
  red: "bg-pastel-red border border-pastel-red-line rounded-[3px]",
  blue: "bg-pastel-blue border border-pastel-blue-line rounded-[3px]",
  lavender: "bg-pastel-lavender border border-pastel-lavender-line rounded-[3px]",
};

export function pastelSurface(color?: PastelColor): string {
  if (!color) return SURFACE_MUTED;
  return PASTEL_SURFACES[color] ?? SURFACE_MUTED;
}
