declare module "jsqr" {
  export interface QRResult {
    data: string;
  }
  export interface QROptions {
    inversionAttempts?: "attemptBoth" | "onlyInvert" | "dontInvert";
  }
  export default function jsQR(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    options?: QROptions,
  ): QRResult | null;
}
