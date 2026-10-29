import type { Attrs, Matcher, RumEventV1, WatchtowerConfig } from "../config";

export interface NetInfo {
  status?: number;
  failed?: boolean;
  trace_id?: string;
}

export interface NavInfo {
  route: string;
  previous?: string;
}

/** What every instrument gets: no globals, so each one is testable alone. */
export interface Ctx {
  cfg: WatchtowerConfig;
  emit(type: RumEventV1["type"], name: string, extra?: Partial<RumEventV1>): void;
  sessionId(): string;
  route(): string;
  /** true for the SDK's own endpoints: never instrumented, never reported */
  isOwn(url: string): boolean;
  onNav(cb: (n: NavInfo) => void): void;
  /** active view span, set by tracing; attached to events by the emitter */
  span?: { trace_id: string; span_id: string };
  /** fetch/XHR outcomes keyed by scrubbed URL, filled by tracing, read by resources */
  net: Map<string, NetInfo>;
  extraAttrs?(): Attrs;
}

export type Uninstall = () => void;

/** String matchers are URL prefixes. */
export const matches = (m: Matcher, url: string): boolean =>
  typeof m === "string" ? url.startsWith(m) : m.test(url);

/** Query and fragment dropped: both can carry tokens. */
export function scrubUrl(u: string): string {
  const i = u.search(/[?#]/);
  return i < 0 ? u : u.slice(0, i);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_SEG = /^(\d+|[0-9a-f]{16,})$/i;

/** `/users/42/orders/<uuid>` becomes `/users/:id/orders/:id`. */
export function normalizeRoute(path: string): string {
  const p = scrubUrl(path)
    .split("/")
    .map((s) => (UUID.test(s) || ID_SEG.test(s) ? ":id" : s))
    .join("/");
  return p || "/";
}

/** Privacy-safe: tag, id, classes and data-testid; never text or other attributes. */
export function selectorOf(el: Element, max = 256): string {
  const id = el.id ? `#${el.id}` : "";
  const cls = [...el.classList].slice(0, 3).map((c) => `.${c}`).join("");
  const t = el.getAttribute("data-testid");
  return `${el.tagName.toLowerCase()}${id}${cls}${t ? `[data-testid=${t}]` : ""}`.slice(0, max);
}

export function deviceClass(): string {
  const w = window.innerWidth;
  return w < 768 ? "mobile" : w < 1024 ? "tablet" : "desktop";
}
