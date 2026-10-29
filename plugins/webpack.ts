import { join } from "node:path";
import { injectDebugId } from "./debugid";
import { uploadMaps, type UploadOptions } from "./upload";

/** webpack 5: `plugins: [new WatchtowerWebpackPlugin({ api, project })]` with `devtool: "source-map"`. */
export class WatchtowerWebpackPlugin {
  constructor(private readonly o: UploadOptions) {}

  apply(compiler: any): void {
    const { RawSource } = compiler.webpack.sources;
    compiler.hooks.thisCompilation.tap("watchtower", (compilation: any) => {
      compilation.hooks.processAssets.tap(
        { name: "watchtower", stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_DEV_TOOLING + 1 },
        () => {
          for (const file of Object.keys(compilation.assets).filter((f) => f.endsWith(".js"))) {
            const map = compilation.getAsset(`${file}.map`);
            const js = compilation.getAsset(file).source.source().toString();
            const r = injectDebugId(file, js, map ? map.source.source().toString() : undefined);
            compilation.updateAsset(file, new RawSource(r.js));
            if (map && r.map) compilation.updateAsset(`${file}.map`, new RawSource(r.map));
          }
        },
      );
    });
    compiler.hooks.afterEmit.tapPromise("watchtower", async (compilation: any) => {
      const out = compiler.outputPath as string;
      const maps = Object.keys(compilation.assets).filter((f) => f.endsWith(".map")).map((f): [string, string] => [f, join(out, f)]);
      await uploadMaps(this.o, maps);
    });
  }
}
