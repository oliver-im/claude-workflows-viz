import { build } from "esbuild";
import { readFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const outfile = join(root, "dist/cli.js");

await build({
  entryPoints: [join(root, "ts/cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  // @resvg/resvg-js and @napi-rs/image ship native .node binaries; keep them
  // external so esbuild doesn't try to bundle a platform addon into the JS file.
  // Both stay in `dependencies`, so npm installs them at the user's site.
  external: ["@resvg/resvg-js", "@napi-rs/image"],
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __cwvCreateRequire } from "node:module";',
      "const require = __cwvCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  define: {
    __CWV_VERSION__: JSON.stringify(pkg.version),
  },
  legalComments: "none",
  logLevel: "info",
});

chmodSync(outfile, 0o755);
console.log(`Bundled ${outfile} (claude-workflows-viz ${pkg.version})`);
