"use client";

import { useEffect } from "react";

/**
 * Registers the offline service worker.
 *
 * Mounted once from the root layout. Renders nothing.
 *
 * Registration is skipped outside production. In dev the asset URLs under
 * /_next/static are not content-hashed, so a cache-first strategy would serve
 * stale modules and break hot reloading. Offline behaviour has to be verified
 * against `next build && next start` instead.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    // Registration is not needed to make the app work, only to make it work
    // offline, so a failure here is logged rather than surfaced.
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
      console.error("Service worker registration failed", error);
    });
  }, []);

  return null;
}