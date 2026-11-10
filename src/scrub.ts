let on = true;

/** `urlScrubbing: false` keeps query strings and path ids (the fragment is always dropped). Set by `init` and by the lazy instrument chunk. */
export const setUrlScrubbing = (v: boolean | undefined): void => void (on = v !== false);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// build assets (`app.3f2a1b9c.js`) look like tokens but are not secrets
const STATIC_EXT = /\.(m?js|css|map|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico)$/i;

/** A path segment that looks like a secret or id: UUID, >= 24 chars, or >= 10 chars with a letter and a digit. */
export const isSecretSegment = (s: string): boolean =>
  UUID.test(s) || s.length >= 24 || (s.length >= 10 && /\d/.test(s) && /[a-z]/i.test(s));

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
  const path = m[2]!.split("/").map((s, i, a) => (i === a.length - 1 && STATIC_EXT.test(s) ? s : isSecretSegment(s) ? ":redacted" : s)).join("/");
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
