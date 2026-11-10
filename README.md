# @watchtowerobservability/browser

[![CI](https://github.com/watchtowerobservability/watchtower-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/watchtowerobservability/watchtower-browser/actions/workflows/ci.yml)

## Install

```sh
npm install @watchtowerobservability/browser
```

The package is on public npm (with provenance); no token is needed.

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

## Self-hosting (vendoring) the script

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

## Consent

GDPR sites can load the SDK before consent and start it later:

```ts
const wt = init({ publishableKey: "wtp_...", endpoint: "https://edge.example.com", service: "web", consent: "pending" });
cmp.onAccept(() => wt.grantConsent());   // starts session, config fetch, instrumentation
cmp.onWithdraw(() => wt.revokeConsent()); // stops, drops queued events and logs, removes `wt.session`
```

With `consent: "pending"` nothing runs and nothing is sent (no session, no config request) until
`grantConsent()`. Calls made before the grant are dropped, not queued. `revokeConsent()` also works on a
client started without `consent`; a later `grantConsent()` starts a new session.

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
