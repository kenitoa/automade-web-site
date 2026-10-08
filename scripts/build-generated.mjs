import { build } from "esbuild";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  lstat,
  realpath,
  readdir,
} from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = await realpath(process.cwd());
const contract = JSON.parse(await readFile("artifact.contract.json", "utf8")),
  acceptSource = process.argv.includes("--accept-source");
let sourceChanged = false;
try {
  await lstat("artifact.signature.json");
  throw new Error(
    "Signed artifacts require a newly reviewed generation to update their publisher signature. Original files were preserved.",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
try {
  await lstat("deployment.signature.json");
  throw new Error(
    "Signed deployment artifacts require a newly reviewed generation. Original files were preserved.",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const relativePath = (value) => {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    /^[A-Za-z]:/.test(value)
  )
    throw new Error("Invalid artifact file path");
  return path.resolve(root, value);
};
const checkedFile = async (value) => {
  const file = relativePath(value);
  let current = root;
  for (const segment of value.split("/")) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Symbolic artifact paths are not accepted");
  }
  if (!(await realpath(file)).startsWith(root + path.sep))
    throw new Error("Artifact file escapes the output folder");
  return file;
};
if (contract.protocol === 2) {
  for (const entry of [
    contract.runtime,
    ...contract.licenses,
    ...contract.sourceFiles,
    ...contract.compiledFiles,
  ]) {
    const file = await checkedFile(entry.path);
    const actual = digest(await readFile(file));
    if (actual !== entry.sha256) {
      if (
        !acceptSource ||
        entry === contract.runtime ||
        contract.licenses.includes(entry) ||
        contract.compiledFiles.includes(entry)
      )
        throw new Error(`Artifact integrity mismatch: ${entry.path}`);
      entry.sha256 = actual;
      sourceChanged = true;
    }
  }
  if (
    !contract.supportedHosts.some(
      (host) =>
        host.platform === process.platform && host.arch === process.arch,
    )
  )
    throw new Error(
      "This artifact's bundled runtime does not support the current OS/architecture",
    );
  if (
    digest(await readFile("package-lock.json")) !==
      contract.packageLockSha256 &&
    !acceptSource
  )
    throw new Error("Artifact package lock changed");
  if (contract.build) {
    contract.build.sourceHash = digest(
      JSON.stringify(
        contract.sourceFiles
          .slice()
          .sort((a, b) => a.path.localeCompare(b.path)),
      ),
    );
    if (sourceChanged) {
      contract.build.serviceBuildHash = contract.build.sourceHash;
      contract.build.commit = null;
    }
  }
} else if (contract.protocol !== 1)
  throw new Error(
    "Unsupported artifact contract; original files were preserved",
  );

const temporary = path.resolve(".dist-build-" + randomUUID());
const serverTemporary = path.resolve(
  ".site-server-build-" + randomUUID() + ".mjs",
);
await mkdir(path.join(temporary, "assets"), { recursive: true });
try {
  await build({
    entryPoints: ["src/runtime/client.tsx"],
    outfile: path.join(temporary, "assets/site.js"),
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2022",
    jsx: "automatic",
  });
  await build({
    entryPoints: ["src/runtime/document.tsx"],
    outfile: ".build-render.mjs",
    bundle: true,
    platform: "node",
    packages: "external",
    format: "esm",
    jsx: "automatic",
  });
  const renderer = await import("./.build-render.mjs?" + Date.now());
  let deploymentWriter;
  if (contract.protocol === 2 && contract.build) {
    await build({
      entryPoints: ["server/deploymentIntegrity.ts"],
      outfile: ".build-deployment.mjs",
      bundle: true,
      platform: "node",
      packages: "external",
      format: "esm",
    });
    deploymentWriter = await import("./.build-deployment.mjs?" + Date.now());
  }
  const raw = JSON.parse(await readFile("project.interface.json", "utf8"));
  const original = renderer.parseProject(raw.project ?? raw);
  for (const pack of original.blockPackages ?? [])
    await renderer.verifyPackageIntegrity(pack);
  if (!renderer.preflightProject(original).supported)
    throw new Error("Original requires unsupported packages; it was preserved");
  if (
    renderer
      .inspectProject(original)
      .some((issue) => issue.severity === "error")
  )
    throw new Error("Project quality check failed");
  const project = renderer.publicProject(original);
  await build({
    entryPoints: ["server/siteServer.ts"],
    define: {
      AUTOMADE_BUILD_HASH: JSON.stringify(
        contract.build?.serviceBuildHash ?? null,
      ),
      AUTOMADE_BUILD_COMMIT: JSON.stringify(contract.build?.commit ?? null),
    },
    outfile: serverTemporary,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    jsx: "automatic",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  for (const route of renderer.siteRoutes(original)) {
    const folder = path.resolve(temporary, "." + route.path);
    if (folder !== temporary && !folder.startsWith(temporary + path.sep))
      throw new Error("Invalid output path");
    await mkdir(folder, { recursive: true });
    await writeFile(
      path.join(folder, "index.html"),
      renderer.html(original, route.pageId, route.contentPath, route.language),
    );
  }
  for (const file of renderer.sitemapArtifacts(original)) {
    const destination = path.join(temporary, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content);
  }
  await writeFile(path.join(temporary, "robots.txt"), renderer.robots(project));
  for (const asset of project.assets) {
    await writeFile(
      path.join(
        temporary,
        "assets",
        `share-${asset.id}.${asset.mime.split("/")[1]}`,
      ),
      Buffer.from(asset.data.slice(asset.data.indexOf(",") + 1), "base64"),
    );
  }
  const backup = ".dist-backup-" + randomUUID();
  const serverBackup = ".site-server-backup-" + randomUUID() + ".mjs";
  const contractBackup = ".artifact-contract-backup-" + randomUUID() + ".json";
  const contractTemporary =
    ".artifact-contract-build-" + randomUUID() + ".json";
  const deploymentBackup =
    ".deployment-contract-backup-" + randomUUID() + ".json";
  let moved = false;
  let serverMoved = false;
  let distInstalled = false;
  let serverInstalled = false;
  let contractMoved = false;
  let contractInstalled = false;
  let deploymentMoved = false;
  let deploymentInstalled = false;
  try {
    await rename("dist", backup);
    moved = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await rename(temporary, "dist");
    distInstalled = true;
    await rename("site-server.mjs", serverBackup);
    serverMoved = true;
    await rename(serverTemporary, "site-server.mjs");
    serverInstalled = true;
    if (contract.protocol === 2) {
      contract.packageLockSha256 = digest(await readFile("package-lock.json"));
      const compiledFiles = [];
      const collect = async (folder) => {
        for (const entry of await readdir(relativePath(folder), {
          withFileTypes: true,
        })) {
          const relative = `${folder}/${entry.name}`;
          if (entry.isSymbolicLink())
            throw new Error("Symbolic build output is not accepted");
          if (entry.isDirectory()) await collect(relative);
          else if (entry.isFile())
            compiledFiles.push({
              path: relative,
              sha256: digest(await readFile(await checkedFile(relative))),
            });
        }
      };
      await collect("dist");
      compiledFiles.push({
        path: "site-server.mjs",
        sha256: digest(await readFile("site-server.mjs")),
      });
      contract.compiledFiles = compiledFiles.sort((a, b) =>
        a.path.localeCompare(b.path),
      );
      await writeFile(contractTemporary, JSON.stringify(contract, null, 2));
      await rename("artifact.contract.json", contractBackup);
      contractMoved = true;
      await rename(contractTemporary, "artifact.contract.json");
      contractInstalled = true;
      if (deploymentWriter) {
        try {
          await rename("deployment.contract.json", deploymentBackup);
          deploymentMoved = true;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const release = JSON.parse(await readFile(".release.json", "utf8"));
        await deploymentWriter.writeDeploymentContract(root, {
          projectId: original.id,
          revision: original.revision,
          releaseId: release.id,
          buildHash: contract.build.serviceBuildHash,
          buildCommit: contract.build.commit,
        });
        deploymentInstalled = true;
      }
    }
  } catch (error) {
    if (deploymentInstalled)
      await rename(
        "deployment.contract.json",
        ".deployment-contract-failed-" + randomUUID() + ".json",
      );
    if (deploymentMoved)
      await rename(deploymentBackup, "deployment.contract.json");
    if (contractMoved) {
      if (contractInstalled)
        await rename(
          "artifact.contract.json",
          ".artifact-contract-failed-" + randomUUID() + ".json",
        );
      await rename(contractBackup, "artifact.contract.json");
    }
    if (serverMoved) {
      if (serverInstalled)
        await rename(
          "site-server.mjs",
          ".site-server-failed-" + randomUUID() + ".mjs",
        );
      await rename(serverBackup, "site-server.mjs");
    }
    if (moved) {
      if (distInstalled) await rename("dist", ".dist-failed-" + randomUUID());
      await rename(backup, "dist");
    }
    throw error;
  }
} finally {
  await rm(".build-render.mjs", { force: true });
  await rm(".build-deployment.mjs", { force: true });
}
