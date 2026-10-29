import { trace, type Span, type TextMapPropagator } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { XMLHttpRequestInstrumentation } from "@opentelemetry/instrumentation-xml-http-request";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { LIMITS, type Matcher, type WatchtowerConfig } from "../config";
import { posthogAttrs } from "../posthog";
import { matches, scrubUrl, type Ctx, type Uninstall } from "./ctx";

/** Same-origin is deliberately not implicit; the Watchtower endpoints never get a trace header. */
export function shouldPropagate(url: string, cfg: WatchtowerConfig, isOwn: (u: string) => boolean): boolean {
  return url !== "" && !isOwn(url) && (cfg.propagateTo ?? []).some((m) => matches(m, url));
}

const spanUrl = (span: Span): string => {
  const a = (span as unknown as { attributes?: Record<string, unknown> }).attributes;
  return String(a?.["http.url"] ?? a?.["url.full"] ?? "");
};

/**
 * The instrumentations inject for every same-origin request and any CORS URL we allow; this
 * propagator is the single decision point, so `propagateTo` is the only way a header is sent.
 */
export function makePropagator(cfg: WatchtowerConfig, isOwn: (u: string) => boolean): TextMapPropagator {
  return {
    inject(context, carrier, setter) {
      const span = trace.getSpan(context);
      if (!span || !shouldPropagate(spanUrl(span), cfg, isOwn)) return;
      const sc = span.spanContext();
      setter.set(carrier, "traceparent", `00-${sc.traceId}-${sc.spanId}-0${sc.traceFlags & 1}`);
    },
    extract: (context) => context,
    fields: () => ["traceparent"],
  };
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** OTel wants RegExp|string equality; ours are prefixes. */
const toRegex = (m: Matcher): RegExp => (typeof m === "string" ? new RegExp(`^${esc(m)}`) : m);

export function installTracing(ctx: Ctx): Uninstall {
  const cfg = ctx.cfg;
  if (!cfg.otlpEndpoint) return () => undefined;
  const base = cfg.otlpEndpoint.replace(/\/$/, "");
  const ignoreUrls = [cfg.endpoint, cfg.otlpEndpoint, ...(cfg.ignoreUrls ?? [])].map(toRegex);

  const exporter = new OTLPTraceExporter({
    url: `${base}/v1/traces`,
    headers: { Authorization: `Bearer ${cfg.publishableKey}` },
  });
  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      "service.name": cfg.service,
      ...(cfg.release ? { "service.version": cfg.release } : {}),
      ...(cfg.environment ? { "deployment.environment.name": cfg.environment } : {}),
      "browser.language": navigator.language,
      "browser.mobile": window.innerWidth < 768,
      "browser.user_agent": navigator.userAgent,
    }),
    spanProcessors: [
      {
        // session.id and the PostHog ids on every span
        onStart: (span) => {
          span.setAttribute("session.id", ctx.sessionId());
          for (const [k, v] of Object.entries({ ...posthogAttrs(), ...ctx.extraAttrs?.() })) span.setAttribute(k, v);
        },
        onEnd: () => undefined,
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      },
      new BatchSpanProcessor(exporter),
    ],
  });
  provider.register({ propagator: makePropagator(cfg, ctx.isOwn) });

  const record = (span: Span, status: number | undefined, failed: boolean): void => {
    const url = scrubUrl(spanUrl(span));
    if (!url) return;
    if (ctx.net.size >= LIMITS.queueMax) ctx.net.delete(ctx.net.keys().next().value!);
    ctx.net.set(url, { status, failed, trace_id: span.spanContext().traceId });
  };
  const unregister = registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new FetchInstrumentation({
        ignoreUrls,
        propagateTraceHeaderCorsUrls: [/.*/],
        applyCustomAttributesOnSpan: (span, _req, res) => {
          const status = (res as { status?: number }).status;
          record(span, status, "ok" in res ? res.ok === false : true);
        },
      }),
      new XMLHttpRequestInstrumentation({
        ignoreUrls,
        propagateTraceHeaderCorsUrls: [/.*/],
        applyCustomAttributesOnSpan: (span, xhr) => record(span, xhr.status, xhr.status === 0 || xhr.status >= 400),
      }),
    ],
  });

  // Page-load and route-change spans; the latest one is the "active span" for errors and profiles.
  const tracer = provider.getTracer("@watchtower/browser");
  const setActive = (s: Span): void => {
    const sc = s.spanContext();
    ctx.span = { trace_id: sc.traceId, span_id: sc.spanId };
  };
  const load = tracer.startSpan("documentLoad", {
    startTime: performance.timeOrigin,
    attributes: { "view.route": ctx.route(), "page.url": scrubUrl(location.href) },
  });
  setActive(load);
  const endLoad = (): void => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    load.end(performance.timeOrigin + (nav?.loadEventEnd || performance.now()));
  };
  if (document.readyState === "complete") endLoad();
  else window.addEventListener("load", endLoad, { once: true });

  ctx.onNav(({ route, previous }) => {
    const s = tracer.startSpan("navigation", {
      attributes: { "view.route": route, ...(previous ? { "view.previous_route": previous } : {}) },
    });
    setActive(s);
    requestAnimationFrame(() => requestAnimationFrame(() => s.end()));
  });

  return () => {
    unregister();
    window.removeEventListener("load", endLoad);
    void provider.shutdown().catch(() => undefined);
  };
}
