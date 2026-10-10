export const MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_SEND_BYTES = 2 * 1024 * 1024;
export const MAX_SIDE = 1600;
export const MAX_IMAGES = 5;

const ACCEPT = new Set(["image/png", "image/jpeg", "image/webp"]);

export function rejectReason(file: File): string | null {
  const t = (file.type || "").toLowerCase();
  const name = file.name.toLowerCase();
  if (t.includes("heic") || t.includes("heif") || name.endsWith(".heic") || name.endsWith(".heif")) {
    return "HEIC isn't supported — export as JPG or PNG and try again.";
  }
  if (!ACCEPT.has(t)) {
    // Allow jpg variants browsers report differently.
    if (!(t === "image/jpg" || name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".png") || name.endsWith(".webp"))) {
      return "Only PNG, JPG, or WebP images.";
    }
  }
  if (file.size > MAX_INPUT_BYTES) return "Each image must be 8 MB or less.";
  return null;
}

/** Downscale to max 1600px long side, JPEG ~0.8. Never sends the original 8MB file. */
export function downscaleToJpeg(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        const long = Math.max(w, h);
        const scale = long > MAX_SIDE ? MAX_SIDE / long : 1;
        const dw = Math.max(1, Math.round(w * scale));
        const dh = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement("canvas");
        canvas.width = dw;
        canvas.height = dh;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas unavailable.");
        ctx.drawImage(img, 0, 0, dw, dh);
        URL.revokeObjectURL(url);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error("Could not process that image."));
              return;
            }
            if (blob.size > MAX_SEND_BYTES) {
              reject(new Error("That image is still over ~2 MB after resizing — try a smaller screenshot."));
              return;
            }
            resolve(blob);
          },
          "image/jpeg",
          0.8,
        );
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image."));
    };
    img.src = url;
  });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Could not read image."));
    r.readAsDataURL(blob);
  });
}
