"use client";

import { useEffect } from "react";

// Registers the service worker on the client after mount. Rendered once, high
// in the root layout, so it runs on every authenticated page. Kept dependency-
// free and silent — a failed or unsupported registration is a no-op (the app
// works fine without it; the SW only adds installability + an offline shell +
// static-asset caching). Registration is deferred to the `load` event so it
// never competes with first paint or hydration.
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* SW is progressive enhancement — ignore failures */
      });
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
