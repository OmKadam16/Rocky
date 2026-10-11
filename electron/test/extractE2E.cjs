"use strict";
/**
 * Runs the extension's page extractor (extension/src/extract.js) in real
 * Chromium against small fixture pages:
 *   npx electron electron/test/extractE2E.cjs
 */
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const PAGES = {
  article: `<!doctype html><title>CRISPR explained</title><nav>Home · About</nav><main><h1>Base editing</h1><p>CRISPR base editors fix single letters.</p>
    <p>They were described in 2016.</p><form><input name="q" value="TYPED SEARCH"><textarea>PRIVATE DRAFT</textarea></form>
    <div contenteditable>EDITABLE NOTE</div><p hidden>HIDDEN TEXT</p><footer>© footer</footer></main>`,
  login: `<!doctype html><title>Sign in</title><main><p>Welcome back</p><input type="password"></main>`,
  payment: `<!doctype html><title>Checkout</title><main><p>Pay now</p><input autocomplete="cc-number"></main>`,
};

const checks = [];
const check = (ok, label) => {
  checks.push(ok);
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
};

app.whenReady().then(async () => {
  let code = 1;
  try {
    const { extractPage } = await import(pathToFileURL(path.join(__dirname, "..", "..", "extension", "src", "extract.js")).href);
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    const run = async (html) => {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      return win.webContents.executeJavaScript(`(${extractPage.toString()})()`);
    };
    const a = await run(PAGES.article);
    check(a.title === "CRISPR explained", "title");
    check(/CRISPR base editors fix single letters\./.test(a.text) && /2016/.test(a.text), "visible main text captured");
    check(!/TYPED SEARCH|PRIVATE DRAFT|EDITABLE NOTE/.test(a.text), "never reads inputs, textareas or editable areas");
    check(!/HIDDEN TEXT|Home · About|footer/.test(a.text), "skips hidden text, nav and footer");
    check((await run(PAGES.login)).skip === "password", "pages with a password field are skipped");
    check((await run(PAGES.payment)).skip === "payment", "payment pages are skipped");
    code = checks.every(Boolean) ? 0 : 1;
    console.log(code ? "\nFAILED" : `\nPASSED ${checks.length}/${checks.length}`);
  } catch (e) {
    console.error("extract E2E error:", e && e.stack ? e.stack : e);
  }
  app.exit(code);
});
