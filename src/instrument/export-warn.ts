/** Spans refused with 401/403/404 are dropped for good: say so once per page load instead of staying silent. */
export function warnOnRefusal<T extends { export(spans: never, cb: (r: { error?: unknown }) => void): void }>(exporter: T, url: string): T {
  const inner = exporter.export.bind(exporter);
  let warned = false;
  exporter.export = (spans, cb) =>
    inner(spans, (r) => {
      const code = (r.error as { code?: number } | undefined)?.code;
      if (!warned && (code === 401 || code === 403 || code === 404)) {
        warned = true;
        console.warn(`[watchtower] spans are not being delivered: HTTP ${code} from ${url}; check otlpEndpoint, the publishable key and allowed origins`);
      }
      cb(r);
    });
  return exporter;
}
