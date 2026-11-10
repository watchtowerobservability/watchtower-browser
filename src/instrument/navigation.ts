import { normalizeRoute, scrubUrl, type Ctx, type NavInfo, type Uninstall } from "./ctx";

let template: string | undefined;

/** Router adapters (B4) set the route template (`/users/:id`); undefined falls back to the URL path. */
export function setRoute(t: string | undefined): void {
  template = t;
  adapter = t !== undefined;
  if (!adapter) return;
  for (const f of [...waiting]) f();
}

// An adapter's hook runs after the router has committed (and, on first load, after hydration), later than
// the History call or the instrument's install. So once an adapter is in use, views and navs wait for its
// `setRoute` (or SETTLE_MS) to report the pattern, not the concrete URL path.
let adapter = false;
const waiting = new Set<() => void>();
const SETTLE_MS = 300;
function whenRouteSettles(cb: () => void, wait: boolean, mine: Set<() => void>): void {
  if (!wait) return cb();
  const run = (): void => {
    if (!mine.delete(run)) return; // uninstalled
    waiting.delete(run);
    clearTimeout(timer);
    cb();
  };
  mine.add(run);
  waiting.add(run);
  const timer = setTimeout(run, SETTLE_MS);
  (timer as { unref?: () => void }).unref?.();
}

export const currentRoute = (): string => template ?? normalizeRoute(location.pathname);

/** Both rAFs: the first runs before the next paint, the second after it. */
const afterPaint = (cb: () => void): void =>
  void requestAnimationFrame(() => void requestAnimationFrame(cb));

export function installNavigation(ctx: Ctx, listeners: Array<(n: NavInfo) => void>): Uninstall {
  let route = currentRoute();
  let viewStart = performance.now();
  let lastHref = location.href;

  const view = (name: string, value: number | undefined, prev: string | undefined, prevMs: number | undefined): void =>
    ctx.emit("view", name, {
      value,
      attrs: {
        route: name,
        url: scrubUrl(location.href),
        ...(prev === undefined ? {} : { previous_route: prev }),
        ...(prevMs === undefined ? {} : { previous_duration_ms: Math.round(prevMs) }),
      },
    });

  // first load: wait for the adapter's hook unless it already ran
  const pending = new Set<() => void>();
  whenRouteSettles(() => view((route = currentRoute()), undefined, undefined, undefined), template === undefined, pending);

  const changed = (trigger: string): void => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const t0 = performance.now();
    const url = scrubUrl(location.href);
    whenRouteSettles(() => {
      const previous = route;
      route = currentRoute();
      const prevMs = t0 - viewStart;
      viewStart = t0;
      ctx.emit("nav", route, { attrs: { route, previous_route: previous, trigger, url } });
      listeners.forEach((f) => f({ route, previous }));
      afterPaint(() => view(route, performance.now() - t0, previous, prevMs));
    }, adapter, pending);
  };

  const h = history;
  const { pushState, replaceState } = h;
  const wrap =
    (orig: typeof pushState, trigger: string): typeof pushState =>
    function (this: History, ...a: Parameters<typeof pushState>) {
      const r = orig.apply(this, a);
      try {
        changed(trigger);
      } catch {
        /* never break the host's router */
      }
      return r;
    };
  const mine = { push: wrap(pushState, "pushState"), replace: wrap(replaceState, "replaceState") };
  h.pushState = mine.push;
  h.replaceState = mine.replace;
  const pop = (): void => changed("popstate");
  const hash = (): void => changed("hashchange");
  window.addEventListener("popstate", pop);
  window.addEventListener("hashchange", hash);
  // a page that closes before the adapter reports still gets its view, under the concrete path
  const flush = (): void => [...pending].forEach((f) => f());
  window.addEventListener("pagehide", flush);

  return () => {
    // `run` empties `pending` as it goes
    for (const f of [...pending]) {
      pending.delete(f);
      waiting.delete(f);
    }
    window.removeEventListener("pagehide", flush);
    // only restore what is still ours: another library may have wrapped on top
    if (h.pushState === mine.push) h.pushState = pushState;
    if (h.replaceState === mine.replace) h.replaceState = replaceState;
    window.removeEventListener("popstate", pop);
    window.removeEventListener("hashchange", hash);
  };
}
