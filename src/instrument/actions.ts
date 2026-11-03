import { ROOT_CONTEXT, trace, type Context, type ContextManager, type Span, type Tracer } from "@opentelemetry/api";
import { selectorOf, type Ctx, type Uninstall } from "./ctx";

/** An action ends this long after its last child span ended, or at the hard cap. */
export const ACTION_IDLE_MS = 100;
export const ACTION_MAX_MS = 10_000;

/**
 * Stack context manager (like OTel's) whose fallback is the open user action: a fetch or XHR the
 * app starts from its own click handler, with no context passing, gets the action span as parent.
 */
export class ActionContextManager implements ContextManager {
  private stack: Context[] = [];
  action?: Context;
  active(): Context {
    return this.stack[this.stack.length - 1] ?? this.action ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(c: Context, fn: F, thisArg?: ThisParameterType<F>, ...args: A): ReturnType<F> {
    this.stack.push(c);
    try {
      return fn.call(thisArg, ...args);
    } finally {
      this.stack.pop();
    }
  }
  bind<T>(c: Context, target: T): T {
    if (typeof target !== "function") return target;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return function (this: unknown, ...a: unknown[]) {
      return self.with(c, () => (target as (...x: unknown[]) => unknown).apply(this, a));
    } as T;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    this.stack = [];
    this.action = undefined;
    return this;
  }
}

const nameOf = (el: Element): string =>
  el.closest("[data-wt-action]")?.getAttribute("data-wt-action")?.slice(0, 128) || selectorOf(el, 128);

/**
 * Automatic user-action spans (Faro userActions parity): click, submit or Enter opens a
 * `user_action` span; spans started while it is open are its children; it ends once they have
 * all ended and nothing new started for 100 ms (cap 10 s). One RUM `action` event carries the
 * duration and the trace. This is an interaction trace, not an analytics funnel.
 */
export function installUserActions(ctx: Ctx, tracer: Tracer, cm: ActionContextManager): {
  uninstall: Uninstall;
  onStart(s: Span, parent: Context): void;
  onEnd(s: Span): void;
} {
  let open: { span: Span; start: number; pending: Set<string>; children: number; idle?: ReturnType<typeof setTimeout>; cap: ReturnType<typeof setTimeout>; name: string; type: string } | undefined;
  const finish = (): void => {
    if (!open) return;
    const a = open;
    open = undefined;
    cm.action = undefined;
    clearTimeout(a.idle);
    clearTimeout(a.cap);
    a.span.end();
    const sc = a.span.spanContext();
    ctx.emit("action", a.name, {
      value: Date.now() - a.start,
      trace_id: sc.traceId,
      span_id: sc.spanId,
      attrs: { "wt.kind": "user_action", "user_action.type": a.type, "user_action.children": a.children },
    });
  };
  const idle = (): void => {
    if (!open || open.pending.size) return;
    clearTimeout(open.idle);
    open.idle = setTimeout(finish, ACTION_IDLE_MS);
  };
  const begin = (type: string, target: EventTarget | null): void => {
    if (!(target instanceof Element)) return;
    finish(); // a new interaction closes the previous one
    const name = nameOf(target);
    const span = tracer.startSpan("user_action", {
      attributes: { "user_action.type": type, "user_action.name": name, "view.route": ctx.route() },
    }, ROOT_CONTEXT);
    open = { span, start: Date.now(), pending: new Set(), children: 0, name, type, cap: setTimeout(finish, ACTION_MAX_MS) };
    cm.action = trace.setSpan(ROOT_CONTEXT, span);
    idle();
  };
  const onClick = (e: Event): void => begin("click", e.target);
  const onSubmit = (e: Event): void => begin("submit", e.target);
  const onKey = (e: Event): void => {
    if ((e as KeyboardEvent).key === "Enter") begin("keydown", e.target);
  };
  document.addEventListener("click", onClick, true);
  document.addEventListener("submit", onSubmit, true);
  document.addEventListener("keydown", onKey, true);
  return {
    uninstall: () => {
      finish();
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("keydown", onKey, true);
    },
    onStart: (s, parent) => {
      if (!open || s === open.span || trace.getSpan(parent) !== open.span) return;
      open.children++;
      open.pending.add(s.spanContext().spanId);
      clearTimeout(open.idle);
    },
    onEnd: (s) => {
      if (!open || !open.pending.delete(s.spanContext().spanId)) return;
      idle();
    },
  };
}
