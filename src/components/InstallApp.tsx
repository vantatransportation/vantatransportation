"use client";

import { useEffect, useState } from "react";

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
type Mode = "loading" | "installed" | "prompt" | "ios" | "manual";

const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || window.matchMedia("(display-mode: window-controls-overlay)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/**
 * Unobtrusive "Install app" action for the site footer. It uses the browser's own install prompt where one exists
 * (Chrome, Edge, Samsung Internet and other Chromium browsers), shows short instructions where it doesn't (Safari on
 * iPhone/iPad, Firefox, desktop Safari), and disappears once the app is installed or already running as an app.
 * It never opens by itself and never shows a pop-up.
 */
export default function InstallApp({ className = "" }: { className?: string }) {
  const [mode, setMode] = useState<Mode>("loading");
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (isStandalone()) { setMode("installed"); return; }
    setMode(isIos() ? "ios" : "manual");
    const onPrompt = (e: Event) => { e.preventDefault(); setDeferred(e as InstallPromptEvent); setMode("prompt"); };
    const onInstalled = () => { setDeferred(null); setMode("installed"); setOpen(false); };
    const mq = window.matchMedia("(display-mode: standalone)");
    const onMode = () => { if (isStandalone()) setMode("installed"); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    mq.addEventListener("change", onMode);
    return () => { window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("appinstalled", onInstalled); mq.removeEventListener("change", onMode); };
  }, []);

  async function install() {
    if (mode === "prompt" && deferred) {
      const ev = deferred;
      setDeferred(null); // the browser allows each captured prompt to be used once
      try { await ev.prompt(); const { outcome } = await ev.userChoice; if (outcome === "accepted") setMode("installed"); else setMode("manual"); } catch { setMode("manual"); }
      return;
    }
    setOpen((o: boolean) => !o);
  }

  if (mode === "loading" || mode === "installed") return null;

  return (
    <div className={`install-app ${className}`}>
      <button type="button" className="install-app__btn" onClick={install} aria-expanded={mode === "prompt" ? undefined : open} aria-controls="install-app-help">
        <span aria-hidden="true">⤓</span> Install app
      </button>
      {open && mode !== "prompt" && (
        <div id="install-app-help" className="install-app__help" role="region" aria-label="How to install Vanta Transportation">
          {mode === "ios" ? (
            <p>In Safari, tap the <strong>Share</strong> button, then choose <strong>Add to Home Screen</strong>.</p>
          ) : (
            <p>
              In Chrome or Edge, open the browser menu and choose <strong>Install Vanta Transportation</strong> (or <strong>Add to Home screen</strong> on Android), or use the install icon in the address bar.
              Some browsers, such as Firefox on desktop, don&apos;t support installing web apps.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
