import { build } from "esbuild";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  stat,
  copyFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { inspectProject, parseProject } from "../src/domain/validation";
import type { ExportResult, Project } from "../src/domain/types";
import { contained, HttpError } from "./http";
import { Store } from "./store";
import { publicProject } from "../src/domain/publication";
import {
  preflightProject,
  verifyPackageIntegrity,
} from "../src/domain/packages";
import { createHash } from "node:crypto";
import { sitemapArtifacts, robots, siteRoutes } from "../src/runtime/document";
export { GENERATOR_VERSION } from "../src/domain/version";
import { GENERATOR_VERSION } from "../src/domain/version";
import {
  signArtifactContract,
  signDeploymentContract,
} from "./artifactSigning";
import { writeDeploymentContract } from "./deploymentIntegrity";
import type {
  ArtifactContract,
  ArtifactFile,
} from "../src/domain/artifactContracts";
export type GenerationLifecycle =
  "before-data-snapshot" | "after-data-snapshot";
export { html } from "../src/runtime/document";
import { html } from "../src/runtime/document";
export function verifyAssets(
  project: Project,
  options: { allowBlobReferences?: boolean } = {},
): void {
  let total = 0;
  for (const asset of project.assets) {
    if (
      !asset.data &&
      options.allowBlobReferences &&
      asset.blobRef &&
      asset.blobRef.id &&
      asset.blobRef.projectId &&
      /^[a-f0-9]{64}$/.test(asset.blobRef.sha256) &&
      ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
        asset.mime,
      )
    )
      continue;
    const buffer = Buffer.from(
      asset.data.slice(asset.data.indexOf(",") + 1),
      "base64",
    );
    total += buffer.length;
    if (buffer.length > 5_000_000 || total > 20_000_000)
      throw new HttpError(
        413,
        "ASSET_SIZE",
        "이미지 한 개는 5MB, 전체는 20MB를 초과할 수 없습니다.",
      );
    const png = buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    const gif = ["GIF87a", "GIF89a"].includes(
      buffer.subarray(0, 6).toString("ascii"),
    );
    const webp =
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP";
    if (!(
      (asset.mime === "image/png" && png) ||
      (asset.mime === "image/jpeg" && jpeg) ||
      (asset.mime === "image/gif" && gif) ||
      (asset.mime === "image/webp" && webp)
    ))
      throw new HttpError(
        400,
        "ASSET_MIME",
        "이미지 내용과 MIME 형식이 일치하지 않습니다.",
      );
  }
}
export async function generate(
  projectInput: unknown,
  options: {
    root: string;
    sourceRoot: string;
    id: string;
    previousDirectory?: string | null;
    dataFile?: string;
    lifecycle?: (event: GenerationLifecycle) => void;
    stage?: (value: string) => void;
    signal?: AbortSignal;
    resolveBlob?: (
      projectId: string,
      blobId: string,
    ) => Promise<{ bytes: Uint8Array; mime: string }>;
  },
): Promise<Omit<ExportResult, "url">> {
  const started = Date.now();
  const project = parseProject(projectInput);
  for (const asset of project.assets)
    if (asset.blobRef) {
      if (!asset.data) {
        if (!options.resolveBlob)
          throw new HttpError(
            422,
            "BLOB_REQUIRED",
            "참조 이미지의 실제 파일을 권한 확인 후 불러와야 합니다.",
          );
        const blob = await options.resolveBlob(project.id, asset.blobRef.id);
        if (blob.mime !== asset.mime)
          throw new HttpError(
            422,
            "BLOB_MIME",
            "참조 이미지의 형식이 다릅니다.",
          );
        asset.data = `data:${asset.mime};base64,${Buffer.from(blob.bytes).toString("base64")}`;
      }
      const digest = createHash("sha256")
        .update(
          Buffer.from(asset.data.slice(asset.data.indexOf(",") + 1), "base64"),
        )
        .digest("hex");
      if (digest !== asset.blobRef.sha256)
        throw new HttpError(
          422,
          "BLOB_INTEGRITY",
          "참조 이미지의 실제 파일 해시가 다릅니다.",
        );
    }
  for (const pack of project.blockPackages ?? [])
    await verifyPackageIntegrity(pack);
  verifyAssets(project);
  const issues = inspectProject(project);
  if (issues.some((x) => x.severity === "error"))
    throw new HttpError(
      422,
      "QUALITY",
      issues
        .filter((x) => x.severity === "error")
        .map((x) => x.message)
        .join(" "),
    );
  if (!/^[a-f0-9-]{36}$/.test(options.id))
    throw new Error("Invalid artifact ID");
  const staging = path.join(options.root, `.${options.id}.staging`),
    directory = path.join(options.root, options.id);
  if (!contained(options.root, staging) || !contained(options.root, directory))
    throw new Error("Invalid export root");
  const output = path.join(staging, "output");
  await mkdir(path.join(output, "dist/assets"), { recursive: true });
  const checkpoint = (stage: string) => {
    options.signal?.throwIfAborted();
    options.stage?.(stage);
  };
  checkpoint("소스 구성");
  const names: string[] = [];
  const collectSources = async (folder: string): Promise<void> => {
    for (const entry of await readdir(path.join(options.sourceRoot, folder), {
      withFileTypes: true,
    })) {
      if (entry.isSymbolicLink())
        throw new Error("Symbolic source links are not exportable");
      if (entry.isDirectory()) await collectSources(`${folder}/${entry.name}`);
      else if (entry.isFile() && /\.(ts|tsx|css)$/.test(entry.name))
        names.push(`${folder}/${entry.name}`);
    }
  };
  for (const folder of ["src/runtime", "src/domain", "server"]) {
    await collectSources(folder);
  }
  names.push("scripts/source-identity.mjs", "scripts/source-identity.d.mts");
  const sourceFiles: { path: string; sha256: string }[] = [];
  for (const name of names.sort()) {
    const destination = path.join(output, name);
    await mkdir(path.dirname(destination), { recursive: true });
    const bytes = await readFile(path.join(options.sourceRoot, name));
    await writeFile(destination, bytes);
    sourceFiles.push({
      path: name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await writeFile(
    path.join(output, "artifact.contract.json"),
    JSON.stringify(
      {
        protocol: 1,
        schemaVersion: 2,
        generatorVersion: GENERATOR_VERSION,
        target: "node",
        node: ">=22.16.0",
        databaseMigration: 15,
        packages: preflightProject(project).requiredPackages,
        sourceFiles,
      },
      null,
      2,
    ),
  );
  const packageJson = JSON.parse(
    await readFile(path.join(options.sourceRoot, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  packageJson.name = "generated-website";
  packageJson.scripts = {
    start: "node site-server.mjs --standalone --open",
    dev: "node site-server.mjs --standalone --open",
    build: "node build.mjs",
    typecheck: "tsc --noEmit",
    lint: "eslint src server",
    test: "node --test tests/*.test.mjs",
  };
  await writeFile(
    path.join(output, "package.json"),
    JSON.stringify(packageJson, null, 2),
  );
  const lock = JSON.parse(
    await readFile(path.join(options.sourceRoot, "package-lock.json"), "utf8"),
  ) as { name: string; packages: Record<string, { name?: string }> };
  lock.name = "generated-website";
  lock.packages[""]!.name = "generated-website";
  await writeFile(
    path.join(output, "package-lock.json"),
    JSON.stringify(lock, null, 2),
  );
  for (const config of ["eslint.config.mjs"])
    await writeFile(
      path.join(output, config),
      await readFile(path.join(options.sourceRoot, config)),
    );
  await writeFile(
    path.join(output, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          strict: true,
          noUncheckedIndexedAccess: true,
          esModuleInterop: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["src/**/*.ts", "src/**/*.tsx", "server/**/*.ts"],
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(output, "project.interface.json"),
    JSON.stringify(
      {
        generatorVersion: GENERATOR_VERSION,
        savedAt: new Date().toISOString(),
        project,
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(output, "index.html"), html(project));
  await mkdir(path.join(output, "pages"), { recursive: true });
  await writeFile(path.join(output, "pages/index.html"), html(project));
  await writeFile(
    path.join(output, "build.mjs"),
    await readFile(
      path.join(options.sourceRoot, "scripts/build-generated.mjs"),
    ),
  );
  checkpoint("사이트 빌드");
  await build({
    entryPoints: [path.join(output, "src/runtime/client.tsx")],
    outfile: path.join(output, "dist/assets/site.js"),
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    nodePaths: [path.join(options.sourceRoot, "node_modules")],
    logLevel: "silent",
  });
  await writeFile(path.join(output, "dist/index.html"), html(project));
  for (const page of project.pages.filter((p) => p.published && !p.home)) {
    const relative = page.path.replace(/^\//, "").replace(/\/$/, "");
    const folder = path.join(output, "dist", relative);
    if (!contained(path.join(output, "dist"), folder))
      throw new Error("Invalid page path");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "index.html"), html(project, page.id));
    const sourceFolder = path.join(output, "pages", relative);
    await mkdir(sourceFolder, { recursive: true });
    await writeFile(
      path.join(sourceFolder, "index.html"),
      html(project, page.id),
    );
  }
  const publicSite = publicProject(project);
  for (const route of siteRoutes(project)) {
    const folder = path.join(output, "dist", route.path.slice(1));
    if (
      path.resolve(folder) !== path.resolve(output, "dist") &&
      !contained(path.join(output, "dist"), folder)
    )
      throw new Error("Invalid content path");
    await mkdir(folder, { recursive: true });
    await writeFile(
      path.join(folder, "index.html"),
      html(project, route.pageId, route.contentPath, route.language),
    );
  }
  for (const file of sitemapArtifacts(project)) {
    const destination = path.join(output, "dist", file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content);
  }
  await writeFile(path.join(output, "dist/robots.txt"), robots(publicSite));
  for (const asset of publicSite.assets) {
    await writeFile(
      path.join(
        output,
        "dist/assets",
        `share-${asset.id}.${asset.mime.split("/")[1]}`,
      ),
      Buffer.from(asset.data.slice(asset.data.indexOf(",") + 1), "base64"),
    );
  }
  await writeFile(
    path.join(output, "site-server.mjs"),
    await readFile(
      path.join(options.sourceRoot, "dist-service/site-server.mjs"),
    ),
  );
  for (const file of ["Dockerfile", "compose.yml", ".dockerignore"]) {
    await copyFile(
      path.join(options.sourceRoot, "infrastructure/site", file),
      path.join(output, file),
    );
  }
  checkpoint("검증과 데이터 보존");
  options.lifecycle?.("before-data-snapshot");
  if (options.dataFile) {
    const previous = new Store(options.dataFile);
    try {
      previous.snapshot(path.join(output, ".site-data.sqlite"));
    } finally {
      previous.close();
    }
  }
  if (
    !options.dataFile &&
    options.previousDirectory &&
    contained(options.root, options.previousDirectory)
  ) {
    const previousFile = path.join(
      options.previousDirectory,
      "output/.site-data.sqlite",
    );
    try {
      await stat(previousFile);
      const previous = new Store(previousFile);
      try {
        previous.snapshot(path.join(output, ".site-data.sqlite"));
      } finally {
        previous.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const snapshot = new Store(path.join(output, ".site-data.sqlite"));
  try {
    snapshot.activateRelease(options.id);
    snapshot.pauseProjectWrites(false);
  } finally {
    snapshot.close();
  }
  await writeFile(
    path.join(output, ".release.json"),
    JSON.stringify({
      id: options.id,
      projectId: project.id,
      revision: project.revision,
      dataMode: "snapshot",
      createdAt: new Date().toISOString(),
    }),
  );
  options.lifecycle?.("after-data-snapshot");
  const info = {
    generatorVersion: GENERATOR_VERSION,
    projectId: project.id,
    revision: project.revision,
    issues,
    build: "passed",
    sourceType: "React + TypeScript",
    data: "Local SQLite",
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(output, "quality-report.json"),
    JSON.stringify(info, null, 2),
  );
  await writeFile(
    path.join(output, "README.md"),
    `# ${project.name}\n\n상위 start-site.cmd를 실행하면 빌드된 사이트와 로컬 데이터 API가 열립니다. 생성한 컴퓨터의 Node.js 실행파일을 포함하며 npm 설치 없이 실행합니다. 다른 OS에서는 해당 OS의 Node.js 22.16 이상을 설치하고 npm start를 실행하세요.\n\n## 개발\n\nnpm ci\nnpm run typecheck\nnpm run lint\nnpm test\nnpm run build\n\n## 배포\n\ndist는 정적 결과물입니다. 폼과 편집 가능한 표는 site-server.mjs와 project.interface.json을 함께 실행해야 동작합니다. 서버는 기본적으로 127.0.0.1에만 바인딩됩니다. 공개 배포에는 인증·인가, TLS 프록시와 접근 정책을 먼저 적용하세요.\n\n## 데이터\n\n문의·표 데이터는 .site-data.sqlite에 저장됩니다. 사이트 실행을 종료한 뒤 백업하거나 SQLite 온라인 백업을 사용하세요. 파일을 초기화하지 마세요.\n\n## 결과\n\nquality-report.json에 자동 검사 결과가 있습니다. 실제 기기와 외부 배포 검증은 별도입니다.\n`,
  );
  await mkdir(path.join(output, "tests"), { recursive: true });
  await writeFile(
    path.join(output, "PLATFORM.md"),
    await readFile(path.join(options.sourceRoot, "docs/platform.md")),
  );
  await writeFile(
    path.join(output, "DEPLOYMENT.md"),
    await readFile(path.join(options.sourceRoot, "docs/public-deployment.md")),
  );
  await writeFile(
    path.join(output, "ARTIFACT.md"),
    `# 독립 결과물 검증\n\nartifact.contract.json은 소스/lock/compiled/포함 Node/라이선스의 SHA256과 지원 OS/arch를 고정합니다. 서버 시작 전 실제 파일을 확인합니다. 같은 지원 환경의 포함 Node 실행은 npm 설치 없이 동작하며, npm ci 및 소스 재빌드는 패키지 설치 환경이 필요합니다.\n\n서명 파일이 존재하는 것만으로 작성자 신원을 신뢰하지 않습니다. 별도 신뢰 경로의 Ed25519 public PEM 파일을 ARTIFACT_TRUSTED_PUBLIC_KEY_FILE로 설정하면 실제 서명을 확인합니다. ARTIFACT_REQUIRE_SIGNATURE=true는 신뢰된 서명이 없는 실행을 거절합니다. private key를 이 폴더에 넣지 마세요. signed artifact 업데이트는 새 검토/생성과 새 서명을 사용합니다.\n\nunsigned build는 새 결과를 검증한 뒤 dist/server/contract를 교체합니다. 기존 데이터/key를 교체하지 않습니다. 의도한 source 변경은 node build.mjs --accept-source로 승인하면 새 hash를 기록하고 이전 commit 증거를 비웁니다. 실제 생산 거래·다른 OS·공개 TLS 검증은 별도입니다.\n`,
  );
  await writeFile(
    path.join(output, "RUNNING.md"),
    `# 실행과 운영\n\n생성 서비스 ${GENERATOR_VERSION}, 프로젝트 ${project.id}, 편집 버전 ${project.revision}, 릴리스 ${options.id}.\n\n기본 실행은 loopback입니다. 사이트 계정·회원 콘텐츠·역할·주문·예약은 번들 서버가 처리합니다. 원본/생성 소스와 운영 DB는 다릅니다. 이 결과의 .site-data.sqlite는 생성 시점 스냅샷입니다. 실제 운영에는 SITE_DATA_FILE로 프로젝트별 고정 저장소를 지정하세요. 공개 활성화는 SITE_ACTIVE_RELEASE_ID가 이 릴리스와 일치해야 합니다. Studio에서 재실행하는 과거 릴리스는 최신 운영 저장소를 읽으며 쓰기는 제한됩니다.\n\nDockerfile/compose.yml과 DEPLOYMENT.md, PLATFORM.md를 확인하세요. 공개 TLS·관리자·공급자 secret 환경을 설정하기 전에는 외부 기능을 완료로 표시하지 않습니다. 실제 문의·회원·주문 DB는 ZIP에 포함하지 않으며 별도 온라인 백업과 복구를 사용합니다.\n`,
  );
  await writeFile(
    path.join(output, "tests/artifact.test.mjs"),
    `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {readFileSync} from 'node:fs';\ntest('artifact has validated project and compiled site',()=>{const p=JSON.parse(readFileSync('project.interface.json','utf8'));assert.equal(p.project.schemaVersion,2);assert.ok(p.project.pages.length);assert.match(readFileSync('dist/index.html','utf8'),/site-config/);assert.ok(readFileSync('dist/assets/site.js').length);});\n`,
  );
  await mkdir(path.join(output, "runtime"), { recursive: true });
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  await copyFile(process.execPath, path.join(output, "runtime", nodeName));
  try {
    await copyFile(
      path.join(path.dirname(process.execPath), "LICENSE"),
      path.join(output, "runtime/LICENSE"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await copyFile(
      path.join(options.sourceRoot, "licenses/node-LICENSE.txt"),
      path.join(output, "runtime/LICENSE.txt"),
    );
  }
  const launcher = `@echo off\r\nsetlocal\r\ncd /d "%~dp0output"\r\n"runtime\\node.exe" site-server.mjs --standalone --open\r\nif errorlevel 1 pause\r\n`;
  await writeFile(path.join(staging, "start-site.cmd"), launcher);
  await writeFile(
    path.join(staging, "start-site.sh"),
    '#!/bin/sh\ncd "$(dirname "$0")/output" || exit 1\nexec "./runtime/node" site-server.mjs --standalone --open\n',
  );
  const fileDigest = async (relative: string): Promise<ArtifactFile> => ({
    path: relative,
    sha256: createHash("sha256")
      .update(await readFile(path.join(output, relative)))
      .digest("hex"),
  });
  const compiledFiles: ArtifactFile[] = [],
    collectCompiled = async (folder: string): Promise<void> => {
      for (const entry of await readdir(path.join(output, folder), {
        withFileTypes: true,
      })) {
        if (entry.isSymbolicLink())
          throw new Error("Symbolic output links are not exportable");
        if (entry.isDirectory())
          await collectCompiled(`${folder}/${entry.name}`);
        else if (entry.isFile())
          compiledFiles.push(await fileDigest(`${folder}/${entry.name}`));
      }
    };
  await collectCompiled("dist");
  compiledFiles.push(await fileDigest("site-server.mjs"));
  for (const file of [
    "package.json",
    "package-lock.json",
    "build.mjs",
    "eslint.config.mjs",
    "tsconfig.json",
  ])
    sourceFiles.push(await fileDigest(file));
  const licenseFiles = (await readdir(path.join(output, "runtime"))).filter(
    (name) => name.startsWith("LICENSE"),
  );
  const licenses = await Promise.all(
    licenseFiles.map((name) => fileDigest(`runtime/${name}`)),
  );
  const sourceHash = createHash("sha256")
      .update(
        JSON.stringify(
          sourceFiles.slice().sort((a, b) => a.path.localeCompare(b.path)),
        ),
      )
      .digest("hex"),
    buildIdentity = JSON.parse(
      await readFile(
        path.join(options.sourceRoot, "dist-service/build.json"),
        "utf8",
      ),
    ) as { hash: string; commit?: string | null };
  if (!/^[a-f0-9]{64}$/.test(buildIdentity.hash))
    throw new Error("Built service identity is required for delivery");
  const contract: ArtifactContract = {
    protocol: 2,
    schemaVersion: 2,
    generatorVersion: GENERATOR_VERSION,
    target: "node",
    node: ">=22.16.0",
    databaseMigration: 15,
    packages: preflightProject(project).requiredPackages,
    sourceFiles: sourceFiles.sort((a, b) => a.path.localeCompare(b.path)),
    packageLockSha256: (await fileDigest("package-lock.json")).sha256,
    runtime: {
      ...(await fileDigest(`runtime/${nodeName}`)),
      version: process.version,
      platform: process.platform,
      arch: process.arch,
      sqlite: process.versions.sqlite ?? "",
      icu: process.versions.icu ?? "",
      tz: process.versions.tz ?? "",
    },
    compiledFiles,
    supportedHosts: [{ platform: process.platform, arch: process.arch }],
    licenses,
    build: {
      sourceHash,
      serviceBuildHash: buildIdentity.hash,
      commit:
        typeof buildIdentity.commit === "string" &&
        /^[a-f0-9]{40}$/.test(buildIdentity.commit)
          ? buildIdentity.commit
          : null,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
  await writeFile(
    path.join(output, "artifact.contract.json"),
    JSON.stringify(contract, null, 2),
  );
  let signed = false;
  const deploymentContract = await writeDeploymentContract(output, {
    projectId: project.id,
    revision: project.revision,
    releaseId: options.id,
    buildHash: contract.build!.serviceBuildHash,
    buildCommit: contract.build!.commit,
  });
  if (process.env.ARTIFACT_SIGNING_PRIVATE_KEY_FILE) {
    const key = await readFile(
      path.resolve(process.env.ARTIFACT_SIGNING_PRIVATE_KEY_FILE),
      "utf8",
    );
    const signature = signArtifactContract(
      contract,
      key,
      process.env.ARTIFACT_SIGNER_ID ?? "",
      process.env.ARTIFACT_SIGNING_KEY_ID ?? "",
    );
    await writeFile(
      path.join(output, "artifact.signature.json"),
      JSON.stringify(signature, null, 2),
    );
    await writeFile(
      path.join(output, "deployment.signature.json"),
      JSON.stringify(
        signDeploymentContract(
          deploymentContract,
          key,
          signature.signerId,
          signature.keyId,
        ),
        null,
        2,
      ),
    );
    signed = true;
  }
  const dependencies = JSON.parse(
    await readFile(path.join(output, "package-lock.json"), "utf8"),
  ) as {
    packages: Record<
      string,
      { version?: string; integrity?: string; license?: string }
    >;
  };
  await writeFile(
    path.join(output, "supply-chain.json"),
    JSON.stringify(
      {
        protocol: 1,
        runtime: contract.runtime,
        packages: Object.entries(dependencies.packages).map(
          ([name, value]) => ({
            name,
            version: value.version ?? "",
            integrity: value.integrity ?? "",
            license: value.license ?? "unspecified",
          }),
        ),
        identitySignature: { configured: signed, signed, verified: false },
      },
      null,
      2,
    ),
  );
  checkpoint("결과 확정");
  await rename(staging, directory);
  return {
    id: options.id,
    path: directory,
    entry: path.join(directory, "start-site.cmd"),
    source: path.join(directory, "output"),
    issues,
    durationMs: Date.now() - started,
  };
}
