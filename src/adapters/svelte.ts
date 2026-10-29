import { trackRoute } from "./router";

/** SvelteKit: in the root layout, `afterNavigate((n) => trackSvelteKit(n.to))` (`$app/navigation`).
 * `route.id` is already a template (`/users/[id]`); it is rewritten to `/users/:id`. */
export function trackSvelteKit(to: { route: { id: string | null }; url: URL } | null): void {
  if (!to) return;
  if (to.route.id) trackRoute(to.route.id.replace(/\[\.{0,3}([^\]]+)\]/g, ":$1").replace(/\/\([^)]+\)/g, ""));
  else trackRoute(to.url.pathname);
}
