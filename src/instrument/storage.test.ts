import { afterEach, describe, expect, it, vi } from "vitest";
import { instrumentSqlJs, instrumentWaSqlite, querySummary } from "../storage";
import type { Uninstall } from "./ctx";
import {
  FRAME_MS, installCacheStorage, installIndexedDb, installStorage, installWebStorage, makeSink, sampleSizes, SINK_KEY,
  webStorageBytes, type DbOp,
} from "./storage";
import { mkCtx } from "./testutil";

let clock = 0;
const tick = (ms: number): void => void (clock += ms);
const undo: Uninstall[] = [];
afterEach(() => {
  undo.splice(0).reverse().forEach((u) => u());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
const fakeClock = (): void => void vi.spyOn(performance, "now").mockImplementation(() => clock);

describe("sink", () => {
  it("reports only slow or failed ops, main-thread sync work against one frame", () => {
    const { c, events } = mkCtx();
    const sink = makeSink(c, 100);
    sink({ system: "indexeddb", operation: "get", ms: 50 });
    sink({ system: "indexeddb", operation: "get", collection: "users", namespace: "app", ms: 120 });
    sink({ system: "localstorage", operation: "setItem", ms: FRAME_MS + 1, mainThread: true });
    sink({ system: "sqlite", operation: "SELECT", ms: 40, mainThread: true, async: true });
    sink({ system: "indexeddb", operation: "put", ms: 1, error: "ConstraintError" });
    expect(events.map((e) => e.name)).toEqual(["get users", "setItem", "put"]);
    expect(events[0]).toMatchObject({ type: "db", value: 120, attrs: {
      "db.system.name": "indexeddb", "db.operation.name": "get", "db.collection.name": "users", "db.namespace": "app",
      "db.query.summary": "get users" } });
    expect(events[1]!.attrs["db.main_thread"]).toBe(true);
    expect(events[2]!.attrs["error.type"]).toBe("ConstraintError");
  });
});

describe("web storage", () => {
  it("flags slow localStorage calls and quota errors, never values", () => {
    fakeClock();
    const ops: DbOp[] = [];
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
      tick(30);
      if (v === "huge") throw new DOMException("full", "QuotaExceededError");
      return orig.call(this, k, v);
    };
    undo.push(() => void (Storage.prototype.setItem = orig));
    installWebStorage((o) => ops.push(o), undo, () => false);
    localStorage.setItem("cart", "secret-value");
    expect(() => localStorage.setItem("x", "huge")).toThrow();
    expect(ops[0]).toMatchObject({ system: "localstorage", operation: "setItem", ms: 30, mainThread: true });
    expect(ops[1]!.error).toBe("QuotaExceededError");
    expect(JSON.stringify(ops)).not.toContain("secret-value");
  });

  it("counts utf-16 bytes of keys and values", () => {
    localStorage.setItem("ab", "cde");
    expect(webStorageBytes(localStorage)).toEqual({ bytes: 10, keys: 1 });
  });
});

/** Minimal IndexedDB shapes: requests and transactions are EventTargets, like the real ones. */
function fakeIdb() {
  class IDBRequest extends EventTarget { error: DOMException | null = null; }
  class IDBTransaction extends EventTarget {
    error: DOMException | null = null;
    constructor(public db: IDBDatabase, public objectStoreNames: string[], public mode: string) { super(); }
  }
  class IDBObjectStore {
    constructor(public name: string, public transaction: IDBTransaction) {}
    get(): IDBRequest { return new IDBRequest(); }
  }
  class IDBDatabase {
    constructor(public name: string) {}
    transaction(stores: string[], mode = "readonly"): IDBTransaction { return new IDBTransaction(this, stores, mode); }
  }
  class IDBFactory { open(_name: string, _v?: number): IDBRequest { return new IDBRequest(); } }
  for (const [k, v] of Object.entries({ IDBRequest, IDBTransaction, IDBObjectStore, IDBDatabase, IDBFactory })) vi.stubGlobal(k, v);
  return { IDBObjectStore, IDBDatabase, IDBFactory };
}

describe("indexeddb", () => {
  it("times requests, transactions and blocked opens; skips the SDK's own queue", () => {
    fakeClock();
    const { IDBObjectStore, IDBDatabase, IDBFactory } = fakeIdb();
    const ops: DbOp[] = [];
    installIndexedDb((o) => ops.push(o), undo);
    const db = new IDBDatabase("app");
    const tx = db.transaction(["users"], "readwrite") as unknown as EventTarget & { error: DOMException | null };
    const req = new IDBObjectStore("users", tx as never).get() as unknown as EventTarget & { error: DOMException | null };
    tick(40);
    req.dispatchEvent(new Event("success"));
    req.dispatchEvent(new Event("success")); // a cursor's next step is not timed again
    tick(10);
    tx.error = new DOMException("x", "ConstraintError");
    tx.dispatchEvent(new Event("abort"));
    const own = new IDBDatabase("wt-offline").transaction(["q"]) as unknown as EventTarget;
    own.dispatchEvent(new Event("complete"));
    const open = new IDBFactory().open("app", 2) as unknown as EventTarget;
    open.dispatchEvent(new Event("blocked"));
    expect(ops).toEqual([
      { system: "indexeddb", operation: "get", collection: "users", namespace: "app", ms: 40, error: undefined },
      { system: "indexeddb", operation: "transaction", collection: "users", namespace: "app", ms: 50, error: "ConstraintError",
        attrs: { "db.indexeddb.mode": "readwrite" } },
      { system: "indexeddb", operation: "open", namespace: "app", ms: 0, error: "blocked" },
    ]);
  });
});

describe("cache storage", () => {
  it("names caches from open and reports rejections", async () => {
    class Cache { match(): Promise<undefined> { return Promise.reject(new TypeError("bad")); } }
    class CacheStorage { open(_name: string): Promise<Cache> { return Promise.resolve(new Cache()); } }
    vi.stubGlobal("Cache", Cache);
    vi.stubGlobal("CacheStorage", CacheStorage);
    const ops: DbOp[] = [];
    installCacheStorage((o) => ops.push(o), undo);
    const cache = await new CacheStorage().open("v1");
    await expect(cache.match()).rejects.toThrow();
    await Promise.resolve();
    expect(ops.map((o) => [o.operation, o.namespace, o.error])).toEqual([["open", "v1", undefined], ["match", "v1", "TypeError"]]);
  });
});

describe("sizes", () => {
  it("emits quota usage, persisted and per-store usage", async () => {
    vi.stubGlobal("navigator", { storage: {
      estimate: () => Promise.resolve({ usage: 900, quota: 1000, usageDetails: { indexedDB: 700, caches: 150, fileSystem: 50 } }),
      persisted: () => Promise.resolve(false),
    } });
    const { c, events } = mkCtx();
    await sampleSizes(c);
    expect(events.map((e) => [e.name, e.attrs["db.system.name"], e.value])).toEqual([
      ["wt.embedded.file_size", "localstorage", 0],
      ["wt.embedded.storage.usage", "browser", 900],
      ["wt.embedded.file_size", "indexeddb", 700],
      ["wt.embedded.file_size", "cache_storage", 150],
      ["wt.embedded.file_size", "opfs", 50],
    ]);
    expect(events[1]!.attrs).toMatchObject({ "storage.quota": 1000, "storage.persisted": false });
  });
});

describe("sqlite wrappers", () => {
  it("summarises without statement text or values", () => {
    expect(querySummary("select * from \"users\" where email = 'a@b'")).toEqual({ operation: "SELECT", collection: "users" });
    expect(querySummary("INSERT INTO main.orders VALUES (1)")).toEqual({ operation: "INSERT", collection: "main.orders" });
    expect(querySummary(undefined)).toEqual({ operation: "QUERY", collection: undefined });
  });

  it("pass through without the storage instrument, report through its sink once installed", async () => {
    fakeClock();
    const db = instrumentSqlJs({ exec: (_s: string) => { tick(20); return []; } }, { name: "app.db" });
    db.exec("SELECT 1 FROM t");
    const { c, events } = mkCtx({ storage: { sampleMs: 0 } });
    undo.push(installStorage(c));
    expect((globalThis as unknown as Record<symbol, unknown>)[SINK_KEY]).toBeTypeOf("function");
    db.exec("SELECT name FROM users WHERE id = 7");
    const wa = instrumentWaSqlite({ exec: async (_db: number, _s: string) => { tick(40); throw Object.assign(new Error("x"), { code: 19 }); } });
    await expect(wa.exec(1, "UPDATE accounts SET a = 1")).rejects.toThrow();
    const db1 = events.filter((e) => e.type === "db");
    expect(db1.map((e) => [e.name, e.attrs["db.main_thread"], e.attrs["error.type"]])).toEqual([
      ["SELECT users", true, undefined],
      ["UPDATE accounts", true, "19"],
    ]);
    expect(db1[0]!.attrs["db.namespace"]).toBe("app.db");
    expect(JSON.stringify(db1)).not.toContain("id = 7");
  });
});
