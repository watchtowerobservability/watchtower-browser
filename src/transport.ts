import { LIMITS, type Attrs, type RumEventV1 } from "./config";
import { BoundedQueue, type OfflineStore } from "./queue";

/** Everything in a `RumBatchV1` except the tenant ids (stamped by the edge) and the events. */
export interface Envelope {
  session_id: string;
  sent_at_ns: number;
  sdk: { name: string; version: string };
  app: { service: string; release?: string; env?: string };
  page: { url: string; route?: string; referrer?: string };
  device: { ua: string; viewport?: [number, number]; dpr?: number; connection?: string };
  user: { id_hash?: string };
  attrs: Attrs;
}

export interface TransportOpts {
  endpoint: string;
  key: string;
  envelope: () => Envelope;
  fetch?: typeof fetch;
  beacon?: (url: string, data: Blob) => boolean;
  random?: () => number;
  now?: () => number;
  /** awaited before each send (e.g. pending user-id hash) */
  beforeFlush?: () => Promise<void>;
  /** durable store for batches that could not be sent; drained back into the queue on start and after a success */
  offline?: OfflineStore<RumEventV1>;
  /** called for every batch the server refused for good (4xx other than 429) */
  onReject?: (status: number, events: number) => void;
}

async function encode(body: string): Promise<{ data: BodyInit; gzip: boolean }> {
  const bytes = new TextEncoder().encode(body);
  if (bytes.length > LIMITS.gzipMinBytes && typeof CompressionStream === "function") {
    try {
      const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
      return { data: await new Response(s).arrayBuffer(), gzip: true };
    } catch {
      /* fall through to plain */
    }
  }
  return { data: body, gzip: false };
}

export class Transport {
  readonly queue = new BoundedQueue<RumEventV1>(LIMITS.queueMax);
  private started = false;
  private busy = false;
  private failures = 0;
  /** events refused with a permanent 4xx (413, 422, ...), by status; reported in `wt.sdk.rejected` */
  readonly rejected: Record<number, number> = {};
  private retryAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private url: string;
  private now: () => number;

  constructor(private o: TransportOpts) {
    this.url = `${o.endpoint.replace(/\/$/, "")}/v1/rum/events`;
    this.now = o.now ?? Date.now;
  }

  /** Begin sending (after remote config resolves). */
  start(): void {
    this.started = true;
    void this.restore();
    if (this.queue.length) this.schedule();
  }

  push(e: RumEventV1): void {
    this.queue.push(e);
    if (!this.started) return;
    if (this.queue.length >= LIMITS.flushEvents) void this.flush();
    else this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    const wait = Math.max(LIMITS.flushMs, this.retryAt - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, wait);
  }

  private async restore(): Promise<void> {
    try {
      const saved = (await this.o.offline?.drain()) ?? [];
      if (!saved.length) return;
      this.queue.requeue(saved);
      this.schedule();
    } catch {
      /* offline storage is best effort */
    }
  }

  private body(events: RumEventV1[]): string {
    const env = this.o.envelope();
    if (this.queue.dropped) env.attrs["wt.sdk.dropped"] = this.queue.dropped;
    const rej = Object.entries(this.rejected);
    if (rej.length) env.attrs["wt.sdk.rejected"] = rej.map(([k, v]) => `${k}:${v}`).join(",");
    return JSON.stringify({ ...env, events });
  }

  /** Send one batch. Never throws. `force` ignores the backoff window (shutdown). */
  async flush(force = false): Promise<void> {
    if (!this.started || this.busy || !this.queue.length) return;
    if (!force && this.now() < this.retryAt) return this.schedule();
    this.busy = true;
    const batch = this.queue.take(LIMITS.flushEvents);
    try {
      await this.o.beforeFlush?.();
      const { data, gzip } = await encode(this.body(batch));
      const f = this.o.fetch ?? globalThis.fetch.bind(globalThis);
      const r = await f(this.url, {
        method: "POST",
        body: data,
        keepalive: true,
        headers: {
          Authorization: `Bearer ${this.o.key}`,
          "Content-Type": "application/json",
          ...(gzip ? { "Content-Encoding": "gzip" } : {}),
        },
      });
      this.handle(r.status, r.headers?.get("Retry-After") ?? null, batch);
    } catch {
      await this.park(batch);
    } finally {
      this.busy = false;
    }
    if (this.queue.length) this.schedule();
  }

  private handle(status: number, retryAfter: string | null, batch: RumEventV1[]): void {
    if (status < 300) {
      this.failures = 0;
      void this.restore();
    } else if (status === 429 || status >= 500) {
      this.backoff(batch, retryAfter);
    } else {
      // other 4xx (413, 422): the batch is invalid, retrying cannot help. Dropped, but counted and surfaced.
      this.rejected[status] = (this.rejected[status] ?? 0) + batch.length;
      this.o.onReject?.(status, batch.length);
    }
  }

  /** Network failure: persist the batch when a store exists (and back off), else requeue in memory. */
  private async park(batch: RumEventV1[]): Promise<void> {
    if (this.o.offline) {
      try {
        await this.o.offline.save(batch);
        this.backoff([], null);
        return;
      } catch {
        /* fall through to memory */
      }
    }
    this.backoff(batch, null);
  }

  private backoff(batch: RumEventV1[], retryAfter: string | null): void {
    this.queue.requeue(batch);
    const secs = retryAfter === null ? NaN : Number(retryAfter);
    const jitter = 0.5 + (this.o.random ?? Math.random)() / 2;
    const exp = Math.min(LIMITS.backoffMaxMs, 1000 * 2 ** this.failures) * jitter;
    this.failures++;
    this.retryAt = this.now() + (Number.isFinite(secs) ? Math.min(secs * 1000, LIMITS.backoffMaxMs) : exp);
  }

  /** Unload path: synchronous `sendBeacon` (key in `?k=`, a public key), `fetch keepalive` if refused. */
  flushBeacon(): void {
    if (!this.started) return;
    while (this.queue.length) {
      const batch = this.queue.take(LIMITS.flushEvents);
      const body = this.body(batch);
      const url = `${this.url}?k=${encodeURIComponent(this.o.key)}`;
      const send = this.o.beacon ?? (typeof navigator !== "undefined" ? navigator.sendBeacon?.bind(navigator) : undefined);
      let ok = false;
      try {
        ok = send ? send(url, new Blob([body], { type: "text/plain" })) : false;
      } catch {
        /* fall through */
      }
      if (!ok) {
        try {
          void (this.o.fetch ?? globalThis.fetch.bind(globalThis))(this.url, {
            method: "POST",
            body,
            keepalive: true,
            headers: { Authorization: `Bearer ${this.o.key}`, "Content-Type": "application/json" },
          }).catch(() => undefined);
        } catch {
          /* best effort */
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    while (this.queue.length) {
      const before = this.queue.length;
      await this.flush(true);
      if (this.queue.length >= before) break; // failed: do not spin
    }
  }
}
