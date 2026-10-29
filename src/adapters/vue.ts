import { trackRoute } from "./router";

interface VueRouterLike {
  afterEach(
    cb: (to: { path: string; params: Record<string, string | string[]>; matched?: Array<{ path: string }> }) => void,
  ): () => void;
}

/** Vue Router: prefers the matched route record's template (`/users/:id`), else derives it from params. */
export function trackVueRouter(router: VueRouterLike): () => void {
  return router.afterEach((to) => {
    const rec = to.matched?.[to.matched.length - 1]?.path;
    if (rec?.includes(":")) trackRoute(rec, {});
    else trackRoute(to.path, to.params);
  });
}
