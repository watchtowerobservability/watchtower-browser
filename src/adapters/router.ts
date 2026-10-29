import { setRoute } from "../instrument/navigation";

type Params = Record<string, string | string[] | undefined>;

/** `/users/42` + `{id:"42"}` -> `/users/:id`; params are matched by whole path segment. */
export function templateFromParams(path: string, params: Params = {}): string {
  const byValue = new Map<string, string>();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => byValue.set(x, `:${k}`));
    else if (v) byValue.set(v, `:${k}`);
  }
  const clean = path.split(/[?#]/)[0] ?? "";
  return clean.split("/").map((s) => byValue.get(safeDecode(s)) ?? s).join("/") || "/";
}

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Sets the route template used by view names and vitals; call on every navigation. */
export function trackRoute(path: string, params?: Params): void {
  try {
    setRoute(templateFromParams(path, params));
  } catch {
    /* the SDK never throws into the host app */
  }
}
