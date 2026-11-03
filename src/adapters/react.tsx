import { Component, Profiler, createElement, useCallback, useEffect, type ErrorInfo, type ProfilerOnRenderCallback, type ReactNode } from "react";
import type { WatchtowerClient } from "../index";
import { trackRoute } from "./router";

interface Props {
  client: Pick<WatchtowerClient, "captureError">;
  fallback?: ReactNode;
  children?: ReactNode;
}

export class WatchtowerErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.client.captureError(error, { "react.component_stack": info.componentStack ?? "" });
  }
  render(): ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}

/** react-router / TanStack Router: `useRouteTracking(useLocation().pathname, useParams())`.
 * Next app router: use `useNextRouteTracking` from `./next`. */
export function useRouteTracking(pathname: string, params?: Record<string, string | string[] | undefined>): void {
  useEffect(() => trackRoute(pathname, params), [pathname, params]);
}

interface ProfilerProps {
  client: Pick<WatchtowerClient, "measure">;
  /** component name in the metric: `custom.react.render` with attrs component and phase */
  id: string;
  /** share of renders reported (default 0.1); renders under minMs are never reported */
  sampleRate?: number;
  minMs?: number;
  children?: ReactNode;
}

/** React.Profiler wrapper (Faro parity): sampled mount/update render durations as measurements. */
export function WatchtowerProfiler({ client, id, sampleRate = 0.1, minMs = 0, children }: ProfilerProps): ReactNode {
  const onRender = useCallback<ProfilerOnRenderCallback>(
    (_id, phase, actual, base) => {
      if (actual < minMs || Math.random() >= sampleRate) return;
      client.measure("react.render", actual, { component: id, phase, "react.base_duration_ms": Math.round(base * 100) / 100 });
    },
    [client, id, sampleRate, minMs],
  );
  return createElement(Profiler, { id, onRender }, children);
}
