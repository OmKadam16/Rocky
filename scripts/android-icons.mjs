// Android launcher icons + splash images from build/icon.png, drawn with the
// Chromium that Playwright already installed (no image library needed).
//
//   node scripts/android-icons.mjs
//
// Writes android/app/src/main/res/:
//   mipmap-<dpi>/ic_launcher.png, ic_launcher_round.png, ic_launcher_foreground.png
//   drawable*/splash.png (light) and drawable-night*/splash.png (dark)
// The adaptive icon = the dark tile colour (values/ic_launcher_background.xml)
// behind the sphere (foreground, inside the 66/108 safe zone).
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const res = path.join(root, "android", "app", "src", "main", "res");
const icon = `data:image/png;base64,${fs.readFileSync(path.join(root, "build", "icon.png")).toString("base64")}`;

const TILE = "#17181A"; // the icon's dark tile
const SPLASH = { light: "#F4F3F0", dark: "#131415" }; // --color-canvas, light / dark
const DPI = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
// The sphere inside build/icon.png (1024 px): centre and radius.
const SPHERE = { cx: 512, cy: 510, r: 308 };

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<img id="i" src="${icon}">`);
await page.waitForFunction(() => document.getElementById("i").complete);

/** Run a drawing in the page, get a PNG back. */
async function draw(w, h, kind, opts = {}) {
  const b64 = await page.evaluate(
    ({ w, h, kind, opts, SPHERE }) => {
      const img = document.getElementById("i");
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      const sphere = (cx, cy, d) => {
        const s = (SPHERE.r * 2) / d;
        g.save();
        g.beginPath();
        g.arc(cx, cy, d / 2, 0, Math.PI * 2);
        g.clip();
        g.drawImage(img, SPHERE.cx - SPHERE.r, SPHERE.cy - SPHERE.r, SPHERE.r * 2, SPHERE.r * 2, cx - d / 2, cy - d / 2, d, d);
        g.restore();
        void s;
      };
      if (kind === "legacy") {
        g.drawImage(img, 0, 0, w, h);
      } else if (kind === "round") {
        g.fillStyle = opts.tile;
        g.beginPath();
        g.arc(w / 2, h / 2, w * 0.46, 0, Math.PI * 2);
        g.fill();
        sphere(w / 2, h / 2, w * 0.56);
      } else if (kind === "foreground") {
        // 108 dp canvas, 66 dp safe circle: the sphere fills ~56 dp of it.
        sphere(w / 2, h / 2, w * (56 / 108));
      } else if (kind === "splash") {
        g.fillStyle = opts.bg;
        g.fillRect(0, 0, w, h);
        sphere(w / 2, h / 2, Math.min(w, h) * 0.22);
      }
      return c.toDataURL("image/png").split(",")[1];
    },
    { w, h, kind, opts, SPHERE },
  );
  return Buffer.from(b64, "base64");
}

const write = (rel, buf) => {
  const f = path.join(res, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, buf);
};

for (const [dpi, k] of Object.entries(DPI)) {
  write(`mipmap-${dpi}/ic_launcher.png`, await draw(48 * k, 48 * k, "legacy"));
  write(`mipmap-${dpi}/ic_launcher_round.png`, await draw(48 * k, 48 * k, "round", { tile: TILE }));
  write(`mipmap-${dpi}/ic_launcher_foreground.png`, await draw(108 * k, 108 * k, "foreground"));
}

// Splash: same pixel sizes as Capacitor's template, light and dark (night).
const pngSize = (f) => {
  const d = fs.readFileSync(f);
  return { w: d.readUInt32BE(16), h: d.readUInt32BE(20) };
};
for (const dir of fs.readdirSync(res).filter((d) => /^drawable(-(land|port)-(m|h|xh|xxh|xxxh)dpi)?$/.test(d))) {
  const f = path.join(res, dir, "splash.png");
  if (!fs.existsSync(f)) continue;
  const { w, h } = pngSize(f);
  write(`${dir}/splash.png`, await draw(w, h, "splash", { bg: SPLASH.light }));
  // Qualifier order matters: orientation before night mode (drawable-land-night-hdpi).
  const night = dir === "drawable" ? "drawable-night" : dir.replace(/^drawable-(land|port)-/, "drawable-$1-night-");
  write(`${night}/splash.png`, await draw(w, h, "splash", { bg: SPLASH.dark }));
}

fs.writeFileSync(
  path.join(res, "values", "ic_launcher_background.xml"),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${TILE}</color>\n</resources>\n`,
);
await browser.close();
console.log("Android icons and splash written.");
