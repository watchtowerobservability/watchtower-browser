/**
 * Co-browse assist (RPL-012), a lazy chunk loaded only with `assist: { enabled: true }`; the
 * project must also turn it on (the edge answers 404 otherwise and polling stops).
 *
 * Consent: nothing happens until the end user accepts the in-page prompt. While an assist runs a
 * banner stays visible with an End button. Replay masking is unchanged: the agent sees the same
 * masked replay as always. Remote control is a second prompt; once granted the agent can only
 * click and scroll, and only on elements that are not inputs (so never password or payment
 * fields), not masked or blocked, and not this UI. Typing has no command at all.
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
  /** pending-request poll interval, default 5000 ms */
  pollMs?: number;
  labels?: Partial<AssistLabels>;
}

export const DEFAULT_LABELS: AssistLabels = {
  request: "Support asks to view this page with you. Text and inputs stay masked.",
  accept: "Allow",
  decline: "Decline",
  banner: "Support is viewing this page (masked).",
  controlRequest: "Support asks to click and scroll for you. Typing is never allowed.",
  allow: "Allow control",
  deny: "Deny",
  controlOn: "Support can click and scroll.",
  stopControl: "Stop control",
  end: "End session",
};

import { effectiveLevel, type MaskLevel } from "./replay/config";

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
  f?: typeof fetch;
  doc?: Document;
}

export interface Command {
  seq: number;
  kind: "click" | "scroll";
  x: number;
  y: number;
  dx: number;
  dy: number;
}

const UI = "data-wt-assist-ui";
/** Never a target: form fields (so password, payment and every other input) and embedded docs. */
const NEVER = "input, textarea, select, option, label, [contenteditable]:not([contenteditable='false']), iframe, embed, object";
const ACTIVE_POLL_MS = 2000;

/** The element a remote command may act on, or null when it must not be touched. */
/** The rules of the effective replay mask level, so remote control never acts where replay masks. */
export function maskRules(local: MaskLevel | undefined, remote: MaskLevel | undefined, maskSelector?: string, blockSelector?: string): MaskRules {
  return { strict: effectiveLevel(local, remote) === "strict", maskSelector, blockSelector };
}

export function safeTarget(el: Element | null, m: MaskRules): Element | null {
  if (!el) return null;
  if (el.closest(`[${UI}]`) || el.closest(NEVER)) return null;
  if (el.closest(`.wt-block, [data-wt-block]${m.blockSelector ? `, ${m.blockSelector}` : ""}`)) return null;
  // strict masks all text except explicitly unmasked parts
  if (m.strict) return el.closest("[data-wt-unmask]") ? el : null;
  if (el.closest(`.wt-mask, [data-wt-mask]${m.maskSelector ? `, ${m.maskSelector}` : ""}`)) return null;
  return el;
}

/** Runs one command; false when it was refused. */
export function run(c: Command, m: MaskRules, doc: Document = document): boolean {
  const win = doc.defaultView;
  if (!win || !(c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1)) return false;
  const px = c.x * win.innerWidth;
  const py = c.y * win.innerHeight;
  const el = safeTarget(doc.elementFromPoint(px, py), m);
  if (!el) return false;
  if (c.kind === "click") {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: win, clientX: px, clientY: py }));
    return true;
  }
  if (c.kind !== "scroll") return false;
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

type Btn = [label: string, onClick: () => void];

/** A fixed panel outside the page's own tree, blocked in replay (`wt-block`). */
function panel(doc: Document, role: "dialog" | "status", text: string, buttons: Btn[]): HTMLElement {
  const box = doc.createElement("div");
  box.setAttribute(UI, "");
  box.className = "wt-block";
  box.setAttribute("role", role);
  if (role === "dialog") box.setAttribute("aria-modal", "false");
  box.setAttribute("aria-label", text);
  box.style.cssText = "position:fixed;z-index:2147483647;left:50%;transform:translateX(-50%);" +
    `${role === "status" ? "top:0" : "bottom:16px"};background:#111;color:#fff;font:14px/1.4 system-ui,sans-serif;` +
    "padding:10px 14px;border-radius:6px;box-shadow:0 2px 12px rgba(0,0,0,.4);display:flex;gap:10px;align-items:center";
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
      if (!e.isTrusted) return;
      on();
    });
    box.appendChild(b);
  }
  doc.body.appendChild(box);
  return box;
}

export interface AssistHandle {
  stop(): void;
}

export function startAssist(d: AssistDeps): AssistHandle {
  const f = d.f ?? fetch.bind(globalThis);
  const doc = d.doc ?? document;
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
    ]));
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
        ? [[L.stopControl, () => void post(`${id}/control`, { channel, grant: false }).catch(() => undefined)], [L.end, end]]
        : [[L.end, end]];
      ui.push(panel(doc, "status", control === "granted" ? `${L.banner} ${L.controlOn}` : L.banner, btns));
    };
    const answer = (grant: boolean): void => {
      asking = false;
      void post(`${id}/control`, { channel, grant }).catch(() => undefined);
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
          const s = (await r.json()) as { control: string; commands: Command[] };
          if (s.control !== control) {
            control = s.control;
            banner();
          }
          if (control === "requested" && !asking) {
            asking = true;
            ui.push(panel(doc, "dialog", L.controlRequest, [[L.allow, () => answer(true)], [L.deny, () => answer(false)]]));
          }
          for (const c of s.commands) {
            after = Math.max(after, c.seq);
            if (control === "granted") run(c, d.mask(), doc);
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
