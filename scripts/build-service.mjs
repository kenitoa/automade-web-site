import { build } from "esbuild";
import {sourceIdentity} from './source-identity.mjs';
import {writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const identity=sourceIdentity(process.cwd());
const commit=process.env.AUTOMADE_SOURCE_COMMIT??process.env.GITHUB_SHA??process.env.BUILD_COMMIT??null;
if(commit!==null&&!/^[a-f0-9]{40,64}$/i.test(commit))throw new Error('Build commit must be a full source commit SHA');
const define={AUTOMADE_BUILD_HASH:JSON.stringify(identity.hash),AUTOMADE_BUILD_COMMIT:JSON.stringify(commit)};
await build({
  define,
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
  define,
  entryPoints: ["server/siteServer.ts"],
  outfile: "dist-service/site-server.mjs",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  jsx: "automatic",
});
for (const [entry, output] of [["server/generationWorker.ts", "generation-worker.mjs"], ["server/siteWorker.ts", "site-worker.mjs"], ["server/expansionWorker.ts", "expansion-worker.mjs"], ["server/imageWorker.ts", "image-worker.mjs"]]) {
  await build({ define,entryPoints: [entry], outfile: `dist-service/${output}`, bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", jsx: "automatic" });
}
const artifacts={};for(const name of ['server.mjs','site-server.mjs','generation-worker.mjs','site-worker.mjs','expansion-worker.mjs','image-worker.mjs'])artifacts[name]=createHash('sha256').update(await readFile('dist-service/'+name)).digest('hex');
await writeFile('dist-service/build.json',JSON.stringify({format:1,...identity,commit,node:process.versions.node,builtAt:new Date().toISOString(),artifacts},null,2));
