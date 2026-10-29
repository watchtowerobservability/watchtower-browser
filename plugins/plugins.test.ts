import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { debugIdFor, injectDebugId } from "./debugid";
import { uploadMaps } from "./upload";
import { watchtower } from "./vite";

const ok = (): Promise<Response> => Promise.resolve(new Response("{}", { status: 201 }));

async function mapFile(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "wt-maps-"));
  const path = join(dir, "app.js.map");
  await writeFile(path, '{"version":3}');
  return { dir, path };
}

describe("debug ids", () => {
  it("debugid_injected_and_stable_for_same_content", () => {
    const a = injectDebugId("app.js", "console.log(1)\n//# sourceMappingURL=app.js.map", '{"version":3}');
    const b = injectDebugId("app.js", "console.log(1)\n//# sourceMappingURL=app.js.map", '{"version":3}');
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.js).toContain(`//# debugId=${a.id}`);
    expect(a.js).toContain("_wtDebugIds");
    expect(JSON.parse(a.map!).debugId).toBe(a.id);
    expect(debugIdFor("other")).not.toBe(a.id);
  });
});

describe("upload", () => {
  it("vite_plugin_uploads_maps_with_release", async () => {
    const { dir, path } = await mapFile();
    const f = vi.fn(ok);
    const p = watchtower({ api: "https://api.example/", project: "prj_1", apiKey: "wts_secret", release: "1.2.3", fetch: f as never });
    await p.writeBundle({ dir }, { "app.js.map": { type: "asset" } });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/v1/projects/prj_1/artifacts?kind=sourcemap&name=app.js.map&release=1.2.3");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer wts_secret");
    expect(path).toContain(dir);
  });

  it("upload_failure_does_not_fail_build_by_default", async () => {
    const { path } = await mapFile();
    const bad = vi.fn(() => Promise.resolve(new Response("no", { status: 500 })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const o = { api: "https://a", project: "p", apiKey: "k", release: "r", fetch: bad as never };
    await expect(uploadMaps(o, [["app.js.map", path]])).resolves.toBeUndefined();
    await expect(uploadMaps({ ...o, failOnError: true }, [["app.js.map", path]])).rejects.toThrow(/upload failed/);
  });

  it("delete_sourcemaps_after_upload", async () => {
    const a = await mapFile();
    await uploadMaps({ api: "https://a", project: "p", apiKey: "k", release: "r", fetch: ok as never }, [["app.js.map", a.path]]);
    await expect(access(a.path)).rejects.toThrow();
    const b = await mapFile();
    await uploadMaps(
      { api: "https://a", project: "p", apiKey: "k", release: "r", deleteSourcemapsAfterUpload: false, fetch: ok as never },
      [["app.js.map", b.path]],
    );
    expect(await readFile(b.path, "utf8")).toBe('{"version":3}');
  });

  it("plugin_refuses_publishable_key_for_upload", async () => {
    const f = vi.fn(ok);
    await expect(uploadMaps({ api: "https://a", project: "p", apiKey: "wtp_abc", fetch: f as never }, [])).rejects.toThrow(/publishable/);
    expect(f).not.toHaveBeenCalled();
  });
});
