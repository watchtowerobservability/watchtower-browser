# @watchtowerobservability/browser

## Install

```sh
echo '@watchtowerobservability:registry=https://npm.pkg.github.com' >> .npmrc
npm install @watchtowerobservability/browser
```

GitHub Packages needs a token with `read:packages`; the release tarball installs without one.

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
- Core budget: 12 KiB gzipped (`size_budget.test.ts`). Replay is a separate lazy chunk (not in this package yet).

`pnpm -C sdks/browser test`, `pnpm -C sdks/browser build` (ESM + `dist/wt.min.js` IIFE).

## Provenance

Every release artifact carries a GitHub build attestation. Verify one with
`gh attestation verify <file> --repo watchtowerobservability/watchtower-browser`.

## License

Apache-2.0. Source of truth is the Watchtower monorepo; this repository is a published mirror.
