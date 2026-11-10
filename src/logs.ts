import { LIMITS, type Attrs } from "./config";
import type { OfflineStore } from "./queue";

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
  private failures = 0;
  private retryAt = 0;
  private parked = false;

  /**
   * `offline` holds batches the network refused (delivery is at-least-once: a lost response resends).
   * It is read back after a successful POST or a retry of this session's own failure, so records stored
   * by an earlier page never leave before logging is on again.
   */
  constructor(
    private readonly base: string,
    private readonly key: string,
    private readonly resource: Attrs,
    private readonly offline?: OfflineStore<unknown>,
    private readonly random: () => number = Math.random,
  ) {}

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
    if (this.buf.length >= FLUSH_AT && Date.now() >= this.retryAt) void this.flush();
    else this.arm();
  }

  private arm(): void {
    this.timer ??= setTimeout(() => void this.flush(), Math.max(FLUSH_MS, this.retryAt - Date.now()));
  }

  discard(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.buf = [];
    this.parked = false;
    void this.offline?.drain().catch(() => undefined);
  }

  /** Batch goes back to the front of the buffer (bounded), the next try waits with backoff or `Retry-After`. */
  private backoff(records: unknown[], retryAfter: string | null): void {
    this.buf = [...records, ...this.buf].slice(0, MAX_BUFFER);
    // A timer armed by a push during the failed POST would retry too early.
    clearTimeout(this.timer);
    this.timer = undefined;
    const secs = retryAfter === null ? NaN : Number(retryAfter);
    const exp = Math.min(LIMITS.backoffMaxMs, 1000 * 2 ** this.failures) * (0.5 + this.random() / 2);
    this.failures++;
    this.retryAt = Date.now() + (Number.isFinite(secs) ? Math.min(secs * 1000, LIMITS.backoffMaxMs) : exp);
    this.arm();
  }

  /** Network failure: keep the batch across page loads when a store exists, else in memory. */
  private async park(records: unknown[]): Promise<void> {
    try {
      if (this.offline) {
        await this.offline.save(records);
        this.parked = true;
        return this.backoff([], null);
      }
    } catch {
      /* fall through to memory */
    }
    this.backoff(records, null);
  }

  private async restore(): Promise<void> {
    try {
      const saved = (await this.offline?.drain()) ?? [];
      const room = Math.max(0, MAX_BUFFER - this.buf.length);
      this.buf.push(...saved.slice(0, room));
      if (saved.length > room) await this.offline?.save(saved.slice(room));
      if (this.buf.length) this.arm();
    } catch {
      /* offline storage is best effort */
    }
  }

  /** Sends now, ignoring any backoff window (the page may be going away). Never throws. */
  async flush(): Promise<void> {
    // Only this session's own failure brings stored records back without a success first.
    if (!this.buf.length && this.parked) {
      this.parked = false;
      await this.restore();
    }
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
      if (r.status < 300) {
        this.failures = 0;
        this.retryAt = 0;
        await this.restore();
      } else if (r.status === 429 || r.status >= 500) {
        this.backoff(logRecords, r.headers?.get("Retry-After") ?? null);
      } else {
        // Other 4xx: the batch or the endpoint is wrong, a retry cannot help.
        this.warn(`HTTP ${r.status} from ${url}`);
      }
    } catch {
      this.warn(`no answer from ${url}`);
      await this.park(logRecords);
    }
  }
}
