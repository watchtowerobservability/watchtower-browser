let on = true;
let allow: RegExp[] = [];
let deny: RegExp[] = [];

/** `'strict'` (= `true`, the default), `'pii'` (strict plus emails, phone numbers, card numbers, IPv4 in path segments), `'off'` (= `false`). Same names as the node SDK's `redact`. */
export type UrlScrubbing = boolean | "strict" | "pii" | "off" | { allow?: RegExp[]; deny?: RegExp[] };
let pii = false;

/** `urlScrubbing: false` keeps query strings and path ids (the fragment is always dropped); `{ allow, deny }` are tested against each path segment (deny wins). Set by `init` and by the lazy instrument chunk. */
export function setUrlScrubbing(v: UrlScrubbing | undefined): void {
  on = v !== false && v !== "off";
  pii = v === "pii";
  allow = typeof v === "object" ? (v.allow ?? []) : [];
  deny = typeof v === "object" ? (v.deny ?? []) : [];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{16,}$/i;
const JWT = /^eyJ[\w-]*\.[\w-]+\.[\w-]*$/;
const DIGITS = /^\d{16,}$/;
const TOKEN = /^[A-Za-z0-9_+=-]{16,}$/;
// readable word-ish part of a kebab/snake slug: `legal`, `Intake`, `q1`, `2024`
const PII = [/^[^@/\s]+(@|%40)[^@/\s]+\.[a-z]{2,}$/i, /^\d{1,3}(\.\d{1,3}){3}$/, /^(?:\d[ -]?){13,19}$/, /^\+?\d[\d().-]{5,}\d$/];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PART = /^([A-Za-z][a-z]*\d{0,2}|\d{1,4})$/;

/**
 * A path segment that looks like a secret: UUID, hex run >= 16, JWT, digit run >= 16, or an opaque token (>= 16 chars of
 * [A-Za-z0-9_+=-] with a letter and a digit that is not a readable kebab/snake slug). Words, slugs, short ids and file names stay.
 * Same rule as the node SDK and the gateway. `urlScrubbing.deny` / `.allow` override.
 */
export const isSecretSegment = (s: string): boolean => {
  if (deny.some((r) => r.test(s))) return true;
  if (allow.some((r) => r.test(s))) return false;
  if (pii && !DATE.test(s) && PII.some((r) => r.test(s))) return true;
  return UUID.test(s) || HEX.test(s) || JWT.test(s) || DIGITS.test(s) || (TOKEN.test(s) && /\d/.test(s) && /[a-z]/i.test(s) && !s.split(/[-_]/).every((p) => PART.test(p)));
};

/** Query and fragment dropped: both can carry tokens. Script URLs for stack frames use this alone. */
export function stripQuery(u: string): string {
  const i = u.search(/[?#]/);
  return i < 0 ? u : u.slice(0, i);
}

/** Script URLs in stack frames: the path stays (source maps match on it), the query goes. */
export const scrubScriptUrl = (u: string): string => (on ? stripQuery(u) : u.split("#")[0]!);

/** Secret-looking path segments become `:redacted`. Takes a path or a full URL without query. */
export function redactPath(u: string): string {
  const m = /^((?:[a-z][a-z0-9+.-]*:)?\/\/[^/]*)?(.*)$/is.exec(u)!;
  const path = m[2]!.split("/").map((s) => (isSecretSegment(s) ? ":redacted" : s)).join("/");
  return (m[1] ?? "") + path;
}

/** Default URL scrubbing for everything the SDK reports: no query, no fragment, secret-looking path segments redacted. */
export function scrubUrl(u: string): string {
  return on ? redactPath(stripQuery(u)) : u.split("#")[0]!;
}

/** OTel span URL attributes, in place (the span processor runs before export). */
export function scrubSpanAttrs(a: Record<string, unknown> | undefined): void {
  if (!a || !on) return;
  for (const k of ["http.url", "url.full", "http.target", "url.path"]) if (typeof a[k] === "string") a[k] = scrubUrl(a[k] as string);
  delete a["url.query"];
}
