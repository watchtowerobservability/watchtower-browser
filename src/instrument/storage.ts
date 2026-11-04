import type { Attrs, StorageConfig } from "../config";
import type { Ctx, Uninstall } from "./ctx";

/** Sync work on the main thread over one frame is jank. */
export const FRAME_MS = 16;
/** Where the `/storage` entry (sql.js, wa-sqlite) finds the running sink; separate bundles share no module state. */
export const SINK_KEY = Symbol.for("watchtower.storage");
/** The SDK's own offline queue (src/queue.ts) is never reported. */
const OWN_DB = "wt-offline";

export interface DbOp {
  system: string;
  operation: string;
  collection?: string;
  namespace?: string;
  ms: number;
  /** ran on the main thread (flagged `db.main_thread`); unless `async`, it blocked rendering, so one frame is the limit */
  mainThread?: boolean;
  /** settled later (a promise): its duration includes waiting, so `slowMs` applies */
  async?: boolean;
  error?: string;
  attrs?: Attrs;
}
export type Sink = (op: DbOp) => void;

/** Main thread = a window context (not a worker). */
export const onMainThread = (): boolean => typeof document !== "undefined";

/** Only slow or failed operations become `db` events: one per op would flood the queue. */
export function makeSink(ctx: Ctx, slowMs: number): Sink {
  return (op) => {
    const limit = op.mainThread && !op.async ? Math.min(slowMs, FRAME_MS) : slowMs;
    if (!op.error && op.ms < limit) return;
    const summary = [op.operation, op.collection].filter(Boolean).join(" ");
    ctx.emit("db", summary, {
      value: Math.round(op.ms),
      attrs: {
        ...op.attrs,
        "db.system.name": op.system,
        "db.operation.name": op.operation,
        "db.query.summary": summary,
        ...(op.collection ? { "db.collection.name": op.collection } : {}),
        ...(op.namespace ? { "db.namespace": op.namespace } : {}),
        ...(op.mainThread ? { "db.main_thread": true } : {}),
        ...(op.error ? { "error.type": op.error } : {}),
        route: ctx.route(),
      },
    });
  };
}

type Fn = (this: unknown, ...a: unknown[]) => unknown;
/** Replaces each method on `proto` and records how to put it back. */
function patch(proto: object | undefined, names: string[], wrap: (orig: Fn, name: string) => Fn, undo: Uninstall[]): void {
  if (!proto) return;
  const p = proto as Record<string, unknown>;
  for (const n of names) {
    const orig = p[n];
    if (typeof orig !== "function") continue;
    p[n] = wrap(orig as Fn, n);
    undo.push(() => void (p[n] = orig));
  }
}

const errName = (e: unknown): string => (e as { name?: string } | null)?.name || "Error";
const G = globalThis as unknown as Record<string, { prototype: object } | undefined>;

/** Times an IDBRequest to its first success or error (a cursor's later steps are the app's own loop). */
function watchRequest(req: IDBRequest, t0: number, done: (ms: number, error?: string) => void): void {
  let fired = false;
  const end = (error?: string): void => {
    if (fired) return;
    fired = true;
    done(performance.now() - t0, error);
  };
  req.addEventListener("success", () => end(), { once: true });
  req.addEventListener("error", () => end(req.error?.name ?? "Error"), { once: true });
}

const IDB_OPS = ["add", "put", "get", "getAll", "getAllKeys", "getKey", "delete", "clear", "count", "openCursor", "openKeyCursor"];

export function installIndexedDb(sink: Sink, undo: Uninstall[]): void {
  const system = "indexeddb";
  const wrapStore = (index: boolean) => (orig: Fn, operation: string): Fn =>
    function (this: unknown, ...a: unknown[]) {
      const t0 = performance.now();
      const req = orig.apply(this, a) as IDBRequest;
      const store = index ? (this as IDBIndex).objectStore : (this as IDBObjectStore);
      const namespace = store.transaction.db.name;
      if (namespace !== OWN_DB) {
        watchRequest(req, t0, (ms, error) => sink({ system, operation, collection: store.name, namespace, ms, error,
          ...(index ? { attrs: { "db.indexeddb.index": (this as IDBIndex).name } } : {}) }));
      }
      return req;
    };
  patch(G.IDBObjectStore?.prototype, IDB_OPS, wrapStore(false), undo);
  patch(G.IDBIndex?.prototype, IDB_OPS.filter((o) => !/^(add|put|delete|clear)$/.test(o)), wrapStore(true), undo);
  // a transaction's span covers queueing behind other transactions too, which is where contention shows
  patch(G.IDBDatabase?.prototype, ["transaction"], (orig) => function (this: unknown, ...a: unknown[]) {
    const tx = orig.apply(this, a) as IDBTransaction;
    const db = this as IDBDatabase;
    if (db.name === OWN_DB) return tx;
    const t0 = performance.now();
    const end = (error?: string): void => sink({ system, operation: "transaction", namespace: db.name,
      collection: Array.from(tx.objectStoreNames).join(","), ms: performance.now() - t0, error,
      attrs: { "db.indexeddb.mode": tx.mode } });
    tx.addEventListener("complete", () => end(), { once: true });
    tx.addEventListener("abort", () => end(tx.error?.name ?? "AbortError"), { once: true });
    return tx;
  }, undo);
  patch(G.IDBFactory?.prototype, ["open"], (orig) => function (this: unknown, ...a: unknown[]) {
    const req = orig.apply(this, a) as IDBOpenDBRequest;
    const namespace = String(a[0]);
    if (namespace === OWN_DB) return req;
    const t0 = performance.now();
    let upgrade = false;
    req.addEventListener("upgradeneeded", () => void (upgrade = true), { once: true });
    // another tab holds an older version open: the app waits until that tab closes
    req.addEventListener("blocked", () => sink({ system, operation: "open", namespace, ms: performance.now() - t0, error: "blocked" }), { once: true });
    watchRequest(req, t0, (ms, error) => sink({ system, operation: "open", namespace, ms, error, attrs: { "db.indexeddb.upgrade": upgrade } }));
    return req;
  }, undo);
}

export function installCacheStorage(sink: Sink, undo: Uninstall[]): void {
  const system = "cache_storage";
  const names = new WeakMap<object, string>();
  const timed = (orig: Fn, operation: string): Fn => function (this: unknown, ...a: unknown[]) {
    const t0 = performance.now();
    const p = orig.apply(this, a) as Promise<unknown>;
    // CacheStorage.open/has/delete take the cache name; a Cache's name is remembered from open
    const onStorage = !!G.CacheStorage && this instanceof (G.CacheStorage as unknown as new () => object);
    const namespace = onStorage ? (/^(open|has|delete)$/.test(operation) ? String(a[0]) : undefined) : names.get(this as object);
    p.then((c) => {
      if (operation === "open" && c) names.set(c as object, namespace!);
      sink({ system, operation, namespace, ms: performance.now() - t0 });
    }, (e: unknown) => sink({ system, operation, namespace, ms: performance.now() - t0, error: errName(e) }));
    return p;
  };
  patch(G.CacheStorage?.prototype, ["match", "has", "open", "delete", "keys"], timed, undo);
  patch(G.Cache?.prototype, ["match", "matchAll", "add", "addAll", "put", "delete", "keys"], timed, undo);
}

const getStorage = (k: "localStorage" | "sessionStorage"): Storage | undefined => {
  try {
    return window[k];
  } catch {
    return undefined; // sandboxed iframe or blocked site data
  }
};

/** localStorage is synchronous: every call runs on the main thread. A full quota throws QuotaExceededError. */
export function installWebStorage(sink: Sink, undo: Uninstall[], quiet: () => boolean): void {
  const ls = getStorage("localStorage");
  // where Storage is a Proxy (happy-dom) methods see its target, not `ls`: learn that receiver once
  let lsSelf: unknown = ls;
  let probing = false;
  patch(G.Storage?.prototype, ["getItem", "setItem", "removeItem", "clear"], (orig, operation) =>
    function (this: unknown, ...a: unknown[]) {
      if (probing) lsSelf = this;
      if (quiet() || probing) return orig.apply(this, a);
      const system = this === ls || this === lsSelf ? "localstorage" : "sessionstorage";
      const t0 = performance.now();
      try {
        const r = orig.apply(this, a);
        sink({ system, operation, ms: performance.now() - t0, mainThread: true });
        return r;
      } catch (e) {
        sink({ system, operation, ms: performance.now() - t0, mainThread: true, error: errName(e) });
        throw e;
      }
    }, undo);
  probing = true;
  try {
    ls?.getItem("");
  } catch {
    // blocked storage: identity compare only
  } finally {
    probing = false;
  }
}

/** UTF-16: two bytes per code unit, keys included (what counts against the ~5 MB limit). */
export function webStorageBytes(s: Storage): { bytes: number; keys: number } {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i) ?? "";
    bytes += (k.length + (s.getItem(k)?.length ?? 0)) * 2;
  }
  return { bytes, keys: s.length };
}

const DETAILS: Array<[string, string]> = [["indexedDB", "indexeddb"], ["caches", "cache_storage"], ["fileSystem", "opfs"]];

/** Origin quota (`navigator.storage.estimate`), per-store usage where the browser breaks it down, and localStorage size. */
export async function sampleSizes(ctx: Ctx): Promise<void> {
  // before the first await, so the caller's quiet window covers exactly this walk
  const ls = getStorage("localStorage");
  if (ls) {
    const { bytes, keys } = webStorageBytes(ls);
    ctx.emit("storage", "wt.embedded.file_size", { value: bytes, attrs: { "db.system.name": "localstorage", "db.localstorage.keys": keys } });
  }
  const st = typeof navigator === "undefined" ? undefined : navigator.storage;
  const est = await st?.estimate?.().catch(() => undefined);
  if (est) {
    // not persisted = best-effort storage the browser may evict under pressure
    const persisted = await st?.persisted?.().catch(() => undefined);
    ctx.emit("storage", "wt.embedded.storage.usage", { value: est.usage ?? 0, attrs: {
      "db.system.name": "browser", "storage.quota": est.quota ?? 0,
      ...(persisted === undefined ? {} : { "storage.persisted": persisted }),
    } });
    const details = (est as { usageDetails?: Record<string, number> }).usageDetails ?? {};
    for (const [k, system] of DETAILS) {
      if (details[k] !== undefined) ctx.emit("storage", "wt.embedded.file_size", { value: details[k], attrs: { "db.system.name": system } });
    }
  }
}

/** Opt-in (`storage` option) lazy chunk: patches IndexedDB, Cache Storage and Web Storage, and samples sizes. */
export function installStorage(ctx: Ctx): Uninstall {
  const o: StorageConfig = typeof ctx.cfg.storage === "object" ? ctx.cfg.storage : {};
  const sink = makeSink(ctx, o.slowMs ?? 100);
  const undo: Uninstall[] = [];
  let sampling = false;
  installIndexedDb(sink, undo);
  installCacheStorage(sink, undo);
  installWebStorage(sink, undo, () => sampling);
  const g = globalThis as unknown as Record<symbol, Sink | undefined>;
  g[SINK_KEY] = sink;
  undo.push(() => void delete g[SINK_KEY]);
  const sample = (): void => {
    sampling = true; // our own localStorage walk (the sync start of sampleSizes) is not app work
    try {
      void sampleSizes(ctx).catch(() => undefined);
    } finally {
      sampling = false;
    }
  };
  sample();
  const every = o.sampleMs ?? 300_000;
  if (every > 0) {
    const id = setInterval(sample, every);
    undo.push(() => clearInterval(id));
  }
  return () => undo.forEach((u) => u());
}
