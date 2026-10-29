import { useEffect } from "react";
import { trackRoute } from "./router";

/** Next app router: `useNextRouteTracking(usePathname(), useParams())` from `next/navigation`. */
export function useNextRouteTracking(pathname: string | null, params?: Record<string, string | string[] | undefined>): void {
  useEffect(() => {
    if (pathname) trackRoute(pathname, params);
  }, [pathname, params]);
}
