import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Rocky for Android: the same web app (phone UI), wrapped by Capacitor.
 *
 * appId com.rocky.calendar.android — the desktop app is com.rocky.calendar;
 * the ".android" suffix keeps the two apart in every store and log. It can
 * never change once the APK is installed (updates must match it).
 *
 * The WebView origin is https://localhost (androidScheme https), so the
 * mic, secure cookies and Supabase auth behave like a normal https site.
 */
const config: CapacitorConfig = {
  appId: "com.rocky.calendar.android",
  appName: "Rocky",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
  android: {
    // Never on in release builds (Capacitor's default is debug builds only).
    webContentsDebuggingEnabled: false,
    allowMixedContent: false,
  },
  plugins: {
    SystemBars: {
      // Injects --safe-area-inset-* (older WebViews get env() wrong).
      insetsHandling: "css",
      style: "DEFAULT",
    },
    SplashScreen: {
      launchShowDuration: 600,
      launchAutoHide: true,
      backgroundColor: "#F4F3F0",
      showSpinner: false,
    },
    Keyboard: {
      // The phone shell follows visualViewport; the WebView itself resizes.
      resize: "native",
    },
    CapacitorUpdater: {
      // Self-hosted, manual: src/lib/appUpdate.ts decides, downloads (SHA-256
      // checked) and switches bundles. Nothing talks to capgo.app.
      autoUpdate: false,
      statsUrl: "",
      channelUrl: "",
      updateUrl: "",
      appReadyTimeout: 10000,
      resetWhenUpdate: true,
      autoDeleteFailed: true,
      autoDeletePrevious: false,
    },
  },
};

export default config;
