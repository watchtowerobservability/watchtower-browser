// Dynamic probes (P6-DI1), a lazy chunk: `wt.probe(name, () => vars)` records a snapshot only
// while an active probe targets `name`. Compiled-in points, no runtime patching. The condition
// subset has no calls (the server validates it too), so evaluating one cannot run code.
export type Vars = Record<string, unknown>;

export interface ProbeDef {
  id: string;
  kind: string;
  location: { file?: string; line?: number; function?: string };
  condition: string;
  message: string;
  capture: { locals_depth?: number; max_bytes?: number };
  max_rate_per_min: number;
  expires_at: number;
}

export interface ProbesOptions {
  endpoint: string;
  /** an ingestion key with scope `probes:read` (a publishable browser key cannot read probes) */
  key: string;
  service: string;
  env?: string;
  version?: string;
  emit: (name: string, attrs: Record<string, string>) => void;
  now?: () => number;
  fetch?: typeof fetch;
}

const VALUE_MAX = 1024;

type Node = (v: Vars) => unknown;
const TOKEN = /\s*(&&|\|\||==|!=|<=|>=|[<>!()[\],]|'[^']*'|"[^"]*"|-?\d+(?:\.\d+)?|[A-Za-z_][\w.]*)/y;

/** Compile a condition; throws on anything outside the subset (calls included). */
export function compile(src: string): (v: Vars) => boolean {
  if (!src.trim()) return () => true;
  const t: string[] = [];
  TOKEN.lastIndex = 0;
  let end = 0;
  for (let m: RegExpExecArray | null; (m = TOKEN.exec(src)); end = TOKEN.lastIndex) t.push(m[1]!);
  if (end !== src.trimEnd().length) throw new Error("bad condition");
  let i = 0;
  const eat = (s: string): boolean => (t[i] === s ? (i++, true) : false);
  const get = (v: Vars, name: string): unknown =>
    name.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Vars)[k] : undefined), v);
  const atom = (): Node => {
    const x = t[i++];
    if (x === undefined) throw new Error("bad condition");
    if (x === "(") {
      const e = or();
      if (!eat(")")) throw new Error("bad condition");
      return e;
    }
    if (x === "[") {
      const items: unknown[] = [];
      while (t[i] !== "]") {
        if (i >= t.length) throw new Error("bad condition");
        const n = t[i++]!;
        if (n !== ",") items.push(lit(n));
      }
      i++;
      return () => items;
    }
    if (/^['"]|^-?\d/.test(x) || x === "true" || x === "false" || x === "null") {
      const val = lit(x);
      return () => val;
    }
    if (t[i] === "(") throw new Error("function calls are not allowed");
    return (v) => get(v, x);
  };
  const lit = (x: string): unknown =>
    x === "true" ? true : x === "false" ? false : x === "null" ? null : /^['"]/.test(x) ? x.slice(1, -1) : Number(x);
  const cmp = (): Node => {
    const a = atom();
    for (const op of ["==", "!=", "<=", ">=", "<", ">", "in", "contains"]) {
      if (!eat(op)) continue;
      const b = atom();
      return (v) => {
        const x = a(v) as never, y = b(v) as never;
        switch (op) {
          case "==": return x === y;
          case "!=": return x !== y;
          case "<": return x < y;
          case "<=": return x <= y;
          case ">": return x > y;
          case ">=": return x >= y;
          case "in": return Array.isArray(y) && y.includes(x);
          default: return typeof x === "string" && typeof y === "string" && (x as string).includes(y as string);
        }
      };
    }
    return a;
  };
  const not = (): Node => {
    if (eat("!")) {
      const n = not();
      return (v) => !n(v);
    }
    return cmp();
  };
  const and = (): Node => {
    let l = not();
    while (eat("&&")) { const a = l, r = not(); l = (v) => !!a(v) && !!r(v); }
    return l;
  };
  const or = (): Node => {
    let l = and();
    while (eat("||")) { const a = l, r = and(); l = (v) => !!a(v) || !!r(v); }
    return l;
  };
  const root = or();
  if (i !== t.length) throw new Error("bad condition");
  return (v) => !!root(v);
}

/** Flatten to dotted names: nesting past `depth` collapses, values cut to 1 KiB, total to `maxBytes`. */
export function capture(vars: Vars, depth: number, maxBytes: number): Record<string, string> {
  const out: Record<string, string> = {};
  let used = 0;
  const put = (name: string, val: string): void => {
    const s = val.slice(0, VALUE_MAX);
    if (used + name.length + s.length <= maxBytes) {
      used += name.length + s.length;
      out[name] = s;
    }
  };
  const walk = (prefix: string, v: unknown, d: number): void => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (d > depth) return put(prefix, "[depth limit]");
      for (const k of Object.keys(v).sort()) walk(prefix ? `${prefix}.${k}` : k, (v as Vars)[k], d + 1);
    } else put(prefix, String(v));
  };
  walk("", vars, 0);
  return out;
}

interface Live { def: ProbeDef; ok: (v: Vars) => boolean; win: number; n: number }

export function createProbes(o: ProbesOptions) {
  const now = o.now ?? Date.now;
  const f = o.fetch ?? globalThis.fetch?.bind(globalThis);
  let live = new Map<string, Live[]>();
  let etag = "";

  const set = (defs: ProbeDef[]): void => {
    const m = new Map<string, Live[]>();
    for (const def of defs) {
      try {
        const key = def.location.function ?? `${def.location.file}:${def.location.line}`;
        m.set(key, [...(m.get(key) ?? []), { def, ok: compile(def.condition), win: 0, n: 0 }]);
      } catch { /* a probe we cannot evaluate is skipped */ }
    }
    live = m;
  };

  async function poll(): Promise<void> {
    const q = new URLSearchParams({ service: o.service, env: o.env ?? "", version: o.version ?? "" });
    const r = await f(`${o.endpoint.replace(/\/$/, "")}/v1/probes/active?${q}`, {
      headers: { Authorization: `Bearer ${o.key}`, ...(etag ? { "If-None-Match": etag } : {}) },
    });
    if (r.status === 304 || !r.ok) return;
    etag = r.headers.get("ETag") ?? "";
    set(((await r.json()) as { probes: ProbeDef[] }).probes);
  }

  /** Records only while an active probe targets `name`; `vars` is not even called otherwise. */
  function hit(name: string, vars: () => Vars): void {
    const ps = live.get(name);
    if (!ps?.length) return;
    const t = now();
    const v = vars();
    for (const p of ps) {
      if (p.def.expires_at && t >= p.def.expires_at * 1000) continue;
      const minute = Math.floor(t / 60000);
      if (p.win !== minute) { p.win = minute; p.n = 0; }
      if (!p.ok(v) || p.n >= Math.min(p.def.max_rate_per_min || 60, 60)) continue;
      p.n++;
      const depth = Math.min(p.def.capture.locals_depth || 3, 3);
      const bytes = Math.min(p.def.capture.max_bytes || 8192, 8192);
      const attrs: Record<string, string> = { "probe.id": p.def.id };
      if (p.def.location.function) attrs["code.function"] = p.def.location.function;
      if (p.def.location.file) {
        attrs["code.filepath"] = p.def.location.file;
        attrs["code.lineno"] = String(p.def.location.line ?? 0);
      }
      for (const [k, s] of Object.entries(capture(v, depth, bytes))) attrs[`code.snapshot.${k}`] = s;
      o.emit("probe.snapshot", attrs);
    }
  }

  return { poll, hit, set };
}

export type Probes = ReturnType<typeof createProbes>;
