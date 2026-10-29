import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { currentRoute, setRoute } from "../instrument/navigation";
import { WatchtowerErrorBoundary } from "./react";
import { templateFromParams, trackRoute } from "./router";
import { trackSvelteKit } from "./svelte";
import { trackVueRouter } from "./vue";

describe("adapters", () => {
  it("react_error_boundary_reports_component_stack", () => {
    const captureError = vi.fn();
    const b = new WatchtowerErrorBoundary({ client: { captureError } });
    const err = new Error("boom");
    b.componentDidCatch(err, { componentStack: "\n    at Bad\n    at App" } as never);
    expect(captureError).toHaveBeenCalledWith(err, { "react.component_stack": "\n    at Bad\n    at App" });
    expect(WatchtowerErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  it("route_adapters_normalize_template", () => {
    expect(templateFromParams("/users/42/orders/7?x=1", { id: "42", oid: "7" })).toBe("/users/:id/orders/:oid");
    trackRoute("/users/42", { id: "42" });
    expect(currentRoute()).toBe("/users/:id");

    let cb: (to: never) => void = () => undefined;
    trackVueRouter({ afterEach: (f) => ((cb = f as never), () => undefined) });
    cb({ path: "/teams/9", params: {}, matched: [{ path: "/teams/:team" }] } as never);
    expect(currentRoute()).toBe("/teams/:team");

    trackSvelteKit({ route: { id: "/(app)/posts/[slug]" }, url: new URL("http://x/posts/a") });
    expect(currentRoute()).toBe("/posts/:slug");
    setRoute(undefined);
  });

  it("exports_map_contains_all_entrypoints", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as { exports: Record<string, unknown> };
    for (const k of [".", "./react", "./next", "./vue", "./angular", "./svelte", "./vite-plugin", "./webpack-plugin", "./rollup-plugin"]) {
      expect(Object.keys(pkg.exports)).toContain(k);
    }
  });

  // The docs live in the monorepo; the published SDK mirror has no docs/ tree.
  const docsDir = join(__dirname, "../../../../docs/product/ingest/browser");
  it.skipIf(!existsSync(docsDir))("framework_docs_cover_csp_and_privacy_attrs", () => {
    const dir = docsDir;
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    expect(files.sort()).toEqual(["angular.md", "cdn.md", "nextjs.md", "react.md", "svelte.md", "vanilla.md", "vue.md"]);
    for (const f of files) {
      const t = readFileSync(join(dir, f), "utf8");
      expect(t, f).toContain("worker-src blob:");
      expect(t, f).toContain("connect-src");
      expect(t, f).toContain("data-wt-mask");
    }
  });
});
