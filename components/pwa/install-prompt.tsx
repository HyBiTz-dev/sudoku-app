"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBackdrop,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogPopup,
  AlertDialogPortal,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** Shared sizing for the two buttons, which sit side by side. */
const PROMPT_BUTTON = "font-semibold";

/**
 * Not in lib.dom yet, so the parts this component uses are declared here.
 * `prompt()` shows the browser's own install UI; the event is single-use.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

/**
 * What the browser can tell us about installing.
 *
 * All of it is browser-only, so it lives in a module-level store read through
 * `useSyncExternalStore` rather than in state set from an effect. `getSnapshot`
 * must return a stable reference between reads, which is why `state` is only ever
 * replaced wholesale.
 */
interface InstallState {
  /** iOS can install, but only from the share sheet — there is no prompt event. */
  ios: boolean;
  /** Already running as an installed app, so there is nothing left to offer. */
  installed: boolean;
  deferredPrompt: BeforeInstallPromptEvent | null;
}

let state: InstallState = { ios: false, installed: false, deferredPrompt: null };
const listeners = new Set<() => void>();

/**
 * Built on first use rather than at module scope: this module is evaluated on
 * the server too, where `window` does not exist.
 */
let standaloneMedia: MediaQueryList | null = null;

/**
 * iPadOS reports itself as "MacIntel", so the touch-point check matters as much
 * as the user agent.
 */
function isIos() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function update(patch: Partial<InstallState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function handleInstallPrompt(event: Event) {
  // Without preventDefault, Chrome shows its own mini-infobar as soon as it is
  // ready, which would compete with the button below.
  event.preventDefault();
  update({ deferredPrompt: event as BeforeInstallPromptEvent });
}

function handleInstalled() {
  update({ installed: true, deferredPrompt: null });
}

/**
 * Browser listeners are attached while the component is mounted and released
 * with it, so importing this module has no side effect of its own.
 */
function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    standaloneMedia = window.matchMedia("(display-mode: standalone)");

    update({ ios: isIos(), installed: standaloneMedia.matches });

    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    // Covers installing from the browser's own UI, which fires no appinstalled
    // event here but does still change the display mode.
    standaloneMedia.addEventListener("change", handleInstalled);
  }

  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;

    window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
    window.removeEventListener("appinstalled", handleInstalled);
    standaloneMedia?.removeEventListener("change", handleInstalled);
    standaloneMedia = null;
  };
}

/** The server has no install state at all, so the first render shows nothing. */
const getServerSnapshot = () => null;

export function InstallPrompt() {
  const install = useSyncExternalStore(subscribe, () => state, getServerSnapshot);
  const [instructionsOpen, setInstructionsOpen] = useState(false);

  const handleInstall = useCallback(async () => {
    const prompt = install?.deferredPrompt;
    if (!prompt) {
      // iOS has no programmatic install, so fall back to telling them how.
      setInstructionsOpen(true);
      return;
    }

    await prompt.prompt();
    // Single-use: a later install fires `beforeinstallprompt` again, so dropping
    // it here avoids leaving a button that no longer does anything.
    update({ deferredPrompt: null });
  }, [install?.deferredPrompt]);

  // Still hydrating, already installed, or a browser with neither install path.
  // Firefox desktop fires no prompt event and has no share sheet, so a button
  // there would dead-end.
  if (!install || install.installed || (!install.deferredPrompt && !install.ios)) {
    return null;
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleInstall}
        aria-label="Install app"
        title="Install app"
        className="text-board-given hover:bg-board-peer"
      >
        <Download />
      </Button>

      <AlertDialog open={instructionsOpen} onOpenChange={setInstructionsOpen}>
        <AlertDialogPortal>
          <AlertDialogBackdrop />
          <AlertDialogPopup>
            <div className="flex flex-col gap-1.5">
              <AlertDialogTitle>Add to Home Screen</AlertDialogTitle>
              <AlertDialogDescription>
                Safari installs the app from the share sheet: tap the{" "}
                <span role="img" aria-label="share">
                  share
                </span>{" "}
                button in the toolbar, then{" "}
                <span className="font-semibold">Add to Home Screen</span>.
              </AlertDialogDescription>
            </div>
            <div className="flex justify-end gap-2">
              <AlertDialogCancel className={PROMPT_BUTTON} render={
                <Button variant="outline" size="lg" />
              }>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction className={PROMPT_BUTTON} render={<Button />}>
                Got it
              </AlertDialogAction>
            </div>
          </AlertDialogPopup>
        </AlertDialogPortal>
      </AlertDialog>
    </>
  );
}