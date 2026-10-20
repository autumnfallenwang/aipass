/**
 * Bundles the api and the gateway into single ESM files for the Docker images
 * (S7): workspace packages and npm dependencies included, so the runtime
 * image needs no node_modules.
 *
 *   pnpm bundle      # → apps/api/dist/{index,init}.mjs, apps/gateway/dist/index.mjs
 */
import { join } from "node:path";
import { build } from "esbuild";

const root = join(import.meta.dirname, "..");
const entries = [
  { in: "apps/api/src/index.ts", out: "apps/api/dist/index.mjs" },
  { in: "apps/api/src/init.ts", out: "apps/api/dist/init.mjs" },
  { in: "apps/gateway/src/index.ts", out: "apps/gateway/dist/index.mjs" },
];

for (const e of entries) {
  const r = await build({
    entryPoints: [join(root, e.in)],
    outfile: join(root, e.out),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: "linked",
    // CommonJS dependencies inside an ESM bundle still call require().
    banner: {
      js: 'import { createRequire as __aipassRequire } from "node:module"; const require = __aipassRequire(import.meta.url);',
    },
    logLevel: "warning",
    metafile: true,
  });
  const bytes = Object.values(r.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
  console.info(`${e.out}: ${(bytes / 1e6).toFixed(1)} MB`);
}
