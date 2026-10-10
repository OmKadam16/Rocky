declare module "jsqr" {
  export interface QRResult {
    data: string;
  }
  export default function jsQR(data: Uint8ClampedArray, width: number, height: number): QRResult | null;
}
