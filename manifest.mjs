import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** All .js files under `dir`, as sorted forward-slash relative paths. */
export function listJs(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".js")) out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** manifest.json content: every .js file with size, sha256 (hex) and SRI sha384. */
export function buildManifest(dir, version) {
  const files = listJs(dir).map((path) => {
    const b = readFileSync(join(dir, path));
    return { path, bytes: b.length, sha256: createHash("sha256").update(b).digest("hex"), integrity: "sha384-" + createHash("sha384").update(b).digest("base64") };
  });
  return { package: "@watchtowerobservability/browser", version, note: "Serve every file listed here (keep the folder layout) next to wt.min.js. .map files are optional.", files };
}
