import type { WatchtowerClient } from "./index";

/** Cookie Munch categories (`CookieMunch.consent`). */
export type CookieMunchCategory = "statistics" | "marketing" | "preferences";
type Snapshot = Partial<Record<CookieMunchCategory, boolean>>;

const EVENTS = ["CookieMunchOnConsentReady", "CookieMunchOnChange"];

/**
 * Follow Cookie Munch (cookiemunch.net): once the visitor has decided (`CookieMunch.hasResponse`; the snapshot is
 * all-false before that, which is never read as a decline) and on every change, call `grantConsent()` or
 * `revokeConsent()` for the `rum` category and stop or restart session replay for the `replay` category (replay
 * also needs `rum`). Defaults: both `statistics`. Returns a function that detaches the listeners.
 */
export function cookieMunchConsent(
  wt: Pick<WatchtowerClient, "grantConsent" | "revokeConsent" | "replay">,
  map: { rum?: CookieMunchCategory; replay?: CookieMunchCategory } = {},
): () => void {
  let rum: boolean | undefined;
  let replayStopped = false;
  const read = (): void => {
    try {
      const cm = (window as { CookieMunch?: { hasResponse?: boolean; consent?: Snapshot } }).CookieMunch;
      if (!cm?.consent || cm.hasResponse !== true) return;
      const rumOk = !!cm.consent[map.rum ?? "statistics"];
      const replayOk = rumOk && !!cm.consent[map.replay ?? "statistics"];
      if (rumOk !== rum) {
        rum = rumOk;
        if (rumOk) wt.grantConsent();
        else wt.revokeConsent();
        replayStopped = false; // a new client starts replay on its own
      }
      if (rumOk && !replayOk && !replayStopped) {
        replayStopped = true;
        wt.replay.stop();
      } else if (replayOk && replayStopped) {
        replayStopped = false;
        wt.replay.start();
      }
    } catch {
      /* the SDK never throws into the host app */
    }
  };
  for (const e of EVENTS) window.addEventListener(e, read);
  read();
  return () => EVENTS.forEach((e) => window.removeEventListener(e, read));
}
