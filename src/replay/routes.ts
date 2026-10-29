import type { RrEvent } from "./config";

/** Route exclusion: string = path prefix, RegExp = tested on the path. Checked at start and on each SPA navigation. */
export class RouteGuard {
  private off?: () => void;
  private was = false;
  constructor(
    private patterns: (string | RegExp)[],
    private onChange: (excluded: boolean) => void,
    private path: () => string = () => location.pathname,
  ) {}

  matches(path: string): boolean {
    return this.patterns.some((p) =>
      typeof p === "string" ? path === p || path.startsWith(p.endsWith("/") ? p : p + "/") : p.test(path),
    );
  }

  matchesUrl(href: string): boolean {
    try {
      return this.matches(new URL(href, "http://x").pathname);
    } catch {
      return false;
    }
  }

  excluded(): boolean {
    return this.matches(this.path());
  }

  /** Replaces excluded URLs in Meta events. */
  rewrite(e: RrEvent): RrEvent {
    if (e.type === 4 && typeof e.data?.href === "string" && this.matchesUrl(e.data.href)) e.data.href = "[excluded]";
    return e;
  }

  private check = (): void => {
    const now = this.excluded();
    if (now !== this.was) {
      this.was = now;
      this.onChange(now);
    }
  };

  start(): void {
    this.was = this.excluded();
    this.onChange(this.was);
    const { pushState, replaceState } = history;
    const wrap = (f: typeof pushState) =>
      function (this: History, ...a: Parameters<typeof pushState>) {
        const r = f.apply(this, a);
        window.dispatchEvent(new Event("wt-route"));
        return r;
      };
    history.pushState = wrap(pushState);
    history.replaceState = wrap(replaceState);
    window.addEventListener("wt-route", this.check);
    window.addEventListener("popstate", this.check);
    this.off = () => {
      history.pushState = pushState;
      history.replaceState = replaceState;
      window.removeEventListener("wt-route", this.check);
      window.removeEventListener("popstate", this.check);
    };
  }

  stop(): void {
    this.off?.();
  }
}
