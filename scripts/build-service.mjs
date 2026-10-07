import { build } from "esbuild";
await build({
  entryPoints: ["server/index.ts"],
  outfile: "dist-service/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  jsx: "automatic",
});
await build({
  entryPoints: ["server/siteServer.ts"],
  outfile: "dist-service/site-server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  jsx: "automatic",
});
