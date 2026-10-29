import { trackRoute } from "./router";

interface SnapshotLike {
  routeConfig: { path?: string } | null;
  firstChild: SnapshotLike | null;
}
interface AngularRouterLike {
  events: { subscribe(cb: (e: { urlAfterRedirects?: string }) => void): { unsubscribe(): void } };
  routerState?: { snapshot: { root: SnapshotLike } };
}

/** Angular: `trackAngularRouter(inject(Router))` from an app initializer. Builds the template from the
 * active `routeConfig.path` chain (`users/:id`). */
export function trackAngularRouter(router: AngularRouterLike): () => void {
  const sub = router.events.subscribe((e) => {
    if (!e.urlAfterRedirects) return;
    const parts: string[] = [];
    for (let s = router.routerState?.snapshot.root ?? null; s; s = s.firstChild) {
      if (s.routeConfig?.path) parts.push(s.routeConfig.path);
    }
    trackRoute(parts.length ? "/" + parts.join("/") : e.urlAfterRedirects);
  });
  return () => sub.unsubscribe();
}
