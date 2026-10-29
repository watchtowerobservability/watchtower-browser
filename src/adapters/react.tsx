import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
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
