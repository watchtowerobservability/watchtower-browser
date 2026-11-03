/**
 * User feedback (ERR-014), a lazy chunk: `client.feedback()` sends a message linked to the last
 * error, the session and its replay; `client.feedbackWidget()` adds an opt-in button and dialog
 * with an optional screenshot, and can open as a crash-report dialog after an error. The name and
 * email are turned into pseudonyms at the edge; the screenshot goes with a bug report of the
 * session (`/v1/rum/bug-reports`), so it sits next to the replay.
 */

export interface Feedback {
  message: string;
  name?: string;
  email?: string;
  /** Error event this is about; default: the last error the SDK captured. */
  eventId?: string;
  /** `data:image/png|jpeg;base64,...`, at most 4 MiB. */
  screenshot?: string;
}

export interface FeedbackWidgetOptions {
  /** Button text (default "Feedback"). */
  label?: string;
  /** Open the dialog as a crash report after each captured error (at most once a minute). */
  openOnError?: boolean;
  /** Ask for name and email (default true). */
  askContact?: boolean;
  /** Offer "Attach screenshot" (default true; the browser asks the user which screen to share). */
  screenshot?: boolean;
}

export interface FeedbackCtx {
  endpoint: string;
  key: string;
  sessionId(): string;
  lastErrorId(): string | undefined;
  flushReplay(): Promise<void>;
}

const MAX_SHOT = 4 << 20;
const MAX_MESSAGE = 4096;

/** The feedback request body; `null` when there is nothing to send. */
export function feedbackBody(f: Feedback, lastError: string | undefined): Record<string, string> | null {
  const message = String(f.message ?? "").trim().slice(0, MAX_MESSAGE);
  if (!message) return null;
  const body: Record<string, string> = { message };
  const id = (f.eventId ?? lastError ?? "").replace(/-/g, "");
  if (/^[0-9a-f]{32}$/i.test(id)) body.event_id = id.toLowerCase();
  if (f.name?.trim()) body.name = f.name.trim().slice(0, 256);
  if (f.email?.trim()) body.email = f.email.trim().slice(0, 256);
  return body;
}

/** A PNG/JPEG data URL within the edge's limit, or undefined. */
export function validShot(s: string | undefined): string | undefined {
  return s && /^data:image\/(png|jpeg);base64,/.test(s) && s.length * 0.75 <= MAX_SHOT ? s : undefined;
}

async function post(ctx: FeedbackCtx, path: string, body: unknown): Promise<boolean> {
  try {
    const r = await fetch(`${ctx.endpoint.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: path.endsWith("/feedback"),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Send feedback; resolves false when it was not accepted (never throws). */
export async function sendFeedback(ctx: FeedbackCtx, f: Feedback): Promise<boolean> {
  const body = feedbackBody(f, ctx.lastErrorId());
  if (!body) return false;
  const ok = await post(ctx, "/v1/rum/feedback", body);
  const shot = validShot(f.screenshot);
  if (ok && shot) {
    await ctx.flushReplay().catch(() => undefined);
    await post(ctx, "/v1/rum/bug-reports", {
      session_id: ctx.sessionId(),
      page_url: location.href.split("#")[0],
      description: body.message,
      user_agent: navigator.userAgent,
      screenshot: shot,
    });
  }
  return ok;
}

/** One frame of a screen the user picks, as a JPEG data URL at most 1600 px wide. */
export async function captureScreen(): Promise<string | undefined> {
  const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia?: (c: unknown) => Promise<MediaStream> };
  if (!md?.getDisplayMedia) return undefined;
  const stream = await md.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    const scale = Math.min(1, 1600 / (video.videoWidth || 1600));
    const c = document.createElement("canvas");
    c.width = Math.round((video.videoWidth || 1600) * scale);
    c.height = Math.round((video.videoHeight || 900) * scale);
    c.getContext("2d")?.drawImage(video, 0, 0, c.width, c.height);
    return validShot(c.toDataURL("image/jpeg", 0.8));
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

/** Mount the button and dialog; returns the widget's controls. */
export function mountWidget(ctx: FeedbackCtx, o: FeedbackWidgetOptions = {}): { open(crash?: boolean): void; remove(): void } {
  let shot: string | undefined;
  const status = el("p", { role: "status" } as Partial<HTMLParagraphElement>);
  const title = el("h2", { textContent: "Send feedback" });
  const message = el("textarea", { required: true, rows: 4, placeholder: "What happened?" });
  const name = el("input", { placeholder: "Name (optional)", autocomplete: "name" });
  const email = el("input", { type: "email", placeholder: "Email (optional)", autocomplete: "email" });
  const attach = el("button", { type: "button", textContent: "Attach screenshot" });
  const send = el("button", { type: "submit", textContent: "Send" });
  const cancel = el("button", { type: "button", textContent: "Cancel" });
  const form = el("form", {}, title, el("label", {}, "Message ", message));
  if (o.askContact !== false) form.append(el("label", {}, "Name ", name), el("label", {}, "Email ", email));
  if (o.screenshot !== false) form.append(attach);
  form.append(send, cancel, status);
  const dialog = el("dialog", {}, form);
  dialog.setAttribute("aria-label", "Feedback");
  dialog.dataset.watchtower = "feedback";
  const button = el("button", { type: "button", textContent: o.label ?? "Feedback" });
  button.dataset.watchtower = "feedback-button";
  button.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483646";
  const open = (crash = false): void => {
    title.textContent = crash ? "It looks like something went wrong" : "Send feedback";
    status.textContent = "";
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  };
  const close = (): void => {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  };
  button.addEventListener("click", () => open());
  cancel.addEventListener("click", close);
  attach.addEventListener("click", () => {
    void captureScreen().then((s) => {
      shot = s;
      status.textContent = s ? "Screenshot attached." : "No screenshot.";
    }, () => void (status.textContent = "No screenshot."));
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    send.disabled = true;
    void sendFeedback(ctx, { message: message.value, name: name.value, email: email.value, screenshot: shot }).then((ok) => {
      send.disabled = false;
      status.textContent = ok ? "Thank you!" : "Could not send, please try again.";
      if (ok) {
        message.value = "";
        shot = undefined;
        setTimeout(close, 1200);
      }
    });
  });
  document.body.append(button, dialog);
  return {
    open,
    remove: () => {
      button.remove();
      dialog.remove();
    },
  };
}
