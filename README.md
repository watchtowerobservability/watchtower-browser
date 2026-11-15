# @watchtowerobservability/browser

[![CI](https://github.com/watchtowerobservability/watchtower-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/watchtowerobservability/watchtower-browser/actions/workflows/ci.yml)

## Install

```sh
npm install @watchtowerobservability/browser
```

The package is on public npm, published from GitHub Actions by npm trusted publishing with provenance (`npm audit signatures` verifies it); no token is needed to install.

Browser SDK core: init, session, batching transport, remote config, PostHog link.

```ts
import { init } from "@watchtowerobservability/browser";
const wt = init({ publishableKey: "wtp_...", endpoint: "https://edge.example.com", service: "web" });
wt.captureError(new Error("x"));
```

- Session: UUIDv4 in `sessionStorage`, 30 min idle / 4 h max rollover, no cookies. Sampling is decided once per session; the effective rate is sent as batch attribute `wt.sample_rate`.
- Transport: flush at 50 events, 5 s or page hide (`sendBeacon`, key in `?k=`: the publishable key is public by design); gzip over 1 KiB; queue of 500 (oldest dropped, counted in `wt.sdk.dropped`); exponential backoff with jitter up to 60 s; honors `Retry-After`. Public methods never throw.
- User ids are hashed with SHA-256 and the project salt (`id_salt` from `/v1/rum/config`) before send; the raw id is never sent.
- PostHog ids are read lazily per batch from `window.posthog` when present; nothing from PostHog is bundled.
- Core budget: 12 KiB gzipped (`size_budget.test.ts`). Replay is a separate lazy chunk (`replay.js`, shipped in this package).
- Bundlers (webpack 5, Next, Vite, Rollup) resolve the lazy chunks themselves from static imports; only an explicit `instrumentUrl`, `replay.scriptUrl`, ... or the `wt.min.js` script build loads by URL.
- Tracing: set `otlpEndpoint` to your gateway's OTLP/HTTP base URL (the key-creation snippet shows it). Without it the SDK creates no spans and `propagateTo` does nothing.
- Replay: add `replay: { enabled: true }` to `init` and turn it on for the project (`PUT /v1/projects/{prj}/privacy` with `{"replay_enabled": true}`); it is off by default (10% session sampling).
- Localhost origins: a key may list `http://localhost:*` only after `PATCH /v1/projects/{prj}` with `{"allow_localhost": true}`.

`pnpm -C sdks/browser test`, `pnpm -C sdks/browser build` (ESM + `dist/wt.min.js` IIFE).

## Hosted and self-hosted script

### Hosted copy

Watchtower hosts the build: `<script src="https://edge.watchtowerops.net/sdk/v0/wt.min.js"></script>`. The lazy chunks
load from the same folder; `https://watchtowerops.net/sdk/v0/` serves the same files. `/sdk/v0/` always carries the
latest 0.x release, so pin by self-hosting (or by the npm version) if you need a fixed build. CSP:

```
script-src https://edge.watchtowerops.net;
connect-src https://edge.watchtowerops.net;
```

Every build ships `manifest.json` (each file with bytes, sha256 and SRI `sha384-` integrity, plus the version) and
`storage.json` (every client-side storage item the SDK writes; it sets no cookies). Both are also served at
`/sdk/v0/manifest.json` and `/sdk/v0/storage.json`. If a chunk cannot load (404, or an SPA fallback answering with
HTML), the SDK logs one console error naming the chunk and base URL; serve every file in `manifest.json` next to `wt.min.js`.

### Self-hosting (vendoring)

To serve the SDK from your own origin instead of a bundler import, copy the whole `dist/`
output, not `wt.min.js` alone: the core loads its features lazily from files next to itself.

| File | Loaded when |
|---|---|
| `wt.min.js` (IIFE, global `Watchtower`) or `index.js` (ESM) | always: the core |
| `instrument/index.js` and the other `instrument/*.js` chunks | errors, web vitals, resources, frustration signals, tracing (almost always) |
| `replay.js` | session replay is on |
| `assist.js` | co-browse assist is on |
| `probes.js` | `probes.key` is set |
| `feedback.js` | the first `feedback` / `feedbackWidget` call |

**Single-file builds (Vite inlining dynamic imports):** import `@watchtowerobservability/browser/lite` instead of the main entry. It has the same API but no reference to `replay.js`, `assist.js`, `feedback.js` or `probes.js`, so the bundle does not grow by about 65 KB gzipped for replay. `replay`, `assist`, `feedback` and `probes` do nothing there.

**User actions:** an automatic action is named `data-wt-action` if set, else a selector without text (tag, id, classes, `data-testid`, `name`). Set `actionNameFromText: true` to use the element's text instead (it can contain personal data). In the script build, `Watchtower.cookieMunchConsent(client)` is available.

Keep the directory layout (`instrument/` beside `wt.min.js`) and the `.map` files if you want
readable stacks. Chunks resolve relative to the script that loaded the core (the `<script src>`
of `wt.min.js`, or `import.meta.url` for ESM), so `/wt/wt.min.js` loads `/wt/instrument/index.js`.
To put a chunk elsewhere, set its URL: `instrumentUrl`, `replay.scriptUrl`, `assist.scriptUrl`, `probes.url`,
`feedback.scriptUrl`.

Content Security Policy: `script-src` must allow the origin serving these files, and
`connect-src` must allow your Watchtower edge (the `endpoint`, e.g. `https://edge.example.com`),
which receives events and serves `/v1/rum/config`.

```html
<script src="/wt/wt.min.js"></script>
<script>Watchtower.init({ publishableKey: "wtp_...", endpoint: "https://edge.example.com", service: "web" });</script>
```

### Content Security Policy for Next.js

Direct to the edge (replace `edge.example.com` and the gateway host if you set `otlpEndpoint`):

```ts
// next.config.ts
const csp = [
  "default-src 'self'",
  "script-src 'self' 'nonce-<per-request>'",          // the SDK is bundled by Next; its lazy chunks are same-origin
  "connect-src 'self' https://edge.example.com https://gateway.example.com", // events, /v1/rum/config, /v1/logs, OTLP traces
  "worker-src 'self' blob:",                          // session replay compresses in a blob: worker
  "img-src 'self' data: blob:",
].join("; ");
export default { headers: async () => [{ source: "/:path*", headers: [{ key: "Content-Security-Policy", value: csp }] }] };
```

Through the same-origin tunnel (below) nothing third-party is needed: `connect-src 'self'` covers events, config,
logs and traces. Replay still needs `worker-src blob:` (omit it if replay is off).

### Ad blockers: same-origin tunnel

Filter lists block third-party telemetry hosts. Point `endpoint` at a path on your own origin and forward it
server-side. A relative `endpoint` works for events, config, logs, traces (`otlpEndpoint` defaults to `endpoint`),
replay and feedback; requests to it are never instrumented or reported.

```ts
// app/api/wt/[...path]/route.ts  (Next app router)
import { tunnelHandler } from "@watchtowerobservability/node/next";
export const { GET, POST } = tunnelHandler({ endpoint: process.env.WT_EDGE_URL! });
```

```ts
init({ publishableKey: "wtp_...", endpoint: "/api/wt", service: "web" });
```

`tunnelHandler` is the route handler exported by `@watchtowerobservability/node/next`; see that package for its
options. Without a tunnel route handler the page gets 404s on `/api/wt/v1/rum/events`.

### URL scrubbing

Every URL the SDK reports (the page URL in each batch and its referrer, `url` on views, navs, resources and
vitals, `http.url`, `url.full`, `url.path` and `url.query` on fetch/XHR spans, `page.url` on page-load spans) loses its
query string and fragment, and path segments that look like secrets become `:redacted`: UUIDs, hex runs of 16 or more, JWTs, digit runs of 16 or more, and random-looking tokens
of 16 or more characters mixing letters and digits. The host is never touched, and readable words, kebab and snake slugs
(`legal-consultation-intake`), short ids (`/config/a1b2c3d4`) and file names (`app.3f2a1b9c.js`) stay. Stack-frame script URLs keep their path (source maps and debug ids match on it) and
lose only the query. Set `urlScrubbing: false` to send paths and queries as they are (the fragment is still dropped). `urlScrubbing: { allow: [/^order-/], deny: [/^acct_/] }` adds your own per-segment
rules (deny wins, then allow, then the defaults).
Presets, named like the node SDK's `redact`: `urlScrubbing: "strict"` (= `true`, the default), `"pii"` (strict, plus emails, phone numbers, card numbers and IPv4 addresses in path segments) and `"off"` (= `false`).
`beforeSend` can still scrub more.

### Trace propagation (`propagateTo`)

`propagateTo: ["https://api.example.com/", /^https:\/\/.*\.example\.com\//]` (string = URL prefix, RegExp = test) lists the
fetch/XHR URLs that get trace headers; default none, and it needs `otlpEndpoint`. Same-origin requests are not exempt. Headers added:
`traceparent` (W3C, always) and `baggage: lucida.session_id=<id>` (only when a Lucida session id is known; it replaces a `baggage`
you set on that request). `tracestate` is never sent. A cross-origin target must answer the preflight with
`Access-Control-Allow-Headers: traceparent, baggage` (add `content-type`, `authorization` as your calls need) or the browser blocks the request.
The SDK's own endpoints are never listed.

### Router adapters and route names

Next app router: `useNextRouteTracking(usePathname(), useParams())` (from `@watchtowerobservability/browser/next`).
Views, navs and vitals are named by the pattern (`/gallery/:typeId`). The hook runs after hydration and after the
router commits, so once it is mounted the first view and each navigation wait for it (at most 300 ms, or until the page
hides) and then report the pattern; without an adapter the first view is sent after the same 300 ms with the
normalised path (`/users/:id` for numeric and UUID segments).

## Consent

GDPR sites can load the SDK before consent and start it later:

```ts
const wt = init({ publishableKey: "wtp_...", endpoint: "https://edge.example.com", service: "web", consent: "pending" });
cmp.onAccept(() => wt.grantConsent());   // starts session, config fetch, instrumentation
cmp.onWithdraw(() => wt.revokeConsent()); // stops, drops queued events and logs, removes `wt.session`
```

With `consent: "pending"` nothing runs and nothing is sent (no session, no config request) until
`grantConsent()`. Data calls made meanwhile (`captureError`, `event`, `measure`, `log`, `flag`, `setUser`, `setAttribute`, `setView`) are held in memory, at most 100 (later ones are dropped), and replayed in order on `grantConsent()` with the replay time as their timestamp; `revokeConsent()` drops them, and calls after a revoke are dropped, not held. Nothing is written to storage while pending. `revokeConsent()` also works on a
client started without `consent`; a later `grantConsent()` starts a new session.

### Cookie Munch

```ts
import { cookieMunchConsent } from "@watchtowerobservability/browser/consent";
const wt = init({ publishableKey: "wtp_...", endpoint: "...", service: "web", consent: "pending" });
cookieMunchConsent(wt, { rum: "statistics", replay: "statistics" }); // returns a function that detaches it
```

It listens to `CookieMunchOnConsentReady` / `CookieMunchOnChange` (and reads `CookieMunch.consent` at once when the
visitor has already decided; `hasResponse` is false before that and is never read as a decline). `rum` calls
`grantConsent()` or `revokeConsent()`; `replay` stops or restarts session replay while RUM stays on. Categories:
`statistics`, `marketing`, `preferences`; both default to `statistics`. `grantConsent()` is idempotent: a second call
while granted does not start a new session.

### Lucida

When the Lucida browser SDK is on the page its session id is added to every batch as `lucida.session_id`. Pass the
client to link it without a global: `init({ ..., lucida: lucidaClient })` (any object with `getSessionId()`); it is
used before `globalThis.lucida`.
`client.setAttribute("lucida.session_id", id)` does the same and wins over the client. The id is sent on the batch
`attrs` (the RUM session), on every error event's `attrs`, on every span and log record as `lucida.session_id`, and as
W3C baggage `lucida.session_id=<id>` on fetch/XHR requests that get a `traceparent` (same `propagateTo` rules).

### Hooks

```ts
const off = wt.on("error", (e) => {}); // { event_id, trace_id?, fingerprint?, message, type?, handled, url, ts }
wt.on("vital", (v) => {});             // { name, value, rating, navigation_id, url, final }
off();                                 // unsubscribe
```

- `error` fires after the SDK has queued the event, for `captureError` (`handled: true`), `window.onerror`,
  unhandled rejections, resource and CSP errors (`handled: false`). `event_id` is the id of the event sent to ingest
  (`events[].id`), so it resolves to the stored error. `message` is capped at 300 chars; `url` has no query string.
  Errors dropped by sampling or `beforeSend` do not fire. `ts` is epoch ms.
- `vital` fires once per vital (`LCP`, `INP`, `CLS`, `FCP`, `TTFB`) per page view, with `final: true`, when the page
  is hidden (`visibilitychange` or `pagehide`). `rating` uses the web-vitals thresholds; `navigation_id` is one id
  per page view (a bfcache restore starts a new one).
- A throwing callback is swallowed. Hooks registered before `grantConsent()` are not kept (the client is a no-op
  until consent).

### `exposeGlobal`

`init({ exposeGlobal: true })` (or a name) sets `globalThis.watchtower` to the client and dispatches
`watchtower:ready` on `window`. It is on by default in the script build and off for npm/ESM; `false` turns the
script default off.

## Beacon (under 2 KB)

For pages that only need Core Web Vitals and uncaught errors: `@watchtowerobservability/browser/beacon` (`dist/beacon.js`, ESM) or `dist/beacon.min.js` (script tag, global `WatchtowerBeacon`, about 1.5 KB gzipped). No tracing, replay, console capture, storage or dependencies.

```ts
import { init } from "@watchtowerobservability/browser/beacon";
init({ key: "wtp_...", endpoint: "https://edge.watchtowerops.net", service: "web", release: "abc123" });
```

```ts
const beacon = init({ key: "wtp_...", consent: "pending" }); // or "denied"; default "granted"
beacon.grantConsent(); // later, when the visitor agrees (revokeConsent() stops sending again)
```

- **Endpoint and key:** `POST <endpoint>/v1/rum/events?k=<key>` (default endpoint `https://edge.watchtowerops.net`). `key` is a publishable RUM key (`wtp_...`), the same kind the full client takes as `publishableKey`; it is public by design, so restrict it with allowed origins.
- **Requests:** exactly one per page view. When the page is hidden (`visibilitychange` to hidden, or `pagehide`, whichever comes first) it calls `navigator.sendBeacon` with a `text/plain` Blob (no preflight). Only if `sendBeacon` throws or returns false does it make one fallback `fetch` POST with `keepalive`, `Authorization: Bearer <key>` and `Content-Type: application/json`. Nothing is retried or queued.
- **Payload (JSON):** `{ session_id, sent_at_ns, sdk: {name, version}, app: {service, release}, page: {url, referrer}, device: {ua, viewport: [w, h], dpr}, user: {}, attrs: {}, events: [...] }`. URLs and referrers have query string and fragment removed. `events` holds one `{id, ts_ns, type: "vital", name: "LCP"|"CLS"|"INP", value, attrs: {rating, url}}` per metric seen, plus up to 10 `{type: "error", name: "Error"|"UnhandledRejection", attrs: {message (1 KiB max), stack (first frame, 300 chars max), handled: false}}`. `session_id` is a random per-page-view id: no cookie, no storage, no user identity.
- **Consent:** `consent` is `"granted"` (default, as in the full client), `"pending"` or `"denied"`. Unless granted, nothing is sent (the metrics are only held in memory); `grantConsent()` / `revokeConsent()` on the returned handle change that, and a page hidden before consent is granted sends nothing for that page view.
- **Size:** about 1.5 KB gzipped (a test fails above 2 KiB).

Approximations: CLS is the plain sum of shifts without recent input (not the session-window maximum), and INP is the longest event duration among interactions (web-vitals reports a high percentile), so it can read higher on busy pages. Errors carry no parsed frames, so they are not symbolicated.

## Source maps

Bundler plugins (`/vite-plugin`, `/rollup-plugin`, `/webpack-plugin`) inject debug ids and upload `.map`
files after the build. Before uploading they create the release (`POST /v1/projects/{prj}/releases`,
idempotent), then post each map to `/artifacts?kind=sourcemap&release=<v>&name=<file>.map`.

- Release: `release` option, else `$WT_RELEASE`, else the short sha (`git rev-parse --short HEAD`), the
  same value the deploy markers and `service.version` use. Pass the same value to `init({ release })`; when omitted, `init` reads `data-release` from the script tag, `<meta name="wt-release">` or a build-injected `__WT_RELEASE__`.
- Key: `apiKey` or `$WT_API_KEY`, a secret key (publishable `wtp_` keys are refused). Maps are deleted after
  upload unless `deleteSourcemapsAfterUpload: false`; upload errors fail the build when `$CI` is set (`failOnError` defaults to true there) and only warn otherwise; set `failOnError` explicitly to override.

### CI-only upload of hidden maps

To keep the secret key out of image builds, build the bundle once in CI with hidden maps, let the plugin
upload and delete them, then copy the finished `dist/` into the image (the Dockerfile never runs the build):

```ts
// vite.config.ts
import { watchtower } from "@watchtowerobservability/browser/vite-plugin";
export default {
  build: { sourcemap: "hidden" }, // maps are emitted, but no sourceMappingURL comment ships
  plugins: [watchtower({ api: "https://api.example.com", project: "prj_...", failOnError: true })],
};
```

```sh
# CI job: the only place WT_API_KEY exists
export WT_RELEASE=$(git rev-parse --short HEAD)
WT_API_KEY=$WT_API_KEY npm run build   # creates the release, uploads and deletes the maps
docker build --build-arg RELEASE=$WT_RELEASE .   # Dockerfile: COPY dist/ ...
```

## Provenance

Every release artifact carries a GitHub build attestation. Verify one with
`gh attestation verify <file> --repo watchtowerobservability/watchtower-browser`.

## License

Apache-2.0. Source of truth is the Watchtower monorepo; this repository is a published mirror.
