/**
 * Co-browse assist and remote control (RPL-012; design in docs/security/cobrowse-control.md), a
 * lazy chunk loaded only with `assist: { enabled: true }`; the project must also turn it on (the
 * edge answers 404 otherwise and polling stops).
 *
 * Consent: nothing happens until the end user accepts the in-page prompt. While an assist runs a
 * banner stays visible with an End button. Replay masking is unchanged. Remote control is off
 * unless `allowControl` is set here, the project allows it, and the end user accepts a second
 * prompt; it then lasts 15 minutes at most, ends after two idle minutes, and the banner
 * ("Support is controlling this page") always carries a Stop button. The SDK is the enforcement
 * point: every command is validated and rate limited here, and acts only on elements that are
 * not masked, blocked, this UI or (for clicks) form fields. Typing goes only into plain text
 * fields (never password, payment, one-time code, file or masked fields). There is no command
 * for navigation, scripts, clipboard or reading values. The prompt and banner live in a shadow
 * root, ignore synthetic clicks and are never a command target.
 */

export interface AssistLabels {
  request: string;
  accept: string;
  decline: string;
  banner: string;
  controlRequest: string;
  allow: string;
  deny: string;
  controlOn: string;
  stopControl: string;
  end: string;
}

export interface AssistConfig {
  enabled: boolean;
  /** let support ask to control the page (click, scroll, type into plain fields); default off */
  allowControl?: boolean;
  /** pending-request poll interval, default 5000 ms */
  pollMs?: number;
  labels?: Partial<AssistLabels>;
}

export const DEFAULT_LABELS: AssistLabels = {
  request: "Support asks to view this page with you. Text and inputs stay masked.",
  accept: "Allow",
  decline: "Decline",
  banner: "Support is viewing this page (masked).",
  controlRequest: "Support asks to control this page: click, scroll and type into plain fields (never passwords or payment details). You can stop at any time.",
  allow: "Allow control",
  deny: "Deny",
  controlOn: "Support is controlling this page.",
  stopControl: "Stop",
  end: "End session",
};

import { effectiveLevel, type MaskLevel } from "./replay/config.js";

export interface MaskRules {
  strict: boolean;
  maskSelector?: string;
  blockSelector?: string;
}

export interface AssistDeps {
  cfg: AssistConfig;
  endpoint: string;
  key: string;
  sessionId: () => string;
  /** make sure the replay records, so the agent can watch live */
  startReplay: () => void;
  mask: () => MaskRules;
  /** the page node of a replay node id (rrweb mirror) */
  resolve?: (id: number) => Node | null;
  f?: typeof fetch;
  doc?: Document;
  /** whether a click is the user's own (default `isTrusted`); tests only */
  trusted?: (e: Event) => boolean;
  /** clock, for tests */
  now?: () => number;
}

export type Kind = "click" | "scroll" | "move" | "type" | "highlight";

export interface Command {
  seq: number;
  kind: Kind;
  x: number;
  y: number;
  dx: number;
  dy: number;
  node?: number | null;
  text?: string | null;
}

const UI = "data-wt-assist-ui";
/** Never a click target: form fields (so password, payment and every other input) and embedded docs. */
const NEVER = "input, textarea, select, option, label, [contenteditable]:not([contenteditable='false']), iframe, embed, object";
const ACTIVE_POLL_MS = 2000;
/** One control grant lasts this long, and ends sooner after this much silence. */
export const CONTROL_MAX_MS = 15 * 60_000;
export const CONTROL_IDLE_MS = 2 * 60_000;
/** Commands the page accepts per second, however many the server relays. */
const RATE_PER_S = 10;
const KINDS: readonly string[] = ["click", "scroll", "move", "type", "highlight"];
/** Input types that take plain text; everything else (password, file, hidden, checkbox ...) is refused. */
const TEXT_TYPES = new Set(["text", "search", "email", "tel", "url", "number"]);
/** Names that give away a payment, identity or secret field even when the type is text. */
const SECRET_NAME = /pass|pwd|card|cc-?(num|csc|exp)|cvv|cvc|iban|account.?n|routing|ssn|social|otp|one.?time|token|secret|pin\b/i;
const SECRET_AUTOCOMPLETE = /(^|\s)(cc-|current-password|new-password|one-time-code)/;

/** The rules of the effective replay mask level, so remote control never acts where replay masks. */
export function maskRules(local: MaskLevel | undefined, remote: MaskLevel | undefined, maskSelector?: string, blockSelector?: string): MaskRules {
  return { strict: effectiveLevel(local, remote) === "strict", maskSelector, blockSelector };
}

/** Not this UI, not blocked, not masked (strict masks all text but explicitly unmasked parts). */
function visible(el: Element, m: MaskRules): boolean {
  if (el.closest(`[${UI}]`)) return false;
  if (el.closest(`.wt-block, [data-wt-block]${m.blockSelector ? `, ${m.blockSelector}` : ""}`)) return false;
  if (m.strict) return !!el.closest("[data-wt-unmask]");
  return !el.closest(`.wt-mask, [data-wt-mask]${m.maskSelector ? `, ${m.maskSelector}` : ""}`);
}

/** The element a remote click may act on, or null when it must not be touched. */
export function safeTarget(el: Element | null, m: MaskRules): Element | null {
  if (!el || el.closest(NEVER)) return null;
  return visible(el, m) ? el : null;
}

/** The field a remote `type` may fill, or null: only plain, enabled, unmasked text fields. */
export function typable(el: Element | null, m: MaskRules): HTMLInputElement | HTMLTextAreaElement | null {
  if (!el || !visible(el, m) || el.closest("iframe, embed, object")) return null;
  const tag = el.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA") return null;
  const f = el as HTMLInputElement | HTMLTextAreaElement;
  if (f.disabled || f.readOnly) return null;
  if (tag === "INPUT" && !TEXT_TYPES.has((f.getAttribute("type") ?? "text").toLowerCase())) return null;
  if (SECRET_AUTOCOMPLETE.test((f.getAttribute("autocomplete") ?? "").toLowerCase())) return null;
  if (SECRET_NAME.test(`${f.name} ${f.id} ${f.getAttribute("inputmode") === "numeric" ? f.placeholder : ""}`)) return null;
  return f;
}

/** A well-formed command, or null: a closed set of kinds, bounded numbers, short plain text. */
export function validate(c: unknown): Command | null {
  const o = c as Partial<Command> | null;
  if (!o || typeof o !== "object" || typeof o.kind !== "string" || !KINDS.includes(o.kind)) return null;
  const num = (v: unknown, lo: number, hi: number): boolean => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
  const node = o.node ?? null;
  if (node !== null && !(Number.isInteger(node) && num(node, 1, 2 ** 31 - 1))) return null;
  if (!num(o.x, 0, 1) || !num(o.y, 0, 1) || !num(o.dx ?? 0, -5000, 5000) || !num(o.dy ?? 0, -5000, 5000)) return null;
  const text = o.text ?? null;
  // eslint-disable-next-line no-control-regex
  if (text !== null && (typeof text !== "string" || text.length > 200 || /[\u0000-\u001f\u007f]/.test(text))) return null;
  if (o.kind === "type" && (node === null || !text)) return null;
  return { seq: Number(o.seq) || 0, kind: o.kind as Kind, x: o.x as number, y: o.y as number, dx: o.dx ?? 0, dy: o.dy ?? 0, node, text };
}

/** The element a command points at: its replay node when it has one (no fallback), else the point. */
function targetOf(c: Command, doc: Document, resolve?: (id: number) => Node | null): Element | null {
  if (c.node != null) {
    const n = resolve?.(c.node) ?? null;
    const el = n && (n.nodeType === 1 ? (n as Element) : n.parentElement);
    return el && el.isConnected && el.ownerDocument === doc ? el : null;
  }
  const win = doc.defaultView;
  return win ? doc.elementFromPoint(c.x * win.innerWidth, c.y * win.innerHeight) : null;
}

/** A pointer dot or outline in the shadow UI, gone after a moment; the page's own DOM is untouched. */
function mark(doc: Document, r: DOMRect, label?: string | null): void {
  const host = doc.createElement("div");
  host.setAttribute(UI, "");
  host.className = "wt-block";
  const box = host.attachShadow({ mode: "open" });
  const d = doc.createElement("div");
  d.style.cssText = `position:fixed;z-index:2147483646;pointer-events:none;left:${r.left}px;top:${r.top}px;` +
    `width:${Math.max(r.width, 12)}px;height:${Math.max(r.height, 12)}px;outline:3px solid #f5a300;border-radius:4px;` +
    "font:12px system-ui,sans-serif;color:#111";
  if (label) {
    const t = doc.createElement("span");
    t.textContent = label;
    t.style.cssText = "position:absolute;top:100%;left:0;background:#f5a300;padding:1px 6px;border-radius:3px;white-space:nowrap";
    d.appendChild(t);
  }
  box.appendChild(d);
  doc.body.appendChild(host);
  setTimeout(() => host.remove(), 3000);
}

/** Runs one command; false when it was refused. `c` must already pass `validate`. */
export function run(c: Command, m: MaskRules, doc: Document = document, resolve?: (id: number) => Node | null): boolean {
  const win = doc.defaultView;
  if (!win) return false;
  const found = targetOf(c, doc, resolve);
  if (c.kind === "type") {
    const f = typable(found, m);
    if (!f || !c.text) return false;
    const room = f.maxLength > 0 ? f.maxLength - f.value.length : 2000 - f.value.length;
    if (room <= 0) return false;
    const proto = f.tagName === "INPUT" ? win.HTMLInputElement.prototype : win.HTMLTextAreaElement.prototype;
    // the native setter, so frameworks that track the value see the change
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(f, f.value + c.text.slice(0, room));
    f.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  const el = safeTarget(found, m);
  if (!el) return false;
  if (c.kind === "move" || c.kind === "highlight") {
    mark(doc, el.getBoundingClientRect(), c.kind === "highlight" ? c.text : null);
    return true;
  }
  if (c.kind === "click") {
    const r = el.getBoundingClientRect();
    const px = c.node != null ? r.left + r.width / 2 : c.x * win.innerWidth;
    const py = c.node != null ? r.top + r.height / 2 : c.y * win.innerHeight;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: win, clientX: px, clientY: py }));
    return true;
  }
  const dx = Math.max(-5000, Math.min(5000, c.dx | 0));
  const dy = Math.max(-5000, Math.min(5000, c.dy | 0));
  for (let p: Element | null = el; p && p !== doc.documentElement; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight || p.scrollWidth > p.clientWidth) {
      const o = win.getComputedStyle(p).overflowY + win.getComputedStyle(p).overflowX;
      if (/auto|scroll/.test(o)) {
        p.scrollBy(dx, dy);
        return true;
      }
    }
  }
  win.scrollBy(dx, dy);
  return true;
}

/** Sliding one-second window: false once `RATE_PER_S` commands ran within the last second. */
export function limiter(now: () => number = Date.now): () => boolean {
  let at: number[] = [];
  return () => {
    const t = now();
    at = at.filter((x) => t - x < 1000);
    if (at.length >= RATE_PER_S) return false;
    at.push(t);
    return true;
  };
}

type Btn = [label: string, onClick: () => void];

/** A fixed panel in its own shadow root, outside the page's tree and blocked in replay (`wt-block`). */
function panel(doc: Document, role: "dialog" | "status", text: string, buttons: Btn[], trusted: (e: Event) => boolean): HTMLElement {
  const host = doc.createElement("div");
  host.setAttribute(UI, "");
  host.className = "wt-block";
  const root = host.attachShadow({ mode: "open" });
  const box = doc.createElement("div");
  box.setAttribute("role", role);
  if (role === "dialog") box.setAttribute("aria-modal", "false");
  box.setAttribute("aria-label", text);
  box.style.cssText = "position:fixed;z-index:2147483647;left:50%;transform:translateX(-50%);" +
    `${role === "status" ? "top:0" : "bottom:16px"};background:#111;color:#fff;font:14px/1.4 system-ui,sans-serif;` +
    "padding:10px 14px;border-radius:6px;box-shadow:0 2px 12px rgba(0,0,0,.4);display:flex;gap:10px;align-items:center;max-width:90vw";
  const p = doc.createElement("span");
  p.textContent = text;
  box.appendChild(p);
  for (const [label, on] of buttons) {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText = "font:inherit;padding:4px 10px;border-radius:4px;border:1px solid #fff;background:#fff;color:#111;cursor:pointer";
    b.addEventListener("click", (e) => {
      // a synthetic (remote) click never answers a consent prompt
      if (!trusted(e)) return;
      on();
    });
    box.appendChild(b);
  }
  root.appendChild(box);
  doc.body.appendChild(host);
  return host;
}

export interface AssistHandle {
  stop(): void;
}

export function startAssist(d: AssistDeps): AssistHandle {
  const f = d.f ?? fetch.bind(globalThis);
  const doc = d.doc ?? document;
  const now = d.now ?? Date.now;
  const trusted = d.trusted ?? ((e: Event) => e.isTrusted);
  const L: AssistLabels = { ...DEFAULT_LABELS, ...d.cfg.labels };
  const base = d.endpoint.replace(/\/$/, "");
  const auth = { Authorization: `Bearer ${d.key}` };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ui: HTMLElement[] = [];

  const post = (path: string, body: unknown): Promise<Response> =>
    f(`${base}/v1/rum/assist/${path}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
  const later = (fn: () => void, ms: number): void => {
    if (!stopped) timer = setTimeout(fn, ms);
  };
  const clear = (): void => {
    ui.forEach((e) => e.remove());
    ui = [];
  };

  const pending = async (): Promise<void> => {
    if (stopped) return;
    try {
      const r = await f(`${base}/v1/rum/assist?session=${encodeURIComponent(d.sessionId())}`, { headers: auth });
      if (r.status === 404) return; // assist is off for this project: stop polling
      if (r.status === 200) {
        const o = (await r.json()) as { id: string; token: string };
        offer(o.id, o.token);
        return;
      }
    } catch {
      /* offline: try again later */
    }
    later(() => void pending(), d.cfg.pollMs ?? 5000);
  };

  const offer = (id: string, token: string): void => {
    clear();
    ui.push(panel(doc, "dialog", L.request, [
      [L.accept, () => void accept(id, token)],
      [L.decline, () => {
        clear();
        void post(`${id}/decline`, { token }).catch(() => undefined);
        later(() => void pending(), d.cfg.pollMs ?? 5000);
      }],
    ], trusted));
  };

  const accept = async (id: string, token: string): Promise<void> => {
    clear();
    try {
      const r = await post(`${id}/accept`, { token });
      if (r.ok) {
        const { channel } = (await r.json()) as { channel: string };
        d.startReplay();
        active(id, channel);
        return;
      }
    } catch {
      /* fall through: back to waiting */
    }
    later(() => void pending(), d.cfg.pollMs ?? 5000);
  };

  const active = (id: string, channel: string): void => {
    let after = 0;
    let control = "none";
    let asking = false;
    let over = false;
    // true only between the user's own "Allow" and the end of that grant; the server alone cannot start control
    let consented = false;
    let grantedAt = 0;
    let lastAt = 0;
    const allowed = limiter(now);
    const end = (): void => {
      over = true;
      clear();
      void post(`${id}/end`, { channel }).catch(() => undefined);
      if (timer) clearTimeout(timer);
      later(() => void pending(), d.cfg.pollMs ?? 5000);
    };
    const banner = (): void => {
      clear();
      const btns: Btn[] = control === "granted"
        ? [[L.stopControl, () => stopControl()], [L.end, end]]
        : [[L.end, end]];
      ui.push(panel(doc, "status", control === "granted" ? `${L.banner} ${L.controlOn}` : L.banner, btns, trusted));
    };
    const stopControl = (): void => {
      consented = false;
      asking = false;
      control = "none";
      void post(`${id}/control`, { channel, grant: false }).catch(() => undefined);
      banner();
    };
    const answer = (grant: boolean): void => {
      consented = grant;
      grantedAt = lastAt = now();
      void post(`${id}/control`, { channel, grant }).catch(() => undefined);
      if (!grant) {
        asking = false;
        control = "none";
      } // on a grant `asking` stays set until the poll shows it
      banner();
    };
    banner();
    const tick = async (): Promise<void> => {
      if (stopped || over) return;
      try {
        const r = await post(`${id}/poll`, { channel, after });
        if (over) return;
        if (r.status === 404) {
          over = true;
          clear(); // ended by the agent, by expiry or because the project turned assist off
          later(() => void pending(), d.cfg.pollMs ?? 5000);
          return;
        }
        if (r.ok) {
          const s = (await r.json()) as { control: string; commands: unknown[] };
          if (s.control === "granted" && !consented) {
            void post(`${id}/control`, { channel, grant: false }).catch(() => undefined); // never a grant the user did not give
            s.control = "none";
          }
          if (s.control === "requested" && !d.cfg.allowControl) {
            void post(`${id}/control`, { channel, grant: false }).catch(() => undefined); // this page does not allow control: no prompt
            s.control = "none";
          }
          if (s.control !== control) {
            control = s.control;
            if (control !== "requested") asking = false;
            banner();
          }
          if (control === "requested" && !asking) {
            asking = true;
            ui.push(panel(doc, "dialog", L.controlRequest, [[L.allow, () => answer(true)], [L.deny, () => answer(false)]], trusted));
          }
          if (control === "granted" && (now() - grantedAt > CONTROL_MAX_MS || now() - lastAt > CONTROL_IDLE_MS)) stopControl();
          for (const raw of s.commands) {
            const c = validate(raw);
            after = Math.max(after, Number((raw as { seq?: number } | null)?.seq) || 0);
            if (c && control === "granted" && allowed() && run(c, d.mask(), doc, d.resolve)) lastAt = now();
          }
        }
      } catch {
        /* keep polling */
      }
      later(() => void tick(), ACTIVE_POLL_MS);
    };
    later(() => void tick(), ACTIVE_POLL_MS);
  };

  void pending();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      clear();
    },
  };
}
