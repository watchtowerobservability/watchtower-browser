import { afterEach, describe, expect, it, vi } from "vitest";
import { cookieMunchConsent } from "./consent";

const wt = () => ({ grantConsent: vi.fn(), revokeConsent: vi.fn(), replay: { start: vi.fn(), stop: vi.fn(), flush: vi.fn() } });
const set = (hasResponse: boolean, consent: Record<string, boolean>) => ((window as any).CookieMunch = { hasResponse, consent });
let off: (() => void) | undefined;
afterEach(() => {
  off?.();
  delete (window as any).CookieMunch;
});

describe("cookieMunchConsent", () => {
  it("does_nothing_before_the_visitor_decides", () => {
    const w = wt();
    set(false, { statistics: false });
    off = cookieMunchConsent(w);
    expect(w.grantConsent).not.toHaveBeenCalled();
    expect(w.revokeConsent).not.toHaveBeenCalled();
  });

  it("grants_once_and_revokes_on_change", () => {
    const w = wt();
    off = cookieMunchConsent(w, { rum: "statistics", replay: "statistics" });
    set(true, { statistics: true });
    window.dispatchEvent(new Event("CookieMunchOnConsentReady"));
    window.dispatchEvent(new Event("CookieMunchOnChange")); // same state: idempotent
    expect(w.grantConsent).toHaveBeenCalledTimes(1);
    set(true, { statistics: false });
    window.dispatchEvent(new Event("CookieMunchOnChange"));
    expect(w.revokeConsent).toHaveBeenCalledTimes(1);
  });

  it("replay_follows_its_own_category", () => {
    const w = wt();
    off = cookieMunchConsent(w, { rum: "statistics", replay: "marketing" });
    set(true, { statistics: true, marketing: false });
    window.dispatchEvent(new Event("CookieMunchOnChange"));
    expect(w.grantConsent).toHaveBeenCalledTimes(1);
    expect(w.replay.stop).toHaveBeenCalledTimes(1);
    set(true, { statistics: true, marketing: true });
    window.dispatchEvent(new Event("CookieMunchOnChange"));
    expect(w.replay.start).toHaveBeenCalledTimes(1);
    expect(w.grantConsent).toHaveBeenCalledTimes(1);
  });

  it("reads_an_existing_decision_at_attach_time", () => {
    const w = wt();
    set(true, { statistics: true });
    off = cookieMunchConsent(w);
    expect(w.grantConsent).toHaveBeenCalledTimes(1);
  });
});
