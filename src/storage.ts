/**
 * `@watchtowerobservability/browser/storage`: pass-the-module wrappers for in-browser SQLite (sql.js,
 * wa-sqlite, both often on OPFS). Not part of the core bundle. Calls are reported only while the
 * `storage` option is on (the lazy storage instrument publishes its sink); otherwise they pass through.
 * Statement text and parameters are never recorded: only the operation and first table.
 */
import { onMainThread, SINK_KEY, type DbOp, type Sink } from "./instrument/storage";

const OP = /^\s*(?:with\b[\s\S]*?\)\s*)?([a-z]+)/i;
const TARGET = /\b(?:from|into|update|join|table)\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)/i;

/** `SELECT users`-style summary parts (same rules as the Node SDK): never values or the statement text. */
export function querySummary(sql: unknown): { operation: string; collection?: string } {
  const text = typeof sql === "string" ? sql : "";
  const operation = text.match(OP)?.[1]?.toUpperCase() ?? "QUERY";
  const collection = text.match(TARGET)?.[1]?.replace(/["`[\]]/g, "");
  return { operation, collection };
}

const sink = (): Sink | undefined => (globalThis as unknown as Record<symbol, Sink | undefined>)[SINK_KEY];
const now = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());
const errType = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "number" || typeof code === "string" ? String(code) : (e as { name?: string } | null)?.name || "Error";
};

type Fn = (...a: unknown[]) => unknown;
type Base = Pick<DbOp, "system" | "namespace" | "mainThread">;

/** Wraps `obj[name]` in place; the SQL is argument `sqlAt`. Sync results are timed now, promises when they settle. */
function wrap(obj: Record<string, unknown>, name: string, sqlAt: number, base: Base): void {
  const orig = obj[name];
  if (typeof orig !== "function" || (orig as { __wt?: boolean }).__wt) return;
  const w = function (this: unknown, ...a: unknown[]): unknown {
    const s = sink();
    if (!s) return (orig as Fn).apply(this, a);
    const q = querySummary(a[sqlAt]);
    const t0 = now();
    const done = (error?: string, async?: boolean): void => s({ ...base, ...q, ms: now() - t0, error, async });
    let r: unknown;
    try {
      r = (orig as Fn).apply(this, a);
    } catch (e) {
      done(errType(e));
      throw e;
    }
    if (r && typeof (r as Promise<unknown>).then === "function") {
      (r as Promise<unknown>).then(() => done(undefined, true), (e: unknown) => done(errType(e), true));
    } else {
      done();
    }
    return r;
  };
  (w as { __wt?: boolean }).__wt = true;
  obj[name] = w;
}

/**
 * sql.js `Database`: `exec`, `run` and `each` are timed. sql.js is synchronous WebAssembly, so on the
 * main thread a call over one frame (16 ms) is reported and flagged `db.main_thread` (move it to a worker).
 * shortcut: prepared statements (`prepare` + `step`) are not timed; wrap hot loops with your own span.
 */
export function instrumentSqlJs<T extends object>(db: T, o: { name?: string } = {}): T {
  const base: Base = { system: "sqlite", namespace: o.name, mainThread: onMainThread() };
  for (const m of ["exec", "run", "each"]) wrap(db as Record<string, unknown>, m, 0, base);
  return db;
}

/**
 * wa-sqlite API object (`SQLite.Factory(module)`): `exec`, `run` and `execWithParams` are timed
 * (`(db, sql, ...)`). Async calls are judged against `slowMs`; on the main thread they are still
 * flagged `db.main_thread`, since the SQLite engine itself runs there between VFS awaits.
 */
export function instrumentWaSqlite<T extends object>(sqlite3: T, o: { name?: string } = {}): T {
  const base: Base = { system: "sqlite", namespace: o.name, mainThread: onMainThread() };
  for (const m of ["exec", "run", "execWithParams"]) wrap(sqlite3 as Record<string, unknown>, m, 1, base);
  return sqlite3;
}
