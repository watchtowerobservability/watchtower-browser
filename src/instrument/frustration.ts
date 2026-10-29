import { selectorOf, type Ctx, type Uninstall } from "./ctx";

const WINDOW_MS = 1000;
const RADIUS = 100;
const RAGE_CLICKS = 3;
const INTERACTIVE = 'a[href],button,summary,[role="button"],[role="link"],input[type="submit"],input[type="button"]';

interface Click {
  t: number;
  x: number;
  y: number;
  el: Element;
}

/**
 * rage / dead / error clicks. Events carry a privacy-safe selector (no text) and coordinates.
 * shortcut: dead_click counts resources that finished within 1 s; a request still in flight
 * at 1 s looks like no network. Tighten with a fetch hook if it produces false positives.
 */
export function installFrustration(ctx: Ctx): Uninstall {
  let recent: Click[] = [];
  let lastMutation = -Infinity;
  let lastClick: Click | undefined;

  const out = (kind: string, c: Click, count: number): void =>
    ctx.emit("frustration", kind, { attrs: { kind, selector: selectorOf(c.el), x: c.x, y: c.y, count } });

  const mo = new MutationObserver(() => (lastMutation = Date.now()));
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

  const onClick = (ev: Event): void => {
    const m = ev as MouseEvent;
    const el = m.target instanceof Element ? m.target : null;
    if (!el) return;
    const c: Click = { t: Date.now(), x: Math.round(m.clientX), y: Math.round(m.clientY), el };
    lastClick = c;

    recent = recent.filter((r) => c.t - r.t <= WINDOW_MS && r.el === el && Math.hypot(r.x - c.x, r.y - c.y) <= RADIUS);
    recent.push(c);
    if (recent.length >= RAGE_CLICKS) {
      out("rage_click", c, recent.length);
      recent = [];
    }

    const target = el.closest(INTERACTIVE);
    if (target && !(target as HTMLButtonElement).disabled) {
      const href = location.href;
      const resources = performance.getEntriesByType("resource").length;
      setTimeout(() => {
        const idle =
          lastMutation < c.t && location.href === href && performance.getEntriesByType("resource").length === resources;
        if (idle) out("dead_click", { ...c, el: target }, 1);
      }, WINDOW_MS);
    }
  };

  let lastErrorClick = -Infinity;
  const onErr = (): void => {
    if (lastClick && Date.now() - lastClick.t <= WINDOW_MS && lastClick.t !== lastErrorClick) {
      lastErrorClick = lastClick.t;
      out("error_click", lastClick, 1);
    }
  };

  document.addEventListener("click", onClick, true);
  window.addEventListener("error", onErr, true);
  window.addEventListener("unhandledrejection", onErr);
  return () => {
    mo.disconnect();
    document.removeEventListener("click", onClick, true);
    window.removeEventListener("error", onErr, true);
    window.removeEventListener("unhandledrejection", onErr);
  };
}
