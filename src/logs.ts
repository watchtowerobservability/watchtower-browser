import type { Attrs } from "./config";

export type LogLevel = "debug" | "log" | "info" | "warn" | "error";

const SEVERITY: Record<LogLevel, number> = { debug: 5, log: 9, info: 9, warn: 13, error: 17 };
const MAX_BUFFER = 200;
const FLUSH_AT = 50;
const FLUSH_MS = 5000;

const kv = (a: Attrs) => Object.entries(a).filter(([, v]) => v !== undefined && v !== null).map(([key, v]) => ({
  key,
  value: typeof v === "boolean" ? { boolValue: v } : { stringValue: String(v) },
}));

/** Real OTLP log records (POST /v1/logs on the gateway, JSON), so the logs views show them. */
export class LogShipper {
  private buf: unknown[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private warned = false;

  constructor(private readonly base: string, private readonly key: string, private readonly resource: Attrs) {}

  /** Once, whatever `debug` says: losing logs is not something to hide behind a flag. */
  private warn(why: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[watchtower] log records are not being delivered (${why}); set otlpEndpoint or WT_EDGE_OTLP_URL on the edge`);
  }

  push(level: LogLevel, message: string, attrs: Attrs, span?: { trace_id?: string; span_id?: string }): void {
    if (this.buf.length >= MAX_BUFFER) return;
    this.buf.push({
      timeUnixNano: `${Date.now()}000000`,
      severityNumber: SEVERITY[level] ?? 9,
      severityText: level.toUpperCase(),
      body: { stringValue: message },
      attributes: kv(attrs),
      ...(span?.trace_id ? { traceId: span.trace_id } : {}),
      ...(span?.span_id ? { spanId: span.span_id } : {}),
    });
    if (this.buf.length >= FLUSH_AT) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), FLUSH_MS);
  }

  discard(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.buf = [];
  }

  /** shortcut: a failed POST drops its records (no retry or offline queue), add one if logs prove lossy. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.buf.length) return;
    const logRecords = this.buf.splice(0);
    let url: string;
    try {
      url = `${new URL(this.base).href.replace(/\/$/, "")}/v1/logs`;
    } catch {
      return this.warn(`bad endpoint ${this.base}`);
    }
    const body = JSON.stringify({
      resourceLogs: [{ resource: { attributes: kv(this.resource) }, scopeLogs: [{ scope: { name: "watchtower-browser" }, logRecords }] }],
    });
    try {
      // keepalive survives page hide; sendBeacon cannot carry the Authorization header
      const r = await fetch(url, {
        method: "POST", keepalive: body.length < 60_000,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` }, body,
      });
      if (r.status === 404 || r.status === 405) this.warn(`HTTP ${r.status} from ${url}`);
    } catch {
      this.warn(`no answer from ${url}`);
    }
  }
}
